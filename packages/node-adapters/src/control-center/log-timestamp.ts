import type { ConsoleTelemetryEvent } from "@fmcad/core";

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu;

export interface ConsoleLogTimestamp {
  readonly timestamp: number | null;
  readonly timestampRaw?: string | number;
}

function parseIsoInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

/** Prefer the source's occurred time; never substitute collector/read time. */
export function consoleLogTimestamp(
  event: ConsoleTelemetryEvent,
): ConsoleLogTimestamp {
  const retained = event as ConsoleTelemetryEvent & {
    readonly data?: Readonly<Record<string, unknown>>;
  };
  const rawValue = retained.data?.["timestamp"];
  const raw =
    typeof rawValue === "string" || typeof rawValue === "number"
      ? rawValue
      : undefined;
  if (typeof raw === "string") {
    const parsed = parseIsoInstant(raw);
    if (parsed !== null) return { timestamp: parsed, timestampRaw: raw };
    return {
      timestamp: null,
      timestampRaw: raw,
    };
  }
  const explicitMs =
    retained.data?.["occurredAtMs"] ?? retained.data?.["timestampMs"];
  if (
    typeof explicitMs === "number" &&
    Number.isSafeInteger(explicitMs) &&
    explicitMs >= 0
  )
    return {
      timestamp: explicitMs,
      ...(raw === undefined ? {} : { timestampRaw: raw }),
    };
  const observed = event.metadata.observedAtMs;
  const observedAtMs = observed.value;
  if (
    typeof observedAtMs === "number" &&
    Number.isSafeInteger(observedAtMs) &&
    observedAtMs >= 0 &&
    observed.unit === "unix-ms" &&
    ["available", "stale"].includes(observed.availability)
  )
    return {
      timestamp: observedAtMs,
      ...(raw === undefined ? {} : { timestampRaw: raw }),
    };

  return {
    timestamp: null,
    ...(raw === undefined ? {} : { timestampRaw: raw }),
  };
}
