import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { gatePhase, controlEligibility } from "@fmcad/core";
import type { QueueSnapshot, QueueControlIntent } from "@fmcad/core";

interface GateState {
  data: QueueSnapshot;
  pause(paused: boolean, requestId: string): unknown;
}

export class QueueGate {
  readonly active = new Map<string, number>();
  readonly waiters = new Set<() => void>();
  readonly scope = new AsyncLocalStorage<{ administrative: boolean }>();
  resuming = false;
  adminTransition: string | null = null;
  buildHash?: string;
  controlCapabilities?: Record<string, boolean>;
  changed?: () => void;

  constructor(
    readonly state: GateState,
    readonly instanceId: string,
  ) {}

  snapshot() {
    const d = this.state.data;
    return {
      protocol: 1,
      ...(this.buildHash === undefined ? {} : { buildHash: this.buildHash }),
      ...(this.controlCapabilities === undefined
        ? {}
        : { capabilities: { ...this.controlCapabilities } }),
      instanceId: this.instanceId,
      generation: d.controlGeneration || 0,
      contextEpoch: d.contextEpoch || 0,
      gateClosed: d.paused,
      activeOperations: this.active.size,
      activeIds: [...this.active.keys()],
      unresolved: !!(d.blocked || d.controlBlocked || d.localUnknown),
      pauseStartedAt: d.pauseStartedAt || null,
      phase: d.localUnknown
        ? "RECOVERY_BLOCKED"
        : gatePhase(d, this.active.size, this.resuming),
      scope: "instance; all managed projects; external clients are not blocked",
    };
  }

  async run<Result>(
    send: () => Promise<Result>,
    { onWait = () => {} }: { onWait?: (waiting: boolean) => void } = {},
  ): Promise<Result> {
    if (!this.scope.getStore()?.administrative) {
      while (this.state.data.paused) {
        onWait(true);
        try {
          await new Promise<void>((resolve) => this.waiters.add(resolve));
        } finally {
          onWait(false);
        }
      }
      if (this.state.data.blocked || this.state.data.controlBlocked) {
        throw Object.assign(new Error("An earlier operation is unresolved"), {
          code: "RECONCILIATION_REQUIRED",
        });
      }
    }
    // Grant and send share a synchronous JS turn. No remote cancellation/replay.
    const id = randomUUID();
    this.active.set(id, Date.now());
    this.changed?.();
    try {
      return await send();
    } finally {
      this.active.delete(id);
      this.changed?.();
    }
  }

  administrative<Result>(check: () => Result): Result {
    return this.scope.run({ administrative: true }, check);
  }

  async control(
    paused: boolean,
    intent: Omit<QueueControlIntent, "paused" | "requestId"> & {
      requestId?: string;
    } = {},
    check: () => Promise<unknown> = async () => {},
  ) {
    if (this.adminTransition)
      throw Object.assign(
        new Error("An administrative transition is pending"),
        {
          code: "BROKER_BUSY",
        },
      );
    if (!paused && this.state.data.localUnknown)
      throw Object.assign(
        new Error("An earlier local workflow is unresolved"),
        {
          code: "RECONCILIATION_REQUIRED",
        },
      );
    const requestId = intent.requestId ?? randomUUID();
    const old = controlEligibility(
      this.state.data,
      { ...intent, paused, requestId },
      this.instanceId,
      this.active.size,
      this.resuming,
    );
    if (old) return { ...this.snapshot(), requestId, ...old };
    if (!paused && this.state.data.paused) {
      this.resuming = true;
      this.changed?.();
      try {
        await this.administrative(check);
      } finally {
        this.resuming = false;
        this.changed?.();
      }
    }
    this.state.pause(paused, requestId);
    if (!paused) {
      const waiters = [...this.waiters];
      this.waiters.clear();
      for (const resolve of waiters) resolve();
    }
    return { ...this.snapshot(), requestId };
  }
}
