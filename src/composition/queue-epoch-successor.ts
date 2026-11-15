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
  SdkProcessDeathBindings,
  NormalProcessDeathBindings,
  SdkProcessDeathProof,
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
const {
  predecessorSnapshot,
  reference,
  epochLineage,
  successorBackendIdentity,
  successorEpochIdentity,
} = load("./queue-epoch-lineage") as typeof import("../queue-epoch-lineage");
const { successionAuthority } = load("./queue-epoch-lineage") as {
  successionAuthority(root: string, entry: Reference): Checked;
};
const { openIsolatedEpoch } = load("./queue-isolated-epoch") as {
  openIsolatedEpoch(
    root: string,
    options: { recover: false },
  ): ReturnType<typeof import("../queue-isolated-epoch").openIsolatedEpoch> & {
    epoch: Pointer | null;
  };
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
const sdkProcessAbsentErrorId =
  "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand";
function priorRetirementLink(value: {
  priorAbortedSuccessor?: Reference;
  priorRetiredSuccessor?: Reference;
}) {
  if (value.priorAbortedSuccessor && value.priorRetiredSuccessor)
    fail(
      "EPOCH_SUCCESSOR_ABORT_INVALID",
      "An approval cannot select two prior retirement chains",
    );
  return value.priorRetiredSuccessor || value.priorAbortedSuccessor;
}

export function verifySdkProcessDeathProof(
  file: string,
  expectedProcess: Process,
  bindings: SdkProcessDeathBindings | NormalProcessDeathBindings,
): Reference {
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    !fs.lstatSync(file).isFile()
  )
    fail(
      "EPOCH_SUCCESSOR_ABORT_INVALID",
      "Canonical SDK process-death proof file required",
    );
  for (const entry of Object.values(bindings))
    if (
      !path.isAbsolute(entry.path) ||
      fs.realpathSync(entry.path) !== entry.path ||
      !fs.lstatSync(entry.path).isFile() ||
      !same(reference(entry.path), entry)
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "SDK process-death proof binding changed",
      );
  const proof = read<SdkProcessDeathProof>(file),
    beforeAt = Date.parse(proof.before?.observedAtUtc || ""),
    exitAt = Date.parse(proof.handleBoundExit?.observedAtUtc || ""),
    afterAt = Date.parse(proof.after?.observedAtUtc || "");
  if (
    proof.version !== 1 ||
    proof.kind !== "sdk-process-death-proof-v1" ||
    !same(proof.expectedProcess, expectedProcess) ||
    !same(proof.bindings, bindings) ||
    proof.before?.state !== "present" ||
    proof.before.pid !== expectedProcess.pid ||
    proof.before.birth !== expectedProcess.birth ||
    typeof proof.before.version !== "string" ||
    !proof.before.version ||
    !path.win32.isAbsolute(proof.before.exe) ||
    path.win32.basename(proof.before.exe).toLowerCase() !== "fusion360.exe" ||
    !/^[1-9]\d*$/.test(proof.before.windowHandle) ||
    !Number.isFinite(beforeAt) ||
    proof.handleBoundExit?.pid !== expectedProcess.pid ||
    proof.handleBoundExit.birth !== expectedProcess.birth ||
    proof.handleBoundExit.hasExited !== true ||
    !Number.isFinite(exitAt) ||
    exitAt < beforeAt ||
    proof.after?.state !== "absent" ||
    proof.after.pid !== expectedProcess.pid ||
    proof.after.errorId !== sdkProcessAbsentErrorId ||
    !Number.isFinite(afterAt) ||
    afterAt < exitAt ||
    afterAt > Date.now()
  )
    fail(
      "EPOCH_SUCCESSOR_ABORT_INVALID",
      "Only exact historical SDK birth, handle-bound exit, and fresh absent-PID proof permit withdrawal",
    );
  return reference(file);
}

/** Retirement permits a NEW owner approval, never hot replacement of a request. */
function assertPriorAbortedSuccessor(
  root: string,
  pointerHash: string,
  owner: Owner,
  clientId: string,
  tokenHash: string,
  link?: Reference,
  nextProcess?: Process,
): void {
  const journal = path.join(root, "epoch-successions");
  const candidates = new Map<
    string,
    { entry: Reference; prior?: Reference; retiredProcess?: Process }
  >();
  for (const name of fs.readdirSync(journal)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const audit = path.join(journal, name),
      file = path.join(audit, "abort-unstarted", "complete.json");
    if (!fs.existsSync(file)) {
      if (
        fs.existsSync(path.join(audit, "worker-ready.json")) &&
        fs.existsSync(path.dirname(file))
      )
        fail(
          "EPOCH_SUCCESSOR_ABORT_INVALID",
          "Prior metadata retirement is incomplete",
        );
      continue;
    }
    const receipt = read<{
      kind: string;
      reason?: string;
      status: string;
      requestId: string;
      clientId: string;
      sdkRequestsSent: number;
      historicalOutcome: string;
      nativeOutcome?: string;
      facts: Reference[];
      approval: Reference;
      processDeathProof?: Reference;
      authority?: Reference;
      owner?: Owner;
      buildHash?: string;
      configHash?: string;
      sourceCommit?: string;
      expectedProcess?: Process;
    }>(file);
    if (!fs.existsSync(path.join(audit, "worker-ready.json"))) continue;
    const sdkZeroAbort =
        receipt.kind === "dead-epoch-successor-aborted-before-sdk" &&
        receipt.reason === "metadata-ready-observation-rejected-before-sdk" &&
        receipt.status === "aborted" &&
        receipt.sdkRequestsSent === 0,
      sdkUnknownWithdrawal =
        receipt.kind === "dead-epoch-successor-withdrawn-after-sdk-unknown" &&
        receipt.reason === "sdk-process-exited-after-unknown-transport" &&
        receipt.status === "withdrawn" &&
        receipt.sdkRequestsSent === 1 &&
        receipt.nativeOutcome === "unknown" &&
        !!receipt.processDeathProof &&
        !!receipt.authority &&
        !!receipt.owner &&
        !!receipt.buildHash &&
        !!receipt.configHash &&
        !!receipt.sourceCommit &&
        !!receipt.expectedProcess;
    if (
      (!sdkZeroAbort && !sdkUnknownWithdrawal) ||
      receipt.historicalOutcome !== "unknown" ||
      hash(receipt.requestId) !== name ||
      !Array.isArray(receipt.facts) ||
      receipt.facts.some((ref) => !same(reference(ref.path), ref))
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "Prior metadata retirement evidence changed",
      );
    const authorityFile = path.join(audit, "authority.json");
    if (!receipt.facts.some((ref) => ref.path === authorityFile))
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "Prior retirement omits its original authority",
      );
    const authority = read<Checked["authority"]>(authorityFile);
    if (authority.predecessor.pointer.sha256 !== pointerHash) continue;
    if (
      receipt.clientId !== clientId ||
      authority.clientId !== clientId ||
      authority.ownerTokenHash !== tokenHash ||
      !same(authority.previousOwner, owner) ||
      !same(reference(receipt.approval.path), receipt.approval)
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "Prior retirement does not bind this predecessor owner",
      );
    const intent = read<{
      approval: Reference;
      facts: Reference[];
      kind?: string;
      reason?: string;
      clientId?: string;
      authority?: Reference;
      owner?: Owner;
      buildHash?: string;
      configHash?: string;
      sourceCommit?: string;
      expectedProcess?: Process;
      processDeathProof?: Reference;
      sdkRequestsSent?: number;
      nativeOutcome?: string;
      historicalOutcome?: string;
    }>(path.join(audit, "abort-unstarted", "intent.json"));
    if (
      !same(intent.approval, receipt.approval) ||
      !same(intent.facts, receipt.facts)
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "Original retirement intent and receipt differ",
      );
    let retiredProcess: Process | undefined;
    if (sdkUnknownWithdrawal) {
      const authorityEntry = reference(authorityFile),
        ready = read<Ready>(path.join(audit, "worker-ready.json")),
        metadata = read<Complete>(path.join(audit, "complete.json")),
        observation = path.join(audit, "dead-epoch-current-observation"),
        processDeathProof = receipt.processDeathProof!;
      if (
        !same(receipt.authority, authorityEntry) ||
        !same(receipt.owner, ready.owner) ||
        !same(metadata.authority, authorityEntry) ||
        !same(metadata.owner, ready.owner) ||
        metadata.sdkRequestsSent !== 0 ||
        metadata.historicalOutcome !== "unknown" ||
        receipt.buildHash !== authority.buildHash ||
        receipt.configHash !== authority.configHash ||
        receipt.sourceCommit !== authority.sourceCommit ||
        !same(receipt.expectedProcess, authority.expectedProcess) ||
        intent.kind !== "withdraw-sdk-unknown-dead-successor" ||
        intent.reason !== "sdk-process-exited-after-unknown-transport" ||
        intent.clientId !== clientId ||
        !same(intent.authority, authorityEntry) ||
        !same(intent.owner, ready.owner) ||
        intent.buildHash !== authority.buildHash ||
        intent.configHash !== authority.configHash ||
        intent.sourceCommit !== authority.sourceCommit ||
        !same(intent.expectedProcess, authority.expectedProcess) ||
        intent.sdkRequestsSent !== 1 ||
        intent.nativeOutcome !== "unknown" ||
        intent.historicalOutcome !== "unknown" ||
        !same(intent.processDeathProof, processDeathProof)
      )
        fail(
          "EPOCH_SUCCESSOR_ABORT_INVALID",
          "SDK1 withdrawal receipt must retain the original owner, build, config and process lineage",
        );
      const proof = verifySdkProcessDeathProof(
        processDeathProof.path,
        authority.expectedProcess,
        {
          authority: reference(authorityFile),
          observationIntent: reference(path.join(observation, "intent.json")),
          observationStart: reference(path.join(observation, "start.json")),
          observationWire: reference(path.join(observation, "wire.json")),
          observationResult: reference(path.join(observation, "result.json")),
        },
      );
      if (
        !same(proof, processDeathProof) ||
        !receipt.facts.some((ref) => same(ref, processDeathProof))
      )
        fail(
          "EPOCH_SUCCESSOR_ABORT_INVALID",
          "SDK1 withdrawal must retain its exact process-death proof",
        );
      retiredProcess = authority.expectedProcess;
    }
    candidates.set(file, {
      entry: reference(file),
      ...(priorRetirementLink(authority)
        ? { prior: priorRetirementLink(authority) }
        : {}),
      ...(retiredProcess ? { retiredProcess } : {}),
    });
  }
  const seen = new Set<string>();
  for (let current = link; current;) {
    const candidate = candidates.get(current.path);
    if (
      seen.size >= 32 ||
      seen.has(current.path) ||
      !candidate ||
      !same(candidate.entry, current)
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "Exact acyclic owner-approved retirement reference required",
      );
    if (
      candidate.retiredProcess &&
      nextProcess &&
      (candidate.retiredProcess.pid === nextProcess.pid ||
        candidate.retiredProcess.birth === nextProcess.birth)
    )
      fail(
        "EPOCH_SUCCESSOR_ABORT_INVALID",
        "A new successor cannot reuse a retired SDK PID or birth identity",
      );
    seen.add(current.path);
    current = candidate.prior;
  }
  if (seen.size !== candidates.size)
    fail(
      "EPOCH_SUCCESSOR_ABORT_REQUIRED",
      "A new successor approval must explicitly link every prior terminal retirement",
    );
}
export function assertSuccessorApproval(value: Inspection, approval: Approval) {
  if (approval.priorNormalCurrentFactsRetry && !approval.normalCurrentStore)
    fail("NORMAL_SUCCESSOR_UNPROVEN", "A fresh normal read attempt cannot authorize isolated or atomic work");
  let effectiveIdentity = value.identity;
  if (value.backendTransition) {
    if (
      !approval.physicalBackendHead ||
      approval.physicalBackendHead.path !==
        path.join(value.root, "physical-backend-head.json") ||
      approval.physicalBackendHead.sha256 !==
        value.backendTransition.head.sha256 ||
      !same(
        reference(approval.physicalBackendHead.path),
        approval.physicalBackendHead,
      )
    )
      fail(
        "EPOCH_SUCCESSOR_FENCE_CHANGED",
        "Exact owner-approved physical backend head required",
      );
    effectiveIdentity = successorBackendIdentity(
      value.root,
      value.pointer,
      value.snapshot,
      value.backendTransition,
      value.previousOwner,
      value.configHash,
    );
  } else if (approval.physicalBackendHead) {
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "Original root configuration or explicit backend transition proof required",
    );
  } else if (value.rootIdentity.configHash !== value.configHash) {
    effectiveIdentity = successorEpochIdentity(
      value.root,
      value.pointer,
      value.snapshot,
    );
  }
  if (
    approval.version !== 1 ||
    approval.purpose !== (approval.normalCurrentStore ? "dead-normal-currentstore-successor-v1" : "dead-isolated-epoch-successor-v1") ||
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
    value.previousLifecycle.buildHash !== effectiveIdentity.buildHash ||
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
    effectiveIdentity.configHash !== value.configHash ||
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
    || (approval.normalCurrentStore && q.normalCurrentStoreSuccessorQualified !== true)
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
  if (approval.normalCurrentStore && state.admissionMode !== "normal-multidocument")
    fail("NORMAL_SUCCESSOR_UNPROVEN", "Only a verified closed normal-admission currentstore may use the normal successor adapter");
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
  assertPriorAbortedSuccessor(
    root,
    approval.pointerHash,
    previousOwner,
    client.auth.clientId,
    hash(client.auth.clientToken),
    priorRetirementLink(approval),
    approval.expectedProcess,
  );
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
  const effectiveBackend = (
    load(
      "./queue-backend-transition",
    ) as typeof import("../queue-backend-transition")
  ).resolveBackendHead(root, () => state).current;
  if (effectiveBackend) {
    value.backendTransition = {
      head: reference(
        path.join(
          root,
          "physical-backend-transitions",
          effectiveBackend.head.requestId,
          "transition.json",
        ),
      ),
      lifecycle: reference(
        path.join(root, "broker-lifecycle-" + previousOwner.nonce + ".json"),
      ),
    };
  }
  assertSuccessorApproval(value, approval);
  if (approval.normalCurrentStore)
    (load("./dist/composition/queue-normal-cold-successor") as typeof import("./queue-normal-cold-successor")).inspectNormalCurrentStore(root, approval, pointer);
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
  assertPriorAbortedSuccessor(
    root,
    a.predecessor.pointer.sha256,
    a.previousOwner,
    a.clientId,
    a.ownerTokenHash,
    priorRetirementLink(a),
    a.expectedProcess,
  );
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
  if (a["normalCurrentStore"])
    (load("./dist/composition/queue-normal-cold-successor") as typeof import("./queue-normal-cold-successor")).assertNormalCurrentPredecessor(root, value);
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
    if (fs.existsSync(path.join(audit, "abort-unstarted", "intent.json")))
      fail(
        "EPOCH_SUCCESSOR_ABORTED",
        "This startup was aborted or its metadata abort is pending; inspect the original abort journal",
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
      ...(value.approval.normalCurrentStore ? { normalCurrentStore: value.approval.normalCurrentStore } : {}),
      ...(value.approval.priorNormalCurrentFactsRetry ? { priorNormalCurrentFactsRetry: value.approval.priorNormalCurrentFactsRetry } : {}),
      ...(value.approval.priorRetiredSuccessor
        ? { priorRetiredSuccessor: value.approval.priorRetiredSuccessor }
        : value.approval.priorAbortedSuccessor
          ? { priorAbortedSuccessor: value.approval.priorAbortedSuccessor }
          : {}),
      ...(value.backendTransition
        ? { backendTransition: value.backendTransition }
        : {}),
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
