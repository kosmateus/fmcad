const IDENTIFIER_MAX_LENGTH = 256;

interface DocumentUnlockTarget {
  readonly docId?: string;
  readonly docFileId?: string;
}

export type DocumentUnlockRequest =
  | {
      readonly action: "status";
      readonly target: DocumentUnlockTarget;
      readonly requestId?: string;
    }
  | {
      readonly action: "inspect";
      readonly target: DocumentUnlockTarget;
      readonly requestId: string;
    }
  | {
      readonly action: "accept";
      readonly target: DocumentUnlockTarget;
      readonly requestId: string;
      readonly observationId: string;
    };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains an unexpected field`);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH
  )
    throw new Error(
      `${label} must contain 1..${IDENTIFIER_MAX_LENGTH} characters`,
    );
  return value;
}

function target(value: unknown): DocumentUnlockTarget {
  const input = object(value, "target");
  exactKeys(input, ["docId", "docFileId"], "target");
  const docId = Object.hasOwn(input, "docId")
    ? identifier(input["docId"], "target.docId")
    : undefined;
  const docFileId = Object.hasOwn(input, "docFileId")
    ? identifier(input["docFileId"], "target.docFileId")
    : undefined;
  if (docId === undefined && docFileId === undefined)
    throw new Error("target requires docId or docFileId");
  return {
    ...(docId === undefined ? {} : { docId }),
    ...(docFileId === undefined ? {} : { docFileId }),
  };
}

/** Decode the strict, broker-only document unlock control request. */
export function decodeDocumentUnlockRequest(
  value: unknown,
): DocumentUnlockRequest {
  const input = object(value, "document unlock request");
  exactKeys(
    input,
    ["action", "target", "requestId", "observationId"],
    "document unlock request",
  );
  const action = input["action"];
  if (action !== "status" && action !== "inspect" && action !== "accept")
    throw new Error("action must be status, inspect, or accept");
  const decodedTarget = target(input["target"]);
  const hasRequestId = Object.hasOwn(input, "requestId");
  const hasObservationId = Object.hasOwn(input, "observationId");

  if (action === "status") {
    if (hasObservationId)
      throw new Error("status does not accept observationId");
    return {
      action,
      target: decodedTarget,
      ...(hasRequestId
        ? { requestId: identifier(input["requestId"], "requestId") }
        : {}),
    };
  }
  if (!hasRequestId) throw new Error(`${action} requires requestId`);
  const requestId = identifier(input["requestId"], "requestId");
  if (action === "inspect") {
    if (hasObservationId)
      throw new Error("inspect does not accept observationId");
    return { action, target: decodedTarget, requestId };
  }
  if (!hasObservationId) throw new Error("accept requires observationId");
  return {
    action,
    target: decodedTarget,
    requestId,
    observationId: identifier(input["observationId"], "observationId"),
  };
}
