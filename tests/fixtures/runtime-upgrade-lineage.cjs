"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Synthetic history: normal restart A -> B, dead-SDK transition B -> C,
// then code X -> Y -> Z on C.
// No transport, broker or SDK operation is constructed.
module.exports = function fixture(base, runtime, restartTamper) {
  const api = require(runtime + "/src/queue-instance");
  const lineage = require(runtime + "/src/queue-epoch-lineage");
  const sourceConfig = {
    backend: "mcp",
    url: "http://127.0.0.1:1/never-called",
    headers: {},
    tool: "fusion_mcp_execute",
    transport: "node",
    protocolVersion: "2025-06-18",
    timeoutMs: 180000,
    routing: "queue",
    queue: {},
  };
  const sdkA = {
    pid: 2147483645,
    birth: "dead-sdk-A",
    version: "fixture",
    activeCommand: "SelectCommand",
  };
  const f = require("./closed-epoch-successor.cjs")(
    base,
    runtime,
    "normal-multidocument",
    sdkA,
    sourceConfig,
  );
  const root = f.dir,
    pointer = f.epoch;
  const snapshotDir = path.join(base, "lineage-snapshot");
  fs.mkdirSync(snapshotDir);
  let snapshot;
  const targetConfig = {
    ...f.cfg,
    backend: "addin",
    tool: "execute_python",
    url: "http://127.0.0.1:1/also-never-called",
  };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return lineage.reference(file);
  };
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const pointerRef = lineage.reference(
    path.join(root, "isolated-admission-epoch.json"),
  );
  let anchors;
  let ownerIndex = 0;
  const owner = () => ({
    pid: 2147400000 + ++ownerIndex,
    birth: "dead-owner-" + ownerIndex,
    nonce: randomUUID(),
    protocol: 2,
  });
  const sdkB = {
    pid: 2147401000,
    birth: "dead-sdk-B",
    version: "fixture",
    activeCommand: "SelectCommand",
  };
  function startup(who, identity, expected, metadataOnly = false) {
    const binding = {
      brokerNonce: who.nonce,
      ownerPid: who.pid,
      ownerBirth: who.birth,
      buildHash: identity.buildHash,
      stage: "startup",
    };
    const receiptFile = path.join(
      root,
      `broker-startup-${who.nonce}.receipt.json`,
    );
    let receiptReference;
    if (!metadataOnly)
      receiptReference = write(receiptFile, {
        ...binding,
        terminal: true,
        outcome: "succeeded",
        instance: identity.instance,
        ...(expected ? { auditExpectedInstance: expected } : {}),
        probeObservation: {
          schema: "fmcad-instance-probe-v1",
          identity: identity.instance,
        },
      });
    const lifecycleReference = write(
      path.join(root, `broker-lifecycle-${who.nonce}.json`),
      {
        owner: who,
        stage: "ready",
        buildHash: identity.buildHash,
        configHash: identity.configHash,
        binding,
        receipt: receiptFile,
      },
    );
    return { receiptReference, lifecycleReference };
  }
  const creationIdentity = read(path.join(pointer.root, "instance.json"));
  const creationOwner = owner();
  const creationStartup = startup(
    creationOwner,
    creationIdentity,
    pointer.currentInstance,
  );
  const ownerReference = write(
    path.join(root, `reclaimed-${randomUUID()}.json`),
    creationOwner,
  );
  const restartedOwner = owner();
  const restartedIdentity = {
    ...creationIdentity,
    buildHash: "b".repeat(64),
    instance: {
      pid: 2147400900,
      birth: "dead-normal-restart-B",
      version: "fixture",
      activeCommand: "SelectCommand",
    },
  };
  const restartedStartup = startup(
    restartedOwner,
    restartedIdentity,
    undefined,
  );
  const restartDirectory = path.join(
    root,
    "normal-restarts",
    restartedOwner.nonce,
  );
  const normalRestart = write(path.join(restartDirectory, "authority.json"), {
    kind: "settled-normal-restart-v1",
    configHash: creationIdentity.configHash,
    current: restartedIdentity.instance,
    binding: read(restartedStartup.lifecycleReference.path).binding,
    pointerReference: pointerRef,
    closedReference: lineage.reference(path.join(pointer.root, "closed.json")),
    ownerReference,
    lifecycleReference: creationStartup.lifecycleReference,
    previousIdentity: write(
      path.join(restartDirectory, "previous-identity.json"),
      creationIdentity,
    ),
    previousState: write(path.join(restartDirectory, "previous-state.json"), {
      jobs: read(path.join(pointer.root, "queue-state.json")).jobs,
    }),
    startupReceipt: restartedStartup.receiptReference,
  });
  if (restartTamper) {
    const authority = read(normalRestart.path);
    switch (restartTamper) {
      case "restart-build":
        restartedIdentity.buildHash = "f".repeat(64);
        break;
      case "binding-build":
        authority.binding.buildHash = "f".repeat(64);
        break;
      case "config":
        authority.configHash = "f".repeat(64);
        break;
      case "sdk-birth":
        authority.current.birth = "foreign";
        break;
      case "pointer":
        authority.pointerReference.sha256 = "f".repeat(64);
        break;
      case "missing-link":
        authority.previousIdentity.path += ".missing";
        break;
      case "state": {
        const state = read(authority.previousState.path);
        state.jobs.foreign = { state: "succeeded" };
        authority.previousState = write(authority.previousState.path, state);
        break;
      }
      case "receipt":
        authority.startupReceipt = creationStartup.receiptReference;
        break;
      default:
        throw new Error(`Unknown restart tamper ${restartTamper}`);
    }
    Object.assign(normalRestart, write(normalRestart.path, authority));
  }
  write(path.join(pointer.root, "instance.json"), {
    ...restartedIdentity,
    normalRestart,
  });
  snapshot = lineage.predecessorSnapshot(root, snapshotDir, true);
  anchors = [snapshot.identity, snapshot.rootIdentity, pointerRef];
  function stopped(
    previous,
    previousOwner,
    sourceIdentityReference,
    sourceStartup,
    kind,
  ) {
    const stopRequestId = "synthetic-stop-" + randomUUID();
    const digest = api.hash(stopRequestId);
    const releaseFile = path.join(root, `console-release-${digest}.json`);
    const admin = write(path.join(root, `console-admin-${digest}.json`), {
      action: "console-stop",
      clientId: pointer.ownerClientId,
      requestId: stopRequestId,
      instanceId: previousOwner.nonce,
      buildHash: previous.buildHash,
      status: "accepted",
      expectedGeneration: 7,
      result: { releaseFile },
    });
    const release = write(releaseFile, {
      terminal: true,
      outcome: "released",
      requestId: stopRequestId,
      instanceId: previousOwner.nonce,
      buildHash: previous.buildHash,
    });
    const evidence = [
      sourceIdentityReference,
      lineage.reference(
        path.join(root, `broker-lifecycle-${previousOwner.nonce}.json`),
      ),
      sourceStartup.receiptReference,
      ...(sourceStartup.kind === "pinned-head-reopen"
        ? [sourceStartup.headReference, sourceStartup.lifecycleReference]
        : []),
      pointerRef,
      lineage.reference(path.join(pointer.root, "closed.json")),
      admin,
      release,
    ];
    return {
      kind,
      previous,
      previousOwner,
      sourceIdentityReference,
      sourceStartup,
      stopRequestId,
      epoch: {
        root: pointer.root,
        epochId: pointer.epochId,
        currentInstance: pointer.currentInstance,
        ownerClientId: pointer.ownerClientId,
      },
      evidence,
      jobs: structuredClone(read(snapshot.state.path).jobs),
      workerEvidence: [],
      queue: {
        active: null,
        blocked: null,
        lease: null,
        localUnknown: null,
        controlBlocked: null,
        paused: true,
        controlGeneration: 8,
        controlRequest: { paused: true, generation: 8 },
      },
    };
  }
  function publish(
    id,
    previousConfig,
    nextConfig,
    identity,
    proofRecord,
    previousHead,
  ) {
    const destination = path.join(root, "physical-backend-transitions", id);
    const identityRef = write(
      path.join(destination, "instance.json"),
      identity,
    );
    const proofName =
      proofRecord.kind === "settled-normal-dead-predecessor-v1"
        ? "deadPredecessor"
        : "runtimeUpgrade";
    const proofRef = write(
      path.join(
        destination,
        proofName === "deadPredecessor"
          ? "dead-predecessor.json"
          : "runtime-upgrade.json",
      ),
      proofRecord,
    );
    const publisher = owner();
    const observed = startup(
      publisher,
      identity,
      proofName === "runtimeUpgrade"
        ? proofRecord.previous.instance
        : undefined,
    );
    const predecessor = [...anchors, ...proofRecord.evidence, proofRef];
    if (previousHead) {
      predecessor.push(previousHead.head.identity);
      predecessor.push(
        write(
          path.join(destination, "predecessor-head.json"),
          previousHead.head,
        ),
      );
    }
    const head = {
      version: 1,
      kind: "owner-bound-physical-backend-transition",
      requestId: id,
      ownerClientId: pointer.ownerClientId,
      ownerTokenHash: pointer.ownerTokenHash,
      epochId: pointer.epochId,
      previousConfig,
      nextConfig,
      previousConfigHash: api.brokerConfigHash(previousConfig),
      nextConfigHash: api.brokerConfigHash(nextConfig),
      identity: identityRef,
      predecessor: [
        ...new Map(predecessor.map((ref) => [ref.path, ref])).values(),
      ],
      observation: [observed.receiptReference],
      [proofName]: proofRef,
    };
    const headRef = write(path.join(destination, "transition.json"), head);
    write(path.join(root, "physical-backend-head.json"), head);
    return {
      head,
      headRef,
      identity,
      publisher,
      observed,
      proofRecord,
      proofRef,
    };
  }
  const original = read(path.join(pointer.root, "instance.json"));
  const initialOwner = restartedOwner;
  const originalStartup = restartedStartup;
  const dead = stopped(
    original,
    initialOwner,
    snapshot.identity,
    {
      kind: "owner-startup-probe",
      receiptReference: originalStartup.receiptReference,
    },
    "settled-normal-dead-predecessor-v1",
  );
  const initial = publish(
    "synthetic-dead-sdk-A-to-B",
    f.cfg,
    targetConfig,
    {
      configHash: api.brokerConfigHash(targetConfig),
      buildHash: "c".repeat(64),
      instance: sdkB,
    },
    dead,
  );
  function upgrade(previous, id, build) {
    const reopenedOwner = owner();
    startup(reopenedOwner, previous.identity, undefined, true);
    const proof = stopped(
      previous.identity,
      reopenedOwner,
      previous.head.identity,
      {
        kind: "pinned-head-reopen",
        headReference: previous.headRef,
        receiptReference: previous.observed.receiptReference,
        lifecycleReference: previous.observed.lifecycleReference,
      },
      "settled-normal-runtime-upgrade-v1",
    );
    return publish(
      id,
      targetConfig,
      targetConfig,
      { ...previous.identity, buildHash: build },
      proof,
      previous,
    );
  }
  const intermediate = upgrade(
    initial,
    "synthetic-runtime-X-to-Y",
    "d".repeat(64),
  );
  const current = upgrade(
    intermediate,
    "synthetic-runtime-Y-to-Z",
    "e".repeat(64),
  );
  const proof = {
    head: current.headRef,
    lifecycle: current.observed.lifecycleReference,
  };
  const verify = () =>
    lineage.successorBackendIdentity(
      root,
      pointer,
      snapshot,
      proof,
      current.publisher,
      current.identity.configHash,
    );
  function tamperCurrentProof(kind) {
    const value = structuredClone(current.proofRecord);
    switch (kind) {
      case "sdk-birth":
        value.previous.instance.birth = "foreign-birth";
        break;
      case "source-ref":
        value.sourceIdentityReference = initial.head.identity;
        break;
      case "skip-head":
        value.sourceStartup.headReference = initial.headRef;
        break;
      case "startup-ref":
        value.sourceStartup.receiptReference =
          initial.observed.receiptReference;
        break;
      case "lifecycle-ref":
        value.sourceStartup.lifecycleReference =
          initial.observed.lifecycleReference;
        break;
      case "owner":
        value.previousOwner.nonce = randomUUID();
        break;
      case "epoch":
        value.epoch.epochId = randomUUID();
        break;
      case "build":
        value.previous.buildHash = "f".repeat(64);
        break;
      case "pending":
        value.jobs.pending = { state: "queued" };
        break;
      case "unknown":
        value.jobs.unknown = { state: "failed", executionOutcome: "unknown" };
        break;
      case "generation":
        value.queue.controlGeneration += 10;
        break;
      case "unpaused":
        value.queue.paused = false;
        break;
      case "active":
        value.queue.active = "foreign";
        break;
      case "stop-request":
        value.stopRequestId = randomUUID();
        break;
      case "missing-evidence":
        value.evidence = [];
        break;
      case "worker":
        value.workerEvidence = [current.observed.receiptReference];
        break;
      default:
        throw new Error(`Unknown tamper case ${kind}`);
    }
    const changed = write(current.proofRef.path, value);
    current.head.runtimeUpgrade = changed;
    current.head.predecessor = current.head.predecessor.map((ref) =>
      ref.path === changed.path ? changed : ref,
    );
    proof.head = write(current.headRef.path, current.head);
  }
  return {
    root,
    pointer,
    snapshot,
    original,
    initial,
    intermediate,
    current,
    proof,
    verify,
    write,
    read,
    anchors,
    api,
    tamperCurrentProof,
  };
};
