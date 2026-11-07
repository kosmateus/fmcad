/** Broker execution application. Effects, clocks and durable records are ports;
 * neither a disconnected observer nor a rejected promise authorizes replay. */
export interface DispatchPorts<Prepared, Reply, Result> {
  prepare(): Prepared | Promise<Prepared>;
  /** Offline checker seam. It must finish before requesting SDK admission. */
  check(prepared: Prepared): void | Promise<void>;
  /** The adapter must invoke send synchronously with its grant. */
  admit(send: () => Promise<Reply>): Promise<Reply>;
  /** Recheck build/input/instance/document/reset fences on the actual boundary. */
  fence(prepared: Prepared): void;
  send(prepared: Prepared): Promise<Reply>;
  settle(prepared: Prepared, reply: Reply): Result | Promise<Result>;
  unknown(error: unknown): void;
  /** A local refusal before this RPC's physical send, not a rollback claim. */
  notSubmitted?(error: unknown): void;
}

export async function dispatchPrepared<Prepared, Reply, Result>(
  ports: DispatchPorts<Prepared, Reply, Result>,
): Promise<Result> {
  let submitted = false;
  try {
    const prepared = await ports.prepare();
    await ports.check(prepared);
    const reply = await ports.admit(() => {
      ports.fence(prepared);
      // No await between the final fence/grant and invoking the physical port.
      submitted = true;
      return ports.send(prepared);
    });
    return await ports.settle(prepared, reply);
  } catch (error) {
    if (submitted) ports.unknown(error);
    else ports.notSubmitted?.(error);
    throw error;
  }
}

export interface CompletionPorts<Settled, Published> {
  settle(): Promise<Settled>;
  /** Native termination and required postflight must be proven before release. */
  postflight(settled: Settled): Promise<void | false>;
  release(settled: Settled): void;
  /** Potentially slow, local publication never owns the physical turn. */
  finalize(settled: Settled): Published | Promise<Published>;
}

export async function completeSdkTurn<Settled, Published>(
  ports: CompletionPorts<Settled, Published>,
): Promise<Published | undefined> {
  const settled = await ports.settle();
  if ((await ports.postflight(settled)) === false) return undefined;
  ports.release(settled);
  return ports.finalize(settled);
}

export interface ExecutionEvidence {
  transportFailed?: boolean | undefined;
  receiptOutcome?: string | undefined;
  nativeOutcome?: string | undefined;
}

/** Native execution and synchronous transport are independent evidence. */
export function executionFailed(evidence: ExecutionEvidence): boolean {
  return (
    evidence.transportFailed === true ||
    evidence.receiptOutcome === "failed" ||
    evidence.nativeOutcome === "failed"
  );
}

export interface ReconciliationEvidence {
  outputAvailable: boolean;
  adapterUnknown: boolean;
  receipts: ReadonlyArray<{ outcome: string }>;
  records: ReadonlyArray<{ failed?: boolean | undefined }>;
  nativeEnds: ReadonlyArray<{ outcome: string }>;
}

export function reconciledExecution(
  evidence: ReconciliationEvidence,
): "succeeded" | "failed" {
  return evidence.outputAvailable &&
    !evidence.adapterUnknown &&
    evidence.receipts.every((value) => value.outcome === "succeeded") &&
    !evidence.records.some((value) => value.failed) &&
    evidence.nativeEnds.every((value) => value.outcome === "succeeded")
    ? "succeeded"
    : "failed";
}

export interface LocalCandidate {
  id: string;
  clientId: string;
  order: number;
}

/** Independent fair local scheduling; does not grant ownership of Fusion. */
export function nextLocalWorker<Job extends LocalCandidate>(
  jobs: ReadonlyArray<Job>,
  lastClient: string | null,
): Job | undefined {
  const clients = [...new Set(jobs.map((job) => job.clientId))].sort();
  const client =
    clients.find((id) => lastClient === null || id > lastClient) ?? clients[0];
  return jobs
    .filter((job) => job.clientId === client)
    .sort((a, b) => a.order - b.order)[0];
}
