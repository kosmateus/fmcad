import { performance } from "node:perf_hooks";
import {
  budgetRemaining,
  budgetTransition,
  type BudgetAction,
} from "@fmcad/core";

type Timer = ReturnType<typeof setTimeout> | number | undefined;
export interface PauseBudgetTimers {
  now?(): number;
  schedule?(callback: () => void, delay: number): Timer;
  cancel?(timer: Timer): void;
}

export class PauseBudget {
  left: number;
  start = 0;
  generation = 0;
  frozen = false;
  ended = false;
  timer: Timer;
  expired: () => void;
  now: () => number;
  schedule: NonNullable<PauseBudgetTimers["schedule"]>;
  cancel: NonNullable<PauseBudgetTimers["cancel"]>;

  constructor(
    ms: number,
    expired: () => void,
    {
      now = () => performance.now(),
      schedule = setTimeout,
      cancel = clearTimeout,
    }: PauseBudgetTimers = {},
  ) {
    this.left = ms;
    this.expired = expired;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.arm();
  }
  remaining(): number {
    return budgetRemaining(this, this.now());
  }
  apply(action: BudgetAction, generation?: number): void {
    const result = budgetTransition(this, action, this.now(), generation);
    Object.assign(this, result.state);
    if (result.effect === "cancel") this.cancel(this.timer);
    if (result.effect === "expired") this.expired();
    if (result.effect === "schedule") {
      const current = this.generation;
      this.timer = this.schedule(
        () => this.apply("expire", current),
        this.left,
      );
    }
  }
  arm(): void {
    this.apply("arm");
  }
  freeze(): void {
    this.apply("freeze");
  }
  resume(): void {
    this.apply("resume");
  }
  close(): void {
    this.apply("close");
  }
}
