import type {
  ClientId,
  DocumentId,
  Id,
  InstanceId,
  JobId,
  JsonValue,
  ProjectId,
  RequestId,
  SessionId,
} from "./contracts";
import { id } from "./contracts";

export type TurnId = Id<"turn">;
export type ObservationSource = "cli" | "mcp" | "opencode" | "system";

/** Correlation data for one observer instance; transport and host session stay distinct. */
export interface InvocationContext {
  readonly version: 1;
  readonly clientId: ClientId | null;
  readonly requestId: RequestId | null;
  readonly jobId: JobId | null;
  readonly projectId: ProjectId | null;
  readonly documentId: DocumentId | null;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly instanceId: InstanceId;
  readonly source: ObservationSource;
  readonly purpose: string | null;
}

export interface InvocationContextInput {
  readonly clientId?: string | null;
  readonly requestId?: string | null;
  readonly jobId?: string | null;
  readonly projectId?: string | null;
  readonly documentId?: string | null;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly instanceId: string;
  readonly source: ObservationSource;
  readonly purpose?: string | null;
}

export function createInvocationContext(
  input: InvocationContextInput,
): InvocationContext {
  if (!["cli", "mcp", "opencode", "system"].includes(input.source))
    throw new Error("Invalid observation source");
  const purpose = input.purpose?.trim() || null;
  if (
    purpose !== null &&
    (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(purpose) ||
      Array.from(purpose).length > 1000)
  ) {
    throw new Error(
      "Invocation purpose must contain at most 1000 Unicode characters without control characters",
    );
  }
  const optional = <K extends string>(
    kind: K,
    value: string | null | undefined,
  ): Id<K> | null =>
    value === null || value === undefined ? null : id(kind, value);
  return Object.freeze({
    version: 1 as const,
    clientId: optional("client", input.clientId),
    requestId: optional("request", input.requestId),
    jobId: optional("job", input.jobId),
    projectId: optional("project", input.projectId),
    documentId: optional("document", input.documentId),
    sessionId: optional("session", input.sessionId),
    turnId: optional("turn", input.turnId),
    instanceId: id("instance", input.instanceId),
    source: input.source,
    purpose,
  });
}

export interface ObservationEvent {
  readonly version: 1;
  readonly invocation: InvocationContext;
  readonly atMs: number;
  readonly name: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export type PresenceState = "observed" | "unknown" | "offline";

export interface ProcessIdentity {
  readonly pid: number;
  readonly birth: string | null;
}

export interface ProcessPresenceRecord extends ProcessIdentity {
  readonly version: 1;
  readonly clientId: ClientId;
  readonly instanceId: InstanceId;
  readonly observedAtMs: number;
  readonly closed: boolean;
}

export interface ProcessPresenceSummary extends ProcessIdentity {
  readonly instanceId: InstanceId;
  readonly lastSeen: number;
  readonly presence: PresenceState;
}

export interface ClientPresenceSummary {
  readonly id: ClientId;
  readonly presence: PresenceState;
  readonly source: "queue-client-process-heartbeat";
  readonly lastSeen: number;
  readonly pid: number;
  readonly birth: string | null;
  readonly processCount: number;
  readonly observedProcesses: number;
  readonly processes: readonly ProcessPresenceSummary[];
}

export function classifyPresence(
  record: ProcessPresenceRecord,
  nowMs: number,
  alive: boolean | null,
  freshnessMs = 15_000,
): PresenceState {
  if (record.closed || alive === false) return "offline";
  const age = nowMs - record.observedAtMs;
  if (
    alive === true &&
    Number.isFinite(age) &&
    Number.isFinite(freshnessMs) &&
    freshnessMs >= 0 &&
    age >= 0 &&
    age <= freshnessMs
  )
    return "observed";
  return "unknown";
}

const rank: Record<PresenceState, number> = {
  observed: 2,
  unknown: 1,
  offline: 0,
};

export function summarizeClientPresence(
  records: readonly ProcessPresenceRecord[],
  nowMs: number,
  alive: (record: ProcessPresenceRecord) => boolean | null,
): ClientPresenceSummary[] {
  const clients = new Map<
    ClientId,
    {
      best: ProcessPresenceSummary;
      processes: ProcessPresenceSummary[];
      observed: number;
    }
  >();
  for (const record of records) {
    const presence = classifyPresence(record, nowMs, alive(record));
    const process: ProcessPresenceSummary = {
      instanceId: record.instanceId,
      pid: record.pid,
      birth: record.birth,
      lastSeen: record.observedAtMs,
      presence,
    };
    const current = clients.get(record.clientId);
    if (!current) {
      clients.set(record.clientId, {
        best: process,
        processes: [process],
        observed: presence === "observed" ? 1 : 0,
      });
      continue;
    }
    current.processes.push(process);
    if (presence === "observed") current.observed++;
    if (
      rank[presence] > rank[current.best.presence] ||
      (rank[presence] === rank[current.best.presence] &&
        process.lastSeen > current.best.lastSeen)
    ) {
      current.best = process;
    }
  }
  return [...clients].map(([clientId, current]) => ({
    id: clientId,
    presence: current.best.presence,
    source: "queue-client-process-heartbeat",
    lastSeen: current.best.lastSeen,
    pid: current.best.pid,
    birth: current.best.birth,
    processCount: current.processes.length,
    observedProcesses: current.observed,
    processes: current.processes,
  }));
}
