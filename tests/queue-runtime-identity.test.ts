import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  openBrokerRuntimeAuthority,
  type BrokerRuntimeIdentityReaders,
  type BrokerRuntimeQueue,
} from "../src/queue-runtime-authority";
import type * as P from "../src/queue-broker-ports";
import type { ApprovedRuntimeRoot } from "../src/queue-runtime-physical-wiring";
import { QueueDomain } from "../packages/core/src/domain/queue";
import { claimBrokerLifetime } from "../packages/node-adapters/src/execution/broker-lifetime";

const runtime = process.env["FMCAD_TEST_RUNTIME"] || process.cwd();
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const instance = load(
  "./queue-instance",
) as BrokerRuntimeIdentityReaders["instance"] & {
  processBirth(): string;
  brokerConfigHash(value: object): string;
};
const readers: BrokerRuntimeIdentityReaders = {
  instance,
  backend: load("./queue-backend-transition"),
  epochs: load("./queue-isolated-epoch"),
  lineage: load("./queue-epoch-lineage"),
  normalAdmission: load("./dist/node-adapters/broker-ipc/normal-admission"),
  normalRestart: load("./dist/node-adapters/broker-ipc/normal-restart"),
  atomicObservation: load("./atomic-workflow-observation"),
  hasRuntimeRootEvidence: (
    load("./dist/node-adapters/execution/physical-generation-profile") as Pick<
      typeof import("../packages/node-adapters/src/execution/physical-generation-profile"),
      "hasRuntimeRootEvidence"
    >
  ).hasRuntimeRootEvidence,
};
const observationScope = (
  load(
    "./atomic-workflow-observation",
  ) as import("../src/queue-broker-modules").BrokerModules["./atomic-workflow-observation"]
).fastenersScope;
const codeHash = instance.buildHash();
const observed: P.Instance = {
  pid: process.pid,
  birth: instance.processBirth(),
  version: "fixture",
  activeCommand: "SelectCommand",
  documents: [],
};
function makeState(): QueueDomain {
  return new QueueDomain({
    recover: false,
    now: () => 1,
    newId: randomUUID,
    hash: instance.hash,
  });
}
function port(
  state: QueueDomain,
  epoch: P.Epoch | null = null,
  admission = "isolated-one-anchor",
): BrokerRuntimeQueue {
  return {
    epoch: () => epoch,
    admissionMode: () => admission,
    current: () => state.data as P.Snapshot,
    assertEpoch: () => {
      if (!epoch) assert.fail("No epoch");
    },
    advanceInstanceEpoch: (id) => state.advanceInstanceEpoch(id),
    writerStatus: () => state.writerStatus(),
  };
}
function startupProbe(dir: string, owner: P.Owner) {
  return {
    binding: Object.freeze({
      brokerNonce: owner.nonce,
      ownerPid: owner.pid,
      ownerBirth: owner.birth,
      buildHash: codeHash,
      stage: "startup" as const,
    }),
    receiptPath: path.join(dir, `broker-startup-${owner.nonce}.receipt.json`),
    diagnosticPath: path.join(dir, `broker-startup-${owner.nonce}.result.json`),
  };
}
function fixture(t: import("node:test").TestContext) {
  const dir = fs.mkdtempSync("/tmp/opencode/runtime-identity-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner: P.Owner = {
    pid: process.pid,
    birth: instance.processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  instance.durable(path.join(dir, "broker.lock"), owner);
  const options = {
    directory: dir,
    buildHash: codeHash,
    configHash: instance.brokerConfigHash({ backend: "addin", url: "fixture" }),
    observationScope,
  };
  const identity = {
    buildHash: options.buildHash,
    configHash: options.configHash,
    instance: observed,
  };
  const probe = startupProbe(dir, owner);
  return { dir, owner, options, identity, probe, state: makeState() };
}

test("selection rejects configuration without claiming; bind pins the later lifetime owner exactly once", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.dir, "broker.lock");
  fs.unlinkSync(lock); // Only this fixture's synthetic marker, before real claim.
  instance.durable(path.join(f.dir, "instance.json"), {
    ...f.identity,
    configHash: "foreign-configuration",
  });
  let claims = 0;
  const selectThenClaim = async () => {
    const authority = await openBrokerRuntimeAuthority(f.options, readers);
    claims++;
    const lifetime = claimBrokerLifetime({
      dir: f.dir,
      socket: path.join(f.dir, "unused.sock"),
      buildHash: codeHash,
      configHash: f.options.configHash,
      processBirth: instance.processBirth,
      disposeClient() {},
    });
    return { authority, lifetime };
  };
  await assert.rejects(selectThenClaim(), { code: "CONFIG_CHANGED" });
  assert.equal(claims, 0);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(
    fs.readdirSync(f.dir).some((name) => name.startsWith("broker-lifecycle-")),
    false,
  );
  instance.durable(path.join(f.dir, "instance.json"), f.identity);
  const selected = await openBrokerRuntimeAuthority(f.options, readers);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => selected.capture(), {
    code: "RUNTIME_AUTHORITY_UNBOUND",
  });
  await assert.rejects(
    selected.identifyStartup(f.probe, async () =>
      assert.fail("No startup work before owner claim and bind"),
    ),
    { code: "RUNTIME_AUTHORITY_UNBOUND" },
  );
  assert.throws(() => selected.activatePublishedEpoch(), {
    code: "RUNTIME_STARTUP_UNVERIFIED",
  });
  const lifetime = claimBrokerLifetime({
    dir: f.dir,
    socket: path.join(f.dir, "unused.sock"),
    buildHash: codeHash,
    configHash: f.options.configHash,
    processBirth: instance.processBirth,
    disposeClient() {},
  });
  try {
    const supplied = { ...lifetime.owner };
    selected.bindQueue(port(f.state), { owner: supplied });
    supplied.nonce = "caller-mutated-after-bind";
    selected.assertCurrent(selected.capture());
    assert.throws(
      () => selected.bindQueue(port(f.state), { owner: supplied }),
      { code: "RUNTIME_AUTHORITY_BOUND" },
    );
    // Keep the actual lifetime's file identity intact while injecting bad content.
    fs.writeFileSync(lock, JSON.stringify(supplied));
    assert.throws(() => selected.capture(), {
      code: "RUNTIME_AUTHORITY_CHANGED",
    });
    assert.deepEqual(selected.current().instance, null);
  } finally {
    fs.writeFileSync(lock, JSON.stringify(lifetime.owner));
    lifetime.abortBeforeInitialize();
  }
  assert.equal(fs.existsSync(lock), false);
});

test("legacy startup owns selection, publication and immutable current identity", async (t) => {
  const f = fixture(t);
  assert.equal(f.probe.binding.stage, "startup");
  assert.equal("rpcId" in f.probe.binding, false);
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  assert.equal(
    authority.selection().identityFile,
    path.join(f.dir, "instance.json"),
  );
  authority.bindQueue(port(f.state), { owner: f.owner });
  const before = authority.capture();
  let probes = 0;
  assert.deepEqual(
    await authority.identifyStartup(f.probe, async () => {
      probes++;
      return observed;
    }),
    { hold: null, atomicObservationOnly: false },
  );
  assert.equal(probes, 1);
  assert.deepEqual(
    instance.readJson(path.join(f.dir, "instance.json")),
    f.identity,
  );
  assert.deepEqual(authority.current().instance, observed);
  assert.equal(Object.isFrozen(authority.current().instance?.documents), true);
  assert.throws(() => authority.assertCurrent(before), {
    code: "RUNTIME_AUTHORITY_CHANGED",
  });
  authority.assertCurrent(authority.capture());
  await assert.rejects(
    authority.identifyStartup(f.probe, async () => {
      assert.fail("Startup cannot replay");
    }),
    { code: "RUNTIME_STARTUP_ALREADY_STARTED" },
  );
});

test("a startup binding from another claimed owner cannot reach the observation transport", async (t) => {
  const f = fixture(t);
  const foreign = fixture(t);
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  authority.bindQueue(port(f.state), { owner: f.owner });
  await assert.rejects(
    authority.identifyStartup(
      {
        ...f.probe,
        binding: foreign.probe.binding,
      },
      async () =>
        assert.fail("A foreign startup binding cannot submit an observation"),
    ),
    { code: "RUNTIME_AUTHORITY_CHANGED" },
  );
  assert.equal(fs.existsSync(path.join(f.dir, "instance.json")), false);
});

test("original durable identity is rechecked after the startup await, without adoption or replay", async (t) => {
  const f = fixture(t);
  instance.durable(path.join(f.dir, "instance.json"), f.identity);
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  authority.bindQueue(port(f.state), { owner: f.owner });
  await assert.rejects(
    authority.identifyStartup(f.probe, async () => {
      instance.durable(path.join(f.dir, "instance.json"), {
        ...f.identity,
        instance: { ...observed, birth: "foreign" },
      });
      return observed;
    }),
    { code: "RUNTIME_AUTHORITY_CHANGED" },
  );
  assert.equal(authority.current().instance, null);
  assert.equal(
    fs
      .readdirSync(f.dir)
      .some((name) => name.startsWith("instance-transition-")),
    false,
  );
});

test("legacy process and version changes retain the original quiescent restart guards and record format", async (t) => {
  for (const mode of ["unconfirmed", "paused", "dirty", "confirmed"] as const) {
    const f = fixture(t);
    const previous = {
      ...f.identity,
      instance: {
        pid: 2147483645,
        birth: "dead:fixture",
        version: "previous-version",
      },
    };
    instance.durable(path.join(f.dir, "instance.json"), previous);
    if (mode === "paused") f.state.pause(true, "explicit-pause");
    const authority = await openBrokerRuntimeAuthority(
      {
        ...f.options,
        confirmVersionTransition: mode !== "unconfirmed",
      },
      readers,
    );
    authority.bindQueue(port(f.state), { owner: f.owner });
    const result = authority.identifyStartup(f.probe, async () => ({
      ...observed,
      documents: mode === "dirty" ? [{ isModified: true }] : [],
    }));
    if (mode !== "confirmed") {
      await assert.rejects(result, { code: "INSTANCE_CHANGED" });
      assert.deepEqual(
        instance.readJson(path.join(f.dir, "instance.json")),
        previous,
      );
      continue;
    }
    await result;
    const record = fs
      .readdirSync(f.dir)
      .find((file) => file.startsWith("instance-transition-"));
    assert.ok(record);
    const transition = instance.readJson<Record<string, unknown>>(
      path.join(f.dir, record),
    );
    assert.equal(transition["source"], "explicit-quiescent-version-transition");
    assert.deepEqual(transition["previous"], previous.instance);
    assert.deepEqual(transition["current"], observed);
    assert.equal(authority.current().instance?.birth, observed.birth);
  }
});

test("startup rechecks owner and original current control state after await", async (t) => {
  for (const mutate of ["owner", "control"] as const) {
    const f = fixture(t);
    const authority = await openBrokerRuntimeAuthority(f.options, readers);
    authority.bindQueue(port(f.state), { owner: f.owner });
    await assert.rejects(
      authority.identifyStartup(f.probe, async () => {
        if (mutate === "owner")
          instance.durable(path.join(f.dir, "broker.lock"), {
            ...f.owner,
            nonce: "foreign",
          });
        else f.state.pause(true, "foreign-pause");
        return observed;
      }),
      { code: "RUNTIME_AUTHORITY_CHANGED" },
    );
    assert.equal(fs.existsSync(path.join(f.dir, "instance.json")), false);
  }
});

test("a durable identity changed after binding cannot become the new startup baseline", async (t) => {
  const f = fixture(t);
  instance.durable(path.join(f.dir, "instance.json"), f.identity);
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  authority.bindQueue(port(f.state), { owner: f.owner });
  instance.durable(path.join(f.dir, "instance.json"), {
    ...f.identity,
    instance: { ...observed, birth: "foreign-before-probe" },
  });
  await assert.rejects(
    authority.identifyStartup(f.probe, async () =>
      assert.fail("Changed original identity must send zero SDK probes"),
    ),
    { code: "RUNTIME_AUTHORITY_CHANGED" },
  );
});

test("configuration rejection and restored unresolved control send no startup probe", async (t) => {
  const foreign = fixture(t);
  instance.durable(path.join(foreign.dir, "instance.json"), {
    ...foreign.identity,
    configHash: "foreign",
  });
  await assert.rejects(openBrokerRuntimeAuthority(foreign.options, readers), {
    code: "CONFIG_CHANGED",
  });
  const f = fixture(t);
  instance.durable(path.join(f.dir, "instance.json"), f.identity);
  f.state.beginControlProbe("original-control");
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  authority.bindQueue(port(f.state), { owner: f.owner });
  const result = await authority.identifyStartup(f.probe, async () => {
    assert.fail(
      "An unresolved original control forbids all startup SDK traffic",
    );
  });
  assert.match(result.hold!, /matching remote terminal receipts/);
  assert.deepEqual(authority.current().instance, observed);
  assert.deepEqual(f.state.data.controlBlocked, { rpcId: "original-control" });
});

test("legacy old-build holder uses the real configured atomic candidate guard", async (t) => {
  for (const matches of [true, false]) {
    const f = fixture(t);
    const reportPath = path.join(f.dir, "original-atomic-report.json");
    const requestId = "original-atomic-request";
    const submitted = f.state.submit({
      kind: "command",
      clientId: "original-owner",
      requestId,
      cwd: f.dir,
      argv: ["batch", "run"],
      timeoutMs: 100,
      phased: true,
      backend: "addin",
      buildHash: "original-build",
      payload: {
        version: 1,
        kind: "cad",
        operation: "batch.run",
        doc: "Original document",
        docId: "original-document",
        data: { atomic: true, runId: "original-run", reportPath },
      },
    });
    const jobId = submitted["id"];
    assert.ok(typeof jobId === "string");
    f.state.readyTurn(jobId);
    assert.ok(f.state.next());
    assert.equal(f.state.data.active, jobId);
    f.state.markDispatch(jobId, { rpcCount: 1, completedCount: 1 });
    f.state.releaseTurn(jobId, 100);
    f.state.readyTurn(jobId);
    assert.ok(f.state.next());
    f.state.markDispatch(jobId, { rpcCount: 2, completedCount: 1 });
    f.state.block(jobId, "original native outcome remains UNKNOWN");
    const configuredScope: P.AtomicScopeConfig = {
      ...observationScope,
      jobId,
      requestId,
      projectDirectory: f.dir,
      reportPath,
      docId: matches ? "original-document" : "foreign-document",
    };
    instance.durable(path.join(f.dir, "instance.json"), {
      ...f.identity,
      buildHash: "original-build",
    });
    const authority = await openBrokerRuntimeAuthority(
      {
        ...f.options,
        observationScope: configuredScope,
      },
      readers,
    );
    authority.bindQueue(port(f.state), { owner: f.owner });
    const result = authority.identifyStartup(f.probe, async () =>
      assert.fail("The exact old-build holder is metadata-only, never a probe"),
    );
    if (matches) {
      assert.equal((await result).atomicObservationOnly, true);
      assert.equal(authority.isAtomicObservationOnly(), true);
      assert.equal(authority.current().buildHash, "original-build");
    } else {
      await assert.rejects(result, { code: "BUILD_CHANGED" });
    }
    assert.equal(f.state.data.jobs[jobId]?.state, "needs_reconciliation");
    assert.equal(f.state.data.jobs[jobId]?.dispatch?.rpcCount, 2);
  }
});

test("unproven native-root markers cannot select legacy state", async (t) => {
  const f = fixture(t);
  instance.durable(path.join(f.dir, "runtime-rebaseline-head.json"), {
    unproven: true,
  });
  await assert.rejects(
    openBrokerRuntimeAuthority(f.options, {
      ...readers,
      backend: {
        resolveBackendHead: () => assert.fail("Must not fall back to legacy"),
      },
    }),
    { code: "RUNTIME_ROOT_AUTHORITY_REQUIRED" },
  );
});

test("authenticated native-root boundary is awaited and never invokes legacy epoch/head readers", async (t) => {
  const f = fixture(t);
  const approved = Object.freeze({
    fixture: "authenticated-reader-result",
  }) as unknown as ApprovedRuntimeRoot;
  let verified = false;
  let checks = 0;
  const authority = await openBrokerRuntimeAuthority(
    {
      ...f.options,
      runtimeRoot: {
        async verifyRuntimeRootBeforeRestore(context) {
          await Promise.resolve();
          assert.equal(context.directory, f.dir);
          verified = true;
          return approved;
        },
        assertVerifiedRoot(directory) {
          assert.equal(directory, f.dir);
          checks++;
        },
      },
    },
    {
      ...readers,
      epochs: {
        openIsolatedEpoch: () =>
          assert.fail("Native root cannot read legacy epochs"),
      },
      backend: {
        resolveBackendHead: () =>
          assert.fail("Native root cannot read legacy heads"),
      },
    },
  );
  assert.equal(verified, true);
  assert.equal(authority.selection().approvedRuntimeRoot, approved);
  authority.bindQueue(port(f.state, null, "runtime-rebaseline"), {
    owner: f.owner,
  });
  await authority.identifyStartup(f.probe, async () => observed);
  assert.equal(
    authority.current().identityFile,
    path.join(f.dir, "runtime-rebaseline-current-instance.json"),
  );
  authority.assertCurrent(authority.capture());
  assert.ok(checks > 0);
  assert.throws(() => authority.activatePublishedEpoch(), {
    code: "PHYSICAL_CAPABILITY_CONFLICT",
  });
});

function epochFixture(
  t: import("node:test").TestContext,
  normal: boolean,
  config?: P.Config,
) {
  const f = fixture(t);
  const create = createRequire(
    path.join(runtime, "tests/fixtures/closed-epoch-successor.cjs"),
  )("./closed-epoch-successor.cjs") as (
    root: string,
    repo: string,
    mode?: string,
    currentInstance?: P.Instance,
    config?: P.Config,
  ) => {
    dir: string;
    cfg: P.Config;
    state: P.State;
    epoch: P.Epoch;
    clientId: string;
    token: string;
  };
  fs.mkdirSync(path.join(f.dir, "epoch"));
  const epoch = create(
    path.join(f.dir, "epoch"),
    runtime,
    normal ? "normal-multidocument" : undefined,
    undefined,
    config,
  );
  const options = {
    ...f.options,
    directory: epoch.dir,
    configHash: instance.brokerConfigHash(epoch.cfg),
  };
  const q: BrokerRuntimeQueue = {
    epoch: () => epoch.state.epoch,
    admissionMode: () => epoch.state.admissionMode,
    current: () => epoch.state.data,
    assertEpoch: (normal) => epoch.state.assertEpoch(normal),
    advanceInstanceEpoch: (id) => epoch.state.advanceInstanceEpoch(id),
    writerStatus: () => epoch.state.writerStatus(),
  };
  const owner = instance.readJson<P.Owner>(path.join(epoch.dir, "broker.lock"));
  return {
    ...f,
    ...epoch,
    options,
    q,
    owner,
    probe: startupProbe(epoch.dir, owner),
  };
}

test("real qualified isolated and normal epoch readers preserve separate no-probe startup policies", async (t) => {
  for (const normal of [false, true]) {
    const f = epochFixture(t, normal);
    const authority = await openBrokerRuntimeAuthority(f.options, readers);
    authority.bindQueue(f.q, { owner: f.owner });
    const result = await authority.identifyStartup(f.probe, async () =>
      assert.fail(
        "A pinned qualified epoch must not send another startup probe",
      ),
    );
    assert.equal(
      authority.current().identityFile,
      path.join(f.epoch.root, "instance.json"),
    );
    assert.equal(authority.current().epochId, f.epoch.epochId);
    assert.equal(authority.current().processUnavailable, false);
    if (normal) assert.equal(result.hold, null);
    else assert.match(result.hold!, /scratch is closed/);
    const original = authority.capture();
    authority.activatePublishedEpoch();
    assert.throws(() => authority.assertCurrent(original), {
      code: "RUNTIME_AUTHORITY_CHANGED",
    });
    authority.assertCurrent(authority.capture());
  }
});

test("qualification or lineage tampering is rejected before startup or activation", async (t) => {
  const f = epochFixture(t, false);
  const authority = await openBrokerRuntimeAuthority(f.options, readers);
  authority.bindQueue(f.q, { owner: f.owner });
  await authority.identifyStartup(f.probe, async () =>
    assert.fail("Pinned epoch"),
  );
  const pointerFile = path.join(f.dir, "isolated-admission-epoch.json");
  const pointer = instance.readJson<Record<string, unknown>>(pointerFile);
  instance.durable(pointerFile, {
    ...pointer,
    ownerTokenHash: "foreign-owner",
  });
  assert.throws(() => authority.activatePublishedEpoch());
  assert.throws(() => authority.capture());
});

test("backend startup publishes only the authenticated head and preserves predecessor bytes", async (t) => {
  // Archived predecessor metadata only; no MCP transport is initialized or used.
  const f = epochFixture(t, true, {
    backend: "mcp",
    url: "http://127.0.0.1:1/never-called",
    headers: {},
    tool: "fusion_mcp_execute",
    transport: "node",
    protocolVersion: "2025-06-18",
    timeoutMs: 180000,
    routing: "queue",
    queue: {},
  });
  if (f.state.data.paused) f.state.pause(false, "owner-transition");
  const lifecycle = load(
    "./queue-backend-transition",
  ) as typeof import("../src/queue-backend-transition");
  const next = {
    ...f.cfg,
    backend: "addin",
    url: "http://127.0.0.1:8765/identity-fixture",
    tool: "execute_python",
  };
  const approval = {
    requestId: "runtime-identity-backend",
    clientId: f.clientId,
    clientToken: f.token,
    previousConfig: f.cfg,
    nextConfig: next,
  };
  const prepared = lifecycle.prepareBackendTransition(
    f.dir,
    f.state,
    next,
    approval,
  );
  const protectedFiles = [
    path.join(f.dir, "instance.json"),
    path.join(f.epoch.root, "instance.json"),
    path.join(f.dir, "queue-state.json"),
    path.join(f.dir, "isolated-admission-epoch.json"),
  ].map((file) => ({ file, bytes: fs.readFileSync(file) }));
  const authority = await openBrokerRuntimeAuthority(
    {
      ...f.options,
      configHash: instance.brokerConfigHash(next),
      transitions: { backend: approval },
    },
    readers,
  );
  authority.bindQueue(f.q, { owner: f.owner });
  const target = {
    ...prepared.identity.instance,
    activeCommand: "SelectCommand",
    documents: [],
  };
  await authority.identifyStartup(
    f.probe,
    async () => {
      instance.durable(f.probe.receiptPath, {
        ...f.probe.binding,
        terminal: true,
        outcome: "succeeded",
        instance: target,
      });
      instance.durable(f.probe.diagnosticPath, { instance: target });
      return target;
    },
    prepared,
  );
  const head = lifecycle.backendHead(f.dir)!;
  assert.equal(authority.current().identityFile, head.identityFile);
  assert.equal(authority.current().configHash, instance.brokerConfigHash(next));
  authority.assertCurrent(authority.capture());
  for (const entry of protectedFiles)
    assert.deepEqual(fs.readFileSync(entry.file), entry.bytes);
  const reopened = await openBrokerRuntimeAuthority(
    {
      ...f.options,
      configHash: instance.brokerConfigHash(next),
    },
    readers,
  );
  reopened.bindQueue(f.q, { owner: f.owner });
  await reopened.identifyStartup(f.probe, async () =>
    assert.fail(
      "An exact current backend head must reopen without another probe",
    ),
  );
  assert.equal(reopened.current().identityFile, head.identityFile);
  assert.deepEqual(
    fs.readFileSync(head.identityFile),
    fs.readFileSync(authority.current().identityFile),
  );
  const record = instance.readJson<Record<string, unknown>>(
    path.join(f.dir, "physical-backend-head.json"),
  );
  instance.durable(path.join(f.dir, "physical-backend-head.json"), {
    ...record,
    ownerTokenHash: "foreign",
  });
  assert.throws(() => authority.capture(), {
    code: "BACKEND_TRANSITION_CHANGED",
  });
});

test("real successor lineage activates only the published qualified identity and revokes original pins", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "successor"));
  const create = createRequire(
    path.join(runtime, "tests/fixtures/dead-epoch-successor.cjs"),
  )("./dead-epoch-successor.cjs") as (
    root: string,
    repo: string,
  ) => {
    dir: string;
    cfg: P.Config;
    nonce: string;
    authorityEntry: P.Reference;
    pointer: Parameters<
      ReturnType<
        typeof import("../src/queue-isolated-epoch").openIsolatedEpoch
      >["installEpoch"]
    >[0];
    identity: Parameters<
      ReturnType<
        typeof import("../src/queue-isolated-epoch").openIsolatedEpoch
      >["installEpoch"]
    >[1];
    initialization: { createdAtMs: number; bindingHash: string };
  };
  const successor = create(path.join(f.dir, "successor"), runtime);
  instance.durable(path.join(successor.dir, "broker.lock"), f.owner);
  instance.durable(path.join(successor.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: successor.authorityEntry,
  });
  const state = (
    load(
      "./queue-isolated-epoch",
    ) as typeof import("../src/queue-isolated-epoch")
  ).openIsolatedEpoch(successor.dir, { recover: false });
  assert.notDeepEqual(
    state.epoch?.succession,
    successor.authorityEntry,
    "The current epoch's prior link is not the new pre-publication successor claim",
  );
  const q: BrokerRuntimeQueue = {
    epoch: () => state.epoch,
    admissionMode: () => state.admissionMode,
    current: () => state.data as P.Snapshot,
    assertEpoch: (normal) => state.assertEpoch(normal),
    advanceInstanceEpoch: (id) => state.advanceInstanceEpoch(id),
    writerStatus: () => state.writerStatus(),
  };
  const options = {
    ...f.options,
    directory: successor.dir,
    configHash: instance.brokerConfigHash(successor.cfg),
    transitions: { deadEpochSuccessorNonce: successor.nonce },
  };
  const authority = await openBrokerRuntimeAuthority(options, readers);
  const foreignClaim = await openBrokerRuntimeAuthority(
    {
      ...options,
      transitions: { deadEpochSuccessorNonce: "foreign-claim" },
    },
    readers,
  );
  assert.throws(
    () =>
      foreignClaim.bindQueue(q, {
        owner: f.owner,
        successorAuthority: successor.authorityEntry,
      }),
    { code: "EPOCH_SUCCESSOR_CLAIM_UNPROVEN" },
  );
  assert.throws(() => foreignClaim.capture(), {
    code: "RUNTIME_AUTHORITY_UNBOUND",
  });
  authority.bindQueue(q, {
    owner: f.owner,
    successorAuthority: successor.authorityEntry,
  });
  const result = await authority.identifyStartup(f.probe, async () =>
    assert.fail("Successor metadata startup cannot send another SDK probe"),
  );
  assert.match(result.hold!, /process is unavailable/);
  assert.equal(authority.current().processUnavailable, true);
  const original = authority.capture();
  state.installEpoch(
    successor.pointer,
    successor.identity,
    successor.initialization,
  );
  const selected = authority.activatePublishedEpoch();
  assert.equal(selected.epochId, successor.pointer.epochId);
  assert.equal(
    selected.identityFile,
    path.join(successor.pointer.root, "instance.json"),
  );
  assert.deepEqual(selected.instance, successor.identity.instance);
  assert.equal(selected.processUnavailable, false);
  assert.throws(() => authority.assertCurrent(original), {
    code: "RUNTIME_AUTHORITY_CHANGED",
  });
  authority.assertCurrent(authority.capture());
});
