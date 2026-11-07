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
