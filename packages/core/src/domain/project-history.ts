import type { ConsoleTelemetryEvent } from "./console-telemetry";

/** The single canonical event contract is owned by the telemetry domain. */
export type ProjectHistoryEvent<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> = TSourceEvent;

/** Query snapshot revision; independent from any source cursor or queue revision. */
export interface ProjectHistoryRevision {
  readonly epoch: string;
  readonly revision: number;
}

export type ProjectHistoryAvailability =
  "available" | "partial" | "unavailable" | "no-data";

export interface ProjectHistorySourceCursor {
  readonly sourceId: string;
  readonly epoch: string;
  readonly position: number;
  readonly positionKind: "sequence" | "revision";
  readonly eventId: string | null;
  readonly updatedAtMs: number;
}

export interface ProjectHistoryReplayCursor {
  readonly sourceId: string;
  readonly epoch: string;
  readonly position: number;
  readonly positionKind: "sequence" | "revision";
  readonly eventId: string | null;
}

export interface ProjectHistoryGap {
  readonly sourceId: string;
  readonly epoch: string;
  readonly fromPosition: number | null;
  readonly toPosition: number | null;
  readonly positionKind: "sequence" | "revision";
  readonly detectedAtMs: number;
  readonly reason: string;
}

export interface ProjectHistoryIngestBatch<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> {
  readonly events: readonly ProjectHistoryEvent<TSourceEvent>[];
  readonly sourceId?: string | null;
  readonly epoch?: string | null;
  readonly cursor?: ProjectHistoryReplayCursor | null;
  readonly gaps?: readonly ProjectHistoryGap[];
  readonly availability?: ProjectHistoryAvailability;
  readonly reason?: string | null;
  readonly observedAtMs?: number | null;
  /** Collector read time for a checkpoint with no accompanying event. */
  readonly readAtMs?: number;
}

export interface ProjectHistorySourceStatus {
  readonly sourceId: string | null;
  readonly state: ProjectHistoryAvailability;
  readonly observedAtMs: number | null;
  readonly cursor: ProjectHistorySourceCursor | null;
  readonly gaps: readonly ProjectHistoryGap[];
  readonly gapsTruncated: boolean;
  readonly reason: string | null;
}

export interface ProjectHistoryProjectLifecycle {
  readonly monitoring: boolean;
  readonly archivedAtMs: number | null;
  readonly updatedAtMs: number;
}

/** Synchronous project-local SQLite fence for lifecycle decisions and writes. */
export interface ProjectHistoryActivityFence {
  readonly projectId: string;
  readonly databaseId: string;
  snapshot(capturedAtMs?: number): ProjectHistorySnapshot;
  setLifecycleIfRevision(
    lifecycle: ProjectHistoryProjectLifecycle,
    expectedRevision: ProjectHistoryRevision,
  ): ProjectHistorySnapshot;
}

export type ProjectHistoryAgentIdentityKind = "agent" | "client" | "session";

/** A project-local display label keyed by a source-reported stable identity. */
export interface ProjectHistoryAgentAlias {
  readonly kind: ProjectHistoryAgentIdentityKind;
  readonly id: string;
  readonly alias: string;
  readonly updatedAtMs: number;
}

export interface ProjectHistorySnapshot {
  readonly projectId: string;
  readonly databaseId: string;
  readonly version: 1;
  readonly revision: ProjectHistoryRevision;
  readonly capturedAtMs: number;
  readonly availability: ProjectHistoryAvailability;
  readonly lifecycle: ProjectHistoryProjectLifecycle;
  readonly aliases: readonly string[];
  readonly agentAliases: readonly ProjectHistoryAgentAlias[];
  readonly sources: readonly ProjectHistorySourceStatus[];
  readonly eventCount: number;
  readonly jobCount: number;
  readonly sessionCount: number;
  readonly fileReferenceCount: number;
}

/** One bounded read transaction suitable for an immutable query snapshot. */
export interface ProjectHistoryReadSnapshot<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> extends ProjectHistorySnapshot {
  readonly events: readonly ProjectHistoryEventRecord<TSourceEvent>[];
  readonly jobs: readonly ProjectHistoryJobRecord<TSourceEvent>[];
  readonly sessions: readonly ProjectHistorySessionRecord<TSourceEvent>[];
  readonly fileReferences: readonly ProjectHistoryFileReference<TSourceEvent>[];
}

export interface ProjectHistoryEventRecord<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> {
  /** Local row identity only; it is not a source event ID or replay cursor. */
  readonly rowId: number;
  readonly event: ProjectHistoryEvent<TSourceEvent>;
  readonly insertedRevision: number;
}

export interface ProjectHistoryJobRecord<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> {
  readonly rowId: number;
  readonly jobId: string;
  readonly state: string | null;
  readonly phase: string | null;
  readonly observedAtMs: number | null;
  readonly event: ProjectHistoryEvent<TSourceEvent>;
}

export interface ProjectHistorySessionRecord<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> {
  readonly rowId: number;
  readonly sessionId: string;
  readonly clientId: string | null;
  readonly agentId: string | null;
  readonly presence: string | null;
  readonly observedAtMs: number | null;
  readonly event: ProjectHistoryEvent<TSourceEvent>;
}

export interface ProjectHistoryFileReference<
  TSourceEvent extends ConsoleTelemetryEvent = ConsoleTelemetryEvent,
> {
  readonly rowId: number;
  readonly id: string;
  readonly jobId: string | null;
  readonly kind: string;
  readonly path: string | null;
  readonly fileId: string | null;
  readonly artifactId: string | null;
  readonly sha256: string | null;
  readonly provenance: string | null;
  readonly observedAtMs: number | null;
  readonly event: ProjectHistoryEvent<TSourceEvent>;
}

export interface ProjectHistoryPage<T> {
  readonly revision: ProjectHistoryRevision;
  readonly capturedAtMs: number;
  readonly rows: readonly T[];
  readonly total: number;
  readonly nextAfter: number | null;
  readonly availability: ProjectHistoryAvailability;
  readonly gaps: readonly ProjectHistoryGap[];
}

export interface ProjectHistoryIngestResult {
  readonly revision: ProjectHistoryRevision;
  readonly inserted: number;
  readonly duplicates: number;
  readonly cursors: readonly ProjectHistorySourceCursor[];
  readonly gaps: readonly ProjectHistoryGap[];
  readonly availability: ProjectHistoryAvailability;
}
