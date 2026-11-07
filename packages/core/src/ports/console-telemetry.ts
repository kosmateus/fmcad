import type {
  ConsoleTelemetryCursor,
  ConsoleTelemetryEvent,
  ConsoleTelemetryReplayPage,
} from "../domain/console-telemetry";

/** SQLite/history adapters accept canonical events; they do not gain queue authority. */
export interface ConsoleTelemetryEventSink {
  append(event: ConsoleTelemetryEvent): Promise<void>;
}

/** Scope-local retained replay. A source epoch change requires a fresh cursor. */
export interface ConsoleTelemetryReplayPort {
  read(input: {
    readonly after: ConsoleTelemetryCursor | null;
    readonly limit: number;
  }): Promise<ConsoleTelemetryReplayPage>;
}
