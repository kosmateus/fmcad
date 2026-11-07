/** Public, transport-neutral read contract shared by the UI and server. */
export const CONSOLE_QUERY_CONTRACT_VERSION = 1 as const;

export type ConsoleQueryCollection =
  | "projects"
  | "overview"
  | "tasks"
  | "agents"
  | "sessions"
  | "files"
  | "logs"
  | "system"
  | "search";

export type ConsoleDataCollection = Exclude<ConsoleQueryCollection, "search">;

export type ConsoleQueryScope =
  { kind: "global" } | { kind: "project"; projectId: string };

export interface ConsoleRevision {
  /** Stable instance ID: ASCII `[A-Za-z0-9_-]`, at most 128 chars. */
  epoch: string;
  revision: number;
}

export type ConsoleSourceState =
  "available" | "partial" | "stale" | "unavailable" | "no-data";

export interface ConsoleSourceStatus {
  state: ConsoleSourceState;
  source: string;
  /** Unix timestamp in milliseconds, or null when the source has no observation. */
  observedAt: number | null;
  reason?: string;
}

export interface ConsoleQuerySnapshot {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  /** Revision local to the exact `scope`; different scopes are incomparable. */
  revision: ConsoleRevision;
  /** Unix timestamp in milliseconds. */
  capturedAt: number;
  scope: ConsoleQueryScope;
  snapshotToken: string;
  sources: Record<string, ConsoleSourceStatus>;
}

export interface ConsoleQuerySort {
  field: string;
  direction: "asc" | "desc";
}

export interface ConsoleQueryRangeFilter {
  eq?: string | number | boolean;
  any?: readonly string[];
  min?: number;
  max?: number;
  includeMissing?: boolean;
}

export interface ConsoleQueryTextFilter {
  contains: string;
}

export interface ConsoleNumericAggregate {
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
  median: number;
  /** Nearest-rank 95th percentile of the complete filtered retained set. */
  p95: number;
}

/** Facet key used for rows with an absent or null field value. */
export const CONSOLE_QUERY_MISSING_FACET = "\u0000missing";

export interface ConsoleArtifactLink {
  artifactId: string;
  sourceHash?: string;
}

export type ConsoleArtifactOutputProvenance =
  "retained-owned-result" | "retained-project-file" | "retained-artifact-store";

export type ConsoleArtifactChannel =
  | {
      state: "available";
      artifactId: string;
      sourceHash: string;
      provenance: ConsoleArtifactOutputProvenance;
    }
  | { state: "missing" | "unavailable"; reason: string };

export interface ConsoleTaskArtifacts {
  originalSource?: ConsoleArtifactLink;
  sentSource?: ConsoleArtifactLink;
  currentFile?: ConsoleArtifactLink;
  response?: ConsoleArtifactLink;
  stdout?: ConsoleArtifactChannel;
  stderr?: ConsoleArtifactChannel;
  /** Retained rpc-result.json content; a descriptor alone never creates this link. */
  rpc?: ConsoleArtifactChannel;
  events?: readonly ConsoleArtifactLink[];
}

/** Canonical read-model row; raw state and timing values are not remapped. */
export interface ConsoleQueryRecord {
  id?: string | null;
  projectId?: string | null;
  name?: string;
  path?: string;
  state?: string;
  taskId?: string | null;
  requestId?: string | null;
  clientId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  timestamp?: string | number | null;
  submittedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  artifacts?: ConsoleTaskArtifacts | null;
  [key: string]: unknown;
}

export interface ConsoleProjectRecord extends ConsoleQueryRecord {
  id: string;
  name: string;
  path?: string;
}

export type ConsoleTaskState = string;

export interface ConsoleTaskRecord extends ConsoleQueryRecord {
  id: string;
  state: ConsoleTaskState;
  requestId?: string | null;
  clientId?: string | null;
  sessionId?: string | null;
  artifacts?: ConsoleTaskArtifacts;
}

export interface ConsoleAgentRecord extends ConsoleQueryRecord {
  id: string;
  name?: string;
  sessionId?: string | null;
  presence?: string;
}

export interface ConsoleLogRecord extends ConsoleQueryRecord {
  id: string;
  taskId?: string | null;
  requestId?: string | null;
  clientId?: string | null;
  /** Event occurrence time as Unix epoch milliseconds; null when source time is unknown. */
  timestamp: number | null;
  /** Raw source time retained as provenance when a source timestamp was reported. */
  timestampRaw?: string | number | null;
  level?: string;
  message?: string;
}

/** One canonical Overview aggregate row for the selected scope and 1 h window. */
export interface ConsoleOverviewRecord extends ConsoleQueryRecord {
  /** Count of registered projects with pending work; null when unknown. */
  pendingProject: number | null;
  /** Count of currently running executions in this scope. */
  running: number | null;
  /** Count of executions whose terminal outcome is unresolved. */
  unresolved: number | null;
  /** Number of observed wait-time samples used for the percentiles. */
  samples: number | null;
  /** Failed executions whose finish time falls within sampleWindow. */
  failedExecutions: number | null;
  /** Median of all retained wait-time samples in sampleWindow, in ms. */
  waitMedianMs: number | null;
  /** Nearest-rank p95 of all retained wait-time samples in sampleWindow, in ms. */
  waitP95Ms: number | null;
  /** Current live reporting sessions, not historical session records. */
  liveReportingSessions: number | null;
  /** Complete UTC epoch-ms window used for the retained aggregates. */
  sampleWindow: { from: number; to: number } | null;
}

export type ConsoleSearchResultType = "project" | "agent" | "task";

export interface ConsoleSearchRecord extends ConsoleQueryRecord {
  resultType: ConsoleSearchResultType;
  collection: "projects" | "agents" | "tasks";
  record: ConsoleQueryRecord;
}

export interface ConsoleQueryRequest {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  scope: ConsoleQueryScope;
  collection: ConsoleQueryCollection;
  /** Required token returned by snapshot(); HTTP transports it in a header. */
  snapshotToken: string;
  search?: string;
  filters?: Record<
    string,
    | string
    | number
    | boolean
    | readonly string[]
    | ConsoleQueryRangeFilter
    | ConsoleQueryTextFilter
  >;
  facetFields?: readonly string[];
  aggregateFields?: readonly string[];
  sort?: readonly ConsoleQuerySort[];
  offset?: number;
  limit?: number;
}

export interface ConsoleQueryPage<T = ConsoleQueryRecord> {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  revision: ConsoleRevision;
  scope: ConsoleQueryScope;
  collection: ConsoleQueryCollection;
  source: ConsoleSourceStatus;
  rows: readonly T[];
  offset: number;
  limit: number;
  /** Null means the full count is unknown; zero is a known empty result. */
  total: number | null;
  facets: Readonly<Record<string, Readonly<Record<string, number>>>>;
  aggregates: Readonly<Record<string, ConsoleNumericAggregate | null>>;
  snapshotToken: string;
}

export interface ConsoleRevisionEvent {
  /** One event per scope; revisions from different scopes are incomparable. */
  scope: ConsoleQueryScope;
  revision: ConsoleRevision;
  /** A consumer must fetch a fresh snapshot when true or when it detects a gap. */
  resyncRequired: boolean;
}

/** Return false when the transport is backpressured; the server drops it. */
export type ConsoleRevisionListener = (
  event: ConsoleRevisionEvent,
) => boolean | void;

export interface ConsoleQueryExportRequest extends Omit<
  ConsoleQueryRequest,
  "offset" | "limit"
> {
  format: "json" | "csv";
}

export interface ConsoleQueryExport {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  revision: ConsoleRevision;
  scope: ConsoleQueryScope;
  collection: ConsoleQueryCollection;
  snapshotToken: string;
  source: ConsoleSourceStatus;
  format: "json" | "csv";
  search: string;
  filters: Readonly<NonNullable<ConsoleQueryRequest["filters"]>>;
  sort: readonly ConsoleQuerySort[];
  rowCount: number;
  content: string;
}

export type ConsoleArtifactKind =
  | "original-source"
  | "sent-source"
  | "current-file"
  | "response"
  | "stdout"
  | "stderr"
  | "rpc"
  | "event";

export const CONSOLE_ARTIFACT_KINDS = [
  "original-source",
  "sent-source",
  "current-file",
  "response",
  "stdout",
  "stderr",
  "rpc",
  "event",
] as const satisfies readonly ConsoleArtifactKind[];

export function isConsoleArtifactKind(
  value: unknown,
): value is ConsoleArtifactKind {
  return (
    typeof value === "string" &&
    (CONSOLE_ARTIFACT_KINDS as readonly string[]).includes(value)
  );
}

export type ConsoleArtifactState =
  | "available"
  | "empty"
  | "missing"
  | "truncated"
  | "expired"
  | "error"
  | "forbidden";

export interface ConsoleArtifactRequest {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  scope: { kind: "project"; projectId: string };
  taskId: string;
  artifactId: string;
  kind: ConsoleArtifactKind;
  snapshotToken: string;
  /** Byte offset in the retained artifact, bounded to 64 MiB by the handler. */
  offset?: number;
  /** Maximum requested UTF-8 bytes per read; default 64 KiB, hard max 2 MiB. */
  length?: number;
}

export interface ConsoleArtifactResult {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  revision: ConsoleRevision;
  state: ConsoleArtifactState;
  artifactId: string;
  kind: ConsoleArtifactKind;
  content: string | null;
  /** Actual UTF-8 byte offset (may advance <=3 bytes to avoid partial codepoints). */
  offset: number;
  /** UTF-8 source bytes read, before any secret redaction. */
  length: number;
  totalLength: number | null;
  reason?: string;
}

export interface ConsoleQueryError {
  version: typeof CONSOLE_QUERY_CONTRACT_VERSION;
  state: "unavailable" | "error" | "expired" | "forbidden";
  code: string;
  message: string;
}

/** Identity established by the HTTP boundary; query code never authenticates. */
export interface ConsoleQueryPrincipal {
  subject: string;
  projectIds: readonly string[];
  globalRead: boolean;
}

/**
 * Application handler. The HTTP owner authenticates first, then passes the
 * principal and validated request. Implementations must remain passive.
 */
export interface ConsoleQueryHandler {
  snapshot(
    scope: ConsoleQueryScope,
    principal: ConsoleQueryPrincipal,
  ): Promise<ConsoleQuerySnapshot | ConsoleQueryError>;
  query<T = Record<string, unknown>>(
    request: ConsoleQueryRequest,
    principal: ConsoleQueryPrincipal,
  ): Promise<ConsoleQueryPage<T> | ConsoleQueryError>;
  export(
    request: ConsoleQueryExportRequest,
    principal: ConsoleQueryPrincipal,
  ): Promise<ConsoleQueryExport | ConsoleQueryError>;
  detail(
    request: ConsoleArtifactRequest,
    principal: ConsoleQueryPrincipal,
  ): Promise<ConsoleArtifactResult | ConsoleQueryError>;
  subscribe(
    scope: ConsoleQueryScope,
    after: ConsoleRevision | null,
    principal: ConsoleQueryPrincipal,
    listener: ConsoleRevisionListener,
  ): (() => void) | null;
}
