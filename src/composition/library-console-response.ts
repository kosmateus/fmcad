import { createRequire } from "node:module";
import type { ConsoleRow, ConsoleSnapshot } from "@fmcad/core";
import type { ResponseReadOptions } from "../../packages/node-adapters/src/console/response";
import type { LogConfiguration } from "./library-console-logs";
const load = createRequire(__filename);
const { redactDiagnostic, responseTaskError, jsonLines } = load(
  "../core",
) as typeof import("@fmcad/core");
const { createResponseReader } = load(
  "../node-adapters/console/response",
) as typeof import("../../packages/node-adapters/src/console/response");
const { queueDirectory } = load("../../queue-connection") as {
  queueDirectory(): string;
};
const read = createResponseReader({ taskError: responseTaskError, jsonLines });
export function openResponse(
  row: ConsoleRow,
  snapshot: ConsoleSnapshot,
  {
    dir = queueDirectory(),
    cfg = {},
  }: { dir?: string; cfg?: LogConfiguration } = {},
): ReturnType<typeof read> {
  const { responsePath } = load("../../queue-response-files") as Pick<
    ResponseReadOptions,
    "responsePath"
  >;
  return read(row, snapshot, {
    dir,
    redact: (text) => redactDiagnostic(text, cfg),
    responsePath,
  });
}
export { jsonLines };
