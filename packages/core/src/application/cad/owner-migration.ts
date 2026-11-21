import { sha256 } from "../../domain/engineering/sha256";

export interface MigrationScope {
  jobId: string;
  [key: string]: unknown;
}
export interface MigrationOwner {
  nonce: string;
  [key: string]: unknown;
}
export interface MigrationJob {
  id: string;
  clientId: string;
  state: string;
  [key: string]: unknown;
}
export interface MigrationSnapshot {
  state: {
    jobs: Record<string, MigrationJob>;
    blocked?: { id: string } | null;
    active?: string | null;
    lease?: unknown;
    localUnknown?: unknown;
    controlBlocked?: unknown;
    controlGeneration?: number;
    contextEpoch?: number;
    paused?: boolean;
    [key: string]: unknown;
  };
  owner: MigrationOwner;
  identity: { buildHash: string; [key: string]: unknown };
  status: {
    control: {
      activeOperations: number;
      activeIds?: string[];
      instanceId: string;
      buildHash: string;
      generation: number;
      contextEpoch: number;
      gateClosed: boolean;
    };
    lease?: unknown;
    stopping?: boolean;
    paused: boolean;
    nonterminalJobCount: number;
    blocked?: { id: string } | null;
    features?: Record<string, unknown>;
    isolatedScratchScope?: { creation: string };
    recoveryAuditScope?: {
      currentInstance: unknown;
      currentModelingAdmission: string;
      newInstanceRebound: boolean;
    };
  };
}
export interface MigrationUpgrade {
  observationJobId: string;
  departingBuildHash: string;
  previousComplete: unknown;
  purpose?: string;
  epochPrerequisite?: unknown;
  auditResponseRecovery?: unknown;
  currentInstance?: unknown;
}
export interface MigrationApproval {
  buildHash: string;
  [key: string]: unknown;
}
export interface MigrationBinding {
  version: number;
  kind: string;
  requestId: string;
  jobId: string;
  clientId: string;
  approvalHash: string;
}
export interface MigrationStages {
  initial: MigrationSnapshot;
  paused: MigrationSnapshot;
  backup: unknown;
  "stop-intent": unknown;
  stopped: unknown;
  installed: unknown;
  "launch-intent": unknown;
  complete: Record<string, unknown>;
}
export interface MigrationPolicy {
  scope: MigrationScope;
  isCandidate(
    job: MigrationJob,
    buildHash: string,
    scope: MigrationScope,
  ): boolean;
  assertUpgrade(
    upgrade: MigrationUpgrade,
    snapshot: MigrationSnapshot,
    clientId: string,
  ): void;
}
export interface MigrationPorts {
  scope: MigrationScope;
  clientId: string;
  authorize(requestId: string, approval: unknown): Promise<void>;
  approve(approval: unknown): Promise<MigrationApproval>;
  authenticate(
    binding: MigrationBinding,
    approved: MigrationApproval,
  ): Promise<void>;
  claim(binding: MigrationBinding, approved: MigrationApproval): Promise<void>;
  read<K extends keyof MigrationStages>(
    stage: K,
  ): MigrationStages[K] | undefined;
  publish<K extends keyof MigrationStages>(
    stage: K,
    value: MigrationStages[K],
  ): Promise<MigrationStages[K]>;
  observe(): Promise<MigrationSnapshot>;
  ownerProof(snapshot: MigrationSnapshot): Promise<void>;
  liveOwner(owner: MigrationOwner): Promise<void>;
  binding(): unknown;
  auditUpgrade?(): MigrationUpgrade;
  pause(snapshot: MigrationSnapshot, requestId: string): Promise<void>;
  evidence(snapshot: MigrationSnapshot): Promise<void>;
  backup(
    snapshot: MigrationSnapshot,
    approved: MigrationApproval,
  ): Promise<unknown>;
  verifyBackup(backup: unknown): Promise<void>;
  originalDead(owner: MigrationOwner): Promise<boolean>;
  fence(
    snapshot: MigrationSnapshot,
    approved: MigrationApproval,
    dead: boolean,
  ): Promise<void>;
  stop(owner: MigrationOwner): Promise<void>;
  deadOwner(owner: MigrationOwner): Promise<void>;
  install(approved: MigrationApproval, backup: unknown): Promise<unknown>;
  verifyInstalled(approved: MigrationApproval): Promise<void>;
  start(approved: MigrationApproval, recovering: boolean): Promise<void>;
  observeNew(approved: MigrationApproval): Promise<MigrationSnapshot>;
  release(result: unknown): Promise<void>;
}
const hash = sha256;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function assertHeld(
  policy: MigrationPolicy,
  snapshot: MigrationSnapshot,
  clientId: string,
  scope = policy.scope,
  closed = true,
  upgrade: MigrationUpgrade | null | undefined = null,
) {
  const { state, status, owner, identity } = snapshot;
  const job = state.jobs[scope.jobId];
  if (!job || job.clientId !== clientId)
    fail(
      "NOT_OWNER",
      "Migration requires the original authenticated atomic job owner",
    );
  if (
    !policy.isCandidate(job, identity.buildHash, scope) ||
    state.blocked?.id !== job.id ||
    state.active !== (upgrade?.observationJobId || job.id)
  )
    fail(
      "HOLDER_CHANGED",
      "Only the exact original unresolved atomic holder may migrate",
    );
  if (
    Object.values(state.jobs).some(
      (j) =>
        j.id !== job.id &&
        j.id !== upgrade?.observationJobId &&
        !["succeeded", "failed", "cancelled", "expired"].includes(j.state),
    ) ||
    state.lease ||
    state.localUnknown ||
    state.controlBlocked ||
    status.control.activeOperations !== 0 ||
    status.control.activeIds?.length ||
    status.lease ||
    status.stopping
  )
    fail(
      "MIGRATION_BUSY",
      "Migration requires zero physical operations, no lease and exactly one unresolved job",
    );
  if (
    status.control.instanceId !== owner.nonce ||
    status.control.buildHash !==
      (upgrade?.departingBuildHash || identity.buildHash) ||
    status.control.generation !== (state.controlGeneration || 0) ||
    status.control.contextEpoch !== (state.contextEpoch || 0)
  )
    fail(
      "MIGRATION_FENCE_CHANGED",
      "Broker instance/build/control fences do not match durable state",
    );
  if (
    closed &&
    (!state.paused || !status.paused || status.control.gateClosed !== true)
  )
    fail(
      "GATE_NOT_CLOSED",
      "The authenticated pause must be durable before migration",
    );
  if (upgrade && status.nonterminalJobCount !== 2)
    fail(
      "MIGRATION_FENCE_CHANGED",
      "Second handoff requires public proof of exactly two unresolved jobs",
    );
  if (upgrade) policy.assertUpgrade(upgrade, snapshot, clientId);
  return job;
}

// This state machine has no process, SDK, credential or deployment authority of
// its own. Production ports below provide those narrowly fenced capabilities.
export function createMigrator(p: MigrationPorts, policy: MigrationPolicy) {
  return async function migrate({
    jobId,
    requestId,
    approval,
    confirmOwnership,
  }: {
    jobId: string;
    requestId: string;
    approval: unknown;
    confirmOwnership: unknown;
  }) {
    if (
      confirmOwnership !== true ||
      jobId !== p.scope.jobId ||
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 180
    )
      fail(
        "MIGRATION_CONFIRMATION_REQUIRED",
        "Exact job, stable request ID and explicit owner migration confirmation are required",
      );
    await p.authorize(requestId, approval);
    const approved = await p.approve(approval); // Real production admission, before pause or signals.
    const binding = {
      version: 1,
      kind: "atomic-owner-migration",
      requestId,
      jobId,
      clientId: p.clientId,
      approvalHash: hash(JSON.stringify(approved)),
    };
    await p.authenticate(binding, approved);
    await p.claim(binding, approved);
    const record = async <K extends keyof MigrationStages>(
      stage: K,
      value: MigrationStages[K],
    ) => p.publish(stage, value);
    let initial = p.read("initial");
    if (!initial) {
      const snapshot = await p.observe();
      assertHeld(
        policy,
        snapshot,
        p.clientId,
        p.scope,
        false,
        p.auditUpgrade?.(),
      );
      await p.ownerProof(snapshot);
      await p.liveOwner(snapshot.owner);
      initial = await record("initial", snapshot);
    }
    if (!same(p.binding(), binding))
      fail(
        "MIGRATION_INTENT_CONFLICT",
        "Migration intent belongs to another owner, build or request",
      );
    if (p.read("complete")) {
      await p.release(p.read("complete"));
      return p.read("complete");
    }
    let paused = p.read("paused");
    if (!paused) {
      await p.pause(initial, requestId + ":pause");
      paused = await p.observe();
      assertHeld(policy, paused, p.clientId, p.scope, true, p.auditUpgrade?.());
      if (
        !same(paused.owner, initial.owner) ||
        !same(paused.state.jobs, initial.state.jobs) ||
        !same(paused.identity, initial.identity)
      )
        fail(
          "HOLDER_CHANGED",
          "Pause changed the original job history/instance",
        );
      await p.evidence(paused);
      await record("paused", paused);
    }
    let backup = p.read("backup");
    if (!backup)
      backup = await record("backup", await p.backup(paused, approved));
    await p.verifyBackup(backup);
    if (!p.read("stopped")) {
      const alreadyDead = await p.originalDead(paused.owner);
      await p.fence(paused, approved, alreadyDead);
      // Intent is durable BEFORE either signal. Interrupted stop is observed,
      // never guessed successful and never upgraded into a terminal CAD result.
      await record("stop-intent", { owner: paused.owner, backup });
      if (!alreadyDead) await p.stop(paused.owner);
      await p.deadOwner(paused.owner);
      await p.fence(paused, approved, true);
      await record("stopped", {
        owner: paused.owner,
        stateHash: hash(JSON.stringify(paused.state)),
        backup,
      });
    }
    await p.deadOwner(paused.owner);
    if (!p.read("installed"))
      await record("installed", await p.install(approved, backup));
    await p.verifyInstalled(approved);
    const launched = p.read("launch-intent");
    if (!launched)
      await record("launch-intent", { buildHash: approved.buildHash });
    await p.start(approved, !!launched);
    await p.verifyBackup(backup);
    const after = await p.observeNew(approved);
    if (
      !same(after.state, paused.state) ||
      !same(after.identity, paused.identity) ||
      same(after.owner, paused.owner) ||
      after.status.control.activeOperations !== 0 ||
      after.status.control.gateClosed !== true ||
      after.status.paused !== true ||
      after.status.control.buildHash !== approved.buildHash ||
      after.status.control.instanceId !== after.owner.nonce ||
      after.status.control.activeIds?.length ||
      after.status.control.generation !==
        (paused.state.controlGeneration || 0) ||
      after.status.control.contextEpoch !== (paused.state.contextEpoch || 0) ||
      after.status.blocked?.id !== jobId ||
      after.status.nonterminalJobCount !== (p.auditUpgrade?.() ? 2 : 1) ||
      (p.auditUpgrade?.() &&
        after.status.features?.["atomicRecoveryAudit"] !== true) ||
      (p.auditUpgrade?.()?.epochPrerequisite &&
        (after.status.features?.["isolatedScratchEpoch"] !== true ||
          after.status.isolatedScratchScope?.creation !==
            "owner-bound-new-document-only")) ||
      (p.auditUpgrade?.()?.auditResponseRecovery &&
        (after.status.features?.["auditFactsCapture"] !== true ||
          after.status.isolatedScratchScope?.creation !== "unavailable")) ||
      (p.auditUpgrade?.()?.currentInstance &&
        (after.status.features?.["atomicRecoveryProcessLossAudit"] !== true ||
          !same(
            after.status.recoveryAuditScope?.currentInstance,
            p.auditUpgrade!().currentInstance,
          ) ||
          after.status.recoveryAuditScope?.currentModelingAdmission !==
            "blocked" ||
          after.status.recoveryAuditScope?.newInstanceRebound !== false))
    )
      fail(
        "HANDOFF_UNPROVEN",
        "Replacement did not preserve the exact paused unresolved snapshot and original Fusion identity",
      );
    const result = await record("complete", {
      version: 1,
      kind: "atomic-owner-migration",
      requestId,
      jobId,
      previousOwner: paused.owner,
      owner: after.owner,
      originalBuildHash: paused.identity.buildHash,
      observerBuildHash: approved.buildHash,
      backup,
      gateClosed: true,
      unresolved: true,
      sdkRequestsSent: 0,
      nativeOutcome: "unknown",
      rollbackVerification: "not_performed",
      modelValidation: "not_performed",
      ...(p.auditUpgrade?.()
        ? {
            purpose:
              p.auditUpgrade!().purpose || "atomic-recovery-audit-upgrade-v1",
            departingBrokerBuildHash: p.auditUpgrade!().departingBuildHash,
            previousComplete: p.auditUpgrade!().previousComplete,
            preservedJobIds: [jobId, p.auditUpgrade!().observationJobId],
            ...(p.auditUpgrade!().currentInstance
              ? {
                  currentAuditInstance: p.auditUpgrade!().currentInstance,
                  historicalProcessState: "terminated",
                  currentModelingAdmission: "blocked",
                }
              : {}),
          }
        : {}),
    });
    await p.release(result);
    return result;
  };
}
