import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
import type {
  Process,
  Owner,
  Pointer,
  Checked,
  Approval,
  Inspection,
  Client,
  Guard,
  Intent,
  Complete,
  Ready,
  Reference,
  BootstrapOptions,
  ObserverClient,
  ObservationInput,
} from "./queue-epoch-successor-types";
const anchor = path.join(__dirname, "../../queue-epoch-successor.js");
const load = createRequire(anchor);
const {
  hash,
  durable,
  readJson,
  priorProcessAlive,
  buildHash,
  brokerConfigHash,
} = load("./queue-instance") as {
  hash(value: string): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string, max: number): unknown;
  priorProcessAlive(value: Process): boolean | null;
  buildHash(): string;
  brokerConfigHash(cfg: unknown): string;
};
const { directory, fileHash, exclusive } = load(
  "./queue-atomic-migration-files",
) as typeof import("../../packages/node-adapters/src/persistence/migration-files");
const { predecessorSnapshot, reference, epochLineage } = load(
  "./queue-epoch-lineage",
) as typeof import("../queue-epoch-lineage");
const { successionAuthority } = load("./queue-epoch-lineage") as {
  successionAuthority(root: string, entry: Reference): Checked;
};
const { openIsolatedEpoch } = load("./queue-isolated-epoch") as {
  openIsolatedEpoch(
    root: string,
    options: { recover: false },
  ): { epoch: Pointer | null };
};
const { resolveRuntimePaths } = load(
  "./dist/config-platform",
) as typeof import("../../packages/node-adapters/src/config-platform");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
// Private journal records retain their existing identity/hash/process guards below.
const read = <T>(file: string): T => readJson(file, 256 * 1024 * 1024) as T;
const exists = <T>(file: string): T | null =>
  fs.existsSync(file) ? read<T>(file) : null;
export function assertSuccessorApproval(value: Inspection, approval: Approval) {
  if (
    approval.version !== 1 ||
    approval.purpose !== "dead-isolated-epoch-successor-v1" ||
    approval.requestId !== value.requestId ||
    approval.clientId !== value.clientId ||
    approval.predecessorEpochId !== value.pointer.epochId ||
    value.pointer.ownerClientId !== value.clientId ||
    value.pointer.ownerTokenHash !== value.ownerTokenHash ||
    value.registeredTokenHash !== value.ownerTokenHash ||
    approval.previousBuildHash !== value.identity.buildHash ||
    approval.pointerHash !== value.snapshot.pointer.sha256 ||
    !same(approval.previousOwner, value.previousOwner) ||
    !same(value.previousLifecycle?.owner, value.previousOwner) ||
    value.previousLifecycle.buildHash !== value.identity.buildHash ||
    value.previousLifecycle.configHash !== value.configHash ||
    !["ready", "recovery"].includes(value.previousLifecycle.stage) ||
    approval.stateHash !== value.snapshot.state.sha256 ||
    approval.rootStateHash !== value.snapshot.rootState.sha256 ||
    approval.rootIdentityHash !== value.snapshot.rootIdentity.sha256 ||
    approval.candidateRoot !== value.runtime ||
    approval.buildHash !== value.codeHash ||
    !/^[a-f0-9]{40}$/.test(approval.sourceCommit || "") ||
    !approval.expectedProcess ||
    Object.keys(approval.expectedProcess).sort().join(",") !== "birth,pid" ||
    !Number.isSafeInteger(approval.expectedProcess.pid) ||
    approval.expectedProcess.pid <= 0 ||
    typeof approval.expectedProcess.birth !== "string" ||
    !approval.expectedProcess.birth ||
    value.identity.configHash !== value.configHash ||
    value.rootIdentity.configHash !== value.configHash ||
    value.previousBrokerAlive !== false ||
    value.previousProcessAlive !== false ||
    value.originalProcessAlive !== false ||
    value.expectedProcessAlive !== true ||
    value.pending ||
    !value.previousOwner ||
    value.previousOwner.protocol !== 2
  )
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "Exact existing owner, dead predecessor/broker, immutable state, qualified build and selected new process required",
    );
  const q = value.qualification;
  if (
    !q ||
    q.passed !== true ||
    q.productionAdmission !== true ||
    q.liveSdkRequestsSent !== 0 ||
    q.sourceCommit !== approval.sourceCommit ||
    q.buildHash !== approval.buildHash ||
    q.publicDirectAccessRefused !== true ||
    q.deadEpochSuccessorReadQualified !== true ||
    q.deadEpochSuccessorRestoreQualified !== true
  )
    fail(
      "EPOCH_SUCCESSOR_UNQUALIFIED",
      "The installed candidate requires a pinned real-checker and public-direct refusal qualification",
    );
}

export function inspectSuccessor(
  client: Client,
  cfg: unknown,
  approvalFile: string,
  requestId: string,
): Inspection {
  const root = client.dir,
    runtime = resolveRuntimePaths({ anchor }).installation;
  directory(root);
  const approvalRef = reference(fs.realpathSync(approvalFile)),
    approval = read<Approval>(approvalRef.path);
  if (
    typeof requestId !== "string" ||
    !requestId ||
    requestId.length > 160 ||
    approval.requestId !== requestId
  )
    fail("INVALID_REQUEST", "A stable owner successor request ID is required");
  const audit = path.join(root, "epoch-successions", hash(requestId));
  const state = openIsolatedEpoch(root, { recover: false });
  if (!state.epoch)
    fail(
      "EPOCH_SUCCESSOR_REQUIRED",
      "There is no predecessor epoch to preserve",
    );
  const pointer = state.epoch,
    identity = read<Inspection["identity"]>(
      path.join(pointer.root, "instance.json"),
    );
  const activeSuccession = exists<{ version: number; authority: Reference }>(
    path.join(root, "active-epoch-succession.json"),
  );
  if (activeSuccession && !same(pointer.succession, activeSuccession.authority))
    fail(
      "EPOCH_SUCCESSOR_PENDING",
      "An unconsumed successor authority already owns this predecessor; unknown creation must not be bypassed by a new request",
    );
  const previousOwner = read<Owner>(path.join(root, "broker.lock"));
  const qualification = approval.qualification;
  if (
    !qualification ||
    !path.isAbsolute(qualification.path || "") ||
    fileHash(qualification.path).sha256 !== qualification.sha256 ||
    fs.realpathSync(qualification.path) !== qualification.path
  )
    fail(
      "EPOCH_SUCCESSOR_UNQUALIFIED",
      "Exact immutable installed qualification reference required",
    );
  const value: Inspection = {
    root,
    runtime,
    audit,
    requestId,
    approvalRef,
    approval,
    clientId: client.auth.clientId,
    ownerTokenHash: hash(client.auth.clientToken),
    registeredTokenHash: read<Record<string, string>>(
      path.join(root, "clients.json"),
    )[client.auth.clientId],
    pointer,
    identity,
    previousOwner,
    snapshot: predecessorSnapshot(root, audit),
    rootIdentity: read(path.join(root, "instance.json")),
    codeHash: buildHash(),
    configHash: brokerConfigHash(cfg),
    qualification: read(qualification.path),
    previousBrokerAlive: priorProcessAlive(previousOwner),
    previousLifecycle: read(
      path.join(root, "broker-lifecycle-" + previousOwner.nonce + ".json"),
    ),
    previousProcessAlive: priorProcessAlive(pointer.currentInstance),
    originalProcessAlive: priorProcessAlive(pointer.originalInstance),
    expectedProcessAlive: priorProcessAlive(approval.expectedProcess),
    pending: [
      path.join(root, "queue-state.pending.json"),
      path.join(pointer.root, "queue-state.pending.json"),
    ].some(fs.existsSync),
  };
  assertSuccessorApproval(value, approval);
  epochLineage(root, pointer);
  for (const name of ["fusion-reset.lock", "autostart.lock"])
    if (fs.existsSync(path.join(root, name)))
      fail(
        "EPOCH_SUCCESSOR_BUSY",
        "A reset/startup marker must be resolved before succession",
      );
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const intent = exists<Intent>(path.join(audit, "intent.json"));
    if (
      !intent ||
      !same(read(file), {
        kind: "dead-epoch-successor",
        nonce: intent.nonce,
        audit,
        clientId: value.clientId,
      })
    )
      fail(
        "EPOCH_SUCCESSOR_BUSY",
        "A foreign recovery transaction owns startup",
      );
  }
  return value;
}

export function assertCurrentPredecessor(
  root: string,
  authorityEntry: Reference,
  { allowPublished = false } = {},
) {
  const value = successionAuthority(root, authorityEntry),
    a = value.authority;
  const selected = read<Pointer>(
    path.join(root, "isolated-admission-epoch.json"),
  );
  const published = allowPublished && same(selected.succession, authorityEntry);
  const closedSuccessor =
    a.kind === "owner-authenticated-closed-epoch-successor";
  if (
    read<Record<string, string>>(path.join(root, "clients.json"))[
      a.clientId
    ] !== a.ownerTokenHash ||
    (!closedSuccessor && priorProcessAlive(a.previousOwner) !== false) ||
    priorProcessAlive(value.pointer.currentInstance) !== closedSuccessor ||
    (closedSuccessor &&
      !published &&
      (!same(read(path.join(root, "broker.lock")), a.previousOwner) ||
        priorProcessAlive(a.previousOwner) !== true)) ||
    priorProcessAlive(value.pointer.originalInstance) !== false ||
    priorProcessAlive(a.expectedProcess) !== true
  )
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "Original credential or process identities changed",
    );
  if (!same(selected, value.pointer) && !published)
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "The active epoch is not the preserved predecessor or its exact successor",
    );
  return value;
}

export function claimSuccessorBroker(
  root: string,
  marker: Owner,
  nonce: string,
  codeHash: string,
  cfg: unknown,
) {
  const guard = read<Guard>(path.join(root, "recovery.lock"));
  if (
    guard.kind !== "dead-epoch-successor" ||
    guard.nonce !== nonce ||
    !same(read(path.join(root, "atomic-migration.lock")), guard) ||
    path.dirname(guard.audit) !== path.join(root, "epoch-successions") ||
    fs.realpathSync(guard.audit) !== guard.audit ||
    fs.existsSync(path.join(root, "broker.lock"))
  )
    fail(
      "EPOCH_SUCCESSOR_GUARD_CHANGED",
      "Exact authenticated successor startup guard required",
    );
  const authorityEntry = reference(path.join(guard.audit, "authority.json"));
  if (
    !same(read(path.join(root, "active-epoch-succession.json")), {
      version: 1,
      authority: authorityEntry,
    })
  )
    fail(
      "EPOCH_SUCCESSOR_CLAIM_UNPROVEN",
      "Only the one active owner-authenticated successor transaction may launch",
    );
  const value = assertCurrentPredecessor(root, authorityEntry);
  const a = value.authority;
  if (
    a.nonce !== nonce ||
    a.buildHash !== codeHash ||
    a.configHash !== brokerConfigHash(cfg) ||
    a.clientId !== guard.clientId ||
    a.candidateRoot !== resolveRuntimePaths({ anchor }).installation ||
    !same(read(path.join(guard.audit, "retired-owner.json")), a.previousOwner)
  )
    fail(
      "EPOCH_SUCCESSOR_CLAIM_UNPROVEN",
      "Successor runtime/owner/config and retired supervisor must match the authority",
    );
  durable(path.join(root, "broker.lock"), marker, true);
  return { ...value, authorityEntry };
}

function releaseGuards(root: string, guard: Guard) {
  for (const name of ["atomic-migration.lock", "recovery.lock"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    if (!same(read(file), guard))
      fail(
        "EPOCH_SUCCESSOR_GUARD_CHANGED",
        "A foreign recovery guard must not be released",
      );
    exclusive(path.join(guard.audit, "released-" + name + ".json"), guard);
    fs.unlinkSync(file);
    const fd = fs.openSync(root, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export async function bootstrapSuccessor(
  client: Client,
  cfg: unknown,
  {
    approval: approvalFile,
    requestId,
    preflight = false,
    confirmOwnership = false,
  }: BootstrapOptions,
) {
  const root = client.dir,
    audit = path.join(root, "epoch-successions", hash(requestId || ""));
  const prior = exists<Intent>(path.join(audit, "intent.json"));
  if (prior) {
    const approved = reference(fs.realpathSync(approvalFile));
    if (
      prior.clientId !== client.auth.clientId ||
      prior.ownerTokenHash !== hash(client.auth.clientToken) ||
      !same(prior.approval, approved) ||
      read<Record<string, string>>(path.join(root, "clients.json"))[
        client.auth.clientId
      ] !== prior.ownerTokenHash
    )
      fail(
        "NOT_OWNER",
        "The original existing successor credentials and approval are required",
      );
    const complete = exists<Complete>(path.join(audit, "complete.json"));
    if (complete) {
      assertCurrentPredecessor(root, complete.authority, {
        allowPublished: true,
      });
      if (confirmOwnership)
        releaseGuards(root, {
          kind: "dead-epoch-successor",
          nonce: prior.nonce,
          audit,
          clientId: prior.clientId,
        });
      return complete; // Original metadata receipt only; no launch or SDK replay.
    }
    if (preflight)
      return {
        state: "pending",
        requestId,
        noReplay: true,
        sdkRequestsSent: 0,
      };
  }
  let value: Inspection | undefined;
  if (!prior) value = inspectSuccessor(client, cfg, approvalFile, requestId);
  if (preflight)
    return {
      ready: true,
      requestId,
      predecessorEpochId: value!.pointer.epochId,
      buildHash: value!.codeHash,
      expectedProcess: value!.approval.expectedProcess,
      sdkRequestsSent: 0,
    };
  if (!confirmOwnership)
    fail(
      "OWNERSHIP_REQUIRED",
      "Explicit ownership confirmation is required for successor startup",
    );
  fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
  directory(audit);
  let intent = prior;
  if (!intent) {
    intent = {
      version: 1,
      requestId,
      clientId: value!.clientId,
      ownerTokenHash: value!.ownerTokenHash,
      nonce: randomUUID(),
      approval: value!.approvalRef,
      previousOwner: value!.previousOwner,
    };
    try {
      durable(path.join(audit, "intent.json"), intent, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = read<Intent>(path.join(audit, "intent.json"));
      if (
        winner.clientId !== intent.clientId ||
        winner.ownerTokenHash !== intent.ownerTokenHash ||
        !same(winner.approval, intent.approval)
      )
        fail(
          "EPOCH_SUCCESSOR_CONFLICT",
          "A different owner or approval already owns this successor intent",
        );
      intent = winner;
    }
  }
  const guard = {
    kind: "dead-epoch-successor",
    nonce: intent.nonce,
    audit,
    clientId: intent.clientId,
  };
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    exclusive(path.join(root, name), guard);
  const authorityFile = path.join(audit, "authority.json");
  if (!fs.existsSync(authorityFile)) {
    value ||= inspectSuccessor(client, cfg, approvalFile, requestId);
    const snapshot = predecessorSnapshot(root, audit, true);
    if (!same(snapshot, value.snapshot))
      fail(
        "EPOCH_SUCCESSOR_FENCE_CHANGED",
        "Predecessor changed before authority publication",
      );
    const qualificationFile = path.join(audit, "installed-qualification.json");
    if (!fs.existsSync(qualificationFile))
      fs.copyFileSync(
        value.approval.qualification.path,
        qualificationFile,
        fs.constants.COPYFILE_EXCL,
      );
    fs.chmodSync(qualificationFile, 0o600);
    const qualification = reference(qualificationFile);
    if (qualification.sha256 !== value.approval.qualification.sha256)
      fail(
        "EPOCH_SUCCESSOR_UNQUALIFIED",
        "Installed qualification changed while preserving it",
      );
    const qualificationFd = fs.openSync(qualificationFile, "r");
    try {
      fs.fsyncSync(qualificationFd);
    } finally {
      fs.closeSync(qualificationFd);
    }
    exclusive(authorityFile, {
      version: 1,
      kind: "owner-authenticated-dead-epoch-successor",
      nonce: intent.nonce,
      requestId,
      clientId: value.clientId,
      ownerTokenHash: value.ownerTokenHash,
      configHash: value.configHash,
      predecessor: snapshot,
      previousOwner: value.previousOwner,
      previousBuildHash: value.identity.buildHash,
      previousBrokerTerminated: true,
      previousProcessTerminated: true,
      expectedProcess: value.approval.expectedProcess,
      candidateRoot: value.runtime,
      buildHash: value.codeHash,
      sourceCommit: value.approval.sourceCommit,
      qualification,
      permission: "one-proven-new-document-only",
      historicalOutcome: "unknown",
    });
  }
  const authorityEntry = reference(authorityFile);
  const activeFile = path.join(root, "active-epoch-succession.json");
  const currentActive = exists<{ version: number; authority: Reference }>(
      activeFile,
    ),
    activeValue = { version: 1, authority: authorityEntry };
  if (!same(currentActive, activeValue)) {
    if (currentActive) {
      const pointer = read<Pointer>(
        path.join(root, "isolated-admission-epoch.json"),
      );
      if (!same(pointer.succession, currentActive.authority))
        fail(
          "EPOCH_SUCCESSOR_PENDING",
          "A different unconsumed successor authority remains fenced",
        );
      exclusive(
        path.join(audit, "previous-active-succession.json"),
        currentActive,
      );
      const before = fileHash(activeFile).sha256;
      assertCurrentPredecessor(root, authorityEntry);
      if (fileHash(activeFile).sha256 !== before)
        fail(
          "EPOCH_SUCCESSOR_FENCE_CHANGED",
          "Active succession changed before publication",
        );
      durable(activeFile, activeValue);
    } else durable(activeFile, activeValue, true);
  }
  const checked = assertCurrentPredecessor(root, authorityEntry);
  const brokerFile = path.join(root, "broker.lock"),
    retiredFile = path.join(audit, "retired-owner.json");
  if (
    fs.existsSync(brokerFile) &&
    same(read(brokerFile), checked.authority.previousOwner)
  ) {
    if (priorProcessAlive(checked.authority.previousOwner) !== false)
      fail("BROKER_ALIVE", "Original supervisor must be dead");
    exclusive(retiredFile, checked.authority.previousOwner);
    if (!same(read(brokerFile), checked.authority.previousOwner))
      fail("LOCK_CHANGED", "Original broker marker changed");
    fs.unlinkSync(brokerFile);
    const fd = fs.openSync(root, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } else if (!fs.existsSync(retiredFile))
    fail(
      "EPOCH_SUCCESSOR_CLAIM_UNPROVEN",
      "The original owner was not retired by this transaction",
    );
  const launchFile = path.join(audit, "launch-intent.json");
  if (
    fs.existsSync(launchFile) &&
    !same(read(launchFile), { nonce: intent.nonce, authority: authorityEntry })
  )
    fail(
      "EPOCH_SUCCESSOR_CONFLICT",
      "The preserved worker launch intent differs from its exact authority",
    );
  if (!fs.existsSync(launchFile)) {
    let won = false;
    try {
      durable(
        launchFile,
        { nonce: intent.nonce, authority: authorityEntry },
        true,
      );
      won = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (won) {
      const stdout = fs.openSync(
        path.join(audit, "worker.stdout.log"),
        "wx",
        0o600,
      );
      const stderr = fs.openSync(
        path.join(audit, "worker.stderr.log"),
        "wx",
        0o600,
      );
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const key of [
          "PATH",
          "HOME",
          "USER",
          "LOGNAME",
          "LANG",
          "LC_ALL",
          "XDG_STATE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "FMCAD_CONFIG",
          "FMCAD_PYTHON",
          "WSL_DISTRO_NAME",
          "TMPDIR",
          "SYSTEMROOT",
        ])
          if (process.env[key] !== undefined) env[key] = process.env[key];
        const child = spawn(
          process.execPath,
          [
            path.join(
              checked.authority.candidateRoot,
              "src/queue-epoch-successor-worker.js",
            ),
          ],
          { cwd: root, detached: true, stdio: ["pipe", stdout, stderr], env },
        );
        child.on("error", (error) =>
          exclusive(path.join(audit, "launch-error.json"), {
            code: (error as NodeJS.ErrnoException).code || "SPAWN_FAILED",
          }),
        );
        child.stdin!.on("error", () => {});
        child.stdin!.end(
          JSON.stringify({ cfg, dir: root, audit, nonce: intent.nonce }),
        );
        child.unref();
      } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
    }
  }
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ready = exists<Ready>(path.join(audit, "worker-ready.json"));
    if (ready) {
      if (
        ready.nonce !== intent.nonce ||
        ready.buildHash !== checked.authority.buildHash ||
        priorProcessAlive(ready.owner) !== true ||
        !same(read(brokerFile), ready.owner) ||
        ready.sdkRequestsSent !== 0
      )
        fail(
          "EPOCH_SUCCESSOR_HANDOFF_UNPROVEN",
          "Replacement metadata-only owner did not match its durable ready receipt",
        );
      assertCurrentPredecessor(root, authorityEntry);
      const complete: Complete = {
        version: 1,
        kind: "dead-epoch-successor-metadata-ready",
        requestId,
        authority: authorityEntry,
        owner: ready.owner,
        buildHash: ready.buildHash,
        sourceCommit: checked.authority.sourceCommit,
        sdkRequestsSent: 0,
        modelingAdmission: "blocked-until-current-facts-and-proven-new-scratch",
        historicalOutcome: "unknown",
      };
      exclusive(path.join(audit, "complete.json"), complete);
      releaseGuards(root, guard);
      return complete;
    }
    if (
      fs.existsSync(path.join(audit, "worker-error.json")) ||
      fs.existsSync(path.join(audit, "launch-error.json"))
    )
      fail(
        "EPOCH_SUCCESSOR_START_FAILED",
        "Successor startup failed; inspect the existing journal, never launch a duplicate",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    state: "pending",
    requestId,
    authority: authorityEntry,
    sdkRequestsSent: 0,
    noReplay: true,
    reason:
      "Observe this existing successor journal; no second worker or SDK request is authorized",
  };
}

export async function observeSuccessor(
  client: ObserverClient,
  input: ObservationInput,
  codeHash: string,
) {
  const status = await client.call("queue-summary");
  if (
    status.features?.deadEpochSuccessor !== true ||
    status.deadEpochSuccessor?.observationRequestId !== input.requestId
  )
    fail(
      "EPOCH_SUCCESSOR_REQUIRED",
      "The exact existing successor observation authority is required",
    );
  if (status.control?.buildHash !== codeHash)
    fail(
      "BUILD_CHANGED",
      "Successor CLI and broker must use the same qualified build",
    );
  const { instanceId, generation, contextEpoch } = status.control!;
  return client.call("observe-successor", {
    ...input,
    control: { instanceId, generation, contextEpoch, buildHash: codeHash },
  });
}
