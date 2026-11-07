export type ExecutionPhase = "queue" | "sdk" | "pause" | "prepare" | "finalize";
export interface TimeoutPolicy {
  readonly queueMs: number | null;
  readonly sdkMs: number | null;
  readonly pauseMs: number | null;
  readonly prepareMs: number | null;
  readonly finalizeMs: number | null;
}
export interface Interruption {
  readonly reason: "deadline" | "cancellation";
  readonly phase: ExecutionPhase;
  readonly stopped: "waiting" | "local_process" | "observation";
  readonly fusionCancelled: false;
  readonly requiresReconciliation: boolean;
}
export function deadlineExpired(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number | null,
): boolean {
  if (
    ![startedAtMs, nowMs].every(Number.isFinite) ||
    (budgetMs !== null && (!Number.isSafeInteger(budgetMs) || budgetMs < 0))
  )
    throw new Error("Invalid deadline");
  return budgetMs !== null && nowMs - startedAtMs >= budgetMs;
}
/** Only apply after the adapter confirms stopping the named local activity. */
export function interruption(
  phase: ExecutionPhase,
  reason: Interruption["reason"],
  sdkMayBeActive: boolean,
): Interruption {
  return {
    reason,
    phase,
    stopped:
      phase === "sdk"
        ? "observation"
        : phase === "prepare" || phase === "finalize"
          ? "local_process"
          : "waiting",
    fusionCancelled: false,
    requiresReconciliation: sdkMayBeActive,
  };
}
