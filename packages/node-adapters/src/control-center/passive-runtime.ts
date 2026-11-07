import fs from "node:fs";
import path from "node:path";
import type {
  ConsoleTelemetryAvailability,
  ConsoleTelemetryPresenceInput,
  ConsoleTelemetryExecutionRecord,
} from "@fmcad/core";
import type { ProjectRegistryStore } from "../../../core/src/ports/project-registry.js";
import { createCollector } from "../console/system-data.js";
import { readJson } from "../persistence/records.js";
import { clientProcessAlive } from "../telemetry/client-presence.js";
import { defaultOpenCodePresenceDirectory } from "../telemetry/opencode-presence.js";
import {
  readProjectClientPresenceRecords,
  readOpenCodePresenceRecords,
  readWorkerIdentity,
  readExistingFusionReceipts,
} from "../telemetry/passive-collectors.js";
import {
  createConsoleTelemetryReadAdapter,
  normalizeClientPresenceRecords,
  normalizeOpenCodePresenceRecords,
  currentPanelProcess,
  type ConsoleTelemetryRead,
  type QueueTelemetryRead,
  type PresenceTelemetryRead,
  type GlobalPresenceTelemetryRead,
} from "../telemetry/console-telemetry.js";
import type { ConsoleTelemetrySnapshotReader } from "./read-port.js";

type Data = Record<string, unknown>;
interface QueueJob extends Data {
  readonly id: string;
  readonly state: string;
}
interface QueueRead extends QueueTelemetryRead {
  readonly jobs: readonly QueueJob[];
}
export interface PassiveConsoleOptions {
  readonly registry: ProjectRegistryStore;
  readonly queueDirectory: string;
  readonly openCodePresenceDirectory?: string;
  /** Transitional lock reader. Only observations are permitted; no repair or RPC. */
  readonly inspectLocks: (
    directory: string,
    options: { now: () => number },
  ) => unknown;
}
const defaultModules = {
  createConsoleTelemetryReadAdapter,
  normalizeClientPresenceRecords,
  normalizeOpenCodePresenceRecords,
  currentPanelProcess,
  readProjectClientPresenceRecords,
  readOpenCodePresenceRecords,
  readWorkerIdentity,
  readExistingFusionReceipts,
  createSystemCollector: createCollector,
  defaultOpenCodePresenceDirectory,
  clientProcessAlive,
  readJson,
};
type PassiveModules = typeof defaultModules &
  Pick<PassiveConsoleOptions, "inspectLocks"> & { queueDirectory(): string };

function safeCode(error: unknown): string {
  const code = record(error)?.["code"];
  return typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code)
    ? code
    : "PASSIVE_TELEMETRY_UNAVAILABLE";
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function missing<T>(source: string): ConsoleTelemetryRead<T> {
  return { status: "missing", source, value: null, observedAtMs: null };
}

function record(value: unknown): Data | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : null;
}

function registeredProjectId(
  registry: ProjectRegistryStore,
  value: unknown,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const directory = fs.realpathSync(value);
    const matches = registry
      .read()
      .projects.filter((project) => project.path === directory);
    return matches.length === 1 ? matches[0]!.projectId : null;
  } catch {
    return null;
  }
}

function queueJobProjectId(
  registry: ProjectRegistryStore,
  job: Data,
): string | null {
  const request = record(job?.["request"]);
  const context = record(request?.["clientContext"]);
  const knownBindings = new Set(
    [context?.["projectId"], job["projectId"]].flatMap((value) =>
      typeof value === "string" && registry.lookup(value) ? [value] : [],
    ),
  );
  const directoryBinding = registeredProjectId(
    registry,
    context?.["projectDirectory"] ?? request?.["cwd"],
  );
  if (directoryBinding) knownBindings.add(directoryBinding);
  if (knownBindings.size > 1)
    throw Object.assign(
      new Error(
        "Queue observation has contradictory registered project bindings",
      ),
      { code: "QUEUE_PROJECT_BINDING_CONFLICT" },
    );
  const declared = context?.["projectId"] ?? job?.["projectId"];
  if (typeof declared === "string" && declared.trim())
    return registry.lookup(declared)?.projectId ?? null;
  return registeredProjectId(
    registry,
    context?.["projectDirectory"] ?? request?.["cwd"],
  );
}

function queueRecoveryPending(queueDirectory: string): boolean {
  try {
    fs.lstatSync(path.join(queueDirectory, "queue-state.pending.json"));
    return true;
  } catch (error) {
    if (record(error)?.["code"] === "ENOENT") return false;
    throw error;
  }
}

function readQueueJobs(
  modules: PassiveModules,
  registry: ProjectRegistryStore,
  queueDirectory: string,
  projectId: string | null,
): ConsoleTelemetryRead<QueueRead> {
  try {
    if (queueRecoveryPending(queueDirectory))
      return {
        status: "unknown",
        source: "queue-state.json",
        value: null,
        observedAtMs: Date.now(),
        reason: "QUEUE_SNAPSHOT_RECOVERY_PENDING",
      };
    const snapshot = record(
      modules.readJson(
        path.join(queueDirectory, "queue-state.json"),
        128 * 1024 * 1024,
      ),
    );
    if (
      !snapshot ||
      snapshot["version"] !== 1 ||
      !record(snapshot["jobs"]) ||
      !nonnegativeInteger(snapshot["revision"]) ||
      snapshot["revision"] < 0 ||
      !nonnegativeInteger(snapshot["epoch"]) ||
      snapshot["epoch"] < 0
    )
      return {
        status: "error",
        source: "queue-state.json",
        value: null,
        observedAtMs: Date.now(),
        reason: "QUEUE_SNAPSHOT_INVALID",
      };
    const jobs: QueueJob[] = [];
    for (const raw of Object.values(record(snapshot["jobs"])!)) {
      const job = record(raw);
      if (
        !job ||
        typeof job["id"] !== "string" ||
        typeof job["state"] !== "string"
      )
        return {
          status: "error",
          source: "queue-state.json",
          value: null,
          observedAtMs: Date.now(),
          reason: "QUEUE_JOB_INVALID",
        };
      const registeredProject = queueJobProjectId(registry, job);
      if (projectId !== null && registeredProject !== projectId) continue;
      jobs.push(
        registeredProject && job["projectId"] !== registeredProject
          ? {
              ...job,
              id: job["id"],
              state: job["state"],
              projectId: registeredProject,
            }
          : { ...job, id: job["id"], state: job["state"] },
      );
    }
    if (queueRecoveryPending(queueDirectory))
      return {
        status: "unknown",
        source: "queue-state.json",
        value: null,
        observedAtMs: Date.now(),
        reason: "QUEUE_SNAPSHOT_CHANGED_DURING_READ",
      };
    return {
      status: "available",
      source: "queue-state.json",
      sourceId: "fmcad-broker-queue",
      epoch: String(snapshot["epoch"]),
      revision: snapshot["revision"],
      observedAtMs: Date.now(),
      value: {
        jobs,
        complete: true,
        scope: projectId === null ? "broker" : "project",
      },
    };
  } catch (error) {
    if (record(error)?.["code"] === "ENOENT")
      return missing("queue-state.json");
    return {
      status: "error",
      source: "queue-state.json",
      value: null,
      observedAtMs: Date.now(),
      reason: safeCode(error),
    };
  }
}

function combinePresenceAvailability(
  statuses: readonly ConsoleTelemetryAvailability[],
): ConsoleTelemetryAvailability {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("available")) return "available";
  return "missing";
}

function combineCompletePresenceAvailability(
  statuses: readonly ConsoleTelemetryAvailability[],
): ConsoleTelemetryAvailability {
  if (statuses.includes("error")) return "error";
  if (statuses.length > 0 && statuses.every((status) => status === "missing"))
    return "missing";
  if (statuses.every((status) => ["available", "stale"].includes(status)))
    return combinePresenceAvailability(statuses);
  return "unknown";
}

function presenceRead(
  modules: PassiveModules,
  projectDirectory: string,
): ConsoleTelemetryRead<PresenceTelemetryRead> {
  const observedAtMs = Date.now();
  const client = modules.readProjectClientPresenceRecords(projectDirectory, {
    now: () => observedAtMs,
    processAlive: modules.clientProcessAlive,
  });
  const openCode = modules.readOpenCodePresenceRecords(
    modules.defaultOpenCodePresenceDirectory(),
    projectDirectory,
    { now: () => observedAtMs, processAlive: modules.clientProcessAlive },
  );
  return {
    status: "available",
    source: `${client.source}+${openCode.source}`,
    observedAtMs,
    value: {
      clientRecords: client.value ?? [],
      clientStatus: client.status,
      openCodeRecords: openCode.value ?? [],
      openCodeStatus: openCode.status,
    },
    ...(client.reason || openCode.reason
      ? { reason: client.reason ?? openCode.reason }
      : {}),
  };
}

function readGlobalPresence(
  modules: PassiveModules,
  registry: ProjectRegistryStore,
): ConsoleTelemetryRead<GlobalPresenceTelemetryRead> {
  const observedAtMs = Date.now();
  const projects = registry.read().projects;
  if (!projects.length) return missing("registered-project-client-presence");
  const clientRecords: ConsoleTelemetryPresenceInput[] = [];
  const clientStatuses: ConsoleTelemetryAvailability[] = [];
  for (const project of projects) {
    const read = modules.readProjectClientPresenceRecords(project.path, {
      now: () => observedAtMs,
      processAlive: modules.clientProcessAlive,
    });
    clientStatuses.push(read.status);
    if (read.value)
      clientRecords.push(
        ...modules.normalizeClientPresenceRecords(
          read.value,
          project.projectId,
          project.path,
          observedAtMs,
          modules.clientProcessAlive,
        ),
      );
  }
  const openCode = modules.readOpenCodePresenceRecords(
    modules.defaultOpenCodePresenceDirectory(),
    projects.map((project) => project.path),
    { now: () => observedAtMs, processAlive: modules.clientProcessAlive },
  );
  const clientStatus = combineCompletePresenceAvailability(clientStatuses);
  const openCodeRecords = (openCode.value ?? []).flatMap((record) =>
    projects.flatMap((project) =>
      modules.normalizeOpenCodePresenceRecords(
        [record],
        project.projectId,
        project.path,
        observedAtMs,
        modules.clientProcessAlive,
      ),
    ),
  );
  return {
    status: "available",
    source:
      "registered-project-client-process-heartbeats+opencode-diagnostic-presence",
    observedAtMs,
    value: {
      records: [...clientRecords, ...openCodeRecords],
      clientStatus,
      openCodeStatus: openCode.status,
    },
    ...(clientStatuses.includes("unknown") || openCode.reason
      ? {
          reason: clientStatuses.includes("unknown")
            ? "GLOBAL_CLIENT_PRESENCE_SOURCE_INCOMPLETE"
            : openCode.reason,
        }
      : {}),
  };
}

function terminalExecutions(
  queue: ConsoleTelemetryRead<QueueRead> | null,
): ConsoleTelemetryRead<readonly ConsoleTelemetryExecutionRecord[]> {
  if (!queue) return missing("queue-state.terminal-executions");
  if (!queue.value)
    return {
      status: queue.status,
      source: "queue-state.terminal-executions",
      value: null,
      observedAtMs: queue.observedAtMs ?? null,
      reason: queue.reason ?? null,
    };
  return {
    status: queue.status,
    source: "queue-state.terminal-executions",
    value: queue.value.jobs
      .filter((job) =>
        ["succeeded", "failed", "cancelled", "expired"].includes(job["state"]),
      )
      .map((job) => ({
        state: job["state"],
        finishedAtMs: nonnegativeInteger(job["finishedAt"])
          ? job["finishedAt"]
          : null,
      })),
    observedAtMs: queue.observedAtMs ?? null,
  };
}

function readProjectLocks(
  modules: PassiveModules,
  projectDirectory: string,
): ConsoleTelemetryRead<unknown> {
  const observedAtMs = Date.now();
  try {
    const value = record(
      modules.inspectLocks(projectDirectory, {
        now: () => observedAtMs,
      }),
    );
    return {
      status: "available",
      source:
        typeof value?.["source"] === "string"
          ? value["source"]
          : "console-locks-read-only",
      value,
      observedAtMs:
        typeof value?.["readAt"] === "number" ? value["readAt"] : observedAtMs,
    };
  } catch (error) {
    return {
      status: "error",
      source: "console-locks-read-only",
      value: null,
      observedAtMs,
      reason: safeCode(error),
    };
  }
}

function readGlobalLocks(
  modules: PassiveModules,
  registry: ProjectRegistryStore,
): ConsoleTelemetryRead<unknown> {
  const observedAtMs = Date.now();
  const projects = registry.read().projects;
  if (!projects.length) return missing("registered-project-console-locks");
  if (projects.length > 128)
    return {
      status: "unknown",
      source: "registered-project-console-locks",
      value: null,
      observedAtMs,
      reason: "GLOBAL_LOCK_PROJECT_BOUND_EXCEEDED",
    };
  const values = projects.map((project) =>
    record(modules.inspectLocks(project.path, { now: () => observedAtMs })),
  );
  const statuses = values.map((value) => value?.["status"]);
  const status = statuses.includes("active")
    ? "active"
    : statuses.every((value) => value === "unsupported")
      ? "unsupported"
      : "unknown";
  return {
    status: "available",
    source: "registered-project-console-locks",
    value: {
      status,
      source: "registered-project-console-locks",
      readAt: observedAtMs,
      reason:
        status === "active"
          ? "At least one registered project has a positively observed lock owner"
          : statuses.every((value) => value === "unknown")
            ? "No verified lock owner; absence does not establish unlocked state"
            : "One or more project lock observations are incomplete",
      entries: values.flatMap((value) =>
        Array.isArray(value?.["entries"]) ? value["entries"] : [],
      ),
    },
    observedAtMs,
    ...(statuses.some((value) => value === "unknown")
      ? { reason: "GLOBAL_LOCK_OBSERVATION_INCOMPLETE" }
      : {}),
  };
}

function readBrokerOwner(
  modules: PassiveModules,
  queueDirectory: string,
): { pid: number; birth: string } | null {
  try {
    const marker = record(
      modules.readJson(path.join(queueDirectory, "broker.lock"), 16_384),
    );
    if (
      marker &&
      nonnegativeInteger(marker["pid"]) &&
      marker["pid"] > 0 &&
      typeof marker["birth"] === "string" &&
      marker["birth"].length > 0
    )
      return { pid: marker["pid"], birth: marker["birth"] };
  } catch {
    // Missing/unreadable ownership leaves broker process metrics unavailable.
  }
  return null;
}

function telemetryReader(
  modules: PassiveModules,
  registry: ProjectRegistryStore,
): ConsoleTelemetrySnapshotReader {
  const queueDirectory = modules.queueDirectory();
  const systemCollector = modules.createSystemCollector();
  let currentQueueRead: ConsoleTelemetryRead<QueueRead> | null = null;
  let currentFusionReceipts = new Map<string, Record<string, unknown>>();
  const reader = modules.createConsoleTelemetryReadAdapter({
    now: Date.now,
    queueJobs: (projectId) => {
      currentQueueRead = readQueueJobs(
        modules,
        registry,
        queueDirectory,
        projectId,
      );
      currentFusionReceipts = new Map();
      return currentQueueRead;
    },
    registeredProjects: () => ({
      status: "available",
      source: "registered-project-history",
      value: registry.read().projects.map((project) => project.projectId),
      observedAtMs: Date.now(),
    }),
    presence: (projectDirectory) => presenceRead(modules, projectDirectory),
    globalPresence: () => readGlobalPresence(modules, registry),
    systemMetrics: (projectDirectory) => {
      try {
        const owner = readBrokerOwner(modules, queueDirectory);
        const value = systemCollector.read({
          mode: "broker",
          ...(projectDirectory ? { project: projectDirectory } : {}),
          ...(owner ? { broker: { owner } } : {}),
        });
        return {
          status: "available",
          source: "read-only-host-os-metrics",
          value,
          observedAtMs: value.readAt,
        };
      } catch (error) {
        return {
          status: "error",
          source: "read-only-host-os-metrics",
          value: null,
          observedAtMs: Date.now(),
          reason: safeCode(error),
        };
      }
    },
    panelProcess: modules.currentPanelProcess,
    workerIdentity: (jobId) =>
      modules.readWorkerIdentity(queueDirectory, jobId, {
        processAlive: modules.clientProcessAlive,
      }).value,
    fusionReceipt: (jobId, kind) => {
      let receipts = currentFusionReceipts.get(jobId);
      if (!receipts) {
        const job = currentQueueRead?.value?.jobs.find(
          (item) => item.id === jobId,
        );
        if (!job) return null;
        const read = modules.readExistingFusionReceipts(queueDirectory, [
          { jobId, state: job["state"] },
        ]);
        receipts = Object.fromEntries(
          (read.value ?? []).map((item) => [item.source, item.receipt]),
        );
        currentFusionReceipts.set(jobId, receipts);
      }
      return receipts[kind] ?? null;
    },
    locks: (projectDirectory) => readProjectLocks(modules, projectDirectory),
    globalLocks: () => readGlobalLocks(modules, registry),
    timingSamples: () => missing("timing-samples-not-connected"),
    terminalExecutions: () => terminalExecutions(currentQueueRead),
    processAlive: modules.clientProcessAlive,
  });
  return { read: (request) => reader.read(request) };
}

/** Passive observations only: never dispatches Fusion work or repairs queue state. */
export function createPassiveConsoleTelemetry(
  options: PassiveConsoleOptions,
): ConsoleTelemetrySnapshotReader {
  return telemetryReader(
    {
      ...defaultModules,
      defaultOpenCodePresenceDirectory: () =>
        options.openCodePresenceDirectory ?? defaultOpenCodePresenceDirectory(),
      inspectLocks: options.inspectLocks,
      queueDirectory: () => options.queueDirectory,
    },
    options.registry,
  );
}
