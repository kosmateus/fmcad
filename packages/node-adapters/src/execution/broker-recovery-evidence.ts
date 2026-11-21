import { createHash } from "node:crypto";
import type {
  RecoveryDispatch,
  RecoveryEvidence,
  RecoveryNativeEnd,
  RecoveryProbe,
  RecoveryProbeStage,
} from "../../../core/src/application/broker-recovery";

type WorkerResult = NonNullable<
  ReturnType<RecoveryEvidence<RecoveryDispatch, never>["readWorkerResult"]>
> & { workflowOutcome?: unknown };
type RuntimeReads =
  | "readFence"
  | "assertWorkerStopped"
  | "readNativeLifecycle"
  | "validateTerminalResponse"
  | "probeRequestHash"
  | "readWorkerResult"
  | "readProbeIntent"
  | "readRemoteReceipt";

interface RecoveryRecords<Dispatch extends RecoveryDispatch> extends Omit<
  RecoveryEvidence<Dispatch, never>,
  RuntimeReads
> {
  readProbeIntent(jobId: string, stage: "reconcile"): RecoveryProbe | null;
  readProbeIntent(
    jobId: string,
    stage: Exclude<RecoveryProbeStage, "reconcile">,
  ): RecoveryProbe | null;
  findRemoteReceipt(
    record: Parameters<
      RecoveryEvidence<Dispatch, never>["readRemoteReceipt"]
    >[0],
    stage?: RecoveryProbeStage | "atomic-observation",
  ): ReturnType<RecoveryEvidence<Dispatch, never>["readRemoteReceipt"]>;
  readWorkerResult(jobId: string): WorkerResult | null;
  readWorkerIdentity(jobId: string): unknown;
  readWorkerStart(jobId: string): unknown;
}

interface RecoveryRuntime<
  Dispatch extends RecoveryDispatch,
  Native extends RecoveryNativeEnd,
  Declaration,
> extends Pick<
  RecoveryEvidence<Dispatch, Native>,
  "readFence" | "validateTerminalResponse"
> {
  workerContext(): "pending" | "closed" | "absent";
  processBirth(pid: number): string;
  workflowNonterminal(value: unknown): boolean;
  nativeReceipts: {
    start(record: Dispatch): Declaration | null;
    completion(record: Dispatch, declaration: Declaration): Native | null;
  };
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function validBirth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/.test(value)
  );
}

function processIsGone(pid: number): boolean {
  try {
    // Signal zero queries the PID in the broker's process namespace; it sends
    // no signal. ENOENT from reading birth may instead be an unavailable boot ID.
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

/** Adapts the existing records reader and canonical broker checks. There is
 * deliberately no writer, transport sender or alternate job store here. */
export function createBrokerRecoveryEvidence<
  Dispatch extends RecoveryDispatch,
  Native extends RecoveryNativeEnd,
  Declaration,
>(
  records: RecoveryRecords<Dispatch>,
  runtime: RecoveryRuntime<Dispatch, Native, Declaration>,
): RecoveryEvidence<Dispatch, Native> {
  return {
    readFence: runtime.readFence,
    assertWorkerStopped(jobId) {
      const worker = runtime.workerContext();
      if (worker === "pending")
        fail(
          "WORKER_PENDING",
          "Owned worker or broker RPC is still pending; no probe sent",
        );
      if (worker === "closed") return;
      const identity = records.readWorkerIdentity(jobId);
      if (identity === null) {
        if (records.readWorkerStart(jobId))
          fail(
            "WORKER_IDENTITY_UNAVAILABLE",
            "Original worker spawn has no durable process identity",
          );
        return;
      }
      if (
        !identity ||
        typeof identity !== "object" ||
        !("pid" in identity) ||
        typeof identity.pid !== "number" ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0 ||
        identity.pid > 0x7fffffff ||
        !("birth" in identity) ||
        !validBirth(identity.birth)
      )
        fail(
          "WORKER_IDENTITY_UNAVAILABLE",
          "Original worker identity is malformed",
        );
      let birth: string;
      try {
        birth = runtime.processBirth(identity.pid);
      } catch {
        if (processIsGone(identity.pid)) return;
        fail(
          "WORKER_IDENTITY_UNAVAILABLE",
          "Cannot establish whether the original worker is still alive",
        );
      }
      if (!validBirth(birth))
        fail(
          "WORKER_IDENTITY_UNAVAILABLE",
          "Current worker identity is malformed",
        );
      if (birth === identity.birth)
        fail(
          "WORKER_PENDING",
          "Original local worker is still alive; no probe sent",
        );
    },
    readWorkerResult(jobId) {
      const worker = records.readWorkerResult(jobId);
      return (
        worker && {
          ...worker,
          nonterminal:
            !!worker.nonterminal ||
            runtime.workflowNonterminal(worker.workflowOutcome),
        }
      );
    },
    readAdapterOutcome: (jobId) => records.readAdapterOutcome(jobId),
    readProbeIntent: (jobId, stage) =>
      stage === "reconcile"
        ? records.readProbeIntent(jobId, "reconcile")
        : records.readProbeIntent(jobId, stage),
    readCompletedPreflight: (jobId) => records.readCompletedPreflight(jobId),
    readRpcRecords: (jobId) => records.readRpcRecords(jobId),
    readRemoteReceipt: (record, stage) =>
      records.findRemoteReceipt(
        record,
        stage ??
          (record.binding.observationKind === "atomic_holder_status"
            ? "atomic-observation"
            : undefined),
      ),
    readOutcome: (jobId) => records.readOutcome(jobId),
    probeRequestHash: (stage, id, rpcId) =>
      createHash("sha256").update(`${stage}:${id}:${rpcId}`).digest("hex"),
    validateTerminalResponse: runtime.validateTerminalResponse,
    readNativeLifecycle(record) {
      const declaration = runtime.nativeReceipts.start(record);
      if (declaration === null) return { kind: "notDeclared" };
      const proof = runtime.nativeReceipts.completion(record, declaration);
      return proof ? { kind: "completed", proof } : { kind: "pending" };
    },
  };
}
