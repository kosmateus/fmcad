import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { ConsoleTelemetryOwnedResultInput } from "../../packages/node-adapters/src/telemetry/telemetry-source.js";
import type { ProjectRegistryOptions } from "../../packages/node-adapters/src/persistence/project-history/registry.js";

const requireRuntime = createRequire(__filename);
const projects = requireRuntime(
  "../node-adapters/persistence/project-history/registry.js",
) as typeof import("../../packages/node-adapters/src/persistence/project-history/registry.js");
const queries = requireRuntime(
  "../node-adapters/control-center/read-port.js",
) as typeof import("../../packages/node-adapters/src/control-center/read-port.js");
const producers = requireRuntime(
  "../node-adapters/persistence/project-history/telemetry-runtime.js",
) as typeof import("../../packages/node-adapters/src/persistence/project-history/telemetry-runtime.js");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Passive registered-project writes; no service startup, discovery, or CAD policy. */
export function createMcpStdioTelemetry(options: {
  readonly clientId: string;
  readonly instanceId: string;
  readonly queueDirectory: string;
  readonly registry?: ProjectRegistryOptions;
  readonly onError?: (code: string) => void;
}) {
  const registry = projects.openProjectRegistry(options.registry);
  const adapter = queries.createConsoleQueryNodeAdapter({
    registry,
    queueDirectory: options.queueDirectory,
    telemetry: {
      read() {
        throw new Error("Producer adapters do not perform console reads");
      },
    },
  });
  const runtimes = new Map<
    string,
    ReturnType<typeof producers.createProjectHistoryTelemetryRuntime>
  >();
  let closed = false;
  let closeTask: Promise<void> | undefined;
  function report(error: unknown): void {
    const code = record(error)?.["code"];
    try {
      options.onError?.(
        typeof code === "string" && /^[A-Z0-9_]{1,128}$/.test(code)
          ? code
          : "PASSIVE_TELEMETRY_UNAVAILABLE",
      );
    } catch {
      /* Passive diagnostics cannot affect delivery. */
    }
  }
  function runtimeFor(projectId: unknown) {
    if (typeof projectId !== "string" || !registry.lookup(projectId))
      throw Object.assign(
        new Error("An explicit registered project is required"),
        { code: "HISTORY_TELEMETRY_PROJECT_REQUIRED" },
      );
    const cached = runtimes.get(projectId);
    if (cached) return cached;
    if (runtimes.size >= 64)
      throw Object.assign(new Error("Producer project bound reached"), {
        code: "HISTORY_TELEMETRY_PROJECT_LIMIT",
      });
    const runtime = producers.createProjectHistoryTelemetryRuntime({
      projectId,
      sourceId: `mcp-stdio:${createHash("sha256").update(`${options.clientId}\0${options.instanceId}\0${projectId}`).digest("hex")}`,
      queueDirectory: options.queueDirectory,
      registry,
      eventSink: adapter.eventSink,
      recordGap: adapter.recordGap,
      onError: report,
    });
    runtimes.set(projectId, runtime);
    return runtime;
  }
  function projectFor(job: Record<string, unknown>): string | null {
    const request = record(job["request"]);
    const context = record(request?.["clientContext"]);
    const declared = context?.["projectId"] ?? job["projectId"];
    // An invalid explicit identity must never silently fall back to a path.
    if (declared !== undefined && declared !== null)
      return typeof declared === "string"
        ? (registry.lookup(declared)?.projectId ?? null)
        : null;
    const directory = context?.["projectDirectory"] ?? request?.["cwd"];
    if (typeof directory !== "string") return null;
    const canonical = realpathSync(directory);
    const matches = registry
      .read()
      .projects.filter((project) => project.path === canonical);
    return matches.length === 1 ? matches[0]!.projectId : null;
  }
  return {
    publishJob(value: unknown): void {
      if (closed) return;
      try {
        const job = record(value);
        if (!job) throw new Error("Invalid queue observation");
        const projectId = projectFor(job);
        runtimeFor(projectId).source.publishJob(job, {
          projectId,
          revision:
            typeof job["revision"] === "number" &&
            Number.isSafeInteger(job["revision"])
              ? job["revision"]
              : null,
          observedAtMs: Date.now(),
          transport: "mcp-stdio",
        });
      } catch (error) {
        report(error);
      }
    },
    publishOwnedResult(input: ConsoleTelemetryOwnedResultInput): void {
      if (closed) return;
      try {
        runtimeFor(input.job["projectId"]).source.publishOwnedResult(input);
      } catch (error) {
        report(error);
      }
    },
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closed = true;
      closeTask = (async () => {
        try {
          for (const runtime of runtimes.values()) {
            try {
              await runtime.close();
            } catch (error) {
              report(error);
            }
          }
        } finally {
          adapter.close();
        }
      })();
      return closeTask;
    },
  };
}
