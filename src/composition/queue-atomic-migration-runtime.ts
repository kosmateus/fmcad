import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
} from "@fmcad/core";
import type {
  MigrationPorts,
  MigrationBinding,
} from "../../packages/core/src/application/cad/owner-migration";
import type { RecoveryWireInput } from "../../packages/node-adapters/src/execution/recovery-python";
import type { AuditWire } from "../../packages/node-adapters/src/execution/recovery-audit";
import type { AtomicObservationInput } from "../../packages/node-adapters/src/execution/atomic-observation";
import type { ProcessIdentity } from "../queue-instance-liveness";
import type {
  HolderScope,
  Owner,
  ProcessOwner,
  Job,
  Snapshot,
  Upgrade,
  Approval,
  QualifiedApproval,
  Intent,
  Guard,
  Backup,
  BackupManifest,
  Abi,
  Evidence,
  PreparedObservation,
  RpcRecord,
  TransportReceipt,
  Qualification,
  Descriptor,
  RuntimeClient,
  RuntimeStages,
} from "./queue-atomic-migration-types";
const load = createRequire(
  path.join(__dirname, "../../queue-atomic-migration-runtime.js"),
);

const { queueDirectory } = load(
  "./queue-connection",
) as typeof import("../entrypoints/queue-connection");
const {
  readJson: boundedJson,
  durable,
  hash,
  buildHash,
  brokerConfigHash,
  priorProcessAlive,
  sameInstance,
} = load("./queue-instance") as {
  readJson(file: string, maximum: number): unknown;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  hash(value: string): string;
  buildHash(root?: string): string;
  brokerConfigHash(cfg: unknown): string;
  priorProcessAlive(owner: Pick<Owner, "pid" | "birth">): boolean | null;
  sameInstance(a: ProcessIdentity, b: ProcessIdentity): boolean;
};
const { createMigrator, assertHeld } = load("./queue-atomic-migration") as {
  createMigrator(
    ports: MigrationPorts,
  ): ReturnType<
    typeof import("../../packages/core/src/application/cad/owner-migration").createMigrator
  >;
  assertHeld(
    snapshot: Snapshot,
    clientId: string,
    scope: HolderScope,
    closed?: boolean,
    upgrade?: Upgrade | null,
  ): void;
};
const { directory, fileHash, inventory, exclusive, backupTree, verifyTree } =
  load(
    "./queue-atomic-migration-files",
  ) as typeof import("../../packages/node-adapters/src/persistence/migration-files");
const {
  fastenersScope,
  prepareAtomicHolderObservation,
  readCurrentAtomicObservationReport,
  atomicInvocationProjection,
  sourceEnvelopeStillCurrent,
  bindAtomicRuntimeAbi,
} = load("./atomic-workflow-observation") as {
  fastenersScope: HolderScope;
  prepareAtomicHolderObservation(
    job: Job,
    request: unknown,
    options: unknown,
  ): Promise<PreparedObservation>;
  readCurrentAtomicObservationReport(
    report: string,
  ): Promise<{ fingerprint: string }>;
  atomicInvocationProjection(
    job: Job,
  ): { invocation: unknown; sourceEnvelope: unknown } | null;
  sourceEnvelopeStillCurrent(value: unknown): boolean;
  bindAtomicRuntimeAbi(
    prepared: PreparedObservation,
    abi: Abi,
  ): PreparedObservation & { atomicRuntimeAbi: Abi };
};
const {
  buildAtomicRuntimeAbi,
  atomicRuntimeAbiStillCurrent,
  escrowAtomicGeneratorDependencies,
} = load("./atomic-runtime-abi") as {
  buildAtomicRuntimeAbi(
    job: Job,
    prepared: PreparedObservation,
    records: RpcRecord[],
    options: { dir: string },
  ): Abi;
  atomicRuntimeAbiStillCurrent(abi: Abi): boolean;
  escrowAtomicGeneratorDependencies(
    root: string,
    audit: string,
  ): BackupManifest["generatorDependencies"];
};
const {
  auditUpgradeApproval,
  assertAuditUpgradeSnapshot,
  auditUpgradeStillCurrent,
} = load("./queue-atomic-audit-upgrade") as {
  auditUpgradeApproval(approval: Approval, dir: string): Upgrade | null;
  assertAuditUpgradeSnapshot(
    upgrade: Upgrade,
    snapshot: Pick<Snapshot, "state" | "owner" | "identity">,
    clientId: string,
  ): void;
  auditUpgradeStillCurrent(upgrade: Upgrade): boolean;
};
const { requireRecoveryProcesses, processLossAudit, processTuple } = load(
  "./queue-instance-liveness",
) as typeof import("../queue-instance-liveness");
type ObservationWire = ReturnType<
  typeof import("../../packages/node-adapters/src/execution/atomic-observation").prepareAtomicObservationWire
>;
type PreparedWire = AuditWire | ObservationWire;
type StopProof = unknown;
interface EpochPauseInput {
  initial: Snapshot;
  current: Snapshot;
  intent: Intent;
  upgrade: Upgrade;
  clientId: string;
  dir: string;
}
interface EpochPausePort {
  inheritedAuditResponsePause(input: EpochPauseInput): unknown;
  inheritedEpochPause(input: EpochPauseInput): unknown;
}
interface QueueConstructor {
  new (options: {
    snapshot: Snapshot["state"];
    now: () => number;
    newId: () => string;
    hash: (value: string) => string;
    commit(next: unknown): void;
  }): unknown;
}
const epochApi = (): EpochPausePort =>
  load("./queue-epoch-prerequisite") as EpochPausePort;
const stopApi = (): {
  stopOwnerPreflight(): StopProof;
  stopOwner(owner: Owner, audit: string): void;
} =>
  load("./queue-atomic-migration-stop") as {
    stopOwnerPreflight(): StopProof;
    stopOwner(owner: Owner, audit: string): void;
  };
const originUnits = (artifact: PreparedPythonArtifact) =>
  (artifact.context as unknown as { origin: PythonArtifactManifest }).origin
    .units;
const fail: (code: string, message: string) => never = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = new Set(["succeeded", "failed"]);
const readJson = <T>(file: string): T =>
  boundedJson(file, 256 * 1024 * 1024) as T;
const { hash: invocationHash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../../packages/core/src/application/cad/json");

function verifyOriginalInput(job: Job, evidence: Evidence) {
  const original = atomicInvocationProjection(job);
  if (
    !original ||
    invocationHash(original.invocation) !== evidence.originalInvocationHash ||
    !same(original.sourceEnvelope, evidence.sourceEnvelope) ||
    !sourceEnvelopeStillCurrent(evidence.sourceEnvelope)
  )
    fail(
      "WORKFLOW_INPUT_CHANGED",
      "Original accepted atomic input/worker envelope changed during migration",
    );
}

export function checkerContentFingerprint(runtimeRoot: string) {
  const engine = load.resolve("basedpyright/package.json", {
    paths: [path.join(runtimeRoot, "src")],
  });
  // Admission's own fingerprint is deliberately path/context-sensitive. This
  // additional content-only inventory proves that relocation cannot silently
  // select a different installed checker. No certificate is reused across roots.
  return inventory(path.dirname(engine)).sha256;
}

function json<T>(file: string): T | null {
  try {
    return readJson<T>(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function requireDead(owner: ProcessOwner) {
  if (priorProcessAlive(owner) !== false)
    fail(
      "MIGRATION_OWNER_LIVE",
      "Original PID/birth is still alive or cannot be established",
    );
}

export function assertMigrationAdmission(dir: string, action: string) {
  if (
    fs.existsSync(path.join(dir, "atomic-migration.lock")) &&
    [
      "submit",
      "observe-atomic",
      "audit-atomic",
      "capture-audit-facts",
      "authorize-isolated-scratch",
      "create-isolated-scratch",
      "close-isolated-scratch",
      "grant-isolated-scratch",
      "backend",
      "pause",
      "drain",
      "resume",
      "reconcile",
      "stop",
      "console-inspect",
      "console-reload",
      "console-restart",
      "console-stop",
    ].includes(action)
  )
    fail(
      "MIGRATION_IN_PROGRESS",
      "Owner handoff is not publicly released; no job or SDK turn may start",
    );
}

function verifyEscrowBackup(backup: Backup, audit: string) {
  if (
    !backup ||
    backup.audit !== audit ||
    backup.manifest !== "backup-manifest.json"
  )
    fail("BACKUP_MISMATCH", "Migration has no exact immutable backup manifest");
  const file = path.join(audit, backup.manifest);
  if (fileHash(file).sha256 !== backup.sha256)
    fail("BACKUP_MISMATCH", "Immutable backup manifest digest changed");
  const manifest = readJson<BackupManifest>(file);
  if (
    manifest.sourceStateHash !== backup.sourceStateHash ||
    hash(
      JSON.stringify(
        readJson<Snapshot["state"]>(
          path.join(audit, "queue-backup", "queue-state.json"),
        ),
      ),
    ) !== backup.sourceStateHash
  )
    fail(
      "BACKUP_MISMATCH",
      "Escrow queue snapshot does not match the bound original state digest",
    );
  for (const name of ["queue", "report", "runtime"] as const)
    verifyTree(path.join(audit, name + "-backup"), manifest[name]);
  for (const [name, files] of Object.entries(
    manifest.generatorDependencies || {},
  )) {
    if (name !== "jsonc-parser")
      fail(
        "BACKUP_MISMATCH",
        "Unexpected original-generator dependency in escrow",
      );
    verifyTree(path.join(audit, "node_modules", name), files);
  }
  return manifest;
}

export function retireDeadMigrationWorker(
  dir: string,
  audit: string,
  intent: Intent,
) {
  const workerFile = path.join(audit, "worker.json"),
    worker = readJson<ProcessOwner>(workerFile);
  requireDead(worker);
  const paused = readJson<Snapshot>(path.join(audit, "paused.json"));
  if (
    !same(
      readJson<Snapshot["state"]>(path.join(dir, "queue-state.json")),
      paused.state,
    ) ||
    !same(
      readJson<Snapshot["identity"]>(path.join(dir, "instance.json")),
      paused.identity,
    ) ||
    readJson<Guard>(path.join(dir, "recovery.lock")).nonce !== intent.nonce ||
    readJson<Guard>(path.join(dir, "atomic-migration.lock")).nonce !==
      intent.nonce
  )
    fail(
      "MIGRATION_FENCE_CHANGED",
      "A dead migration worker may be replaced only with the exact still-closed escrow",
    );
  const current = json<Owner>(path.join(dir, "broker.lock"));
  if (
    !current &&
    !same(
      json<Owner>(path.join(audit, "original-broker.lock.json")),
      paused.owner,
    )
  )
    fail(
      "MIGRATION_LOCK_CHANGED",
      "Missing broker marker has no prior migration archive proof",
    );
  if (current && !same(current, paused.owner)) {
    if (current.pid !== worker.pid || current.birth !== worker.birth)
      fail("MIGRATION_LOCK_CHANGED", "Another process owns the broker marker");
    requireDead(current);
    exclusive(
      path.join(audit, "retired-owner-" + hash(current.nonce) + ".json"),
      {
        owner: current,
        worker,
        migrationNonce: intent.nonce,
        buildHash: intent.approved.buildHash,
        stateHash: hash(JSON.stringify(paused.state)),
      },
    );
  }
  const archive = path.join(
    audit,
    "worker-attempts",
    worker.pid + "-" + hash(worker.birth).slice(0, 16),
  );
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  // The process claim moves LAST, so a crash can never expose a fresh claim
  // while a stale ready/error record still occupies its publication path.
  for (const name of [
    "worker-ready.json",
    "worker-error.json",
    "worker.json",
  ]) {
    const file = path.join(audit, name);
    if (fs.existsSync(file)) {
      const preserved = path.join(archive, name);
      if (fs.existsSync(preserved))
        fail(
          "MIGRATION_RECEIPT_CONFLICT",
          "Prior worker evidence must never be overwritten",
        );
      fs.renameSync(file, preserved);
      for (const current of [archive, audit]) {
        const fd = fs.openSync(current, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }
  for (const current of [archive, path.dirname(archive), audit]) {
    const fd = fs.openSync(current, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function validateOriginalEvidence(
  dir: string,
  snapshot: Snapshot,
  upgrade: Upgrade | null = null,
) {
  const job = snapshot.state.jobs[fastenersScope.jobId]!,
    root = path.join(dir, "jobs", job.id);
  const worker = json<ProcessOwner>(path.join(root, "worker-identity.json"));
  if (worker) requireDead(worker);
  else if (fs.existsSync(path.join(root, "worker-start.json")))
    fail(
      "WORKER_IDENTITY_UNAVAILABLE",
      "Original worker birth proof is missing",
    );
  requireRecoveryProcesses(snapshot.identity.instance, upgrade);
  const adapter = json<{ jobId: string; buildHash: string; unknown?: boolean }>(
    path.join(root, "adapter-outcome.json"),
  );
  if (
    adapter &&
    (adapter.jobId !== job.id ||
      adapter.buildHash !== snapshot.identity.buildHash ||
      adapter.unknown)
  )
    fail(
      "ADAPTER_RECONCILIATION_REQUIRED",
      "Original adapter outcome is not settled and bound to this build",
    );
  const names = fs
    .readdirSync(root)
    .filter((n) => /^rpc-.*\.json$/.test(n) && n !== "rpc-result.json")
    .sort();
  if (names.length !== job.dispatch.rpcCount)
    fail(
      "RECEIPT_UNAVAILABLE",
      "Original dispatch journal count is incomplete",
    );
  const rpcRecords = names.map((n) => readJson<RpcRecord>(path.join(root, n)));
  const records = [...rpcRecords];
  for (const stage of ["preflight", "postflight"]) {
    const record = json<RpcRecord>(path.join(root, stage + "-start.json"));
    if (record) records.push(record);
  }
  for (const record of records) {
    const binding = record.binding,
      receipt = record.receipt && readJson<TransportReceipt>(record.receipt);
    if (
      !binding ||
      typeof record.receipt !== "string" ||
      path.dirname(record.receipt) !== root ||
      binding.jobId !== job.id ||
      binding.buildHash !== snapshot.identity.buildHash ||
      !sameInstance(record.instance, snapshot.identity.instance) ||
      !receipt ||
      receipt.terminal !== true ||
      !terminal.has(receipt.outcome) ||
      !sameInstance(receipt.instance, record.instance) ||
      !["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"].every(
        (k) => receipt[k] === binding[k],
      )
    )
      fail(
        "RECEIPT_MISMATCH",
        "A physical turn lacks its exact terminal transport receipt; no stop allowed",
      );
  }
  return {
    receipts: records.map((record) => ({
      receipt: record.receipt,
      ...fileHash(record.receipt),
    })),
    rpcRecords,
  };
}

export async function approvedCandidate(
  file: string,
  prepareFinal?: (approval: Approval) => Promise<PreparedWire>,
) {
  const approval = readJson<Approval>(file);
  if (
    approval.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(approval.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(approval.buildHash || "") ||
    !/^[a-f0-9]{64}$/.test(approval.admissionModuleSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(approval.checkerFingerprint || "") ||
    !path.isAbsolute(approval.candidateRoot || "") ||
    !path.isAbsolute(approval.installRoot || "") ||
    approval.candidateRoot === approval.installRoot
  )
    fail(
      "INVALID_MIGRATION_APPROVAL",
      "Approved source, build, admission composition and distinct absolute runtime roots are required",
    );
  for (const root of [
    approval.candidateRoot,
    fs.existsSync(approval.installRoot)
      ? approval.installRoot
      : path.dirname(approval.installRoot),
  ]) {
    directory(root);
    if (fs.realpathSync(root) !== root)
      fail("UNSAFE_MIGRATION_PATH", "Runtime roots must not traverse symlinks");
  }
  if (
    buildHash(approval.candidateRoot) !== approval.buildHash ||
    readJson<{ fingerprint: string }>(
      path.join(approval.candidateRoot, "runtime-build.json"),
    ).fingerprint !== approval.buildHash
  )
    fail(
      "BUILD_CHANGED",
      "Candidate runtime bytes do not match the approved build manifest",
    );
  const qualification = approval.qualification;
  if (
    !qualification ||
    !path.isAbsolute(qualification.path || "") ||
    !/^[a-f0-9]{64}$/.test(qualification.sha256 || "") ||
    fileHash(qualification.path).sha256 !== qualification.sha256
  )
    fail(
      "QUALIFICATION_UNAVAILABLE",
      "Approved qualification receipt is missing or changed",
    );
  const q = readJson<Qualification>(qualification.path);
  if (
    q.sourceCommit !== approval.sourceCommit ||
    q.buildHash !== approval.buildHash ||
    q.productionAdmission !== true ||
    q.passed !== true ||
    ((approval.purpose?.startsWith("atomic-recovery-") ||
      processLossAudit(approval)) &&
      q.auditUpgradeQualified !== true) ||
    (processLossAudit(approval) && q.processLossAuditQualified !== true) ||
    (approval.purpose === "isolated-scratch-epoch-upgrade-v1" &&
      q.isolatedEpochQualified !== true) ||
    (approval.purpose === "atomic-audit-facts-recovery-upgrade-v1" &&
      (q.auditFactsCaptureQualified !== true ||
        q.isolatedEpochQualified !== true))
  )
    fail(
      "QUALIFICATION_UNAVAILABLE",
      "Qualification does not bind this source/build and production admission",
    );
  const modulePath = path.join(
    approval.candidateRoot,
    "src/queue-admission.js",
  );
  if (
    !fs.existsSync(modulePath) ||
    fileHash(modulePath).sha256 !== approval.admissionModuleSha256
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Approved production admission module is not present",
    );
  const composition = load(modulePath) as {
    migrationAdmissionPreflight(prepared: ObservationWire): Promise<Descriptor>;
    recoveryAuditAdmissionPreflight(prepared: AuditWire): Promise<Descriptor>;
  };
  if (typeof composition.migrationAdmissionPreflight !== "function")
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Production composition has no offline migration admission preflight",
    );
  if (typeof prepareFinal !== "function")
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Exact owner-bound final observer artifact is required for admission qualification",
    );
  const finalWire = await prepareFinal(approval);
  if (
    [
      "atomic-recovery-audit-upgrade-v1",
      "atomic-recovery-process-loss-audit-upgrade-v1",
      "isolated-scratch-epoch-upgrade-v1",
      "atomic-audit-facts-recovery-upgrade-v1",
    ].includes(approval.purpose!)
  ) {
    const prepared = finalWire as AuditWire;
    if (typeof composition.recoveryAuditAdmissionPreflight !== "function")
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Candidate has no canonical current-state audit preflight",
      );
    const descriptor =
      await composition.recoveryAuditAdmissionPreflight(prepared);
    if (
      descriptor.version !== 1 ||
      descriptor.production !== true ||
      descriptor.finalByteCertificate !== true ||
      descriptor.status !== "passed" ||
      descriptor.purpose !== "atomic-recovery-audit-v1" ||
      descriptor.buildHash !== approval.buildHash ||
      descriptor.sourceModuleHash !== approval.admissionModuleSha256 ||
      descriptor.checkerFingerprint !== approval.checkerFingerprint ||
      descriptor.artifactHash !== prepared.artifact.artifactHash ||
      descriptor.sourceHash !== prepared.record.binding["sourceHash"] ||
      descriptor.auditBindingHash !==
        prepared.record.binding["auditBindingHash"] ||
      descriptor.originArtifactHash !==
        prepared.record.binding["pythonOriginHash"] ||
      !Array.isArray(descriptor.executedUnits) ||
      invocationHash(descriptor.executedUnits) !==
        invocationHash(
          originUnits(prepared.artifact).map(
            ({ id, filename, role, sha256 }) => ({
              id,
              filename,
              role,
              sha256,
            }),
          ),
        )
    )
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Current-state audit has no exact real checker/final byte certificate",
      );
    const checkerContents = checkerContentFingerprint(approval.candidateRoot);
    if (checkerContentFingerprint(approval.installRoot) !== checkerContents)
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Installed-site checker differs from qualified audit checker contents",
      );
    return {
      ...approval,
      checkerContentFingerprint: checkerContents,
      admission: descriptor,
    };
  }
  const prepared = finalWire as ObservationWire;
  if (approval.purpose !== undefined)
    fail("INVALID_MIGRATION_APPROVAL", "Unknown migration purpose");
  const descriptor = await composition.migrationAdmissionPreflight(prepared);
  if (
    descriptor?.version !== 1 ||
    descriptor.production !== true ||
    descriptor.scopedAtomicObservation !== true ||
    descriptor.finalByteCertificate !== true ||
    descriptor.buildHash !== approval.buildHash ||
    descriptor.status !== "passed" ||
    descriptor.sourceModuleHash !== approval.admissionModuleSha256 ||
    descriptor.checkerFingerprint !== approval.checkerFingerprint ||
    descriptor.artifactHash !== prepared.pythonArtifact.artifactHash ||
    descriptor.sourceHash !== prepared.record.binding["sourceHash"] ||
    descriptor.atomicRuntimeAbiHash !==
      prepared.record.binding.atomicRuntimeAbiHash ||
    descriptor.originArtifactHash !==
      prepared.record.binding["pythonOriginHash"] ||
    descriptor.observationKind !== "atomic_holder_status" ||
    descriptor.observationTargetJobId !== fastenersScope.jobId ||
    descriptor.observationIdentityHash !==
      prepared.record.binding.observationIdentityHash ||
    !Array.isArray(descriptor.abiPinnedUnits) ||
    !Array.isArray(descriptor.executedUnits) ||
    invocationHash(descriptor.abiPinnedUnits) !==
      invocationHash(prepared.record.atomicRuntimeAbi["abiPinnedUnits"]) ||
    invocationHash(descriptor.executedUnits) !==
      invocationHash(originUnits(prepared.pythonArtifact))
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Production checker/certificate is not proven ready for this exact observer build",
    );
  const checkerContents = checkerContentFingerprint(approval.candidateRoot);
  if (checkerContentFingerprint(approval.installRoot) !== checkerContents)
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Installed-site checker bytes differ from the qualified candidate checker",
    );
  return {
    ...approval,
    checkerContentFingerprint: checkerContents,
    admission: {
      version: descriptor.version,
      production: descriptor.production,
      scopedAtomicObservation: descriptor.scopedAtomicObservation,
      finalByteCertificate: descriptor.finalByteCertificate,
      buildHash: descriptor.buildHash,
      checkerFingerprint: descriptor.checkerFingerprint,
      artifactHash: descriptor.artifactHash,
      atomicRuntimeAbiHash: descriptor.atomicRuntimeAbiHash,
      originArtifactHash: descriptor.originArtifactHash,
      abiPinnedUnits: descriptor.abiPinnedUnits,
      executedUnits: descriptor.executedUnits,
    },
  };
}

export function createProductionMigrator(client: RuntimeClient, cfg: unknown) {
  const dir = directory(queueDirectory()),
    scope = fastenersScope;
  let audit!: string,
    intent!: Pick<Intent, "approved"> & Partial<Intent>,
    authorizedSnapshot!: Snapshot,
    authorizedRequestId!: string;
  let upgrade: Upgrade | null = null;
  const read = <K extends keyof RuntimeStages>(
    stage: K,
  ): RuntimeStages[K] | null =>
    json<RuntimeStages[K]>(path.join(audit, stage + ".json"));
  function assertNoResetOrStarter() {
    if (
      fs.existsSync(path.join(dir, "fusion-reset.lock")) ||
      fs.existsSync(path.join(dir, "autostart.lock"))
    )
      fail(
        "MIGRATION_COMPETING_LIFECYCLE",
        "A Fusion reset or another startup owns the lifecycle; no owner stop allowed",
      );
  }
  function assertGuards() {
    assertNoResetOrStarter();
    const expected = {
      kind: "atomic-owner-migration",
      nonce: intent.nonce,
      audit,
      clientId: client.auth.clientId,
    };
    if (
      !same(json<Guard>(path.join(dir, "atomic-migration.lock")), expected) ||
      !same(json(path.join(dir, "recovery.lock")), expected)
    )
      fail(
        "MIGRATION_LOCK_CHANGED",
        "One-time migration escrow no longer owns both lifecycle guards",
      );
  }
  const ports = {
    scope,
    clientId: client.auth.clientId,
    auditUpgrade: () => upgrade,
    async authorize(requestId: string, approvalFile: string) {
      assertNoResetOrStarter();
      authorizedRequestId = requestId;
      const root = path.join(dir, "atomic-migrations", hash(requestId));
      const prior = json<Intent>(path.join(root, "intent.json"));
      if (prior) {
        if (
          prior.binding.clientId !== client.auth.clientId ||
          prior.ownerTokenHash !== hash(client.auth.clientToken) ||
          readJson<Record<string, string>>(path.join(dir, "clients.json"))[
            client.auth.clientId
          ] !== prior.ownerTokenHash
        )
          fail(
            "NOT_OWNER",
            "Original migration receipt is not owned by this authenticated client",
          );
        upgrade = auditUpgradeApproval(readJson<Approval>(approvalFile), dir);
        authorizedSnapshot = (json<Snapshot>(path.join(root, "paused.json")) ||
          json<Snapshot>(path.join(root, "initial.json")))!;
        if (!authorizedSnapshot) authorizedSnapshot = await ports.observe();
      } else {
        const found = await client.call("find-request", {
          requestId: scope.requestId,
        });
        if (
          found.job?.id !== scope.jobId ||
          found.job.clientId !== client.auth.clientId ||
          readJson<Record<string, string>>(path.join(dir, "clients.json"))[
            client.auth.clientId
          ] !== hash(client.auth.clientToken)
        )
          fail(
            "NOT_OWNER",
            "Original broker did not authenticate this holder owner",
          );
        upgrade = auditUpgradeApproval(readJson<Approval>(approvalFile), dir);
        authorizedSnapshot = await ports.observe();
        assertHeld(
          authorizedSnapshot,
          client.auth.clientId,
          scope,
          false,
          upgrade,
        );
        if (upgrade) {
          const observed = await client.call("find-request", {
            requestId:
              authorizedSnapshot.state.jobs[upgrade.observationJobId]!
                .requestId,
          });
          if (
            observed.job?.id !== upgrade.observationJobId ||
            observed.job.clientId !== client.auth.clientId
          )
            fail(
              "NOT_OWNER",
              "The same authenticated owner must also own the unavailable observation",
            );
        }
      }
    },
    async approve(file: string) {
      const approved = await approvedCandidate(file, async (approval) => {
        if (buildHash() !== approval.buildHash)
          fail(
            "BUILD_CHANGED",
            "Run the migrator CLI from the approved candidate runtime",
          );
        const originalPrepared = await prepareAtomicHolderObservation(
          authorizedSnapshot.state.jobs[scope.jobId]!,
          { version: 1, kind: "atomic_holder_status", ...scope },
          {
            clientId: client.auth.clientId,
            observerBuildHash: approval.buildHash,
            originalBuildHash: authorizedSnapshot.identity.buildHash,
            approvedScope: scope,
          },
        );
        const original = validateOriginalEvidence(
          dir,
          authorizedSnapshot,
          upgrade,
        );
        if (upgrade) {
          assertAuditUpgradeSnapshot(
            upgrade,
            authorizedSnapshot,
            client.auth.clientId,
          );
          if (
            !auditUpgradeStillCurrent(upgrade) ||
            invocationHash(originalPrepared.identity) !==
              invocationHash(upgrade.identity) ||
            originalPrepared.originalInvocationHash !==
              upgrade.originalInvocationHash ||
            !same(originalPrepared.sourceEnvelope, upgrade.sourceEnvelope) ||
            originalPrepared.reportFingerprint !== upgrade.reportFingerprint
          )
            fail(
              "AUDIT_UPGRADE_PROOF_INVALID",
              "Unavailable observation no longer matches immutable original input/report",
            );
          const auditApi = load("./queue-atomic-recovery-audit") as {
            prepareRecoveryAudit: typeof import("../../packages/node-adapters/src/execution/recovery-python").prepareRecoveryAudit;
            prepareRecoveryAuditWire(input: RecoveryWireInput): AuditWire;
          };
          const binding = {
            purpose: "atomic-recovery-audit-v1",
            targetJobId: scope.jobId,
            observationJobId: upgrade.observationJobId,
            priorProofHash: upgrade.observationProof.sha256,
            originalJobHash: authorizedSnapshot.state.jobs[scope.jobId]!.hash,
            observationJobHash:
              authorizedSnapshot.state.jobs[upgrade.observationJobId]!.hash,
            clientId: client.auth.clientId,
            auditBuildHash: approval.buildHash,
            ...(processLossAudit(upgrade)
              ? {
                  currentInstance: upgrade!.currentInstance,
                  historicalInstance: processTuple(
                    authorizedSnapshot.identity.instance,
                  ),
                  historicalProcessState: "terminated",
                }
              : {}),
          };
          const reader = auditApi.prepareRecoveryAudit(
            approval.candidateRoot,
            originalPrepared.identity,
            binding,
          );
          const seed = hash(authorizedRequestId);
          const rpcId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
          return auditApi.prepareRecoveryAuditWire({
            reader,
            rpcId,
            payload: {
              jsonrpc: "2.0",
              id: "audit-upgrade-preflight",
              method: "tools/call",
              params: {
                name: "execute_python",
                arguments: {
                  code: reader.artifact.script + '\n\nrun("")\n',
                  persistent: false,
                },
              },
            },
            receipt: path.join(
              dir,
              "atomic-migrations",
              seed,
              `audit-preflight-${rpcId}.receipt.json`,
            ),
            instance: authorizedSnapshot.identity.instance,
            buildHash: approval.buildHash,
            jobId: scope.jobId,
            auditBinding: binding,
          });
        }
        const prepared = bindAtomicRuntimeAbi(
          originalPrepared,
          buildAtomicRuntimeAbi(
            authorizedSnapshot.state.jobs[scope.jobId]!,
            originalPrepared,
            original.rpcRecords,
            { dir },
          ),
        );
        const seed = hash(authorizedRequestId),
          rpcId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
        return (
          load("./queue-atomic-wire") as {
            prepareAtomicObservationWire(
              input: AtomicObservationInput,
            ): ObservationWire;
          }
        ).prepareAtomicObservationWire({
          payload: {
            jsonrpc: "2.0",
            id: "migration-preflight",
            method: "tools/call",
            params: {
              name: "execute_python",
              arguments: {
                code: prepared.script + '\n\nrun("")\n',
                persistent: false,
              },
            },
          },
          rpcId,
          observerJobId: "migration-preflight-" + seed.slice(0, 32),
          targetJobId: scope.jobId,
          codeHash: approval.buildHash,
          identity: prepared.identity,
          instance: authorizedSnapshot.identity.instance,
          originArtifact: prepared.artifact,
          atomicRuntimeAbi: prepared.atomicRuntimeAbi!,
          receipt: path.join(
            dir,
            "atomic-migrations",
            seed,
            `preflight-${rpcId}.receipt.json`,
          ),
          dispatchTimeoutMs: 30000,
        });
      });
      if (!same(auditUpgradeApproval(approved, dir), upgrade))
        fail(
          "MIGRATION_INTENT_CONFLICT",
          "Audit-upgrade approval changed during owner preflight",
        );
      stopApi().stopOwnerPreflight();
      if (buildHash() !== approved.buildHash)
        fail(
          "BUILD_CHANGED",
          "Run the migrator CLI from the approved candidate runtime",
        );
      return approved;
    },
    async authenticate(binding: MigrationBinding, approved: QualifiedApproval) {
      const prior = json<Intent>(
        path.join(
          dir,
          "atomic-migrations",
          hash(binding.requestId),
          "intent.json",
        ),
      );
      if (prior) {
        if (
          !same(prior.binding, binding) ||
          prior.ownerTokenHash !== hash(client.auth.clientToken) ||
          readJson<Record<string, string>>(path.join(dir, "clients.json"))[
            client.auth.clientId
          ] !== prior.ownerTokenHash
        )
          fail(
            "NOT_OWNER",
            "Resuming migration requires the original receipt-bound private owner credential",
          );
      } else {
        const snapshot = await ports.observe();
        assertHeld(snapshot, client.auth.clientId, scope, false, upgrade);
        // ownerProof uses the approved installation to bind the actual process.
        intent = { approved };
        await ports.ownerProof(snapshot);
        await ports.liveOwner(snapshot.owner);
      }
    },
    async claim(binding: MigrationBinding, approved: QualifiedApproval) {
      const key = hash(binding.requestId);
      audit = path.join(dir, "atomic-migrations", key);
      fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
      directory(audit);
      const prior = json<Intent>(path.join(audit, "intent.json"));
      intent = prior || {
        binding,
        approved,
        nonce: randomUUID(),
        ownerTokenHash: hash(client.auth.clientToken),
      };
      if (
        !same(intent.binding, binding) ||
        !same(intent.approved, approved) ||
        intent.ownerTokenHash !== hash(client.auth.clientToken)
      )
        fail(
          "MIGRATION_INTENT_CONFLICT",
          "One-time migration belongs to another owner/approval/request",
        );
      exclusive(path.join(audit, "intent.json"), intent);
      const marker = {
        kind: "atomic-owner-migration",
        nonce: intent.nonce,
        audit,
        clientId: client.auth.clientId,
      };
      const completed = read("complete");
      if (!completed) {
        exclusive(path.join(dir, "atomic-migration.lock"), marker);
        exclusive(path.join(dir, "recovery.lock"), marker);
      }
    },
    binding: () => intent.binding,
    read,
    publish: async <K extends keyof RuntimeStages>(
      stage: K,
      value: RuntimeStages[K],
    ) => exclusive(path.join(audit, stage + ".json"), value),
    async observe() {
      const status = await client.call("queue-summary");
      return {
        status,
        state: readJson<Snapshot["state"]>(path.join(dir, "queue-state.json")),
        owner: readJson<Owner>(path.join(dir, "broker.lock")),
        identity: readJson<Snapshot["identity"]>(
          path.join(dir, "instance.json"),
        ),
      };
    },
    async ownerProof(snapshot: Snapshot) {
      const found = await client.call("find-request", {
        requestId: scope.requestId,
      });
      if (
        found.job?.id !== scope.jobId ||
        found.job.clientId !== client.auth.clientId ||
        readJson<Record<string, string>>(path.join(dir, "clients.json"))[
          client.auth.clientId
        ] !== hash(client.auth.clientToken) ||
        snapshot.state.jobs[scope.jobId]!.request.ownerToken !==
          hash(client.auth.clientToken)
      )
        fail(
          "NOT_OWNER",
          "Original broker did not authenticate this exact holder owner",
        );
      if (
        upgrade &&
        snapshot.state.jobs[upgrade.observationJobId]?.request.ownerToken !==
          hash(client.auth.clientToken)
      )
        fail(
          "NOT_OWNER",
          "Unavailable observer ownership no longer matches the authenticated owner",
        );
      const approved = intent.approved;
      if (brokerConfigHash(cfg) !== snapshot.identity.configHash)
        fail(
          "CONFIG_CHANGED",
          "Migration physical backend configuration differs from the original broker",
        );
      if (
        buildHash(approved.installRoot) !==
        (upgrade?.departingBuildHash || snapshot.identity.buildHash)
      )
        fail(
          "BUILD_CHANGED",
          "Original installed bytes differ from the live broker build",
        );
      const command = fs
        .readFileSync(`/proc/${snapshot.owner.pid}/cmdline`, "utf8")
        .split("\0");
      const supervisor = upgrade
        ? "queue-atomic-migration-worker.js"
        : "queue-autostart-worker.js";
      if (
        !command.includes(path.join(approved.installRoot, "src", supervisor)) ||
        (upgrade &&
          !command.includes(
            path.dirname(
              upgrade.epochPrerequisite?.files.migrationComplete.path ||
                upgrade.auditResponseRecovery?.files.migrationComplete.path ||
                upgrade.previousComplete.path,
            ),
          ))
      )
        fail(
          "OWNER_COMMAND_CHANGED",
          "Original PID is not the approved installed broker supervisor",
        );
    },
    async liveOwner(owner: Owner) {
      if (priorProcessAlive(owner) !== true)
        fail(
          "MIGRATION_OWNER_CHANGED",
          "Original PID/birth is not currently live",
        );
    },
    async pause(initial: Snapshot, requestId: string) {
      if (upgrade?.auditResponseRecovery) {
        const current = await ports.observe();
        assertHeld(current, client.auth.clientId, scope, true, upgrade);
        await ports.publish(
          "pause-adoption",
          epochApi().inheritedAuditResponsePause({
            initial,
            current,
            intent: intent as Intent,
            upgrade,
            clientId: client.auth.clientId,
            dir,
          }),
        );
        return;
      }
      if (upgrade?.epochPrerequisite) {
        const current = await ports.observe();
        assertHeld(current, client.auth.clientId, scope, true, upgrade);
        const adopted = epochApi().inheritedEpochPause({
          initial,
          current,
          intent: intent as Intent,
          upgrade,
          clientId: client.auth.clientId,
          dir,
        });
        await ports.publish("pause-adoption", adopted);
        return;
      }
      const file = path.join(
        dir,
        "lifecycle-control-" + hash(requestId) + ".json",
      );
      const existing = json<{ binding: unknown }>(file);
      if (existing) {
        const expected = {
          action: "pause",
          clientId: client.auth.clientId,
          requestId,
          instanceId: initial.owner.nonce,
          expectedGeneration: initial.status.control.generation,
          buildHash: upgrade?.departingBuildHash || initial.identity.buildHash,
        };
        if (!same(existing.binding, expected))
          fail("MIGRATION_PAUSE_CONFLICT", "Pause intent binding changed");
        const saved = readJson<Snapshot["state"]>(
          path.join(dir, "queue-state.json"),
        );
        if (saved.paused && saved.controlRequests?.[requestId]?.paused === true)
          return;
        fail(
          "MIGRATION_PAUSE_UNKNOWN",
          "Original pause has no durable closed-gate proof; never replayed",
        );
      }
      await client.call("pause", {
        control: {
          requestId,
          instanceId: initial.owner.nonce,
          expectedGeneration: initial.status.control.generation,
        },
      });
    },
    async evidence(snapshot: Snapshot) {
      const original = validateOriginalEvidence(dir, snapshot, upgrade);
      const originalPrepared = await prepareAtomicHolderObservation(
        snapshot.state.jobs[scope.jobId]!,
        { version: 1, kind: "atomic_holder_status", ...scope },
        {
          clientId: client.auth.clientId,
          observerBuildHash: intent.approved.buildHash,
          originalBuildHash: snapshot.identity.buildHash,
          approvedScope: scope,
        },
      );
      const prepared = upgrade
        ? originalPrepared
        : bindAtomicRuntimeAbi(
            originalPrepared,
            buildAtomicRuntimeAbi(
              snapshot.state.jobs[scope.jobId]!,
              originalPrepared,
              original.rpcRecords,
              { dir },
            ),
          );
      const { QueueDomain } = load(
        path.join(intent.approved.candidateRoot, "src/dist/core/domain/queue"),
      ) as { QueueDomain: QueueConstructor };
      new QueueDomain({
        snapshot: snapshot.state,
        now: Date.now,
        newId: randomUUID,
        hash,
        commit(next: unknown) {
          if (!same(next, snapshot.state))
            fail(
              "MIGRATION_RECOVERY_WOULD_EDIT_JOB",
              "Candidate recovery would change the escrow snapshot",
            );
        },
      });
      await ports.publish("evidence", {
        receipts: original.receipts,
        reportFingerprint: prepared.reportFingerprint,
        originalInvocationHash: prepared.originalInvocationHash,
        sourceEnvelope: prepared.sourceEnvelope,
        ...(upgrade
          ? { auditUpgrade: upgrade }
          : { atomicRuntimeAbi: prepared.atomicRuntimeAbi! }),
        identity: prepared.identity,
        reportInventory: inventory(scope.reportPath),
      });
    },
    async backup(paused: Snapshot, approved: QualifiedApproval) {
      const excluded = (rel: string) =>
        rel === "broker.sock" ||
        rel === "console-state.json" ||
        rel === "atomic-migrations" ||
        rel.endsWith(".log");
      const queue = backupTree(dir, path.join(audit, "queue-backup"), excluded);
      const report = backupTree(
        scope.reportPath,
        path.join(audit, "report-backup"),
      );
      const runtime = backupTree(
        approved.installRoot,
        path.join(audit, "runtime-backup"),
      );
      const generatorDependencies = escrowAtomicGeneratorDependencies(
        approved.installRoot,
        audit,
      );
      const manifest = path.join(audit, "backup-manifest.json");
      exclusive(manifest, {
        version: 1,
        queue,
        report,
        runtime,
        generatorDependencies,
        sourceStateHash: hash(JSON.stringify(paused.state)),
      });
      return {
        audit,
        manifest: "backup-manifest.json",
        sha256: fileHash(manifest).sha256,
        sourceStateHash: hash(JSON.stringify(paused.state)),
      };
    },
    async verifyBackup(backup: Backup) {
      verifyEscrowBackup(backup, audit);
    },
    async fence(paused: Snapshot, approved: QualifiedApproval, dead = false) {
      assertGuards();
      const current = dead
        ? {
            state: readJson<Snapshot["state"]>(
              path.join(dir, "queue-state.json"),
            ),
            owner: readJson<Owner>(path.join(dir, "broker.lock")),
            identity: readJson<Snapshot["identity"]>(
              path.join(dir, "instance.json"),
            ),
          }
        : await ports.observe();
      if (
        !same(current.state, paused.state) ||
        !same(current.owner, paused.owner) ||
        !same(current.identity, paused.identity) ||
        (!dead &&
          ((current as Snapshot).status.control.activeOperations !== 0 ||
            (current as Snapshot).status.control.gateClosed !== true))
      )
        fail(
          "MIGRATION_FENCE_CHANGED",
          "Closed queue/holder/instance changed after escrow",
        );
      if (
        buildHash(approved.installRoot) !==
          (upgrade?.departingBuildHash || paused.identity.buildHash) ||
        buildHash(approved.candidateRoot) !== approved.buildHash
      )
        fail(
          "BUILD_CHANGED",
          "Pinned original/candidate bytes changed before owner stop",
        );
      const e = read("evidence")!;
      verifyOriginalInput(current.state.jobs[scope.jobId]!, e);
      if (upgrade)
        assertAuditUpgradeSnapshot(upgrade, current, client.auth.clientId);
      if (
        upgrade
          ? !same(e.auditUpgrade, upgrade) || !auditUpgradeStillCurrent(upgrade)
          : !atomicRuntimeAbiStillCurrent(e.atomicRuntimeAbi!)
      )
        fail(
          "BUILD_CHANGED",
          "Original ABI source witness changed before owner stop",
        );
      if (
        (await readCurrentAtomicObservationReport(scope.reportPath))
          .fingerprint !== e.reportFingerprint ||
        !same(inventory(scope.reportPath), e.reportInventory)
      )
        fail("WORKFLOW_REPORT_CHANGED", "Original report changed after escrow");
      const original = validateOriginalEvidence(dir, paused, upgrade);
      if (!same(original.receipts, e.receipts))
        fail(
          "RECEIPT_MISMATCH",
          "Original physical receipts changed after escrow",
        );
    },
    async stop(owner: Owner) {
      assertGuards();
      stopApi().stopOwner(owner, audit);
    },
    async originalDead(owner: Owner) {
      const alive = priorProcessAlive(owner);
      if (alive === null)
        fail(
          "MIGRATION_OWNER_UNKNOWN",
          "Original PID/birth liveness cannot be established",
        );
      return !alive;
    },
    async deadOwner(owner: Owner) {
      requireDead(owner);
    },
    async install(approved: QualifiedApproval, backup: Backup) {
      assertGuards();
      const manifest = verifyEscrowBackup(backup, audit);
      const root = approved.installRoot,
        staged = root + ".atomic-staged-" + intent.nonce;
      const previous = root + ".atomic-previous-" + intent.nonce;
      // Directory renames are on the installation filesystem. The entire old
      // runtime remains intact; no overlay, deletion or unknown-file overwrite.
      if (!fs.existsSync(previous)) {
        verifyTree(root, manifest.runtime);
        const candidate = backupTree(approved.candidateRoot, staged);
        verifyTree(staged, candidate);
        if (buildHash(staged) !== approved.buildHash)
          fail("BUILD_CHANGED", "Staged runtime differs from approved bytes");
        fs.renameSync(root, previous);
      }
      verifyTree(previous, manifest.runtime);
      if (!fs.existsSync(root)) fs.renameSync(staged, root);
      if (buildHash(root) !== approved.buildHash)
        fail("BUILD_CHANGED", "Installed runtime is not the approved build");
      const fd = fs.openSync(path.dirname(root), "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { previous, installed: root, buildHash: approved.buildHash };
    },
    async verifyInstalled(approved: QualifiedApproval) {
      assertGuards();
      if (buildHash(approved.installRoot) !== approved.buildHash)
        fail("BUILD_CHANGED", "Installed build changed after migration");
      if (
        checkerContentFingerprint(approved.installRoot) !==
        approved.checkerContentFingerprint
      )
        fail(
          "PYTHON_ADMISSION_UNAVAILABLE",
          "Installed checker bytes changed since production qualification",
        );
    },
    async start(approved: QualifiedApproval) {
      assertGuards();
      const worker = json<ProcessOwner>(path.join(audit, "worker.json"));
      if (worker) {
        const alive = priorProcessAlive(worker);
        if (alive === null)
          fail(
            "MIGRATION_START_UNKNOWN",
            "Migration worker liveness is unknown; no replacement launched",
          );
        if (alive) return;
        // No SDK admission is possible while the migration guard exists. Only
        // our proven-dead worker, with an unchanged escrow snapshot, is retired.
        retireDeadMigrationWorker(dir, audit, intent as Intent);
      }
      // An interrupted spawn with no worker receipt is safe to re-enter: the
      // candidate worker must atomically win worker.json BEFORE serve/SDK access.
      // Losing duplicate launchers exit without writing outcomes or claiming a broker.
      const attempt = randomUUID();
      exclusive(path.join(audit, "launch-attempt-" + attempt + ".json"), {
        attempt,
        buildHash: approved.buildHash,
      });
      const out = fs.openSync(
        path.join(audit, "worker-" + attempt + ".stdout.log"),
        "wx",
        0o600,
      );
      const err = fs.openSync(
        path.join(audit, "worker-" + attempt + ".stderr.log"),
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
              approved.installRoot,
              "src/queue-atomic-migration-worker.js",
            ),
            audit,
          ],
          {
            detached: true,
            stdio: ["pipe", out, err],
            cwd: dir,
            shell: false,
            env,
          },
        );
        child.once("error", (error) => {
          try {
            exclusive(path.join(audit, "worker-error.json"), {
              code:
                (error as NodeJS.ErrnoException).code ||
                "MIGRATION_SPAWN_FAILED",
              notStarted: true,
            });
          } catch {
            /* Missing durable spawn proof remains an unknown launch; never replay. */
          }
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(JSON.stringify({ cfg, nonce: intent.nonce }));
        child.unref();
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
    },
    async observeNew(approved: QualifiedApproval): Promise<Snapshot> {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const ready = read("worker-ready");
        if (ready) {
          const snapshot = await ports.observe();
          const worker = read("worker");
          if (
            snapshot.status.features?.["atomicWorkflowObserve"] !== true ||
            ready.buildHash !== approved.buildHash ||
            !same(snapshot.owner, ready.owner) ||
            worker?.pid !== ready.owner.pid ||
            worker?.birth !== ready.owner.birth ||
            priorProcessAlive(snapshot.owner) !== true
          )
            fail(
              "HANDOFF_UNPROVEN",
              "Replacement owner/build has no matching live process and ready receipt",
            );
          requireRecoveryProcesses(snapshot.identity.instance, upgrade);
          const e = read("evidence")!;
          verifyOriginalInput(snapshot.state.jobs[scope.jobId]!, e);
          const original = validateOriginalEvidence(dir, snapshot, upgrade);
          const prepared = await prepareAtomicHolderObservation(
            snapshot.state.jobs[scope.jobId]!,
            { version: 1, kind: "atomic_holder_status", ...scope },
            {
              clientId: client.auth.clientId,
              observerBuildHash: approved.buildHash,
              originalBuildHash: snapshot.identity.buildHash,
              approvedScope: scope,
            },
          );
          if (upgrade) {
            if (
              !auditUpgradeStillCurrent(upgrade) ||
              invocationHash(prepared.identity) !==
                invocationHash(upgrade.identity)
            )
              fail(
                "AUDIT_UPGRADE_PROOF_INVALID",
                "Original handoff/observation evidence changed during second handoff",
              );
            await ports.publish("handoff-audit-upgrade", {
              purpose: upgrade.purpose,
              previousComplete: upgrade.previousComplete,
              observationProof: upgrade.observationProof,
            });
          } else {
            const relocatedAbi = buildAtomicRuntimeAbi(
              snapshot.state.jobs[scope.jobId]!,
              prepared,
              original.rpcRecords,
              { dir },
            );
            if (
              relocatedAbi.hash !== e.atomicRuntimeAbi!.hash ||
              !atomicRuntimeAbiStillCurrent(relocatedAbi)
            )
              fail(
                "BUILD_CHANGED",
                "Relocated original runtime does not preserve the same verified ABI proof",
              );
            await ports.publish("handoff-abi", relocatedAbi);
          }
          if (
            (await readCurrentAtomicObservationReport(scope.reportPath))
              .fingerprint !== e.reportFingerprint ||
            !same(inventory(scope.reportPath), e.reportInventory)
          )
            fail(
              "WORKFLOW_REPORT_CHANGED",
              "Original holder report changed during handoff",
            );
          return snapshot;
        }
        if (read("worker-error"))
          fail(
            "MIGRATION_START_FAILED",
            "Replacement failed; inspect its original durable error receipt",
          );
        await sleep(100);
      }
      return fail(
        "MIGRATION_START_UNKNOWN",
        "No replacement ready receipt; do not launch a second broker",
      );
    },
    async release() {
      for (const name of ["atomic-migration.lock", "recovery.lock"]) {
        const file = path.join(dir, name),
          archived = path.join(audit, "released-" + name + ".json");
        if (fs.existsSync(file)) {
          if (readJson<Guard>(file).nonce !== intent.nonce)
            fail(
              "MIGRATION_LOCK_CHANGED",
              "Migration guard belongs to another intent",
            );
          exclusive(archived, readJson(file));
          fs.unlinkSync(file);
        }
      }
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
  // The core drives these lifecycle stages in order; runtime approval narrows
  // the core's extensible approval/snapshot records before effectful ports run.
  const migrate = createMigrator(ports as unknown as MigrationPorts);
  const preflight = async (
    approval: string,
    requestId: string,
    jobId: string,
  ) => {
    if (
      jobId !== scope.jobId ||
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 180
    )
      fail(
        "INVALID_REQUEST",
        "Stable migration request ID is required for preflight",
      );
    await ports.authorize(requestId, approval);
    const approved = await ports.approve(approval);
    intent = { approved };
    const snapshot = await ports.observe();
    assertHeld(snapshot, client.auth.clientId, scope, false, upgrade);
    await ports.ownerProof(snapshot);
    await ports.liveOwner(snapshot.owner);
    const original = validateOriginalEvidence(dir, snapshot, upgrade);
    const originalPrepared = await prepareAtomicHolderObservation(
      snapshot.state.jobs[scope.jobId]!,
      { version: 1, kind: "atomic_holder_status", ...scope },
      {
        clientId: client.auth.clientId,
        observerBuildHash: approved.buildHash,
        originalBuildHash: snapshot.identity.buildHash,
        approvedScope: scope,
      },
    );
    const prepared = upgrade
      ? originalPrepared
      : bindAtomicRuntimeAbi(
          originalPrepared,
          buildAtomicRuntimeAbi(
            snapshot.state.jobs[scope.jobId]!,
            originalPrepared,
            original.rpcRecords,
            { dir },
          ),
        );
    if (upgrade && !auditUpgradeStillCurrent(upgrade))
      fail(
        "AUDIT_UPGRADE_PROOF_INVALID",
        "First handoff/observation history changed during preflight",
      );
    const processes = requireRecoveryProcesses(
      snapshot.identity.instance,
      upgrade,
    );
    await ports.liveOwner(snapshot.owner);
    return {
      version: 1,
      kind: "atomic-migration-preflight",
      jobId: scope.jobId,
      owner: snapshot.owner,
      originalBuildHash: snapshot.identity.buildHash,
      observerBuildHash: approved.buildHash,
      processObservation: processes,
      readinessObservedAt: new Date().toISOString(),
      validity:
        "point-in-time; apply and every handoff fence recheck process identities",
      generation: snapshot.status.control.generation,
      contextEpoch: snapshot.status.control.contextEpoch,
      stateHash: hash(JSON.stringify(snapshot.state)),
      reportFingerprint: prepared.reportFingerprint,
      receipts: original.receipts,
      admission: approved.admission,
      readyToPause: true,
      readyToStop: false,
      ...(upgrade
        ? {
            purpose: upgrade.purpose,
            departingBrokerBuildHash: upgrade.departingBuildHash,
            observationJobId: upgrade.observationJobId,
            previousComplete: upgrade.previousComplete,
            alreadyPaused: snapshot.state.paused,
          }
        : {
            atomicRuntimeAbiHash: prepared.atomicRuntimeAbi!.hash,
            abiPinnedUnits: prepared.atomicRuntimeAbi!.proof.abiPinnedUnits,
          }),
      stopCapability: stopApi().stopOwnerPreflight(),
      sdkRequestsSent: 0,
      nativeOutcome: "unknown",
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
    };
  };
  return Object.assign(migrate, { preflight });
}

// Called only by the new broker before QueueState construction or any SDK turn.
export function claimMigratedBroker(
  dir: string,
  marker: Owner,
  nonce: string,
  codeHash: string,
  approvedScope = fastenersScope,
) {
  const lock = readJson<Guard>(path.join(dir, "recovery.lock"));
  if (
    !nonce ||
    lock.kind !== "atomic-owner-migration" ||
    lock.nonce !== nonce ||
    !same(lock, readJson<Guard>(path.join(dir, "atomic-migration.lock")))
  )
    fail("RECOVERY_IN_PROGRESS", "Migration owns the closed queue");
  const audit = lock.audit,
    intent = readJson<Intent>(path.join(audit, "intent.json"));
  const paused = readJson<Snapshot>(path.join(audit, "paused.json")),
    stopped = readJson<{ stateHash: string; backup: Backup }>(
      path.join(audit, "stopped.json"),
    );
  const installed = readJson<{ buildHash: string }>(
    path.join(audit, "installed.json"),
  );
  if (
    audit !==
      path.join(dir, "atomic-migrations", hash(intent.binding.requestId)) ||
    intent.binding.jobId !== fastenersScope.jobId ||
    intent.binding.clientId !== lock.clientId ||
    intent.nonce !== nonce ||
    installed.buildHash !== codeHash ||
    intent.approved.buildHash !== codeHash ||
    stopped.stateHash !== hash(JSON.stringify(paused.state)) ||
    readJson<Record<string, string>>(path.join(dir, "clients.json"))[
      intent.binding.clientId
    ] !== intent.ownerTokenHash ||
    !same(
      readJson<Snapshot["state"]>(path.join(dir, "queue-state.json")),
      paused.state,
    ) ||
    !same(
      readJson<Snapshot["identity"]>(path.join(dir, "instance.json")),
      paused.identity,
    )
  )
    fail(
      "MIGRATION_FENCE_CHANGED",
      "Escrow/build/owner/snapshot proof changed before replacement startup",
    );
  if (
    checkerContentFingerprint(intent.approved.installRoot) !==
    intent.approved.checkerContentFingerprint
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Replacement checker differs from the production-qualified content inventory",
    );
  const upgrade = auditUpgradeApproval(intent.approved, dir);
  assertHeld(paused, intent.binding.clientId, approvedScope, true, upgrade);
  if (
    upgrade &&
    !same(
      readJson<Evidence>(path.join(audit, "evidence.json")).auditUpgrade,
      upgrade,
    )
  )
    fail(
      "AUDIT_UPGRADE_PROOF_INVALID",
      "Replacement has no matching second-window proof",
    );
  verifyOriginalInput(
    paused.state.jobs[fastenersScope.jobId]!,
    readJson<Evidence>(path.join(audit, "evidence.json")),
  );
  requireRecoveryProcesses(paused.identity.instance, upgrade);
  if (stopped.backup?.sourceStateHash !== stopped.stateHash)
    fail(
      "BACKUP_MISMATCH",
      "Stop receipt does not bind the immutable original queue backup",
    );
  verifyEscrowBackup(stopped.backup, audit);
  requireDead(paused.owner);
  const { QueueDomain } = load("./dist/core/domain/queue") as {
    QueueDomain: QueueConstructor;
  };
  new QueueDomain({
    snapshot: paused.state,
    now: Date.now,
    newId: randomUUID,
    hash,
    commit(next: unknown) {
      if (!same(next, paused.state))
        fail(
          "MIGRATION_RECOVERY_WOULD_EDIT_JOB",
          "Candidate recovery would change the escrow snapshot",
        );
    },
  });
  const old = json<Owner>(path.join(dir, "broker.lock"));
  if (old && !same(old, paused.owner)) {
    const retired = json<{
      owner: Owner;
      worker: ProcessOwner;
      migrationNonce: string;
      buildHash: string;
      stateHash: string;
    }>(path.join(audit, "retired-owner-" + hash(old.nonce) + ".json"));
    if (
      !retired ||
      !same(retired.owner, old) ||
      retired.worker.pid !== old.pid ||
      retired.worker.birth !== old.birth ||
      retired.migrationNonce !== nonce ||
      retired.buildHash !== codeHash ||
      retired.stateHash !== stopped.stateHash
    )
      fail("MIGRATION_LOCK_CHANGED", "Another broker already owns the queue");
    requireDead(old);
  }
  const preserved = path.join(audit, "original-broker.lock.json");
  if (!old && !same(json(preserved), paused.owner))
    fail(
      "MIGRATION_LOCK_CHANGED",
      "Absent broker marker has no durable earlier migration claim",
    );
  exclusive(preserved, paused.owner);
  if (old) fs.unlinkSync(path.join(dir, "broker.lock"));
  durable(path.join(dir, "broker.lock"), marker, true);
  if (processLossAudit(upgrade))
    exclusive(path.join(dir, `current-audit-instance-${marker.nonce}.json`), {
      version: 1,
      purpose: "current-only-after-original-process-loss",
      owner: marker,
      buildHash: codeHash,
      migrationAudit: audit,
      originalInstance: processTuple(paused.identity.instance),
      currentInstance: upgrade!.currentInstance,
      ...(upgrade!.epochPrerequisite
        ? { epochPrerequisite: upgrade!.epochPrerequisite }
        : {}),
      ...(upgrade!.auditResponseRecovery
        ? { auditResponseRecovery: upgrade!.auditResponseRecovery }
        : {}),
    });
  return stopped.stateHash;
}
