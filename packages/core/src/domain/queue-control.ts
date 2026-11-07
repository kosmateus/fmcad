import type { QueueSnapshot } from "./queue-model";

export function gatePhase(
  data: QueueSnapshot,
  activeCount: number,
  resuming: boolean,
): string {
  return resuming
    ? "RESUMING"
    : data.blocked || data.controlBlocked
      ? "RECOVERY_BLOCKED"
      : !data.paused
        ? "RUNNING"
        : activeCount
          ? "PAUSING"
          : "PAUSED";
}

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
export interface QueueControlIntent {
  paused: boolean;
  requestId: string;
  instanceId?: string;
  expectedGeneration?: number;
}
export function controlEligibility(
  data: QueueSnapshot,
  intent: QueueControlIntent,
  instanceId: string,
  activeCount: number,
  resuming: boolean,
): { appliedGeneration: number } | null {
  const { requestId, paused, expectedGeneration } = intent;
  if (typeof requestId !== "string" || !requestId || requestId.length > 256)
    deny("INVALID_REQUEST", "Control requestId must contain 1..256 characters");
  if (
    expectedGeneration !== undefined &&
    (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
  )
    deny("INVALID_REQUEST", "Invalid control generation");
  if (intent.instanceId !== undefined && intent.instanceId !== instanceId)
    deny("INSTANCE_CHANGED", "Re-read the broker instance");
  const requests = data.controlRequests || {};
  const old = Object.hasOwn(requests, requestId) ? requests[requestId] : null;
  if (old) {
    if (old.paused !== paused)
      deny("REQUEST_CONFLICT", "Control requestId has a different intent");
    return { appliedGeneration: old.generation };
  }
  if (
    expectedGeneration !== undefined &&
    expectedGeneration !== (data.controlGeneration || 0)
  )
    deny("STATE_CONFLICT", "Broker control state changed; read current state");
  if (resuming) deny("STATE_CONFLICT", "Resume is already in progress");
  if (!paused && data.paused && (activeCount || data.blocked))
    deny("RECONCILIATION_REQUIRED", "Drain and reconcile before resuming");
  return null;
}

export interface PauseBudgetState {
  left: number;
  start: number;
  generation: number;
  frozen: boolean;
  ended: boolean;
}
export function budgetRemaining(state: PauseBudgetState, now: number): number {
  return Math.max(
    0,
    state.left -
      (state.frozen || state.ended ? 0 : Math.max(0, now - state.start)),
  );
}
export type BudgetAction = "arm" | "freeze" | "resume" | "close" | "expire";
export function budgetTransition(
  state: PauseBudgetState,
  action: BudgetAction,
  now: number,
  generation = state.generation,
): {
  state: PauseBudgetState;
  effect: "none" | "schedule" | "cancel" | "expired";
} {
  const next: PauseBudgetState = {
    left: state.left,
    start: state.start,
    generation: state.generation,
    frozen: state.frozen,
    ended: state.ended,
  };
  if (action === "expire") {
    if (state.ended || state.frozen || generation !== state.generation)
      return { state: next, effect: "none" };
    next.left = 0;
    next.ended = true;
    return { state: next, effect: "expired" };
  }
  if (action === "freeze" || action === "close") {
    if (action === "freeze" && (state.frozen || state.ended))
      return { state: next, effect: "none" };
    next.left = budgetRemaining(state, now);
    next.generation++;
    if (action === "close") next.ended = true;
    else next.frozen = true;
    return { state: next, effect: "cancel" };
  }
  if (action === "resume" && (!state.frozen || state.ended))
    return { state: next, effect: "none" };
  next.frozen = false;
  next.start = now;
  next.generation++;
  return { state: next, effect: "schedule" };
}
