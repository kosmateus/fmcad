import { createHash } from "node:crypto";
import type {
  RecoveryDispatch,
  RecoveryEvidence,
  RecoveryProbe,
  RecoveryProbeStage,
} from "../../../core/src/application/broker-recovery";

type WorkerResult = NonNullable<
  ReturnType<RecoveryEvidence<RecoveryDispatch, never>["readWorkerResult"]>
> & { workflowOutcome?: unknown };
type NativeEnd = RecoveryDispatch["binding"] & { outcome: string };

type RuntimeReads =
  | "readFence"
  | "assertWorkerStopped"
  | "readNativeEnd"
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
  readWorkerIdentity(jobId: string): { pid: number; birth: string } | null;
  readWorkerStart(jobId: string): unknown;
}

interface RecoveryRuntime<
  Dispatch extends RecoveryDispatch,
  Native extends NativeEnd,
> extends Pick<
  RecoveryEvidence<Dispatch, Native>,
  "readFence" | "readNativeEnd" | "validateTerminalResponse"
> {
  workerContext(): "pending" | "closed" | "absent";
  processBirth(pid: number): string;
  workflowNonterminal(value: unknown): boolean;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Adapts the existing records reader and canonical broker checks. There is
 * deliberately no writer, transport sender or alternate job store here. */
export function createBrokerRecoveryEvidence<
  Dispatch extends RecoveryDispatch,
  Native extends NativeEnd,
>(
  records: RecoveryRecords<Dispatch>,
  runtime: RecoveryRuntime<Dispatch, Native>,
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
      if (!identity) {
        if (records.readWorkerStart(jobId))
          fail(
            "WORKER_IDENTITY_UNAVAILABLE",
            "Original worker spawn has no durable process identity",
          );
        return;
      }
      let birth: string;
      try {
        birth = runtime.processBirth(identity.pid);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        )
          return;
        throw error;
      }
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
    readNativeEnd: runtime.readNativeEnd,
  };
}
