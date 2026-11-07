import {
  id,
  type GeometryQuantity,
  type OperationResult,
  type OperationRequest,
  type JsonValue,
  type DomainEvent,
  type RequestContext,
} from "./contracts";
import { legacyResult } from "./outcome";

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  )
    throw new Error("Expected plain DTO");
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => descriptor.get || descriptor.set,
    )
  )
    throw new Error("DTO accessors are not allowed");
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    ) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unsupported DTO fields");
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error("Unsupported DTO value");
  return value as T;
}
function nullableId<K extends string>(kind: K, value: unknown) {
  return value === null ? null : id(kind, text(value));
}

export function decodeRequestContext(input: unknown): RequestContext {
  const value = object(input);
  keys(value, [
    "version",
    "clientId",
    "requestId",
    "sessionId",
    "projectId",
    "documentId",
    "instanceId",
    "purpose",
  ]);
  if (value["version"] !== 1) throw new Error("Unsupported request version");
  const purpose = nullableText(value["purpose"]);
  if (
    purpose !== null &&
    (Array.from(purpose).length > 1000 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(purpose))
  )
    throw new Error("Invalid purpose");
  return {
    version: 1,
    clientId: id("client", text(value["clientId"])),
    requestId: id("request", text(value["requestId"])),
    sessionId: nullableId("session", value["sessionId"]),
    projectId: nullableId("project", value["projectId"]),
    documentId: nullableId("document", value["documentId"]),
    instanceId: nullableId("instance", value["instanceId"]),
    purpose,
  };
}

export function decodeResult(input: unknown): OperationResult {
  const value = object(input);
  keys(value, [
    "version",
    "requestId",
    "jobId",
    "acceptance",
    "executionOutcome",
    "mayHaveMutated",
    "validation",
    "code",
  ]);
  if (value["version"] !== 1) throw new Error("Unsupported result version");
  if (
    value["mayHaveMutated"] !== null &&
    typeof value["mayHaveMutated"] !== "boolean"
  )
    throw new Error("Invalid mutation evidence");
  const evidence = object(value["validation"]);
  keys(evidence, ["status", "source", "artifactId", "measurements"]);
  const measurements = Object.entries(object(evidence["measurements"])).map(
    ([name, inputQuantity]) => {
      const quantity = object(inputQuantity);
      keys(quantity, ["value", "unit"]);
      if (
        quantity["value"] !== null &&
        (typeof quantity["value"] !== "number" ||
          !Number.isFinite(quantity["value"]))
      )
        throw new Error("Invalid geometry quantity");
      const unit = choice<GeometryQuantity["unit"]>(quantity["unit"], [
        "mm",
        "cm",
        "m",
        "mm2",
        "cm2",
        "m2",
        "mm3",
        "cm3",
        "m3",
        "rad",
        "deg",
        "unitless",
      ]);
      return [name, { value: quantity["value"], unit }] as const;
    },
  );
  const result: OperationResult = {
    version: 1,
    requestId: nullableId("request", value["requestId"]),
    jobId: nullableId("job", value["jobId"]),
    acceptance: choice(value["acceptance"], [
      "accepted",
      "rejected",
      "unknown",
    ]),
    executionOutcome: choice(value["executionOutcome"], [
      "not_started",
      "active",
      "partial",
      "succeeded",
      "failed",
      "unknown",
    ]),
    mayHaveMutated: value["mayHaveMutated"],
    validation: {
      status: choice(evidence["status"], [
        "not_checked",
        "pass",
        "fail",
        "partial",
        "unknown",
        "unsupported",
        "missing",
        "stale",
        "blocked",
        "unavailable",
      ]),
      source: nullableText(evidence["source"]),
      artifactId: nullableId("artifact", evidence["artifactId"]),
      measurements: Object.fromEntries(measurements),
    },
    code: nullableText(value["code"]),
  };
  if (
    result.executionOutcome === "not_started" &&
    result.mayHaveMutated === true
  )
    throw new Error("Contradictory mutation evidence");
  return result;
}

/** Explicit compatibility boundary; never use a future schema as legacy data. */
export function decodePublicResult(input: unknown): OperationResult {
  const value = object(input);
  if (Object.hasOwn(value, "version")) return decodeResult(value);
  if (
    !["success", "status", "accepted", "executionOutcome", "state"].some(
      (key) => Object.hasOwn(value, key),
    )
  )
    throw new Error("Unrecognized legacy result");
  return legacyResult(value);
}

/** Projection only: persisted job/request internals never become public DTOs. */
export function decodePersistedJob(
  input: unknown,
  version: number,
): OperationResult {
  if (version !== 1) throw new Error("Unsupported persisted queue version");
  const value = object(input);
  const jobId = id("job", text(value["id"]));
  const requestId = id("request", text(value["requestId"]));
  const state = choice(value["state"], [
    "preparing",
    "processing",
    "queued",
    "running",
    "sending",
    "needs_reconciliation",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]);
  const dispatch = value["dispatch"] == null ? null : object(value["dispatch"]);
  const submitted =
    typeof dispatch?.["rpcCount"] === "number" && dispatch["rpcCount"] > 0;
  const details = value["details"] == null ? {} : object(value["details"]);
  const waiting = [
    "preparing",
    "processing",
    "queued",
    "cancelled",
    "expired",
  ].includes(state);
  const result = legacyResult({
    state,
    code: details["code"] ?? value["code"],
    executionOutcome: Object.hasOwn(details, "executionOutcome")
      ? details["executionOutcome"]
      : Object.hasOwn(value, "executionOutcome")
        ? value["executionOutcome"]
        : ["running", "sending", "needs_reconciliation"].includes(state)
          ? "unknown"
          : state === "succeeded"
            ? "succeeded"
            : state === "failed"
              ? "failed"
              : submitted
                ? "unknown"
                : "not_started",
    accepted: true,
    mayHaveMutated: Object.hasOwn(details, "mayHaveMutated")
      ? details["mayHaveMutated"]
      : Object.hasOwn(value, "mayHaveMutated")
        ? value["mayHaveMutated"]
        : submitted
          ? true
          : waiting
            ? false
            : null,
  }, { allowUnknownExecutionOutcome: true });
  return { ...result, jobId, requestId };
}

/** Existing remote receipts are unversioned bindings; no implicit future fallback. */
export function decodePersistedReceipt(input: unknown): OperationResult {
  const value = object(input);
  if (Object.hasOwn(value, "version"))
    throw new Error("Unsupported persisted receipt version");
  if (typeof value["terminal"] !== "boolean")
    throw new Error("Invalid receipt");
  const outcome = value["terminal"]
    ? choice(value["outcome"], ["succeeded", "failed"])
    : "unknown";
  return {
    ...legacyResult({ executionOutcome: outcome, accepted: true }),
    requestId: nullableId("request", value["requestId"] ?? null),
    jobId: nullableId("job", value["jobId"] ?? null),
  };
}

export function encodeResult(result: OperationResult): string {
  return JSON.stringify(decodeResult(result));
}

function json(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value))
    throw new Error("Expected finite JSON data without cycles");
  ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value))
    result = Array.from(value, (item) => json(item, ancestors));
  else
    result = Object.fromEntries(
      Object.entries(object(value)).map(([key, item]) => {
        if (
          /^(?:token|authorization|credentials?|credentialStore|credentialsPath|process|env)$/i.test(
            key,
          )
        )
          throw new Error("Private runtime data in request");
        return [key, json(item, ancestors)];
      }),
    );
  ancestors.delete(value);
  return result;
}

export function decodeRequest(input: unknown): OperationRequest {
  const value = object(input);
  keys(value, ["context", "operation", "arguments"]);
  return {
    context: decodeRequestContext(value["context"]),
    operation: text(value["operation"]),
    arguments: json(object(value["arguments"])) as Readonly<
      Record<string, JsonValue>
    >,
  };
}

export function encodeRequest(request: OperationRequest): string {
  return JSON.stringify(decodeRequest(request));
}

export function decodeEvent(input: unknown): DomainEvent {
  const value = object(input);
  keys(value, ["version", "context", "jobId", "atMs", "name", "data"]);
  if (
    value["version"] !== 1 ||
    typeof value["atMs"] !== "number" ||
    !Number.isSafeInteger(value["atMs"]) ||
    value["atMs"] < 0
  )
    throw new Error("Unsupported event");
  return {
    version: 1,
    context: decodeRequestContext(value["context"]),
    jobId: nullableId("job", value["jobId"]),
    atMs: value["atMs"],
    name: text(value["name"]),
    data: json(object(value["data"])) as Readonly<Record<string, JsonValue>>,
  };
}

export function encodeEvent(event: DomainEvent): string {
  return JSON.stringify(decodeEvent(event));
}
