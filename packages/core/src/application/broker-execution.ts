import { dispatchPrepared, type DispatchPorts } from "./execution";

const consume = Symbol("consume prepared broker turn");

/** A job may receive several grants. Allocate a fresh identity before each
 * logical turn is prepared, and carry that same object into its grant. */
export interface TurnIdentity {
  readonly jobId: string;
}

export function createTurnIdentity(jobId: string): TurnIdentity {
  return Object.freeze({ jobId });
}

function alreadyConsumed() {
  return Object.assign(new Error("A prepared RPC cannot be replayed"), {
    code: "PREPARED_RPC_CONSUMED",
  });
}

/** Local, process-bound authority. A prepared turn is never a recovery record. */
export interface PreparedTurn<Ready> {
  readonly turn: TurnIdentity;
  inspect(check: (ready: Ready) => void): void;
  [consume](): Ready;
}

export async function prepare<Ready>(
  turn: TurnIdentity,
  build: () => Ready | Promise<Ready>,
): Promise<PreparedTurn<Ready>> {
  let ready: { value: Ready } | undefined = { value: await build() };
  const current = () => {
    if (!ready) throw alreadyConsumed();
    return ready.value;
  };
  return Object.freeze({
    turn,
    inspect(check: (value: Ready) => void) {
      check(current());
    },
    [consume]() {
      const value = current();
      ready = undefined;
      return value;
    },
  });
}

export function executeTurn<
  Grant extends { turn: TurnIdentity },
  Ready,
  Reply,
  Result,
>(
  grant: Grant,
  prepared: PreparedTurn<Ready>,
  ports: Omit<DispatchPorts<Ready, Reply, Result>, "prepare" | "fence"> & {
    assertCurrentGrant(grant: Grant): undefined;
    fence(ready: Ready): undefined;
  },
): Promise<Result> {
  return dispatchPrepared({
    ...ports,
    // Consume before the pause gate or any later refusal. No second attempt
    // may use the same prepared bytes, even when this attempt never sent.
    prepare: () => prepared[consume](),
    async admit(send) {
      let available = true;
      try {
        return await ports.admit(() => {
          if (!available) return Promise.reject(alreadyConsumed());
          available = false;
          return send();
        });
      } finally {
        available = false;
      }
    },
    fence(ready) {
      if (grant.turn !== prepared.turn)
        throw Object.assign(
          new Error("Prepared RPC belongs to a different logical turn"),
          {
            code: "PREPARED_RPC_UNAVAILABLE",
          },
        );
      ports.assertCurrentGrant(grant);
      ports.fence(ready);
    },
  });
}

type TurnFailure = {
  code?: string | undefined;
  message?: string | undefined;
  probeNotSubmitted?: boolean | undefined;
  probeCompleted?: boolean | undefined;
};

type RefusedPreflight =
  | { code: "BUILD_CHANGED_BEFORE_EXECUTION"; preflightCompleted: false }
  | { code: "FUSION_BUSY"; preflightCompleted: true };

interface ProductTurnPorts<Failure extends TurnFailure, Published> {
  inspectPrepared(): boolean;
  errorInfo(cause: unknown): Failure;
  refusePreparation(error: Failure): void;
  runObservation?: (() => Promise<Published>) | undefined;
  verifyLocalInputs(): boolean;
  assertCurrent(): void;
  preflight(): Promise<unknown>;
  sameObservedInstance(error: Failure): boolean;
  refusePreflight(outcome: RefusedPreflight, error: Failure): void;
  /** Return whether the prepared operation still has its original target. */
  verifyDocument(localContextChanged: boolean): boolean;
  executeAndComplete(): Promise<Published>;
}

/** Sequence a normal product turn. All probes and the product call retain their
 * own send fences; the phase protocol cannot turn a lost reply into a retry. */
export async function runBrokerProductTurn<
  Failure extends TurnFailure,
  Published,
>(ports: ProductTurnPorts<Failure, Published>) {
  let localContextChanged: boolean;
  try {
    localContextChanged = ports.inspectPrepared();
  } catch (cause) {
    const error = ports.errorInfo(cause);
    if (error.code !== "DOCUMENT_CHANGED") {
      ports.refusePreparation(error);
      return;
    }
    // Observe the current document with the checked read-only preflight. Do
    // not let the original operation use the replacement document.
    localContextChanged = true;
  }
  if (ports.runObservation) return ports.runObservation();
  if (!ports.verifyLocalInputs()) return;
  try {
    await ports.preflight();
    ports.assertCurrent();
  } catch (cause) {
    ports.assertCurrent();
    const error = ports.errorInfo(cause);
    if (error.code === "BUILD_CHANGED" && error.probeNotSubmitted === true) {
      ports.refusePreflight(
        { code: "BUILD_CHANGED_BEFORE_EXECUTION", preflightCompleted: false },
        error,
      );
      return;
    }
    if (
      error.code === "FUSION_BUSY" &&
      error.probeCompleted === true &&
      ports.sameObservedInstance(error)
    ) {
      ports.refusePreflight({ code: "FUSION_BUSY", preflightCompleted: true }, error);
      return;
    }
    throw error;
  }
  if (!ports.verifyDocument(localContextChanged)) return;
  return ports.executeAndComplete();
}

type WorkerExitDecision =
  | { kind: "postflight"; missingPublication: boolean }
  | {
      kind: "hold";
      reason: string;
      rejection?: { code: string; message: string };
      outcome?: {
        state: "needs_reconciliation";
        code: "WORKFLOW_NONTERMINAL";
        workflowOutcome: unknown;
        nonterminal: true;
      };
    }
  | { kind: "alreadyHeld"; rejection: { code: string; message: string } };

/** Decide from durable bound evidence, not the process's exit code alone. */
export function decideBrokerWorkerExit(
  facts: {
    jobId: string;
    kind: "command" | "rpc";
    phased: boolean;
    pending: boolean;
    workflowUnknown: boolean;
    unknown: boolean;
    timedOut: boolean;
    dispatched: boolean;
    exitCode: number | undefined;
  },
  evidence: {
    worker(): {
      jobId: string;
      terminal?: boolean;
      nonterminal?: boolean;
      workflowOutcome?: unknown;
    } | null;
    workflowNonterminal(value: unknown): boolean;
    blocked(): boolean;
  },
): WorkerExitDecision {
  if (facts.pending)
    return {
      kind: "hold",
      reason: "Worker exited while a broker RPC is still pending; no postflight sent",
      rejection: {
        code: "RECONCILIATION_REQUIRED",
        message: "SDK RPC remains pending; not cancelled or replayed",
      },
    };
  const worker = evidence.worker();
  if (
    facts.workflowUnknown ||
    (!facts.phased &&
      (worker?.nonterminal || evidence.workflowNonterminal(worker?.workflowOutcome)))
  )
    return {
      kind: "hold",
      reason: "Typed workflow result is unknown/nonterminal; a synchronous script receipt is insufficient",
      rejection: {
        code: "WORKFLOW_NONTERMINAL",
        message: "Typed SDK workflow remains unknown; no replay",
      },
      outcome: {
        state: "needs_reconciliation",
        code: "WORKFLOW_NONTERMINAL",
        workflowOutcome: worker?.workflowOutcome || null,
        nonterminal: true,
      },
    };
  if (facts.unknown || (facts.timedOut && facts.dispatched) || evidence.blocked())
    return {
      kind: "alreadyHeld",
      rejection: {
        code: "RECONCILIATION_REQUIRED",
        message: "SDK outcome requires reconciliation; not cancelled or replayed",
      },
    };
  const needsWorkerResult =
    facts.kind === "command" &&
    !facts.phased &&
    (!worker?.terminal || worker.jobId !== facts.jobId);
  if (needsWorkerResult && facts.dispatched)
    return {
      kind: "hold",
      reason: "Worker exited after dispatch without its own durable terminal result",
    };
  return {
    kind: "postflight",
    missingPublication: needsWorkerResult && facts.exitCode === 0,
  };
}
