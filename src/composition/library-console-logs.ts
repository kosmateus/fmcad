import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import type { LogCursor } from "../../packages/node-adapters/src/console/logs";
import type { ConsoleRow } from "@fmcad/core";
const load = createRequire(__filename);
const { redactDiagnostic, parseConsoleLog, recordedTime, matchesTask } = load(
  "../core",
) as typeof import("@fmcad/core");
const { createLogReader } = load(
  "../node-adapters/console/logs",
) as typeof import("../../packages/node-adapters/src/console/logs");
const { createTaskEventAdapter } = load(
  "../node-adapters/console/task-events",
) as typeof import("../../packages/node-adapters/src/console/task-events");
export type LogConfiguration = NonNullable<
  Parameters<typeof redactDiagnostic>[1]
>;

export function sanitize(value: unknown, cfg: LogConfiguration = {}): string {
  return stripVTControlCharacters(redactDiagnostic(String(value), cfg)).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    "",
  );
}
export function parseLog(
  value: unknown,
  cfg: LogConfiguration = {},
): ConsoleRow {
  return parseConsoleLog(sanitize(value, cfg));
}
const read = createLogReader(parseLog);
export function readLogs(
  project: string,
  cfg: LogConfiguration = {},
  limit?: number,
  byteLimit?: number,
  tracker?: Map<string, LogCursor>,
) {
  return read(project, cfg, limit, byteLimit, tracker);
}
const adapter = createTaskEventAdapter({
  parseLog,
  time: recordedTime,
  matches: matchesTask,
});
export function readTaskEvents(
  project: string,
  task: ConsoleRow,
  cfg: LogConfiguration = {},
) {
  return adapter.readTaskEvents(project, task, cfg);
}
export function createTaskEventReader(
  project: string,
  cfg: LogConfiguration = {},
) {
  return adapter.createTaskEventReader(project, cfg);
}
export { matchesTask as matches };
export const { eventsFor } = load("../core") as typeof import("@fmcad/core");
