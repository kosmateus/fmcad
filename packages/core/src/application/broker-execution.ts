import { dispatchPrepared, type DispatchPorts } from "./execution";

const consume = Symbol("consume prepared broker turn");

/** Local, process-bound authority. A prepared turn is never a recovery record. */
export interface PreparedTurn<Ready> {
  readonly jobId: string;
  inspect(check: (ready: Ready) => void): void;
  [consume](): Ready;
}

export async function prepare<Ready>(
  jobId: string,
  build: () => Ready | Promise<Ready>,
): Promise<PreparedTurn<Ready>> {
  let ready: { value: Ready } | undefined = { value: await build() };
  const current = () => {
    if (!ready)
      throw Object.assign(new Error("A prepared RPC cannot be replayed"), {
        code: "PREPARED_RPC_CONSUMED",
      });
    return ready.value;
  };
  return Object.freeze({
    jobId,
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
  Grant extends { job: { id: string } },
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
    fence(ready) {
      if (grant.job.id !== prepared.jobId)
        throw Object.assign(
          new Error("Prepared RPC belongs to a different job"),
          {
            code: "PREPARED_RPC_UNAVAILABLE",
          },
        );
      ports.assertCurrentGrant(grant);
      ports.fence(ready);
    },
  });
}
