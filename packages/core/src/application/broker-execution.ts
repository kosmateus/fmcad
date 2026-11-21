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
