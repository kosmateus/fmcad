import type {
  ConsoleReadPort,
  ConsoleSnapshot,
  ReadObservation,
} from "@fmcad/core";

/** Adapter-side clock and passive collector are supplied by the composition root. */
export function createConsoleReadPort(
  read: () => ConsoleSnapshot,
  now: () => number = Date.now,
  freshnessMs = 15_000,
): ConsoleReadPort {
  return {
    read(): ReadObservation<ConsoleSnapshot> {
      try {
        const value = read();
        const at = value.observedAt;
        if (!value.available) {
          if (value.operations || value.agents || value.logs)
            return {
              status: "stale",
              value,
              observedAt: at ?? null,
              reason:
                value.reason || "Source unavailable; retained observations",
            };
          return {
            status: "missing",
            value: null,
            observedAt: null,
            reason: value.reason || "No telemetry",
          };
        }
        const age = typeof at === "number" ? now() - at : NaN;
        if (!Number.isFinite(age) || age < 0 || age > freshnessMs)
          return {
            status: "stale",
            value,
            observedAt: at ?? null,
            reason: "Observation freshness is unconfirmed",
          };
        return { status: "available", value, observedAt: at! };
      } catch (error) {
        return {
          status: "error",
          value: null,
          observedAt: null,
          reason:
            error instanceof Error ? error.message : "Telemetry read failed",
        };
      }
    },
  };
}
