import type { QueueJob } from "../domain/queue-model";

export interface RecoveryInstance {
  pid: number;
  birth: string;
  version: string;
  activeCommand?: string;
}

export interface RecoveryBinding {
  jobId: string;
  rpcId: string;
  requestHash: string;
  buildHash: string;
  sourceHash?: string;
  isolatedEpoch?: string;
  observationKind?: string;
}

interface ReceiptReference {
  binding: RecoveryBinding;
  instance: RecoveryInstance;
  receipt?: string;
}

export interface RecoveryReceipt extends RecoveryBinding {
  terminal: boolean;
  outcome: string;
  instance: RecoveryInstance;
}

export interface RecoveryDispatch extends ReceiptReference {
  method: string;
  terminal: boolean;
  nonterminal?: boolean;
  failed?: boolean;
  remoteReceipt?: RecoveryReceipt;
}

export type RecoveryProbeStage = "preflight" | "postflight" | "reconcile";
export interface RecoveryProbe extends ReceiptReference {
  // Recovery probe intents didn't record these redundant top-level fields.
  jobId?: string;
  buildHash?: string;
}

export interface CompletedPreflight {
  jobId: string;
  buildHash: string;
  completed?: boolean;
  instance: RecoveryInstance;
}

type NativeEnd = RecoveryBinding & { outcome: string };
export type RecoveryJob = Pick<
  QueueJob,
  "id" | "clientId" | "requestId" | "hash" | "state" | "dispatch"
> & {
  request: Pick<QueueJob["request"], "buildHash"> & { isolatedEpoch?: string };
};

/** Snapshot of the actual authority, not data supplied by a receipt or IPC caller. */
export interface RecoveryFence {
  jobId: string;
  clientId: string;
  requestId: string;
  jobHash: string;
  state: string;
  rpcCount: number;
  brokerInstanceId: string;
  instance: RecoveryInstance;
  buildHash: string;
  executableBuildHash: string;
  epochId: string | null;
  /** Normal admission has an epoch but legacy receipt envelopes do not echo it. */
  receiptEpoch: string | undefined;
  revision: number;
  generation: number;
  contextEpoch: number;
  activeJobId: string | null;
  blockedJobId: string | null;
}

export interface RecoveryEvidence<
  Dispatch extends RecoveryDispatch,
  Native extends NativeEnd,
> {
  /** Read fresh live state, including durable owner and instance identity;
   * return null if the current process no longer has that authority. */
  readFence(jobId: string): RecoveryFence | null;
  assertWorkerStopped(jobId: string): void;
  readWorkerResult(jobId: string): {
    jobId: string;
    terminal?: boolean;
    code: number;
    nonterminal?: boolean;
  } | null;
  readAdapterOutcome(jobId: string): {
    jobId: string;
    buildHash: string;
    unknown?: boolean;
    rpcId?: string;
  } | null;
  readProbeIntent(
    jobId: string,
    stage: RecoveryProbeStage,
  ): RecoveryProbe | null;
  readCompletedPreflight(jobId: string): CompletedPreflight | null;
  readRpcRecords(jobId: string): readonly Dispatch[];
  readRemoteReceipt(
    record: ReceiptReference,
    stage?: RecoveryProbeStage,
  ): RecoveryReceipt | null;
  probeRequestHash(
    stage: "preflight" | "postflight",
    jobId: string,
    rpcId: string,
  ): string;
  validateTerminalResponse(record: Dispatch): void;
  readNativeEnd(record: Dispatch): Native | null;
  readOutcome(jobId: string): unknown;
}

class EvidenceBlocked extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function deny(code: string, message: string): never {
  throw new EvidenceBlocked(code, message);
}

function sameInstance(
  left: RecoveryInstance,
  right: RecoveryInstance,
): boolean {
  return (
    !!left &&
    !!right &&
    left.pid === right.pid &&
    left.birth === right.birth &&
    left.version === right.version
  );
}

function idle(instance: RecoveryInstance): boolean {
  return (
    instance.activeCommand === "" || instance.activeCommand === "SelectCommand"
  );
}

// Ignore observations such as activeCommand; the process incarnation is the fence.
function sameFence(left: RecoveryFence, right: RecoveryFence): boolean {
  return (
    sameInstance(left.instance, right.instance) &&
    left.jobId === right.jobId &&
    left.clientId === right.clientId &&
    left.requestId === right.requestId &&
    left.jobHash === right.jobHash &&
    left.state === right.state &&
    left.rpcCount === right.rpcCount &&
    left.brokerInstanceId === right.brokerInstanceId &&
    left.buildHash === right.buildHash &&
    left.executableBuildHash === right.executableBuildHash &&
    left.epochId === right.epochId &&
    left.receiptEpoch === right.receiptEpoch &&
    left.revision === right.revision &&
    left.generation === right.generation &&
    left.contextEpoch === right.contextEpoch &&
    left.activeJobId === right.activeJobId &&
    left.blockedJobId === right.blockedJobId
  );
}

function receiptMatches(
  left: RecoveryBinding,
  right: RecoveryBinding,
): boolean {
  return (
    left.jobId === right.jobId &&
    left.rpcId === right.rpcId &&
    left.requestHash === right.requestHash &&
    left.buildHash === right.buildHash &&
    left.sourceHash === right.sourceHash &&
    left.isolatedEpoch === right.isolatedEpoch &&
    left.observationKind === right.observationKind
  );
}

export type RecoveryDecision<Dispatch, Native> =
  | {
      kind: "waitingForEvidence";
      code: string;
      message: string;
      /** Present only after original work and any prior probe are proven settled. */
      observation?: { priorFailed: RecoveryProbe | null };
    }
  | { kind: "settled"; dispatched: false; preflight: RecoveryInstance | null }
  | {
      kind: "settled";
      dispatched: true;
      observation: RecoveryInstance;
      records: readonly Dispatch[];
      receipts: readonly RecoveryReceipt[];
      nativeEnds: readonly Native[];
      workerSucceeded: boolean;
      workerTerminal: boolean;
      adapterUnknown: boolean;
    };

/** Read original evidence in place. Neither a waiting decision nor a settled
 * decision starts work or writes state. Consume synchronously against the same
 * fence; after an await call reconcile again, never apply a cached decision. */
export function createBrokerRecovery<
  Dispatch extends RecoveryDispatch,
  Native extends NativeEnd,
>(evidence: RecoveryEvidence<Dispatch, Native>) {
  function assertFence(expected: RecoveryFence): void {
    const current = evidence.readFence(expected.jobId);
    if (!current || !sameFence(expected, current))
      deny(
        "STATE_CONFLICT",
        "Recovery owner, original work or local fence changed",
      );
  }

  function assertJob(job: RecoveryJob, fence: RecoveryFence, local: boolean) {
    if (
      job.id !== fence.jobId ||
      job.clientId !== fence.clientId ||
      job.requestId !== fence.requestId ||
      job.hash !== fence.jobHash ||
      job.state !== fence.state ||
      !Number.isSafeInteger(fence.rpcCount) ||
      fence.rpcCount < 0 ||
      (job.dispatch?.rpcCount || 0) !== fence.rpcCount ||
      (job.request.isolatedEpoch ?? null) !== fence.epochId
    )
      deny(
        "STATE_CONFLICT",
        "Recovery job no longer matches the owned original request",
      );
    if (
      local
        ? fence.activeJobId !== job.id
        : job.state !== "needs_reconciliation" || fence.blockedJobId !== job.id
    )
      deny("NOT_BLOCKED", "Job does not own the expected recovery scope");
    if (
      (job.request.buildHash !== undefined &&
        job.request.buildHash !== fence.buildHash) ||
      (!local && fence.executableBuildHash !== fence.buildHash)
    )
      deny(
        "BUILD_CHANGED",
        "Restore the original executable build before reconciling",
      );
  }

  function readReceipt(
    record: ReceiptReference,
    requireIdle: boolean,
    stage?: RecoveryProbeStage,
    saved?: RecoveryReceipt,
  ) {
    const validate = (value: RecoveryReceipt) => {
      if (
        value.terminal !== true ||
        !["succeeded", "failed"].includes(value.outcome) ||
        !receiptMatches(value, record.binding) ||
        !sameInstance(value.instance, record.instance)
      )
        deny(
          "RECEIPT_MISMATCH",
          "Receipt does not bind the original request/source/build/instance/epoch",
        );
      if (requireIdle && !idle(value.instance))
        deny(
          "NATIVE_RECEIPT_REQUIRED",
          "Remote completion does not prove native idle",
        );
      return value;
    };
    // Check the named file through the port even when the terminal journal
    // retained a copy; an absent duplicate is allowed, a contradictory one isn't.
    const current = evidence.readRemoteReceipt(record, stage);
    if (saved && current && current.outcome !== saved.outcome)
      deny(
        "RECEIPT_MISMATCH",
        "Remote receipt changed after terminal publication",
      );
    if (current) validate(current);
    const value = saved ?? current;
    if (!value)
      deny(
        "RECEIPT_UNAVAILABLE",
        "Original terminal receipt is unavailable; no probe sent",
      );
    return validate(value);
  }

  function boundToJob(
    record: ReceiptReference,
    fence: RecoveryFence,
    probe = false,
  ) {
    return (
      record.binding?.jobId === fence.jobId &&
      typeof record.binding.rpcId === "string" &&
      record.binding.rpcId.length > 0 &&
      typeof record.binding.requestHash === "string" &&
      record.binding.requestHash.length > 0 &&
      record.binding.buildHash === fence.buildHash &&
      record.binding.isolatedEpoch ===
        (probe ? undefined : fence.receiptEpoch) &&
      (!probe || record.binding.sourceHash === undefined) &&
      sameInstance(record.instance, fence.instance)
    );
  }

  function readDispatch(
    job: RecoveryJob,
    fence: RecoveryFence,
    local: boolean,
  ) {
    const records = evidence.readRpcRecords(job.id);
    const receipts: RecoveryReceipt[] = [];
    const nativeEnds: Native[] = [];
    if (records.some((record) => !boundToJob(record, fence)))
      deny(
        "RECEIPT_MISMATCH",
        "RPC journal belongs to a different job, build, instance or epoch",
      );
    if (!local && fence.rpcCount === 0) {
      if (records.some((record) => record.terminal))
        deny(
          "RECEIPT_MISMATCH",
          "Terminal RPC journal conflicts with the undispatched state",
        );
      return { records, receipts, nativeEnds };
    }
    if (
      records.length !== fence.rpcCount ||
      new Set(records.map((record) => record.binding.rpcId)).size !==
        records.length
    )
      deny(
        "RECEIPT_UNAVAILABLE",
        "Complete original dispatch journal is unavailable; no probe sent",
      );
    for (const record of records) {
      if (
        (record.binding.sourceHash !== undefined || record.remoteReceipt) &&
        !record.receipt
      )
        deny(
          "RECEIPT_MISMATCH",
          "Script journal omits its original receipt reference",
        );
      // The records port has already checked the canonical receipt path.
      // Preserve the native lifecycle guard before looking at the remote copy.
      const ended = local ? null : evidence.readNativeEnd(record);
      if (ended) {
        if (!receiptMatches(ended, record.binding))
          deny(
            "RECEIPT_MISMATCH",
            "Native evidence differs from the original dispatch",
          );
        nativeEnds.push(ended);
      }
      if (record.nonterminal && !ended)
        deny(
          "WORKFLOW_RECONCILIATION_REQUIRED",
          "Original workflow has no matching terminal lifecycle receipt",
        );
      if (record.terminal !== true) {
        if (local || !record.receipt)
          deny(
            "RECEIPT_UNAVAILABLE",
            "Original RPC has no terminal completion evidence",
          );
        receipts.push(readReceipt(record, true));
      } else {
        evidence.validateTerminalResponse(record);
        if (record.receipt)
          receipts.push(
            readReceipt(record, true, undefined, record.remoteReceipt),
          );
        else if (
          local &&
          ![
            "initialize",
            "notifications/initialized",
            "ping",
            "tools/list",
          ].includes(record.method)
        )
          deny(
            "NATIVE_RECEIPT_REQUIRED",
            "Native idle completion needs a script receipt",
          );
      }
    }
    return { records, receipts, nativeEnds };
  }

  function readFlight(
    job: RecoveryJob,
    fence: RecoveryFence,
    stage: "preflight" | "postflight",
  ) {
    const started = evidence.readProbeIntent(job.id, stage);
    if (!started) return null;
    if (
      started.jobId !== job.id ||
      started.buildHash !== fence.buildHash ||
      !boundToJob(started, fence, true) ||
      !/^[a-f0-9-]{36}$/.test(started.binding.rpcId) ||
      started.binding.requestHash !==
        evidence.probeRequestHash(stage, job.id, started.binding.rpcId)
    )
      deny(
        "RECEIPT_MISMATCH",
        `${stage} probe binding mismatch; no new probe sent`,
      );
    return readReceipt(started, false, stage);
  }

  function waiting(error: unknown) {
    if (error instanceof EvidenceBlocked)
      return {
        kind: "waitingForEvidence" as const,
        code: error.code,
        message: error.message,
      };
    // Host ports preserve existing typed broker failures; unexpectedly broken
    // adapters are not evidence and must not be mistaken for a valid decision.
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
    )
      return {
        kind: "waitingForEvidence" as const,
        code: error.code,
        message: error.message,
      };
    throw error;
  }

  return {
    /** Call immediately before using a decision in the existing broker's
     * synchronous state transition. Never carry the authorization over an await. */
    assertCurrentFence: assertFence,
    reconcile(
      job: RecoveryJob,
      expectedFence: RecoveryFence,
    ): RecoveryDecision<Dispatch, Native> {
      try {
        assertJob(job, expectedFence, false);
        assertFence(expectedFence);
        evidence.assertWorkerStopped(job.id);
        const worker = evidence.readWorkerResult(job.id);
        if (worker && worker.jobId !== job.id)
          deny("RECEIPT_MISMATCH", "Worker result belongs to a different job");
        if (worker?.nonterminal)
          deny(
            "WORKFLOW_RECONCILIATION_REQUIRED",
            "Typed worker outcome is not terminal",
          );
        const adapter = evidence.readAdapterOutcome(job.id);
        if (
          adapter &&
          (adapter.jobId !== job.id ||
            adapter.buildHash !== expectedFence.buildHash)
        )
          deny(
            "RECEIPT_MISMATCH",
            "Adapter evidence belongs to a different job/build",
          );
        if (adapter?.unknown && (!expectedFence.rpcCount || !adapter.rpcId))
          deny(
            "ADAPTER_RECONCILIATION_REQUIRED",
            "Unbound adapter uncertainty cannot be certified",
          );
        const preflight = readFlight(job, expectedFence, "preflight");
        readFlight(job, expectedFence, "postflight");
        const original = readDispatch(job, expectedFence, false);
        if (expectedFence.rpcCount === 0) {
          if (evidence.readProbeIntent(job.id, "reconcile"))
            deny(
              "RECEIPT_MISMATCH",
              "Recovery probe journal conflicts with the undispatched state",
            );
          const completed = evidence.readCompletedPreflight(job.id);
          if (
            completed &&
            (completed.jobId !== job.id ||
              completed.buildHash !== expectedFence.buildHash ||
              !sameInstance(completed.instance, expectedFence.instance))
          )
            deny(
              "RECEIPT_MISMATCH",
              "Completed preflight is not bound to this job/instance/build",
            );
          assertFence(expectedFence);
          return {
            kind: "settled",
            dispatched: false,
            preflight:
              completed?.completed === true
                ? completed.instance
                : (preflight?.instance ?? null),
          };
        }
        const outcome = evidence.readOutcome(job.id);
        if (
          outcome &&
          typeof outcome === "object" &&
          "code" in outcome &&
          outcome.code === "WORKFLOW_NONTERMINAL" &&
          !original.nativeEnds.length
        )
          deny(
            "WORKFLOW_RECONCILIATION_REQUIRED",
            "A generic synchronous receipt cannot clear a typed workflow fence",
          );
        if (
          adapter?.unknown &&
          !original.nativeEnds.some((proof) => proof.rpcId === adapter.rpcId)
        )
          deny(
            "ADAPTER_RECONCILIATION_REQUIRED",
            "Generic RPC completion cannot certify the adapter result",
          );
        const prior = evidence.readProbeIntent(job.id, "reconcile");
        if (prior && !boundToJob(prior, expectedFence, true))
          deny("RECEIPT_MISMATCH", "Recovery probe identity mismatch");
        const receipt = prior ? readReceipt(prior, true, "reconcile") : null;
        assertFence(expectedFence);
        if (receipt?.outcome !== "succeeded")
          return {
            kind: "waitingForEvidence",
            code: "OBSERVATION_REQUIRED",
            message:
              "Original work settled but an idle recovery observation is still required",
            observation: { priorFailed: prior },
          };
        return {
          kind: "settled",
          dispatched: true,
          ...original,
          observation: receipt.instance,
          workerSucceeded: worker?.terminal === true && worker.code === 0,
          workerTerminal: worker?.terminal === true,
          adapterUnknown: !!adapter?.unknown,
        };
      } catch (error) {
        return waiting(error);
      }
    },
    /** A known pre-send local postflight guard is not a remote receipt. Only the
     * original dispatch journals are relevant here, with the stricter old rules. */
    verifyCompletedDispatch(job: RecoveryJob, expectedFence: RecoveryFence) {
      try {
        assertJob(job, expectedFence, true);
        assertFence(expectedFence);
        readDispatch(job, expectedFence, true);
        assertFence(expectedFence);
        return { kind: "settled" as const };
      } catch (error) {
        return waiting(error);
      }
    },
  };
}
