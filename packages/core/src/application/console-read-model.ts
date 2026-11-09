import type { OperationResult } from "../domain/contracts";
import type { PresenceState } from "../domain/observation";

/** UI records are observations, never receipts or admission authority. */
export interface ConsoleRow {
  id?: string;
  requestId?: string | null;
  clientId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  state?: string;
  kind?: string;
  label?: string;
  description?: string;
  document?: string;
  sourcePath?: string;
  sourceHash?: string;
  script?: string;
  source?: string;
  sourceFile?: string;
  presence?: PresenceState;
  clientKind?: string;
  work?: string;
  name?: string;
  level?: string;
  component?: string;
  event?: string;
  message?: string;
  timestamp?: string | number | null;
  submittedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastSeen?: number | null;
  order?: number | null;
  operations?: ConsoleRow[];
  operationResult?: OperationResult;
  [key: string]: unknown;
}

export interface ConsoleSnapshot {
  mode?: string;
  project?: string;
  readAt?: number;
  observedAt?: number | null;
  available?: boolean;
  reason?: string | null;
  capabilities?: { monitor: boolean; brokerControl: boolean };
  operations?: ConsoleRow[] | null;
  agents?: ConsoleRow[] | null;
  logs?: ConsoleRow[] | null;
  taskEvents?: { taskId: string; logs: ConsoleRow[] | null };
  retention?: Record<string, unknown>;
  [key: string]: unknown;
}

export const nonemptyId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export const terminalState = (state: unknown): boolean =>
  ["succeeded", "failed", "cancelled", "expired", "completed"].includes(
    String(state),
  );
export const openOperation = (row: ConsoleRow): boolean =>
  !terminalState(row.state);
export const recordedTime = (value: unknown): number =>
  typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;

/** Paths must first be canonicalized by the adapter. No filesystem access here. */
export function projectContains(
  root: string,
  cwd: string,
  separator = "/",
): boolean {
  const prefix = root.endsWith(separator) ? root : root + separator;
  return cwd === root || cwd.startsWith(prefix);
}

export function sourceName(row: ConsoleRow): string | null {
  const path = nonemptyId(row.sourcePath)
    ? row.sourcePath
    : nonemptyId(row.script)
      ? row.script
      : row.label?.match(/^run (.+)$/)?.[1];
  return path?.split(/[\\/]/).at(-1) || null;
}
export function documentLabel(row: ConsoleRow): string | null {
  return nonemptyId(row.document)
    ? row.document
    : sourceName(row)
      ? "py · " + sourceName(row)
      : null;
}
export function clientKind(id: unknown): string {
  if (typeof id !== "string") return "Other";
  return id.startsWith("mcp-stdio:")
    ? "MCP stdio"
    : id.startsWith("opencode:")
      ? "OpenCode"
      : id.startsWith("cli:")
        ? "CLI"
        : "Other";
}

/** Text-only interface; presence semantics must not depend on a terminal renderer. */
export interface ConsolePresenceLabels {
  readonly language: string;
  L(key: string): string;
  statusText(value: ConsoleRow["presence"]): string;
}

export function presenceText(
  row: ConsoleRow,
  labels: ConsolePresenceLabels,
): string {
  if (row.source === "job-history")
    return labels.language === "pl" ? "Tylko historia" : "History only";
  return labels.statusText(row.presence);
}

export function presenceSummary(
  snapshot: ConsoleSnapshot,
  labels: ConsolePresenceLabels,
): string {
  const agents = snapshot.agents ?? [];
  const observed =
    snapshot.available === false
      ? 0
      : agents.filter((agent) => agent.presence === "observed").length;
  if (observed) return `${observed} · ${labels.L("clientPresenceConfirmed")}`;
  const tracked = agents.filter((agent) =>
    agent.source?.endsWith("process-heartbeat"),
  );
  if (tracked.length)
    return `0 online · ${tracked.filter((agent) => agent.presence === "offline").length} offline · ${tracked.filter((agent) => agent.presence !== "offline").length} ${labels.L("unconfirmed")}`;
  return labels.L("clientPresenceUnmeasured");
}

export function identityCounts(
  agents: readonly ConsoleRow[] | null | undefined,
  available?: boolean,
) {
  if (!Array.isArray(agents)) return null;
  const current = agents.filter(
    (agent) => available !== false && agent.presence === "observed",
  ).length;
  return {
    current: agents.every((agent) => agent.source === "job-history")
      ? null
      : current,
    history: agents.length - current,
    total: agents.length,
    untracked: agents.filter((agent) => agent.source === "job-history").length,
    unknown: agents.filter(
      (agent) =>
        agent.source !== "job-history" &&
        (available === false ||
          !agent.presence ||
          agent.presence === "unknown"),
    ).length,
  };
}

export function matchesTask(
  row: ConsoleRow,
  task: ConsoleRow | null | undefined,
): boolean {
  return (
    !!task &&
    ((nonemptyId(task.id) && row.taskId === task.id) ||
      (nonemptyId(task.requestId) &&
        row.requestId === task.requestId &&
        (!nonemptyId(row.taskId) || row.taskId === task.id)))
  );
}
export function eventsFor(
  snapshot: ConsoleSnapshot,
  task: ConsoleRow,
): ConsoleRow[] | null {
  const hasArchive =
    nonemptyId(task.id) && snapshot.taskEvents?.taskId === task.id;
  const archived = hasArchive ? snapshot.taskEvents?.logs : [];
  if (!Array.isArray(snapshot.logs) && !archived?.length)
    return hasArchive ? (archived ?? null) : null;
  return [
    ...new Map(
      [...(snapshot.logs || []), ...(archived || [])]
        .filter((row) => matchesTask(row, task))
        .map((row) => [
          row.sourceFile && row.id?.includes(":")
            ? JSON.stringify([
                row.sourceFile,
                row.id.split(":").at(-1),
                row.timestamp,
                row.message,
              ])
            : row.id,
          row,
        ]),
    ).values(),
  ].sort(
    (a, b) =>
      (recordedTime(a.timestamp) || 0) - (recordedTime(b.timestamp) || 0),
  );
}
export function kindOf(row?: ConsoleRow | null): "log" | "agent" | "task" {
  return row?.level
    ? "log"
    : Array.isArray(row?.operations) || row?.presence !== undefined
      ? "agent"
      : "task";
}
export function correlate(
  row: ConsoleRow | null | undefined,
  snapshot: ConsoleSnapshot = {},
  kind = kindOf(row),
) {
  if (!row) return { operations: [], events: [], agents: [] };
  const identities = new Set(
    (kind === "agent"
      ? [row.id, row.sessionId]
      : [row.clientId, row.sessionId]
    ).filter(nonemptyId),
  );
  const source = Array.isArray(snapshot.operations)
    ? snapshot.operations
    : null;
  const operations =
    kind === "agent"
      ? source?.filter(
          (op) =>
            (nonemptyId(op.clientId) && identities.has(op.clientId)) ||
            (nonemptyId(op.sessionId) && identities.has(op.sessionId)),
        )
      : kind === "log"
        ? source?.filter((op) =>
            nonemptyId(row.taskId)
              ? op.id === row.taskId
              : nonemptyId(row.requestId) && op.requestId === row.requestId,
          )
        : [row];
  const tasks = new Set(
    (operations || []).map((op) => op.id).filter(nonemptyId),
  );
  const requests = new Set(
    (operations || []).map((op) => op.requestId).filter(nonemptyId),
  );
  if (kind === "log" && nonemptyId(row.taskId)) tasks.add(row.taskId);
  if (kind === "log" && nonemptyId(row.requestId)) requests.add(row.requestId);
  const events =
    kind === "task"
      ? eventsFor(snapshot, row)
      : Array.isArray(snapshot.logs) || snapshot.taskEvents
        ? [
            ...new Map(
              [...(snapshot.logs || []), ...(snapshot.taskEvents?.logs || [])]
                .filter(
                  (log) =>
                    (nonemptyId(log.taskId) && tasks.has(log.taskId)) ||
                    (nonemptyId(log.requestId) &&
                      requests.has(log.requestId) &&
                      (!nonemptyId(log.taskId) || tasks.has(log.taskId))) ||
                    (kind === "agent" &&
                      nonemptyId(log.agentId) &&
                      identities.has(log.agentId)),
                )
                .map((log) => [log.id, log]),
            ).values(),
          ]
        : null;
  const agents = (snapshot.agents || []).filter(
    (agent) =>
      (nonemptyId(agent.id) && identities.has(agent.id)) ||
      (nonemptyId(agent.sessionId) && identities.has(agent.sessionId)) ||
      (kind === "log" &&
        nonemptyId(row.agentId) &&
        [agent.id, agent.sessionId].includes(row.agentId)),
  );
  return { operations: operations ?? null, events, agents };
}

export function baseSnapshot(
  mode: string,
  project: string,
  at: number,
): ConsoleSnapshot {
  return {
    mode,
    project,
    readAt: at,
    observedAt: null,
    generation: null,
    sequence: null,
    available: false,
    reason: "No telemetry",
    capabilities: { monitor: false, brokerControl: false },
    broker: null,
    agents: null,
    operations: null,
    logs: null,
    fusion: { connectivity: "unknown", observedAt: null, source: null },
  };
}
export function retainSnapshot(
  snapshot: ConsoleSnapshot,
  historyLimit = 500,
  logLimit = 2000,
): ConsoleSnapshot {
  if (![historyLimit, logLimit].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("Invalid retention limit");
  const value = JSON.parse(JSON.stringify(snapshot)) as ConsoleSnapshot;
  if (value.operations) {
    const unique = [
      ...new Map(value.operations.map((item) => [item.id, item])).values(),
    ];
    const history = unique
      .filter((item) => terminalState(item.state))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    value.retention = {
      ...value.retention,
      terminalTruncated: Math.max(0, history.length - historyLimit),
    };
    value.operations = [
      ...unique.filter(openOperation),
      ...history.slice(0, historyLimit),
    ];
  }
  if (value.logs)
    value.logs = logLimit === 0 ? [] : value.logs.slice(-logLimit);
  return value;
}

export class ConsoleReadStore {
  value: ConsoleSnapshot;
  constructor(
    readonly mode: string,
    readonly project: string,
    readonly historyLimit = 500,
    readonly logLimit = 2000,
    at = 0,
  ) {
    this.value = baseSnapshot(mode, project, at);
  }
  replace(snapshot: ConsoleSnapshot): ConsoleSnapshot {
    if (snapshot.mode !== this.mode || snapshot.project !== this.project)
      throw new Error(
        "Topology changed; explicit context reselection required",
      );
    this.value = retainSnapshot(snapshot, this.historyLimit, this.logLimit);
    return this.snapshot();
  }
  unavailable(reason: string): ConsoleSnapshot {
    this.value = {
      ...this.value,
      available: false,
      reason,
      capabilities: { monitor: false, brokerControl: false },
    };
    return this.snapshot();
  }
  snapshot(): ConsoleSnapshot {
    return JSON.parse(JSON.stringify(this.value)) as ConsoleSnapshot;
  }
}

export type ReadObservation<T> =
  | { status: "available"; value: T; observedAt: number }
  | { status: "stale"; value: T; observedAt: number | null; reason: string }
  | {
      status: "missing" | "error";
      value: null;
      observedAt: null;
      reason: string;
    };

/** Source comparison cannot prove execution: it compares retained and current bytes only. */
export function sourceHashMismatch(
  expected: unknown,
  actual: unknown,
): boolean | null {
  return typeof expected === "string" &&
    /^[a-f0-9]{64}$/i.test(expected) &&
    typeof actual === "string" &&
    /^[a-f0-9]{64}$/i.test(actual)
    ? expected.toLowerCase() !== actual.toLowerCase()
    : null;
}

export interface AuthoritativeControlState {
  instanceId: string;
  generation: number;
}
export function controlIntent(
  paused: boolean,
  requestId: string,
  observation: ReadObservation<AuthoritativeControlState>,
) {
  if (observation.status !== "available")
    throw new Error("Read fresh authoritative broker state before control");
  const before = observation.value;
  if (
    !nonemptyId(requestId) ||
    !nonemptyId(before.instanceId) ||
    !Number.isSafeInteger(before.generation) ||
    before.generation < 0
  )
    throw new Error("Invalid broker control identity");
  return {
    method: paused ? "pause" : "resume",
    control: {
      requestId,
      instanceId: before.instanceId,
      expectedGeneration: before.generation,
    },
  };
}

/** Summary classifications preserve unknown outcomes instead of inventing success. */
export function consoleTaskGroup(
  row: ConsoleRow,
): "active" | "waiting" | "unresolved" | "history" {
  if (row.state === "queued") return "waiting";
  if (row.state === "running" || row.state === "sending") return "active";
  return terminalState(row.state) ? "history" : "unresolved";
}
export function consoleTaskCounts(
  rows: readonly ConsoleRow[] | null | undefined,
) {
  if (!rows) return null;
  return rows.reduce<Record<ReturnType<typeof consoleTaskGroup>, number>>(
    (counts, row) => {
      counts[consoleTaskGroup(row)]++;
      return counts;
    },
    { active: 0, waiting: 0, unresolved: 0, history: 0 },
  );
}
export function consoleRecordedDuration(row: ConsoleRow): number | null {
  const start = recordedTime(row.startedAt),
    end = recordedTime(row.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;
}
export function consoleLogWindowStats(
  rows: readonly ConsoleRow[] | null | undefined,
) {
  if (!rows) return null;
  const counts = new Map(
    ["INFO", "WARN", "ERROR", "DEBUG", "TRACE", "OTHER"].map((level) => [
      level,
      0,
    ]),
  );
  let first: number | null = null,
    last: number | null = null,
    invalid = 0;
  for (const row of rows) {
    const level = row.level || "OTHER";
    counts.set(level, (counts.get(level) ?? 0) + 1);
    const value = row.timestamp;
    const time =
      typeof value === "number"
        ? value
        : typeof value === "string" &&
            /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())
          ? Date.parse(value)
          : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()))
      invalid++;
    else {
      first = first === null ? time : Math.min(first, time);
      last = last === null ? time : Math.max(last, time);
    }
  }
  return { total: rows.length, counts, first, last, invalid };
}
