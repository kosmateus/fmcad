import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseFlags } from "../entrypoints/cli/parser";
import { findCommand } from "./library-commands";
import type { ConsoleSnapshot } from "../../packages/core/src";
import type { SnapshotOptions } from "../../packages/node-adapters/src/console/snapshots";
import type { LogCursor } from "../../packages/node-adapters/src/console/logs";
const load = createRequire(__filename);
const { queueDirectory } = load("../../queue-connection") as {
  queueDirectory(): string;
};
const { readJson, priorProcessAlive } = load("../../queue-instance") as Pick<
  SnapshotOptions,
  "readJson"
> & { priorProcessAlive: SnapshotOptions["alive"] };
const {
  baseSnapshot: base,
  ConsoleReadStore,
  projectContains,
  classifyPresence,
  id,
  projectConsoleOperation,
  redactDiagnostic,
  formatJsonError,
} = load("../core") as typeof import("../../packages/core/src");
const { createSnapshotReaders } = load(
  "../node-adapters/console/snapshots",
) as typeof import("../../packages/node-adapters/src/console/snapshots");
const { createCollector } = load(
  "../node-adapters/console/system-data",
) as typeof import("../../packages/node-adapters/src/console/system-data");
const { createConsoleReadPort } = load(
  "../node-adapters/console/read-port",
) as typeof import("../../packages/node-adapters/src/console/read-port");
const { readClientPresence } = load("../../client-presence") as ReturnType<
  typeof import("../../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
>;
type ConsoleDataConfiguration = NonNullable<
  Parameters<typeof redactDiagnostic>[1]
> & { routing?: string };
export interface ConsoleDataOptions {
  dir?: string;
  now?: () => number;
  alive?: SnapshotOptions["alive"];
  cfg?: ConsoleDataConfiguration;
}
const { readLogs } = load("../../console-logs") as {
  readLogs: ReturnType<
    typeof import("../../packages/node-adapters/src/console/logs").createLogReader<ConsoleDataConfiguration>
  >;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, cfg: ConsoleDataConfiguration = {}) =>
  redactDiagnostic(String(value), cfg).replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))|[\x00-\x1f\x7f-\x9f]/g,
    "",
  );
const readers = createSnapshotReaders({
  base,
  contains: projectContains,
  presence: (observedAtMs, now, alive) =>
    classifyPresence(
      {
        version: 1,
        clientId: id("client", "direct"),
        instanceId: id("instance", "direct"),
        pid: 0,
        birth: null,
        observedAtMs,
        closed: false,
      },
      now,
      alive,
    ),
});

function operation(
  job: Record<string, unknown>,
  cfg: ConsoleDataConfiguration = {},
) {
  const request = record(job["request"]);
  const result = projectConsoleOperation(job, (value) => text(value, cfg));
  if (job["description"] || request["description"])
    result.description = text(
      job["description"] || request["description"],
      cfg,
    );
  if (request["kind"] === "command" && Array.isArray(request["argv"])) {
    if (!request["argv"].every((arg: unknown) => typeof arg === "string"))
      throw new Error("Invalid recorded command arguments");
    const { rest } = parseFlags(request["argv"]);
    const entry = findCommand(rest);
    result.label = entry?.key || "command";
    if (entry?.kind === "run") {
      let scriptPath;
      for (let i = 1; i < rest.length; i++) {
        if (Object.hasOwn(entry.flags, rest[i]!)) {
          if (entry.flags[rest[i]!] === "value") i++;
          continue;
        }
        if (rest[i] === "--") {
          i++;
          if (rest[i]) scriptPath = rest[i];
          break;
        }
        if (!rest[i]!.startsWith("-")) {
          scriptPath = rest[i];
          break;
        }
      }
      if (scriptPath) result.script = text(path.basename(scriptPath), cfg);
      if (
        scriptPath &&
        (path.isAbsolute(scriptPath) ||
          scriptPath.includes("/") ||
          scriptPath.includes("\\"))
      ) {
        if (typeof request["cwd"] !== "string")
          throw new Error("Recorded command has no project directory");
        const cwd = request["cwd"];
        const resolved = path.resolve(cwd, scriptPath);
        result.sourcePath = text(resolved, cfg);
        const inputs = request["inputFiles"];
        const input = Array.isArray(inputs)
          ? inputs
              .map(record)
              .find(
                (item) =>
                  typeof item["path"] === "string" &&
                  path.resolve(cwd, item["path"]) === resolved,
              )
          : undefined;
        if (
          input &&
          typeof input["sha256"] === "string" &&
          /^[a-f0-9]{64}$/i.test(input["sha256"])
        )
          result.sourceHash = input["sha256"];
      }
      if (result.script) result.label = "run " + result.script;
    }
    const index = rest.indexOf("--doc");
    if (index >= 0 && typeof rest[index + 1] === "string")
      result.document = text(rest[index + 1], cfg);
  }
  return result;
}

export function brokerSnapshot(
  project: string,
  {
    dir = queueDirectory(),
    now = Date.now,
    alive = priorProcessAlive,
    cfg = {},
  }: ConsoleDataOptions = {},
) {
  return readers.brokerSnapshot(project, {
    dir,
    now,
    alive,
    readJson,
    operation: (job) => operation(job, cfg),
    clients: (project) => {
      const presence = readClientPresence(project, {
        now,
        alive: (identity) => alive({ ...identity }),
      });
      return {
        ...presence,
        clients: presence.clients.map((client) => ({
          ...client,
          id: text(client.id, cfg),
        })),
      };
    },
  });
}

export function directSnapshot(
  project: string,
  {
    now = Date.now,
    alive = priorProcessAlive,
    cfg = {},
  }: ConsoleDataOptions = {},
) {
  return readers.directSnapshot(project, {
    now,
    alive,
    readJson,
    operation: (job) => operation(job, cfg),
  });
}

export class ConsoleStore extends ConsoleReadStore {
  constructor(
    mode: string,
    project: string,
    { historyLimit = 500, logLimit = 2000 } = {},
  ) {
    super(mode, project, historyLimit, logLimit, Date.now());
  }
  override unavailable(error: unknown) {
    return super.unavailable(
      text(
        error instanceof SyntaxError
          ? formatJsonError(error)
          : error instanceof Error
            ? error.message
            : String(error),
      ),
    );
  }
}

export function createAdapter({
  project,
  cfg,
  ...options
}: ConsoleDataOptions & { project: string; cfg: ConsoleDataConfiguration }) {
  const mode =
    cfg.routing === "queue"
      ? "broker"
      : cfg.routing === "direct"
        ? "direct"
        : "unknown";
  const store = new ConsoleStore(mode, project);
  const collector = createCollector();
  const logTracker = new Map<string, LogCursor>();
  const adapter = {
    store,
    read() {
      let snapshot: ConsoleSnapshot;
      try {
        if (!project || mode === "unknown")
          throw new Error("Select a project and a known routing configuration");
        snapshot =
          mode === "broker"
            ? brokerSnapshot(project, { ...options, cfg })
            : directSnapshot(project, { ...options, cfg });
      } catch (error) {
        snapshot = store.unavailable(error);
        snapshot.readAt = Date.now();
      }
      if (project) {
        try {
          const logs = readLogs(project, cfg, 2000, 256 * 1024, logTracker);
          snapshot.logs = logs.logs;
          snapshot["logSources"] = logs.sources;
          snapshot["logsResynced"] = logs.resynced;
          snapshot.retention = {
            ...snapshot.retention,
            logWindowTruncated: logs.truncated,
            logFilesRead: logs.sources.length,
            logBytesRead: logs.bytesRead,
          };
        } catch {
          if (store.value.logs === undefined) delete snapshot.logs;
          else snapshot.logs = store.value.logs;
          snapshot["logWarning"] = "Log source unavailable";
        }
        if (mode === "broker") {
          try {
            const file = path.join(
              options.dir || queueDirectory(),
              "instance.json",
            );
            const identity = record(readJson(file));
            const instance = record(identity["instance"]);
            const documents = instance["documents"];
            snapshot["fusion"] = {
              connectivity: "unknown",
              source: "last-broker-identity",
              observedAt: fs.statSync(file).mtimeMs,
              document: Array.isArray(documents)
                ? documents.map(record).find((doc) => doc["isActive"])?.[
                    "name"
                  ] || null
                : null,
              version: instance["version"] || null,
            };
          } catch {
            /* No SDK observation is available. */
          }
        }
      }
      const system = collector.read(snapshot);
      snapshot["system"] = system;
      snapshot["host"] = system.host;
      return store.replace(snapshot);
    },
  };
  return {
    ...adapter,
    observation: createConsoleReadPort(
      () => adapter.read(),
      options.now || Date.now,
    ),
  };
}
