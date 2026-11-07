import path from "node:path";
import {
  collectConsoleTelemetry,
  normalizeConsoleFusionReceipt,
  normalizeConsoleLocks,
  normalizeConsoleTelemetryJob,
  summarizeConsolePresence,
  type ConsoleTelemetryTimingSample,
} from "@fmcad/core";
import type {
  ConsoleTelemetryAvailability,
  ConsoleTelemetryCursor,
  ConsoleTelemetryEvent,
  ConsoleTelemetryExecutionRecord,
  ConsoleTelemetryPresenceInput,
  ConsoleTelemetrySnapshot,
} from "@fmcad/core";
import { currentProcessIdentity } from "./client-presence";

type Data = Record<string, unknown>;

export interface ConsoleTelemetryRead<T> {
  readonly status: ConsoleTelemetryAvailability;
  readonly value: T | null;
  readonly source: string;
  readonly sourceId?: string | null;
  readonly epoch?: string | null;
  readonly sequence?: number | null;
  readonly revision?: number | null;
  readonly observedAtMs?: number | null;
  readonly reason?: string | null;
}

export interface QueueTelemetryRead {
  readonly jobs: readonly unknown[];
  readonly complete: boolean;
  readonly scope: "project" | "broker";
}

export interface PresenceTelemetryRead {
  readonly clientRecords: readonly unknown[];
  readonly clientStatus: ConsoleTelemetryAvailability;
  readonly openCodeRecords: readonly unknown[];
  readonly openCodeStatus: ConsoleTelemetryAvailability;
}

export interface GlobalPresenceTelemetryRead {
  readonly records: readonly ConsoleTelemetryPresenceInput[];
  readonly clientStatus: ConsoleTelemetryAvailability;
  readonly openCodeStatus: ConsoleTelemetryAvailability;
}

export interface ConsoleTelemetryReadPorts {
  readonly now: () => number;
  readonly queueJobs: (
    projectId: string | null,
  ) => ConsoleTelemetryRead<QueueTelemetryRead>;
  readonly registeredProjects: () => ConsoleTelemetryRead<readonly string[]>;
  readonly presence: (
    projectDirectory: string,
  ) => ConsoleTelemetryRead<PresenceTelemetryRead>;
  readonly globalPresence?: () => ConsoleTelemetryRead<GlobalPresenceTelemetryRead>;
  readonly systemMetrics: () => ConsoleTelemetryRead<unknown>;
  readonly panelProcess?: () => unknown;
  readonly workerIdentity: (jobId: string) => unknown;
  /** Reads only receipts already written by preflight/postflight; never sends RPC. */
  readonly fusionReceipt: (
    jobId: string,
    kind: "preflight" | "postflight",
  ) => unknown;
  readonly locks: (projectDirectory: string) => ConsoleTelemetryRead<unknown>;
  readonly globalLocks?: () => ConsoleTelemetryRead<unknown>;
  readonly timingSamples: (
    projectId: string | null,
  ) => ConsoleTelemetryRead<readonly ConsoleTelemetryTimingSample[]>;
  readonly terminalExecutions: (
    projectId: string | null,
  ) => ConsoleTelemetryRead<readonly ConsoleTelemetryExecutionRecord[]>;
  readonly processAlive: (identity: {
    readonly pid: number;
    readonly birth: string;
  }) => boolean | null;
}

export interface ConsoleTelemetryReadRequest {
  readonly scope:
    | {
        readonly kind: "project";
        readonly projectId: string;
        readonly projectDirectory: string;
      }
    | { readonly kind: "global" };
  readonly previousCursor?: ConsoleTelemetryCursor | null;
  readonly timingWindowMs?: number;
}

function asRecord(value: unknown): Data | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function effectiveAvailability(
  outer: ConsoleTelemetryAvailability,
  inner: ConsoleTelemetryAvailability,
): ConsoleTelemetryAvailability {
  if (outer === "available") return inner;
  return outer === "stale" && inner === "available" ? "stale" : outer;
}

function processIdentity(
  value: unknown,
  processAlive: ConsoleTelemetryReadPorts["processAlive"],
): { pid: number | null; birth: string | null; alive: boolean | null } {
  const record = asRecord(value);
  const pid = record?.["pid"];
  const birth = text(record?.["birth"]);
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !birth)
    return {
      pid: Number.isSafeInteger(pid) ? (pid as number) : null,
      birth,
      alive: null,
    };
  return {
    pid: pid as number,
    birth,
    alive: processAlive({ pid: pid as number, birth }),
  };
}

function projectMatches(raw: unknown, projectDirectory: string): boolean {
  const record = asRecord(raw);
  const candidate = text(record?.["project"]);
  if (!candidate) return false;
  try {
    const root = path.resolve(projectDirectory);
    const relative = path.relative(root, path.resolve(candidate));
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

/** Normalize the full on-disk client heartbeat set; no recent-256 page limit. */
export function normalizeClientPresenceRecords(
  records: readonly unknown[],
  projectId: string,
  projectDirectory: string,
  readAtMs: number,
  processAlive: ConsoleTelemetryReadPorts["processAlive"],
): ConsoleTelemetryPresenceInput[] {
  return records.flatMap((raw) => {
    const record = asRecord(raw);
    if (
      !record ||
      record["version"] !== 1 ||
      !projectMatches(raw, projectDirectory)
    )
      return [];
    const pid = record["pid"];
    const birth = text(record["birth"]);
    const clientId = text(record["clientId"]);
    const observedAtMs = record["observedAt"];
    if (
      !Number.isSafeInteger(pid) ||
      (pid as number) <= 0 ||
      typeof record["closed"] !== "boolean" ||
      typeof observedAtMs !== "number" ||
      !Number.isFinite(observedAtMs) ||
      !clientId
    )
      return [];
    const alive =
      record["closed"] === true
        ? false
        : birth
          ? processAlive({ pid: pid as number, birth })
          : null;
    return [
      {
        projectId,
        source: "project-client-process-heartbeat",
        pid: pid as number,
        birth,
        clientId,
        observedAtMs,
        alive,
        presence:
          record["closed"] === true
            ? "offline"
            : alive === null
              ? "unknown"
              : alive === false
                ? "offline"
                : readAtMs - observedAtMs > 15_000
                  ? "stale"
                  : readAtMs < observedAtMs
                    ? "unknown"
                    : "observed",
      },
    ];
  });
}

/** Normalize OpenCode's passive diagnostic presence without creating AI agents. */
export function normalizeOpenCodePresenceRecords(
  records: readonly unknown[],
  projectId: string,
  projectDirectory: string,
  readAtMs: number,
  processAlive: ConsoleTelemetryReadPorts["processAlive"],
): ConsoleTelemetryPresenceInput[] {
  const normalized: ConsoleTelemetryPresenceInput[] = [];
  for (const raw of records) {
    const file = asRecord(raw);
    if (
      !file ||
      file["schemaVersion"] !== 1 ||
      !Array.isArray(file["sessions"])
    )
      continue;
    const pid = file["pid"];
    const birth = text(file["birth"]);
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) continue;
    const processState = birth
      ? processAlive({ pid: pid as number, birth })
      : null;
    for (const rawSession of file["sessions"]) {
      const session = asRecord(rawSession);
      if (!session || !projectMatches(session, projectDirectory)) continue;
      const sessionId = text(session["sessionId"] ?? session["sessionID"]);
      const reportedSessionId = text(session["id"]);
      const observedAtMs = file["updatedAt"];
      if (
        !reportedSessionId ||
        typeof observedAtMs !== "number" ||
        !Number.isFinite(observedAtMs)
      )
        continue;
      const ended = ["ended", "deleted"].includes(String(session["status"]));
      normalized.push({
        projectId,
        source: "opencode-diagnostic-presence",
        pid: pid as number,
        birth,
        ...(sessionId ? { sessionId } : {}),
        ...(text(session["clientId"])
          ? { reportedClientId: text(session["clientId"])! }
          : {}),
        reportedSessionId,
        observedAtMs,
        alive: ended ? false : processState,
        presence:
          ended || processState === false
            ? "offline"
            : processState === null || readAtMs < observedAtMs
              ? "unknown"
              : readAtMs - observedAtMs > 15_000
                ? "stale"
                : "observed",
        ...(text(session["agent"]) ? { agent: text(session["agent"])! } : {}),
        ...(text(session["agentId"])
          ? { agentId: text(session["agentId"])! }
          : {}),
        ...(text(session["model"]) ? { model: text(session["model"])! } : {}),
        ...(text(session["role"]) ? { role: text(session["role"])! } : {}),
      });
    }
  }
  return normalized;
}

export function normalizeWorkerIdentity(
  raw: unknown,
  processAlive: ConsoleTelemetryReadPorts["processAlive"],
): { pid: number | null; birth: string | null; alive: boolean | null } {
  return processIdentity(raw, processAlive);
}

/** The web server process is reported as panel; no browser process is observed. */
export function currentPanelProcess(): {
  readonly pid: number;
  readonly birth: string | null;
  readonly alive: boolean | null;
} {
  const identity = currentProcessIdentity();
  return {
    pid: process.pid,
    birth: identity?.birth ?? null,
    alive: identity ? true : null,
  };
}

function jobState(job: unknown): string | null {
  return text(asRecord(job)?.["state"]);
}

function jobId(job: unknown): string | null {
  return text(asRecord(job)?.["id"]);
}

function shouldReadWorkerIdentity(job: unknown): boolean {
  return ["preparing", "queued", "sending", "running", "processing"].includes(
    jobState(job) ?? "",
  );
}

function currentWorkers(
  jobs: readonly unknown[],
  ports: ConsoleTelemetryReadPorts,
  readAtMs: number,
): { readonly processes: readonly unknown[]; readonly complete: boolean } {
  const workers = new Map<string, unknown>();
  let complete = true;
  for (const job of jobs) {
    const id = jobId(job);
    if (!id || !shouldReadWorkerIdentity(job)) continue;
    const identity = normalizeWorkerIdentity(
      ports.workerIdentity(id),
      ports.processAlive,
    );
    if (!identity.pid || !identity.birth) {
      complete = false;
      continue;
    }
    const key = `${identity.pid}:${identity.birth}`;
    workers.set(key, {
      ...identity,
      observedAtMs: readAtMs,
      rssBytes: null,
      uptimeSeconds: null,
      cpuPercent: null,
    });
  }
  return { processes: [...workers.values()], complete };
}

function attachExistingFusionReceipts(
  job: unknown,
  event: ConsoleTelemetryEvent,
  ports: ConsoleTelemetryReadPorts,
  readAtMs: number,
): ConsoleTelemetryEvent {
  const state = jobState(job);
  if (
    !state ||
    ["unknown", "unresolved", "needs_reconciliation", "blocked"].includes(state)
  )
    return event;
  const id = jobId(job);
  if (!id) return event;
  const postflight = ports.fusionReceipt(id, "postflight");
  const receipt = postflight ?? ports.fusionReceipt(id, "preflight");
  if (receipt === null || receipt === undefined) return event;
  const normalized = normalizeConsoleFusionReceipt(
    receipt,
    postflight ? "postflight" : "preflight",
    {
      sourceId: "existing-fusion-receipt",
      readAtMs,
      observedAtMs: null,
    },
  );
  return { ...event, fusion: normalized };
}

/** Pairs only already-read passive sources. This adapter never talks to Fusion or the queue. */
export function createConsoleTelemetryReadAdapter(
  ports: ConsoleTelemetryReadPorts,
) {
  return {
    read(request: ConsoleTelemetryReadRequest): ConsoleTelemetrySnapshot {
      const readAtMs = ports.now();
      if (!Number.isSafeInteger(readAtMs) || readAtMs < 0)
        throw new Error("Telemetry clock returned an invalid timestamp");
      const projectScope = request.scope.kind === "project";
      const projectId = projectScope ? request.scope.projectId : null;
      const projectDirectory = projectScope
        ? request.scope.projectDirectory
        : null;
      const scope = projectScope ? "project" : "broker";
      const queue = ports.queueJobs(projectId);
      const queueValue = queue.value;
      const sourceScopeMatches = !!queueValue && queueValue.scope === scope;
      const projectRegistry = projectScope ? null : ports.registeredProjects();
      const jobs = sourceScopeMatches ? queueValue!.jobs : null;
      const events = jobs
        ? jobs.map((job) => {
            const id = jobId(job);
            const workerIdentity =
              id && shouldReadWorkerIdentity(job)
                ? normalizeWorkerIdentity(
                    ports.workerIdentity(id),
                    ports.processAlive,
                  )
                : null;
            const normalized = normalizeConsoleTelemetryJob(job, {
              projectId,
              sourceId: queue.sourceId,
              epoch: queue.epoch,
              sequence: queue.sequence,
              revision: queue.revision,
              observedAtMs: queue.observedAtMs,
              readAtMs,
              transport: text(
                asRecord(asRecord(job)?.["request"])?.["transport"],
              ),
              freshness: queue.status,
              worker: workerIdentity,
            });
            return attachExistingFusionReceipts(
              job,
              normalized,
              ports,
              readAtMs,
            );
          })
        : [];
      const presence = projectScope
        ? ports.presence(projectDirectory!)
        : (ports.globalPresence?.() ?? {
            status: "missing" as const,
            value: null,
            source: "global-presence-source-not-provided",
            observedAtMs: null,
            reason: "GLOBAL_PRESENCE_SOURCE_NOT_PROVIDED",
            truncated: false,
          });
      const presenceRead = presence.value;
      const presenceSources = presenceRead
        ? projectScope
          ? [
              ...normalizeClientPresenceRecords(
                (presenceRead as PresenceTelemetryRead).clientRecords,
                projectId!,
                projectDirectory!,
                readAtMs,
                ports.processAlive,
              ),
              ...normalizeOpenCodePresenceRecords(
                (presenceRead as PresenceTelemetryRead).openCodeRecords,
                projectId!,
                projectDirectory!,
                readAtMs,
                ports.processAlive,
              ),
            ]
          : (presenceRead as GlobalPresenceTelemetryRead).records
        : null;
      const presenceComplete = {
        clients: effectiveAvailability(
          presence.status,
          presenceRead
            ? (
                presenceRead as
                  PresenceTelemetryRead | GlobalPresenceTelemetryRead
              ).clientStatus
            : presence.status,
        ),
        openCode: effectiveAvailability(
          presence.status,
          presenceRead
            ? (
                presenceRead as
                  PresenceTelemetryRead | GlobalPresenceTelemetryRead
              ).openCodeStatus
            : presence.status,
        ),
      } as const;
      const system = ports.systemMetrics();
      const lock = projectScope
        ? ports.locks(projectDirectory!)
        : (ports.globalLocks?.() ?? {
            status: "missing" as const,
            value: null,
            source: "global-lock-source-not-provided",
            observedAtMs: null,
            reason: "GLOBAL_LOCK_SOURCE_NOT_PROVIDED",
            truncated: false,
          });
      const timing = ports.timingSamples(projectId);
      const executions = ports.terminalExecutions(projectId);
      const workers = jobs
        ? currentWorkers(jobs, ports, readAtMs)
        : { processes: null, complete: false };
      const cursorPosition = queue.sequence ?? queue.revision ?? null;
      const sourceCursor =
        queue.sourceId && queue.epoch && cursorPosition !== null
          ? {
              sourceId: queue.sourceId,
              epoch: queue.epoch,
              position: cursorPosition,
              positionKind:
                queue.sequence !== null && queue.sequence !== undefined
                  ? ("sequence" as const)
                  : ("revision" as const),
              eventId:
                events
                  .map((event) => event.metadata.eventId.value)
                  .filter((eventId): eventId is string => eventId !== null)
                  .sort((left, right) => left.localeCompare(right))
                  .at(-1) ?? null,
            }
          : null;
      const snapshot = collectConsoleTelemetry({
        projectId,
        sourceId: queue.sourceId,
        readAtMs,
        previousCursor: request.previousCursor,
        sourceCursor,
        jobs,
        jobsComplete:
          sourceScopeMatches &&
          ["available", "stale"].includes(queue.status) &&
          queueValue!.complete,
        jobsScope: scope,
        registeredProjectIds:
          projectRegistry?.status === "available" ||
          projectRegistry?.status === "stale"
            ? projectRegistry.value
            : null,
        registeredProjectsComplete:
          projectRegistry?.status === "available" &&
          projectRegistry.value !== null,
        jobSource: {
          sourceId: queue.sourceId,
          epoch: queue.epoch,
          sequence: queue.sequence,
          revision: queue.revision,
          observedAtMs: queue.observedAtMs,
          transport: null,
          freshness: queue.status,
        },
        presenceSources,
        presenceComplete,
        presenceScope: scope,
        systemMetrics: system.value,
        systemAvailability: system.status,
        panelProcess: ports.panelProcess?.() ?? currentPanelProcess(),
        workerProcesses: workers.processes,
        workersComplete:
          workers.complete &&
          sourceScopeMatches &&
          queue.status === "available",
        workersScope: scope,
        locks: lock.value,
        locksAvailability: lock.status,
        timingSamples:
          timing.status === "available" || timing.status === "stale"
            ? timing.value
            : null,
        timingAvailability: timing.status,
        executions:
          executions.status === "available" || executions.status === "stale"
            ? executions.value
            : null,
        executionsAvailability: executions.status,
        timingWindowMs: request.timingWindowMs ?? 60 * 60 * 1000,
        timingScope: scope,
      });
      return {
        ...snapshot,
        events: {
          ...snapshot.events,
          value: snapshot.events.value === null ? null : events,
        },
        locks: normalizeConsoleLocks(lock.value, readAtMs, lock.status),
        presence: summarizeConsolePresence(
          projectId,
          presenceSources,
          presenceComplete,
          readAtMs,
          15_000,
          scope,
        ),
      };
    },
  };
}
