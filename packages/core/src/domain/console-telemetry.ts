import type { OwnedResultReference } from "../ports/execution-store";

export type ConsoleTelemetryAvailability =
  "available" | "stale" | "missing" | "unsupported" | "unknown" | "error";

export type ConsoleTelemetryScope =
  "event" | "project" | "job" | "turn" | "process" | "broker" | "host";

export type ConsoleTelemetryUnit =
  | "identity"
  | "text"
  | "count"
  | "unix-ms"
  | "ms"
  | "bytes"
  | "bytes-per-second"
  | "percent"
  | "seconds"
  | "load-average"
  | null;

/** A value is usable only together with its source, scope, unit and freshness. */
export interface ConsoleTelemetryValue<T> {
  readonly value: T | null;
  readonly availability: ConsoleTelemetryAvailability;
  readonly source: string;
  readonly unit: ConsoleTelemetryUnit;
  readonly scope: ConsoleTelemetryScope;
  readonly observedAtMs: number | null;
  readonly readAtMs: number;
  readonly reason: string | null;
}

export type ConsoleTelemetryPhase =
  | "preparing"
  | "queued"
  | "sending"
  | "running"
  | "processing"
  | "terminal"
  | "unresolved";

export type ConsoleTelemetryPhaseKind =
  "prepare" | "queueWait" | "sdkActive" | "pause" | "finalize";

export type ConsoleTelemetryEventType =
  | "queue.job-snapshot"
  | "queue.owned-result"
  | "queue.phase-interval"
  | "observation.event"
  | "opencode.session-observation"
  | "presence.process-observation"
  | "fusion.receipt-observation";

export interface ConsoleTelemetryMetadata {
  readonly eventId: ConsoleTelemetryValue<string>;
  readonly sourceId: ConsoleTelemetryValue<string>;
  readonly epoch: ConsoleTelemetryValue<string>;
  /** A producer sequence, not a queue order or fabricated counter. */
  readonly sequence: ConsoleTelemetryValue<number>;
  readonly revision: ConsoleTelemetryValue<number>;
  readonly observedAtMs: ConsoleTelemetryValue<number>;
  readonly readAtMs: ConsoleTelemetryValue<number>;
}

export interface ConsoleTelemetryIdentity {
  readonly projectId: ConsoleTelemetryValue<string>;
  readonly requestId: ConsoleTelemetryValue<string>;
  readonly jobId: ConsoleTelemetryValue<string>;
  readonly turnId: ConsoleTelemetryValue<string>;
  readonly clientId: ConsoleTelemetryValue<string>;
  readonly sessionId: ConsoleTelemetryValue<string>;
  readonly documentId: ConsoleTelemetryValue<string>;
  readonly documentFileId: ConsoleTelemetryValue<string>;
  readonly purpose: ConsoleTelemetryValue<string>;
  /** Source-reported aliases retained separately from canonical identities. */
  readonly reportedClientId: ConsoleTelemetryValue<string>;
  readonly reportedSessionId: ConsoleTelemetryValue<string>;
}

export interface ConsoleTelemetryActor {
  /** Transport/source identity; it is never projected as an AI agent. */
  readonly transport: ConsoleTelemetryValue<string>;
  /** Only producer-declared values are populated. */
  readonly agentId: ConsoleTelemetryValue<string>;
  readonly agent: ConsoleTelemetryValue<string>;
  readonly model: ConsoleTelemetryValue<string>;
  readonly role: ConsoleTelemetryValue<string>;
}

export interface ConsoleTelemetryFileReference {
  readonly kind: "source" | "output";
  readonly path: ConsoleTelemetryValue<string>;
  readonly fileId: ConsoleTelemetryValue<string>;
  readonly artifactId: ConsoleTelemetryValue<string>;
  readonly sha256: ConsoleTelemetryValue<string>;
  readonly provenance: ConsoleTelemetryValue<string>;
  /** Exact existing storage reference; it never contains a path or bearer authority. */
  readonly ownedResult?: ConsoleTelemetryValue<OwnedResultReference>;
}

export interface ConsoleTelemetryTimings {
  /** Local request preparation only; never inferred from submit-to-start. */
  readonly prepareMs: ConsoleTelemetryValue<number>;
  /** Scheduler wait only; phased preparation is excluded unless turn spans exist. */
  readonly queueWaitMs: ConsoleTelemetryValue<number>;
  /** Sum of observed physical SDK-turn intervals; not job wall time. */
  readonly sdkActiveMs: ConsoleTelemetryValue<number>;
  /** Job-attributed pause intervals only; broker-wide pause is not attributed. */
  readonly pauseMs: ConsoleTelemetryValue<number>;
  /** Local finalization only; never inferred from finish minus start. */
  readonly finalizeMs: ConsoleTelemetryValue<number>;
  /** Submitted-to-terminal workflow wall time. */
  readonly totalWorkflowMs: ConsoleTelemetryValue<number>;
}

export interface ConsoleTelemetryWorkerIdentity {
  readonly pid: ConsoleTelemetryValue<number>;
  readonly birth: ConsoleTelemetryValue<string>;
  readonly alive: ConsoleTelemetryValue<boolean>;
}

export interface ConsoleTelemetryProcess {
  readonly kind: "panel" | "broker" | "worker";
  readonly identity: ConsoleTelemetryWorkerIdentity;
  readonly rssBytes: ConsoleTelemetryValue<number>;
  readonly uptimeSeconds: ConsoleTelemetryValue<number>;
  readonly cpuPercent: ConsoleTelemetryValue<number>;
}

export interface ConsoleTelemetryLocks {
  readonly status: ConsoleTelemetryValue<"active" | "unknown" | "unsupported">;
  readonly evidenceCount: ConsoleTelemetryValue<number>;
  readonly reason: ConsoleTelemetryValue<string>;
}

export interface ConsoleTelemetryHostMetrics {
  readonly hostname: ConsoleTelemetryValue<string>;
  readonly cpuPercent: ConsoleTelemetryValue<number>;
  readonly ramUsedBytes: ConsoleTelemetryValue<number>;
  readonly ramTotalBytes: ConsoleTelemetryValue<number>;
  readonly swapUsedBytes: ConsoleTelemetryValue<number>;
  readonly swapTotalBytes: ConsoleTelemetryValue<number>;
  readonly load: ConsoleTelemetryValue<readonly number[]>;
  readonly diskUsedBytes: ConsoleTelemetryValue<number>;
  readonly diskTotalBytes: ConsoleTelemetryValue<number>;
  readonly diskPath: ConsoleTelemetryValue<string>;
  readonly networkInterface: ConsoleTelemetryValue<string>;
  readonly rxBytesPerSecond: ConsoleTelemetryValue<number>;
  readonly txBytesPerSecond: ConsoleTelemetryValue<number>;
  readonly uptimeSeconds: ConsoleTelemetryValue<number>;
  readonly processCount: ConsoleTelemetryValue<number>;
}

export interface ConsoleTelemetryFusionObservation {
  readonly state: ConsoleTelemetryValue<string>;
  readonly idle: ConsoleTelemetryValue<boolean>;
  readonly documentId: ConsoleTelemetryValue<string>;
  readonly documentFileId: ConsoleTelemetryValue<string>;
  readonly source: ConsoleTelemetryValue<"preflight" | "postflight">;
}

/** Canonical source event. Public UI/server DTOs map this through a read port. */
export interface ConsoleTelemetryEvent {
  readonly version: 1;
  readonly eventType: ConsoleTelemetryEventType;
  readonly eventName: ConsoleTelemetryValue<string>;
  readonly metadata: ConsoleTelemetryMetadata;
  readonly identity: ConsoleTelemetryIdentity;
  readonly actor: ConsoleTelemetryActor;
  readonly state: ConsoleTelemetryValue<string>;
  readonly phase: ConsoleTelemetryValue<ConsoleTelemetryPhase>;
  readonly phaseIntervalKind: ConsoleTelemetryValue<ConsoleTelemetryPhaseKind>;
  readonly physicalTurns: ConsoleTelemetryValue<number>;
  readonly physicalTurnOrdinal: ConsoleTelemetryValue<number>;
  readonly sourceFiles: ConsoleTelemetryValue<
    readonly ConsoleTelemetryFileReference[]
  >;
  readonly outputFiles: ConsoleTelemetryValue<
    readonly ConsoleTelemetryFileReference[]
  >;
  readonly timings: ConsoleTelemetryTimings;
  readonly worker: ConsoleTelemetryWorkerIdentity;
  readonly fusion: ConsoleTelemetryFusionObservation;
}

export interface ConsoleTelemetryCursor {
  /** A stable identity for one independently replayed source stream and scope. */
  readonly sourceId: string;
  readonly epoch: string;
  readonly position: number;
  readonly positionKind: "sequence" | "revision";
  /** Stable event ID breaks ties when a source revision contains several records. */
  readonly eventId: string | null;
}

export interface ConsoleTelemetryGap {
  /** Must match the cursor's sourceId/epoch/positionKind exactly. */
  readonly sourceId: string;
  readonly epoch: string;
  readonly fromPosition: number;
  readonly toPosition: number;
  readonly positionKind: "sequence" | "revision";
  readonly detectedAtMs: number;
  readonly reason: string;
}

export interface ConsoleTelemetryReplayBatch {
  readonly events: ConsoleTelemetryValue<readonly ConsoleTelemetryEvent[]>;
  readonly cursor: ConsoleTelemetryValue<ConsoleTelemetryCursor>;
  readonly gaps: ConsoleTelemetryValue<readonly ConsoleTelemetryGap[]>;
  readonly limit: number;
  readonly truncated: boolean;
}

export interface ConsoleTelemetryReplayPage {
  readonly events: readonly ConsoleTelemetryEvent[];
  readonly cursor: ConsoleTelemetryCursor | null;
  readonly gaps: readonly ConsoleTelemetryGap[];
  readonly truncated: boolean;
}

export interface ConsoleTelemetryPresenceInput {
  readonly projectId: string | null;
  readonly source: string;
  readonly pid: number | null;
  readonly birth: string | null;
  readonly clientId?: string | null;
  readonly sessionId?: string | null;
  readonly reportedClientId?: string | null;
  readonly reportedSessionId?: string | null;
  readonly observedAtMs: number | null;
  readonly alive: boolean | null;
  readonly presence?: "observed" | "stale" | "unknown" | "offline";
  readonly agentId?: string | null;
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly role?: string | null;
}

export interface ConsoleTelemetryPresenceSummary {
  readonly projectId: ConsoleTelemetryValue<string>;
  readonly clientSource: ConsoleTelemetryValue<ConsoleTelemetryAvailability>;
  readonly openCodeSource: ConsoleTelemetryValue<ConsoleTelemetryAvailability>;
  readonly processCount: ConsoleTelemetryValue<number>;
  readonly clientCount: ConsoleTelemetryValue<number>;
  readonly sessionCount: ConsoleTelemetryValue<number>;
  readonly declaredAgentCount: ConsoleTelemetryValue<number>;
  readonly sources: readonly string[];
}

export interface ConsoleTelemetryPresenceCompleteness {
  readonly clients: ConsoleTelemetryAvailability;
  readonly openCode: ConsoleTelemetryAvailability;
}

export interface ConsoleTelemetryPresenceObservations {
  readonly sources: {
    readonly clients: ConsoleTelemetryAvailability;
    readonly openCode: ConsoleTelemetryAvailability;
  };
  readonly records: readonly ConsoleTelemetryPresenceInput[];
}

export interface ConsoleTelemetryPercentiles {
  readonly windowMs: number;
  readonly sampleCount: ConsoleTelemetryValue<number>;
  readonly p50Ms: ConsoleTelemetryValue<number>;
  readonly p95Ms: ConsoleTelemetryValue<number>;
}

export interface ConsoleTelemetryExecutionRecord {
  readonly state: string | null;
  readonly finishedAtMs: number | null;
}

/** Names and units map directly to the approved ConsoleOverviewRecord. */
export interface ConsoleTelemetryOverview {
  readonly pendingProject: ConsoleTelemetryValue<number>;
  readonly running: ConsoleTelemetryValue<number>;
  readonly unresolved: ConsoleTelemetryValue<number>;
  readonly samples: ConsoleTelemetryValue<number>;
  readonly failedExecutions: ConsoleTelemetryValue<number>;
  readonly waitMedianMs: ConsoleTelemetryValue<number>;
  readonly waitP95Ms: ConsoleTelemetryValue<number>;
  readonly liveReportingSessions: ConsoleTelemetryValue<number>;
  readonly sampleWindow: ConsoleTelemetryValue<{
    readonly from: number;
    readonly to: number;
  }>;
}

export interface ConsoleTelemetrySnapshot {
  readonly version: 1;
  readonly projectId: ConsoleTelemetryValue<string>;
  readonly currentCounts: ConsoleTelemetryValue<
    Readonly<Record<ConsoleTelemetryPhase, number>>
  >;
  readonly events: ConsoleTelemetryValue<readonly ConsoleTelemetryEvent[]>;
  readonly cursor: ConsoleTelemetryValue<ConsoleTelemetryCursor>;
  readonly gaps: ConsoleTelemetryValue<readonly ConsoleTelemetryGap[]>;
  readonly presence: ConsoleTelemetryPresenceSummary;
  readonly presenceObservations: ConsoleTelemetryPresenceObservations;
  readonly host: ConsoleTelemetryHostMetrics;
  readonly processes: {
    readonly panel: ConsoleTelemetryProcess;
    readonly broker: ConsoleTelemetryProcess;
    readonly workers: ConsoleTelemetryValue<readonly ConsoleTelemetryProcess[]>;
  };
  readonly locks: ConsoleTelemetryLocks;
  readonly timingPercentiles: ConsoleTelemetryPercentiles;
  readonly overview: ConsoleTelemetryOverview;
}
