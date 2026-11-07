/** Read-only wire model used by the browser adapter. It contains no demo defaults. */
export interface ConsoleRow {
  readonly id?: string | null;
  readonly requestId?: string | null;
  readonly clientId?: string | null;
  readonly agentId?: string | null;
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly state?: string | null;
  readonly kind?: string | null;
  readonly label?: string | null;
  readonly description?: string | null;
  readonly document?: string | null;
  readonly sourceHash?: string | null;
  readonly script?: string | null;
  readonly source?: string | null;
  readonly sourceFile?: string | null;
  readonly presence?: string | null;
  readonly clientKind?: string | null;
  readonly work?: string | null;
  readonly name?: string | null;
  readonly level?: string | null;
  readonly component?: string | null;
  readonly event?: string | null;
  readonly message?: string | null;
  readonly timestamp?: string | number | null;
  readonly submittedAt?: number | null;
  readonly startedAt?: number | null;
  readonly finishedAt?: number | null;
  readonly lastSeen?: number | null;
  readonly order?: number | null;
  readonly operations?: readonly ConsoleRow[] | null;
  readonly [key: string]: unknown;
}

export interface ConsoleSnapshot {
  readonly mode?: string;
  readonly project?: string;
  readonly readAt?: number;
  readonly observedAt?: number | null;
  readonly available?: boolean;
  readonly reason?: string | null;
  readonly capabilities?: {
    readonly monitor?: boolean;
    readonly brokerControl?: boolean;
  };
  readonly operations?: readonly ConsoleRow[] | null;
  readonly agents?: readonly ConsoleRow[] | null;
  readonly logs?: readonly ConsoleRow[] | null;
  readonly taskEvents?: {
    readonly taskId: string;
    readonly logs: readonly ConsoleRow[] | null;
  } | null;
  readonly retention?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
  readonly path?: string | null;
  readonly color?: string | null;
  readonly description?: string | null;
}

export interface OperationalTask extends ConsoleRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly command: string;
  readonly status: string;
  readonly sourceState: string;
  readonly client: string;
  readonly waitMs: number | null;
  readonly executionMs: number | null;
}

export interface OperationalLog extends ConsoleRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly message: string;
  readonly level: string;
}

export interface OperationalClient extends ConsoleRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
}

export interface OperationalProject {
  readonly id: string;
  readonly name: string;
  readonly path: string | null;
  readonly color: string | null;
  readonly description: string | null;
  readonly tasks: readonly OperationalTask[] | null;
  readonly logs: readonly OperationalLog[] | null;
  readonly clients: readonly OperationalClient[] | null;
  readonly snapshot: ConsoleSnapshot;
}

export const nonemptyId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function terminalState(state: unknown): boolean {
  return [
    "succeeded",
    "success",
    "failed",
    "unsuccessful",
    "cancelled",
    "expired",
    "completed",
  ].includes(String(state).toLowerCase());
}

export function openOperation(row: ConsoleRow): boolean {
  return !terminalState(row.state);
}

export function recordedTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string") return Date.parse(value);
  return NaN;
}

function stableEventKey(row: ConsoleRow): string | null {
  if (nonemptyId(row.id)) return `id:${row.id}`;
  const timestamp = row.timestamp;
  const message = row.message;
  if (timestamp != null && nonemptyId(message))
    return `event:${JSON.stringify([row.sourceFile ?? null, timestamp, message, row.taskId ?? null, row.requestId ?? null])}`;
  return null;
}

export function matchesTask(
  row: ConsoleRow,
  task: ConsoleRow | null | undefined,
): boolean {
  if (!task) return false;
  return (
    (nonemptyId(task.id) && nonemptyId(row.taskId) && row.taskId === task.id) ||
    (nonemptyId(task.requestId) &&
      nonemptyId(row.requestId) &&
      row.requestId === task.requestId &&
      (!nonemptyId(row.taskId) || row.taskId === task.id))
  );
}

export function eventsFor(
  snapshot: ConsoleSnapshot,
  task: ConsoleRow,
): ConsoleRow[] | null {
  const taskId = nonemptyId(task.id) ? task.id : null;
  const hasArchive = taskId !== null && snapshot.taskEvents?.taskId === taskId;
  const archived = hasArchive ? (snapshot.taskEvents?.logs ?? null) : [];
  if (!Array.isArray(snapshot.logs) && !archived?.length)
    return hasArchive && archived ? [...archived] : null;

  const unique = new Map<string, ConsoleRow>();
  for (const row of [...(snapshot.logs ?? []), ...(archived ?? [])]) {
    if (!matchesTask(row, task)) continue;
    const key = stableEventKey(row);
    if (key !== null && !unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()].sort(
    (left, right) =>
      (recordedTime(left.timestamp) || 0) -
      (recordedTime(right.timestamp) || 0),
  );
}

function inferredKind(row?: ConsoleRow | null): "log" | "agent" | "task" {
  if (nonemptyId(row?.level)) return "log";
  return Array.isArray(row?.operations) || row?.presence !== undefined
    ? "agent"
    : "task";
}

export function correlate(
  row: ConsoleRow | null | undefined,
  snapshot: ConsoleSnapshot = {},
  kind = inferredKind(row),
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
      ? (source?.filter(
          (operation) =>
            (nonemptyId(operation.clientId) &&
              identities.has(operation.clientId)) ||
            (nonemptyId(operation.sessionId) &&
              identities.has(operation.sessionId)),
        ) ?? null)
      : kind === "log"
        ? (source?.filter((operation) =>
            nonemptyId(row.taskId)
              ? operation.id === row.taskId
              : nonemptyId(row.requestId) &&
                operation.requestId === row.requestId,
          ) ?? null)
        : [row];

  const operationRows = operations ?? [];
  const taskIds = new Set(
    operationRows.map((operation) => operation.id).filter(nonemptyId),
  );
  const requestIds = new Set(
    operationRows.map((operation) => operation.requestId).filter(nonemptyId),
  );
  if (kind === "log" && nonemptyId(row.taskId)) taskIds.add(row.taskId);
  if (kind === "log" && nonemptyId(row.requestId))
    requestIds.add(row.requestId);

  const allLogs = [
    ...(snapshot.logs ?? []),
    ...(snapshot.taskEvents?.logs ?? []),
  ];
  const events =
    kind === "task"
      ? eventsFor(snapshot, row)
      : Array.isArray(snapshot.logs) || snapshot.taskEvents
        ? [
            ...new Map(
              allLogs.flatMap((log) => {
                const matches =
                  (nonemptyId(log.taskId) && taskIds.has(log.taskId)) ||
                  (nonemptyId(log.requestId) &&
                    requestIds.has(log.requestId) &&
                    (!nonemptyId(log.taskId) || taskIds.has(log.taskId))) ||
                  (kind === "agent" &&
                    nonemptyId(log.agentId) &&
                    identities.has(log.agentId));
                const key = matches ? stableEventKey(log) : null;
                return key === null ? [] : [[key, log] as const];
              }),
            ).values(),
          ]
        : null;

  const agents = (snapshot.agents ?? []).filter(
    (agent) =>
      (nonemptyId(agent.id) && identities.has(agent.id)) ||
      (nonemptyId(agent.sessionId) && identities.has(agent.sessionId)) ||
      (kind === "log" &&
        nonemptyId(row.agentId) &&
        [agent.id, agent.sessionId].some(
          (id) => nonemptyId(id) && id === row.agentId,
        )),
  );
  return { operations, events, agents };
}

function timestampField(row: ConsoleRow, name: string): number | null {
  const value = row[name];
  const time = recordedTime(value);
  return Number.isFinite(time) ? time : null;
}

function elapsed(
  row: ConsoleRow,
  directField: string,
  start: string,
  end: string,
): number | null {
  const direct = row[directField];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0)
    return direct;
  const from = timestampField(row, start);
  const to = timestampField(row, end);
  return from !== null && to !== null && to >= from ? to - from : null;
}

function taskStatus(state: string): string {
  switch (state.toLowerCase()) {
    case "succeeded":
    case "completed":
      return "success";
    case "failed":
      return "unsuccessful";
    default:
      return state;
  }
}

function mapTask(
  row: ConsoleRow,
  project: ProjectIdentity,
): OperationalTask | null {
  if (!nonemptyId(row.id)) return null;
  const state = nonemptyId(row.state) ? row.state : "unknown";
  const client = nonemptyId(row.clientId) ? row.clientId : "";
  return {
    ...row,
    id: row.id,
    projectId: project.id,
    projectName: project.name,
    command: nonemptyId(row.label)
      ? row.label
      : nonemptyId(row.script)
        ? `run ${row.script}`
        : nonemptyId(row.kind)
          ? row.kind
          : "Nieznana operacja",
    status: taskStatus(state),
    sourceState: state,
    client,
    waitMs: elapsed(row, "waitMs", "submittedAt", "startedAt"),
    executionMs: elapsed(row, "executionMs", "startedAt", "finishedAt"),
  };
}

function mapLog(
  row: ConsoleRow,
  project: ProjectIdentity,
): OperationalLog | null {
  if (!nonemptyId(row.id)) return null;
  return {
    ...row,
    id: row.id,
    projectId: project.id,
    projectName: project.name,
    message: typeof row.message === "string" ? row.message : "",
    level: nonemptyId(row.level) ? row.level.toUpperCase() : "OTHER",
  };
}

function mapClient(
  row: ConsoleRow,
  project: ProjectIdentity,
): OperationalClient | null {
  if (!nonemptyId(row.id)) return null;
  return {
    ...row,
    id: row.id,
    projectId: project.id,
    projectName: project.name,
  };
}

export function mapProjectSnapshot(
  project: ProjectIdentity,
  snapshot: ConsoleSnapshot,
): OperationalProject {
  return {
    id: project.id,
    name: project.name,
    path: project.path ?? null,
    color: project.color ?? null,
    description: project.description ?? null,
    tasks: Array.isArray(snapshot.operations)
      ? snapshot.operations.flatMap((row) => {
          const task = mapTask(row, project);
          return task ? [task] : [];
        })
      : null,
    logs: Array.isArray(snapshot.logs)
      ? snapshot.logs.flatMap((row) => {
          const log = mapLog(row, project);
          return log ? [log] : [];
        })
      : null,
    clients: Array.isArray(snapshot.agents)
      ? snapshot.agents.flatMap((row) => {
          const client = mapClient(row, project);
          return client ? [client] : [];
        })
      : null,
    snapshot,
  };
}
