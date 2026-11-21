import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { reconciledExecution } from "../../../core/src/application/execution";
import type {
  RecoveryDispatch,
  RecoveryEvidence,
  RecoveryNativeEnd,
  RecoveryInstance,
  RecoveryObservationGrant,
  RecoveredDispatch,
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

/** Host IO for the recovery observation selected by the core policy.
 * An offline or unsent probe must not publish an intent. */
export function observeBrokerRecovery(
  job: { id: string; directory: string; instance: RecoveryInstance; buildHash: string },
  previous: RecoveryProbe | null,
  grant: RecoveryObservationGrant,
  ports: {
    read(file: string): unknown;
    write(file: string, value: unknown, fresh?: boolean): void;
    send(
      options: {
        binding: Pick<RecoveryProbe["binding"], "jobId" | "rpcId" | "requestHash" | "buildHash">;
        receiptPath: string;
        diagnosticPath: string;
      },
      fence: { assertCurrent(): void; start(): void },
    ): Promise<unknown>;
  },
) {
  const rpcId = randomUUID();
  const binding = {
    jobId: job.id,
    rpcId,
    requestHash: createHash("sha256").update(`reconcile:${job.id}:${rpcId}`).digest("hex"),
    buildHash: job.buildHash,
  };
  const receipt = path.join(job.directory, `reconcile-${rpcId}.receipt.json`);
  return ports.send(
    {
      binding,
      receiptPath: receipt,
      diagnosticPath: path.join(job.directory, `reconcile-${rpcId}.result.json`),
    },
    {
      assertCurrent: grant.assertCurrent,
      start() {
        grant.beforeSend();
        if (previous) {
          const archived = path.join(job.directory, `reconcile-probe-${previous.binding.rpcId}.json`);
          grant.assertCurrent();
          if (lstatSync(archived, { throwIfNoEntry: false })) {
            if (!isDeepStrictEqual(ports.read(archived), previous))
              fail("RECEIPT_MISMATCH", "Archived recovery intent differs");
          } else ports.write(archived, previous, true);
        }
        grant.assertCurrent();
        ports.write(
          path.join(job.directory, "reconcile-probe.json"),
          { binding, instance: job.instance, receipt },
          !previous,
        );
      },
    },
  );
}

/** Publish only the original, bound output; this port never sends more SDK work. */
export function publishBrokerRecoveredDispatch<
  Dispatch extends RecoveryDispatch,
  Native extends RecoveryNativeEnd,
  Response,
  Result,
>(
  directory: string,
  decision: RecoveredDispatch<Dispatch, Native>,
  assertCurrent: () => void,
  ports: {
    rpc: boolean;
    readOutput(): Response | null;
    restoreOutput(record: Dispatch): Response;
    publishOutput(response: Response): void;
    successfulOutput(response: Response): boolean;
    describeNativeEnd(proof: Native): unknown;
    write(file: string, value: unknown): void;
    resolve(details: unknown): Result;
  },
) {
  assertCurrent();
  ports.write(path.join(directory, "reconcile-postflight.json"), decision.observation);
  let output = ports.rpc ? ports.readOutput() : null;
  const onlyRecord = decision.records.length === 1 ? decision.records[0] : undefined;
  if (!output && ports.rpc && onlyRecord?.terminal) {
    output = ports.restoreOutput(onlyRecord);
    assertCurrent();
    ports.publishOutput(output);
  }
  const available =
    !decision.adapterUnknown &&
    (ports.rpc ? !!output && ports.successfulOutput(output) : decision.workerSucceeded);
  const details = {
    state: reconciledExecution({
      outputAvailable: available,
      adapterUnknown: decision.adapterUnknown,
      receipts: decision.receipts,
      records: decision.records,
      nativeEnds: decision.nativeEnds,
    }),
    code: decision.workerTerminal || output ? "RECONCILED" : "RESULT_UNAVAILABLE",
    mayHaveMutated: true,
    sdkSettled: true,
    publicationOutcome: available ? "published" : "unavailable",
    limitations:
      "Synchronous receipts alone do not prove native background completion or model/physical validation.",
    ...(decision.nativeEnds.length
      ? { nativeCompletion: decision.nativeEnds.map(ports.describeNativeEnd) }
      : {}),
  };
  assertCurrent();
  ports.write(path.join(directory, "outcome.json"), details);
  assertCurrent();
  return ports.resolve(details);
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
