import type { EventSink } from "@fmcad/core";
import type { ObservationEvent } from "@fmcad/core";

export type ObservationEventWriter = (event: ObservationEvent) => Promise<void>;

export function createTelemetryEventSink(
  write: ObservationEventWriter,
  maxBytes = 6_144,
): EventSink {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Event sink limit must be a positive safe integer");
  let disposed = false;
  return {
    async publish(event) {
      if (disposed) return;
      if (
        !validEvent(event) ||
        Buffer.byteLength(JSON.stringify(event), "utf8") > maxBytes
      ) {
        throw new Error("Invalid or oversized observation event");
      }
      await write(event);
    },
    dispose() {
      disposed = true;
    },
  };
}

function validEvent(value: ObservationEvent): boolean {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isFinite(value.atMs) ||
    typeof value.name !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value.name) ||
    !value.invocation ||
    value.invocation.version !== 1 ||
    typeof value.invocation.instanceId !== "string" ||
    !["cli", "mcp", "opencode", "system"].includes(value.invocation.source)
  )
    return false;
  for (const key of [
    "clientId",
    "requestId",
    "jobId",
    "projectId",
    "documentId",
    "sessionId",
    "turnId",
  ] as const) {
    const identity = value.invocation[key];
    if (
      identity !== null &&
      (typeof identity !== "string" ||
        !identity.trim() ||
        identity.length > 256)
    )
      return false;
  }
  if (
    value.invocation.purpose !== null &&
    (typeof value.invocation.purpose !== "string" ||
      value.invocation.purpose.length > 1000)
  )
    return false;
  return validRecord(value.data, 0);
}

function validRecord(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8)
    return false;
  const entries = Object.entries(value);
  if (entries.length > 64) return false;
  return entries.every(
    ([key, item]) =>
      key.length > 0 && key.length <= 128 && validJson(item, depth + 1),
  );
}

function validJson(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 128 && value.every((item) => validJson(item, depth + 1))
    );
  if (typeof value === "object") return validRecord(value, depth + 1);
  return false;
}
