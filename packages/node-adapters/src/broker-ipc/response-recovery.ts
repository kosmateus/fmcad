type RecordValue = Record<string, unknown>;
export interface ResponseRecoveryClient {
  readonly auth: { readonly clientId: string };
  call(action: string, values: RecordValue): Promise<unknown>;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function lostResponse(error: unknown): boolean {
  return (
    record(error) &&
    typeof error["code"] === "string" &&
    [
      "QUEUE_IPC_RESPONSE_LOST",
      "QUEUE_IPC_TIMEOUT",
      "ECONNRESET",
      "EPIPE",
      "ECONNREFUSED",
      "ENOENT",
    ].includes(error["code"])
  );
}
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
function identified(
  error: unknown,
  identity: RecordValue,
  cause?: unknown,
): object {
  return Object.assign(
    record(error)
      ? error
      : new Error("Queue observation failed", { cause: error }),
    identity,
    cause === undefined ? {} : { cause },
  );
}

/** Bounded observation only. No dispatch, cancellation or reconciliation retry. */
export async function readResult(
  client: ResponseRecoveryClient,
  action: string,
  values: RecordValue,
  signal?: AbortSignal,
): Promise<unknown> {
  if (action !== "result" && action !== "find-request")
    throw new Error("Expected a result observation");
  const identity = values["jobId"]
    ? { jobId: values["jobId"] }
    : { requestId: values["requestId"] };
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted)
      throw Object.assign(
        new Error("Stopped waiting; the original job is NOT cancelled"),
        { code: "WAIT_ABORTED", ...identity },
      );
    try {
      return await client.call(action, values);
    } catch (error) {
      if (!lostResponse(error) || attempt >= 2)
        throw identified(error, identity);
      await delay(100 * (attempt + 1));
    }
  }
}

/** Recover the admitted receipt, never resubmit after transport uncertainty. */
export async function submitWithRecovery(
  client: ResponseRecoveryClient,
  request: RecordValue,
  refreshIdleBroker?: () => Promise<unknown>,
): Promise<unknown> {
  if (typeof request["requestId"] !== "string" || !request["requestId"])
    throw new Error("Stable requestId required");
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.call("submit", { request });
    } catch (error) {
      if (
        attempt === 0 &&
        refreshIdleBroker &&
        record(error) &&
        error["code"] === "BUILD_CHANGED" &&
        error["notStarted"] === true
      ) {
        await refreshIdleBroker();
        continue;
      }
      if (!lostResponse(error)) throw error;
      const identity = { requestId: request["requestId"] };
      let found: unknown;
      try {
        found = await readResult(client, "find-request", {
          ...identity,
          expectedRequest: request,
        });
      } catch (observationError) {
        if (
          record(observationError) &&
          observationError["code"] === "REQUEST_CONFLICT"
        ) {
          // This is a diagnosed immutable-ID mismatch, not a recovered receipt.
          // Keep the lost ACK as context and never infer permission to resubmit.
          throw identified(observationError, identity, error);
        }
        throw identified(error, identity, observationError);
      }
      if (!record(found) || !record(found["job"]))
        throw identified(error, identity);
      if (
        found["job"]["clientId"] !== client.auth.clientId ||
        found["job"]["requestId"] !== request["requestId"]
      ) {
        throw Object.assign(
          new Error("Broker returned a foreign request identity"),
          { code: "NOT_OWNER", ...identity },
        );
      }
      if (found["requestMatched"] !== true) throw identified(error, identity);
      return found["job"];
    }
  }
}
