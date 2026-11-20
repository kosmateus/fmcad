import type { OperationResult } from "../domain/contracts";
import type { PresenceState } from "../domain/observation";

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
  taskEvents?: {
    taskId: string;
    logs: ConsoleRow[] | null;
    sources?: string[];
    limited?: boolean;
    error?: string | null;
  };
  retention?: Record<string, unknown>;
  [key: string]: unknown;
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

/** Passive only: implementations must not probe SDK, start/resume, or change admission. */
export interface ConsoleMetricsPort<T> {
  read(snapshot: ConsoleSnapshot): T;
}
export interface ConsoleReadPort {
  read(): ReadObservation<ConsoleSnapshot>;
}
