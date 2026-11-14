import { record } from "./contracts";

/** Preserve evidence without retrying an operation whose reply cannot settle it. */
export function unknownNativeOutcome(
  cause: unknown,
): Error & { unknown: true } {
  const error =
    cause instanceof Error && Object.isExtensible(cause)
      ? cause
      : new Error(cause instanceof Error ? cause.message : String(cause), {
          cause,
        });
  return Object.assign(error, { unknown: true as const });
}

export function parseNativeResult(text: string): Record<string, unknown> {
  try {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("FMCAD_RESULT "));
    if (lines.length !== 1)
      throw new Error("Expected exactly one native result marker");
    const value: unknown = JSON.parse(lines[0]!.slice("FMCAD_RESULT ".length));
    if (!record(value)) throw new Error("Expected a native result object");
    return value;
  } catch (error) {
    throw unknownNativeOutcome(error);
  }
}

/**
 * Only primitive dimension validation emits this receipt. It is returned inside
 * the ordinary checked, request-bound native result, never recovered from a
 * thrown transport exception. Later kernel/selector errors remain unknown.
 */
export function nativeInputRejection(
  operation: string,
  output: Record<string, unknown>,
): { code: string; message: string } | undefined {
  if (
    !/^shape\.(box|cylinder|tube|ring|cone)$/.test(operation) ||
    output["operation"] !== operation ||
    output["success"] !== false ||
    !Array.isArray(output["created"]) ||
    output["created"].length !== 0 ||
    (output["affected"] !== undefined &&
      (!Array.isArray(output["affected"]) || output["affected"].length !== 0))
  )
    return undefined;
  const result = output["result"];
  if (!record(result) || result["status"] !== "failed") return undefined;
  const rejection = result["rejection"],
    error = result["error"];
  if (
    !record(rejection) ||
    Object.keys(rejection).sort().join(",") !==
      "kind,mutationStatus,operation,version" ||
    rejection["kind"] !== "cad-input-rejection" ||
    rejection["version"] !== 1 ||
    rejection["operation"] !== operation ||
    rejection["mutationStatus"] !== "not_started" ||
    !record(error) ||
    Object.keys(error).sort().join(",") !== "code,message" ||
    error["code"] !== "INVALID_INPUT" ||
    typeof error["message"] !== "string" ||
    !error["message"]
  )
    return undefined;
  return { code: error["code"], message: error["message"] };
}
