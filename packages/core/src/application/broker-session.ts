import type { TurnIdentity } from "./broker-execution";

type JobContext = { readonly job: { readonly id: string } };

export type BrokerGrant<Context> = Readonly<{
  context: Context;
  turn: TurnIdentity;
  /** Incarnation of this grant in the local session, not the broker epoch. */
  generation: number;
}>;

export type BrokerHold<Context> = Readonly<{
  context: Context | null;
  reason: string;
  generation: number;
}>;

export type BrokerSessionSnapshot<Context> = Readonly<{
  active: BrokerGrant<Context> | null;
  held: BrokerHold<Context> | null;
  /** Local slot version only; never identifies the process lock or durable epoch. */
  generation: number;
}>;

type Publish = () => undefined;

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Owns the runtime slot, not the durable queue or proof of remote completion. */
export function createBrokerSession<Context extends JobContext>() {
  type Grant = BrokerGrant<Context>;
  type Hold = BrokerHold<Context>;
  let active: Grant | null = null;
  let held: Hold | null = null;
  let generation = 0;
  let publishing = false;
  const admitted = new WeakSet<TurnIdentity>();

  function assertNotPublishing() {
    if (publishing)
      deny("BROKER_SESSION_BUSY", "A physical slot transition is publishing");
  }

  function publish(commit: Publish | undefined) {
    publishing = true;
    try {
      commit?.();
    } finally {
      publishing = false;
    }
  }

  function assertCurrentGrant(grant: unknown): undefined {
    assertNotPublishing();
    if (active === null || grant !== active)
      deny("RECONCILIATION_REQUIRED", "Original SDK ownership changed");
  }

  return Object.freeze({
    snapshot(): BrokerSessionSnapshot<Context> {
      return Object.freeze({ active, held, generation });
    },

    // Only a caller that has authorized scoped work against the current hold
    // may pass it here. The session does not decide if a job qualifies.
    acquire(context: Context, turn: TurnIdentity, scope?: Hold): Grant {
      assertNotPublishing();
      if (active || (scope ?? null) !== held)
        deny("BROKER_SESSION_BUSY", "The physical slot is already owned");
      if (turn.jobId !== context.job.id || admitted.has(turn))
        deny(
          "PREPARED_RPC_UNAVAILABLE",
          "Invalid or already admitted logical turn",
        );
      admitted.add(turn);
      active = Object.freeze({ context, turn, generation: ++generation });
      return active;
    },

    assertCurrentGrant,

    /** Revoke execution authority before publishing an UNKNOWN or host fault.
     * A failed publication must not reopen the physical slot. */
    hold(owner: Grant | Hold | null, reason: string, commit?: Publish): Hold {
      assertNotPublishing();
      if (owner !== (active ?? held))
        deny(
          "RECONCILIATION_REQUIRED",
          "Physical slot owner changed before hold",
        );
      active = null;
      held = Object.freeze({
        context: owner?.context ?? null,
        reason,
        generation: ++generation,
      });
      publish(commit);
      return held;
    },

    /** Publish synchronously against the exact captured grant (or recovery hold).
     * Releasing scoped work does not release the original hold. */
    settle(owner: Grant | Hold, commit: Publish) {
      assertNotPublishing();
      if (active ? owner !== active : !held || owner !== held)
        deny(
          "RECONCILIATION_REQUIRED",
          "Physical slot owner changed before settlement",
        );
      publish(commit);
      if (active) active = null;
      else held = null;
      generation++;
    },
  });
}
