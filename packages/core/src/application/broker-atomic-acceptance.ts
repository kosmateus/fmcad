import { canonical } from "../domain/queue";
import type { AtomicWorkflowObservation } from "../domain/queue-model";
import type { RecoveryBinding, RecoveryInstance } from "./broker-recovery";

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function sameInstance(a: RecoveryInstance | undefined, b: RecoveryInstance | undefined) {
  return !!a && !!b && a.pid === b.pid && a.birth === b.birth && a.version === b.version;
}

type OwnerOutcome = "committed" | "aborted";
type ResolvedOwnerState = "succeeded" | "failed";

interface AtomicOwnerIdentity {
  commandId: string;
  runId: string;
  requestHash: string;
  backend: string;
  sessionNonce: string;
  documentIdentity: {
    expected: { creationId: string };
    resolved: { creationId: string };
  };
  resolvedIdentity: { creationId: string };
}

interface AtomicOwnerProof {
  version: number;
  kind: string;
  targetJobId: string;
  targetRequestId: string;
  observerJobId: string;
  observerRequestId: string;
  clientId: string;
  projectDirectory: string;
  reportPath: string;
  reportFingerprint: string;
  originalBuildHash: string;
  observerBuildHash: string;
  observerInstance: RecoveryInstance;
  identity: AtomicOwnerIdentity;
  identityMatches: boolean;
  readOnlyOperation: string;
  remoteOutcome: string;
  toolFailed: boolean;
  rpcId: string;
  receipt: string;
  binding: RecoveryBinding & {
    observationTargetJobId?: string;
    observationIdentityHash?: string;
  };
  summary: {
    identity?: AtomicOwnerIdentity;
    identityMatches?: boolean;
    outcome: string;
    status: string;
    completed: boolean;
    destroyed: boolean;
    idle: boolean;
    cleanupCompleted?: boolean;
    definitionDeleted?: boolean;
  } | null;
}

interface AtomicOwnerReceipt {
  kind: string;
  targetJobId: string;
  targetRequestId: string;
  clientId: string;
  acceptedOutcome: string;
  resolvedState: string;
  observerJobId: string;
  reportFingerprint: string;
  identity: AtomicOwnerIdentity;
  instance: RecoveryInstance;
  originalBuildHash: string;
  observerBuildHash: string;
  proofPath: string;
  proofSha256: string;
  reportPath: string;
  paused: boolean;
  controlGeneration: number;
  contextEpoch: number;
}

interface AcceptanceFence {
  paused: boolean;
  controlGeneration: number;
  contextEpoch: number;
  blockedId: string | null | undefined;
  activeId: string | null | undefined;
  targetState: string | undefined;
  leased: boolean;
  otherNonterminal?: boolean;
}

interface AtomicAcceptanceIdentity {
  targetId: string;
  requestId: string;
  owner: string;
  outcome: OwnerOutcome;
}

interface ObserverJob {
  id: string;
  requestId: string;
  state: string;
  buildHash: string | undefined;
  projectDirectory: string | undefined;
  marker: AtomicWorkflowObservation | undefined;
}

function sameAtomicEvidence(a: unknown, b: unknown) {
  if (a === b) return true;
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

export function atomicOwnerOutcome(value: string): OwnerOutcome {
  if (value !== "committed" && value !== "aborted")
    deny("INVALID_ACCEPTED_OUTCOME", "Owner acceptance must name the observed committed or aborted outcome");
  return value;
}

function ownerState(outcome: OwnerOutcome): ResolvedOwnerState {
  return outcome === "committed" ? "succeeded" : "failed";
}

function exactBlocked(targetId: string, fence: AcceptanceFence) {
  return fence.targetState === "needs_reconciliation" && fence.blockedId === targetId && fence.activeId === targetId;
}

function acceptanceGate(fence: AcceptanceFence, expected: Pick<AcceptanceFence, "paused" | "controlGeneration" | "contextEpoch">) {
  return fence.paused === expected.paused && fence.controlGeneration === expected.controlGeneration && fence.contextEpoch === expected.contextEpoch;
}

export function requireFreshAtomicAdmission(
  targetId: string,
  eligibility: {
    candidate: boolean;
    fence: AcceptanceFence;
    active: {
      jobId: string | undefined;
      unknown: boolean;
      pending: boolean;
      childRunning: boolean;
    } | null;
    otherActivity: boolean;
  },
) {
  if (!eligibility.candidate)
    deny("WORKFLOW_TYPE_NOT_ALLOWED", "Owner outcome acceptance is restricted to the exact Fasteners atomic job");
  if (!exactBlocked(targetId, eligibility.fence))
    deny("NOT_BLOCKED", "The exact Fasteners atomic job is no longer the blocked queue owner");
  if (eligibility.fence.leased)
    deny("QUEUE_BUSY", "An unresolved queue lease prevents atomic owner acceptance");
  const { active } = eligibility;
  if (active && (active.jobId !== targetId || !active.unknown || active.pending || active.childRunning))
    deny("WORKER_PENDING", "Original worker or RPC is still pending; owner acceptance is unavailable");
  if (eligibility.otherActivity)
    deny("BROKER_BUSY", "Another physical admission remains active; owner acceptance is deferred");
}

export function selectFreshAtomicObserver(input: AtomicAcceptanceIdentity & {
  targetHash: string;
  targetBuildHash: string | undefined;
  targetDirectory: string | undefined;
  build: string;
  fence: AcceptanceFence;
  jobs: readonly ObserverJob[];
}) {
  const observers = input.jobs.filter(
    (job) => job.marker?.targetJobId === input.targetId && job.state === "succeeded",
  );
  const observer = observers[0];
  if (observers.length !== 1 || !observer)
    deny("ATOMIC_OBSERVATION_REQUIRED", "Exactly one successful scoped atomic status observation is required");
  const marker = observer.marker;
  if (
    !marker ||
    marker.targetRequestId !== input.requestId ||
    marker.targetClientId !== input.owner ||
    marker.targetJobHash !== input.targetHash ||
    marker.targetBuildHash !== input.targetBuildHash ||
    marker.observerBuildHash !== input.build ||
    observer.buildHash !== input.build ||
    observer.projectDirectory !== marker.projectDirectory ||
    marker.projectDirectory !== input.targetDirectory ||
    !acceptanceGate(input.fence, marker)
  )
    deny("WORKFLOW_GATE_CHANGED", "Owner, pause, context, job or build fence changed after the scoped observation");
  if (hasOtherNonterminal(input.jobs, input.targetId, observer.id))
    deny("QUEUE_BUSY", "Other queued/local jobs must remain held until the scoped owner acceptance is complete");
  return { observer, marker };
}

export function hasOtherNonterminal(
  jobs: readonly { id: string; state: string }[],
  targetId: string,
  observerId: string,
) {
  return jobs.some((job) =>
    job.id !== targetId && job.id !== observerId &&
    !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
  );
}

export function requirePersistedOwnerAcceptance(receipt: AtomicOwnerReceipt, input: AtomicAcceptanceIdentity) {
  if (
    receipt.kind !== "atomic-workflow-owner-acceptance" ||
    receipt.targetJobId !== input.targetId ||
    receipt.targetRequestId !== input.requestId ||
    receipt.clientId !== input.owner ||
    receipt.acceptedOutcome !== input.outcome ||
    receipt.resolvedState !== ownerState(input.outcome)
  )
    deny("ACCEPTANCE_CONFLICT", "A different owner outcome was already durably accepted for this job");
}

export function requirePersistedAtomicObserver(
  receipt: AtomicOwnerReceipt,
  targetId: string,
  observer: { state: string; targetJobId: string | undefined; expectedPath: string } | undefined,
) {
  if (
    !observer ||
    observer.state !== "succeeded" ||
    observer.targetJobId !== targetId ||
    observer.expectedPath !== receipt.proofPath
  )
    deny("ACCEPTANCE_RECEIPT_MISMATCH", "Persisted owner acceptance no longer binds the unique scoped observer");
}

export function requirePersistedAtomicProof(
  receipt: AtomicOwnerReceipt,
  evidence: { value: AtomicOwnerProof; sha256: string },
) {
  if (evidence.sha256 !== receipt.proofSha256)
    deny("ACCEPTANCE_RECEIPT_MISMATCH", "Scoped atomic proof changed after owner acceptance");
  const proof = evidence.value;
  if (
    proof.version !== 1 ||
    proof.kind !== "atomic_holder_status" ||
    proof.targetJobId !== receipt.targetJobId ||
    proof.observerJobId !== receipt.observerJobId ||
    proof.identityMatches !== true ||
    proof.readOnlyOperation !== "atomic_status" ||
    proof.remoteOutcome !== "succeeded" ||
    proof.toolFailed === true ||
    proof.summary?.outcome !== receipt.acceptedOutcome ||
    proof.summary?.destroyed !== true ||
    proof.summary?.idle !== true ||
    !sameAtomicEvidence(receipt.identity, proof.identity) ||
    receipt.reportFingerprint !== proof.reportFingerprint ||
    (receipt.instance && !sameInstance(receipt.instance, proof.observerInstance))
  )
    deny("ACCEPTANCE_RECEIPT_MISMATCH", "Scoped proof no longer matches the persisted owner acceptance");
}

export function decidePersistedAtomicAcceptance(
  receipt: AtomicOwnerReceipt,
  proof: AtomicOwnerProof,
  remote: { outcome: string; expectedPath: string },
  fence: AcceptanceFence,
): "already-settled" | "validate-current" {
  if (
    remote.outcome !== "succeeded" ||
    proof.binding?.jobId !== receipt.observerJobId ||
    proof.binding?.rpcId !== proof.rpcId ||
    proof.binding?.buildHash !== receipt.observerBuildHash ||
    proof.receipt !== remote.expectedPath
  )
    deny("ACCEPTANCE_RECEIPT_MISMATCH", "Original scoped transport receipt is no longer valid");
  if (fence.targetState === receipt.resolvedState) return "already-settled";
  assertPersistedFence(receipt, fence);
  return "validate-current";
}

function assertPersistedFence(receipt: AtomicOwnerReceipt, fence: AcceptanceFence) {
  if (!exactBlocked(receipt.targetJobId, fence))
    deny("ACCEPTANCE_INCOMPLETE", "Prior owner acceptance receipt cannot be applied to the current queue state");
  if (!acceptanceGate(fence, receipt) || fence.leased || fence.otherNonterminal)
    deny("WORKFLOW_GATE_CHANGED", "Queue changed since owner acceptance was durably recorded");
}

export function requirePersistedAtomicInstance(
  receipt: AtomicOwnerReceipt,
  identity: { buildHash: string; instance: RecoveryInstance },
  targetBuild: string | undefined,
  isAlive: () => boolean,
) {
  if (
    targetBuild !== receipt.originalBuildHash ||
    identity.buildHash !== receipt.originalBuildHash ||
    !sameInstance(identity.instance, receipt.instance) ||
    !isAlive()
  )
    deny("INSTANCE_CHANGED", "Original Fusion identity changed since owner acceptance was recorded");
}

export function requireFreshAtomicInstance(
  identity: { buildHash: string; instance: RecoveryInstance },
  brokerInstance: RecoveryInstance,
  targetBuild: string | undefined,
  isAlive: () => boolean,
) {
  if (targetBuild !== identity.buildHash || !sameInstance(brokerInstance, identity.instance))
    deny("BUILD_CHANGED", "Original target job/instance binding changed before acceptance");
  if (!isAlive())
    deny("INSTANCE_CHANGED", "The original Fusion PID/birth identity is no longer alive at owner acceptance");
}

export function completePersistedAtomicAcceptance(
  receipt: AtomicOwnerReceipt,
  input: AtomicAcceptanceIdentity,
  report: { fingerprint: string; identity: AtomicOwnerIdentity; isCurrent(): boolean },
  acceptancePath: string,
  fence: AcceptanceFence,
) {
  if (
    report.fingerprint !== receipt.reportFingerprint ||
    !sameAtomicEvidence(report.identity, receipt.identity) ||
    !report.isCurrent()
  )
    deny("WORKFLOW_REPORT_CHANGED", "Atomic report changed since owner acceptance was durably recorded");
  assertPersistedFence(receipt, fence);
  return ownerResolution(input.outcome, acceptancePath, receipt.observerJobId);
}

function ownerResolution(outcome: OwnerOutcome, path: string, observerId: string) {
  const state = ownerState(outcome);
  return {
    state,
    code: outcome === "committed" ? "OWNER_ACCEPTED_ATOMIC_COMMIT" : "OWNER_ACCEPTED_ATOMIC_ABORT",
    executionOutcome: state,
    mayHaveMutated: true,
    sdkSettled: true,
    publicationOutcome: "unavailable",
    acceptanceReceipt: path,
    observationJobId: observerId,
    nativeOutcome: outcome,
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  } as const;
}

export function requireFreshAtomicProof(input: AtomicAcceptanceIdentity & {
  observer: { id: string; requestId: string };
  marker: AtomicWorkflowObservation;
  expectedInstance: RecoveryInstance;
  proof: AtomicOwnerProof;
  build: string;
}) {
  const { observer, marker, expectedInstance, proof, build } = input;
  if (
    proof.version !== 1 ||
    proof.kind !== "atomic_holder_status" ||
    proof.targetJobId !== input.targetId ||
    proof.targetRequestId !== input.requestId ||
    proof.observerJobId !== observer.id ||
    proof.observerRequestId !== observer.requestId ||
    proof.clientId !== input.owner ||
    proof.projectDirectory !== marker.projectDirectory ||
    proof.reportPath !== marker.reportPath ||
    proof.reportFingerprint !== marker.reportFingerprint ||
    proof.originalBuildHash !== marker.targetBuildHash ||
    proof.observerBuildHash !== build ||
    proof.readOnlyOperation !== "atomic_status" ||
    proof.remoteOutcome !== "succeeded" ||
    proof.toolFailed === true
  )
    deny("RECEIPT_MISMATCH", "Scoped proof envelope, owner, build or transport outcome differs from the authorized observation");
  const summary = proof.summary;
  if (proof.identityMatches !== true || !summary || summary.identityMatches === false || !sameAtomicEvidence(summary.identity, proof.identity))
    deny("RECEIPT_MISMATCH", "Atomic status summary identity does not exactly match the report-bound holder identity");
  if (
    !sameAtomicEvidence(proof.identity, {
      commandId: marker.commandId,
      runId: proof.identity?.runId,
      requestHash: proof.identity?.requestHash,
      backend: "addin",
      sessionNonce: marker.sessionNonce,
      documentIdentity: proof.identity?.documentIdentity,
      resolvedIdentity: proof.identity?.documentIdentity?.resolved,
    }) ||
    proof.identity?.documentIdentity?.expected?.creationId !== marker.docId ||
    proof.identity?.documentIdentity?.resolved?.creationId !== marker.docId ||
    proof.identity?.resolvedIdentity?.creationId !== marker.docId
  )
    deny("RECEIPT_MISMATCH", "Scoped proof identity does not match the original command, session and document pin");
  if (!sameInstance(proof.observerInstance, expectedInstance))
    deny("INSTANCE_CHANGED", "Atomic status proof came from a different Fusion PID/birth/version");
  if (
    summary.outcome !== input.outcome ||
    summary.destroyed !== true ||
    summary.idle !== true ||
    (input.outcome === "committed" && (summary.status !== "completed" || summary.completed !== true)) ||
    (input.outcome === "aborted" && (summary.status !== "terminated" || summary.completed !== false))
  )
    deny("OBSERVED_OUTCOME_MISMATCH", "Atomic status does not show the exact owner-selected destroyed and idle terminal outcome");
  return summary;
}

export function requireFreshAtomicReport(
  proof: AtomicOwnerProof,
  marker: AtomicWorkflowObservation,
  report: {
    fingerprint: string;
    commandId: string;
    sessionNonce: string;
    docId: string;
    identity: AtomicOwnerIdentity;
  },
) {
  if (
    report.fingerprint !== marker.reportFingerprint ||
    report.fingerprint !== proof.reportFingerprint ||
    report.commandId !== marker.commandId ||
    report.sessionNonce !== marker.sessionNonce ||
    report.docId !== marker.docId ||
    !sameAtomicEvidence(report.identity, proof.identity)
  )
    deny("WORKFLOW_REPORT_CHANGED", "Atomic report identity/history changed after the holder observation");
}

export function requireFreshAtomicRemoteBinding(proof: AtomicOwnerProof, expected: {
  instance: RecoveryInstance;
  receiptPath: string;
  observerId: string;
  targetId: string;
  build: string;
  identityHash: string;
}) {
  if (
    !/^[a-f0-9-]{36}$/.test(proof.rpcId || "") ||
    proof.receipt !== expected.receiptPath ||
    proof.binding?.jobId !== expected.observerId ||
    proof.binding?.rpcId !== proof.rpcId ||
    proof.binding?.buildHash !== expected.build ||
    proof.binding?.observationKind !== "atomic_holder_status" ||
    proof.binding?.observationTargetJobId !== expected.targetId ||
    proof.binding?.observationIdentityHash !== expected.identityHash ||
    !sameInstance(proof.observerInstance, expected.instance)
  )
    deny("RECEIPT_MISMATCH", "Scoped atomic status transport receipt is not bound to the observed target/build/identity");
}

export function completeFreshAtomicAcceptance(input: AtomicAcceptanceIdentity & {
  proof: AtomicOwnerProof;
  summary: NonNullable<AtomicOwnerProof["summary"]>;
  marker: AtomicWorkflowObservation;
  remoteOutcome: string;
  proofPath: string;
  proofSha256: string;
  acceptancePath: string;
  acceptedAt: string;
  reportCurrent(): boolean;
  fence: AcceptanceFence;
}) {
  const { proof, summary, marker, fence, outcome } = input;
  if (input.remoteOutcome !== "succeeded")
    deny("RECEIPT_MISMATCH", "Scoped atomic status transport receipt is not a successful terminal receipt");
  if (!input.reportCurrent() || !exactBlocked(input.targetId, fence) || !acceptanceGate(fence, marker) || fence.leased)
    deny("WORKFLOW_GATE_CHANGED", "Report or queue fences changed during owner acceptance; unresolved blocker is retained");
  const acceptance = {
    version: 1,
    kind: "atomic-workflow-owner-acceptance",
    targetJobId: input.targetId,
    targetRequestId: input.requestId,
    observerJobId: proof.observerJobId,
    observerRequestId: proof.observerRequestId,
    clientId: input.owner,
    acceptedOutcome: outcome,
    resolvedState: ownerState(outcome),
    projectDirectory: marker.projectDirectory,
    reportPath: marker.reportPath,
    reportFingerprint: marker.reportFingerprint,
    identity: proof.identity,
    instance: proof.observerInstance,
    originalBuildHash: marker.targetBuildHash,
    observerBuildHash: proof.observerBuildHash,
    paused: marker.paused,
    controlGeneration: marker.controlGeneration,
    contextEpoch: marker.contextEpoch,
    proofPath: input.proofPath,
    proofSha256: input.proofSha256,
    remoteReceipt: { rpcId: proof.rpcId, outcome: input.remoteOutcome, observerBuildHash: proof.observerBuildHash },
    effects: {
      nativeOutcome: outcome,
      destroyed: true,
      idleAtObservation: true,
      cleanupCompleted: summary.cleanupCompleted === true,
      definitionDeleted: summary.definitionDeleted === true,
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
      mayHaveMutated: true,
    },
    acceptedAt: input.acceptedAt,
  } as const;
  return {
    acceptance,
    resolution: {
      ...ownerResolution(outcome, input.acceptancePath, proof.observerJobId),
      cleanupCompleted: acceptance.effects.cleanupCompleted,
      definitionDeleted: acceptance.effects.definitionDeleted,
    },
  };
}
