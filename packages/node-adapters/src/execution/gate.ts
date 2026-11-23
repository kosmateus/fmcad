import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { gatePhase, controlEligibility } from "@fmcad/core";
import type { QueueSnapshot, QueueControlIntent } from "@fmcad/core";

interface GateState {
  data: QueueSnapshot;
  pause(paused: boolean, requestId: string): unknown;
}

declare const activityToken: unique symbol;
export interface GateActivityToken {
  readonly id: string;
  readonly [activityToken]: true;
}

declare const adminToken: unique symbol;
export interface GateAdminToken {
  readonly [adminToken]: true;
}

export class QueueGate {
  #active = new Map<GateActivityToken, number>();
  #waiters = new Set<() => void>();
  #scope = new AsyncLocalStorage<{ administrative: boolean }>();
  #resuming = false;
  #admin: { token: GateAdminToken; name: string } | null = null;
  buildHash?: string;
  controlCapabilities?: Record<string, boolean>;
  changed?: () => void;

  constructor(
    readonly state: GateState,
    readonly instanceId: string,
  ) {}

  get active(): ReadonlyMap<string, number> {
    return new Map([...this.#active].map(([token, at]) => [token.id, at]));
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get activeIds(): readonly string[] {
    return Object.freeze([...this.#active.keys()].map((token) => token.id));
  }

  get waitingCount(): number {
    return this.#waiters.size;
  }

  get isAdministrative(): boolean {
    return this.#scope.getStore()?.administrative === true;
  }

  get resuming(): boolean {
    return this.#resuming;
  }

  get adminTransition(): string | null {
    return this.#admin?.name ?? null;
  }

  beginActivity(): GateActivityToken {
    const token = Object.freeze({ id: randomUUID() }) as GateActivityToken;
    this.#active.set(token, Date.now());
    return token;
  }

  endActivity(token: GateActivityToken): boolean {
    if (!this.#active.delete(token)) return false;
    return true;
  }

  hasActivity(token: GateActivityToken): boolean {
    return this.#active.has(token);
  }

  hasOtherActivity(token?: GateActivityToken): boolean {
    return this.#active.size > (token && this.#active.has(token) ? 1 : 0);
  }

  beginAdminTransition(name: string): GateAdminToken {
    if (!name || this.#admin || this.#resuming)
      throw Object.assign(new Error("An administrative transition is pending"), {
        code: "BROKER_BUSY",
      });
    const token = Object.freeze({}) as GateAdminToken;
    this.#admin = { token, name };
    return token;
  }

  endAdminTransition(token: GateAdminToken): boolean {
    if (this.#admin?.token !== token) return false;
    this.#admin = null;
    return true;
  }

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
      activeOperations: this.activeCount,
      activeIds: [...this.activeIds],
      unresolved: !!(d.blocked || d.controlBlocked || d.localUnknown),
      pauseStartedAt: d.pauseStartedAt || null,
      phase: d.localUnknown
        ? "RECOVERY_BLOCKED"
        : gatePhase(d, this.activeCount, this.resuming),
      scope: "instance; all managed projects; external clients are not blocked",
    };
  }

  async run<Result>(
    send: () => Promise<Result>,
    { onWait = () => {} }: { onWait?: (waiting: boolean) => void } = {},
  ): Promise<Result> {
    if (!this.isAdministrative) {
      while (this.state.data.paused) {
        onWait(true);
        try {
          await new Promise<void>((resolve) => this.#waiters.add(resolve));
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
    const token = this.beginActivity();
    this.changed?.();
    try {
      return await send();
    } finally {
      this.endActivity(token);
      this.changed?.();
    }
  }

  administrative<Result>(check: () => Result): Result {
    return this.#scope.run({ administrative: true }, check);
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
      this.activeCount,
      this.resuming,
    );
    if (old) return { ...this.snapshot(), requestId, ...old };
    if (!paused && this.state.data.paused) {
      this.#resuming = true;
      this.changed?.();
      try {
        await this.administrative(check);
      } finally {
        this.#resuming = false;
        this.changed?.();
      }
    }
    this.state.pause(paused, requestId);
    if (!paused) {
      const waiters = [...this.#waiters];
      this.#waiters.clear();
      for (const resolve of waiters) resolve();
    }
    return { ...this.snapshot(), requestId };
  }
}
