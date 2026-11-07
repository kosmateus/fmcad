import type {
  ProjectHistoryEvent,
  ProjectHistoryEventRecord,
  ProjectHistoryAgentIdentityKind,
  ProjectHistoryActivityFence,
  ProjectHistoryFileReference,
  ProjectHistoryIngestBatch,
  ProjectHistoryIngestResult,
  ProjectHistoryJobRecord,
  ProjectHistoryPage,
  ProjectHistoryProjectLifecycle,
  ProjectHistoryReadSnapshot,
  ProjectHistoryRevision,
  ProjectHistoryReplayCursor,
  ProjectHistorySessionRecord,
  ProjectHistorySnapshot,
} from "../domain/project-history";

export interface ProjectHistoryPageRequest {
  readonly after?: number;
  readonly limit: number;
}

export type ProjectHistorySynchronousResult<T> =
  T extends PromiseLike<unknown> ? never : T;

export interface ProjectHistoryAgentAliasIdentity {
  readonly kind: ProjectHistoryAgentIdentityKind;
  readonly id: string;
}

/** Read-only contract for an existing retained event/execution source. */
export interface ProjectHistorySourceReader<
  TSourceEvent extends ProjectHistoryEvent = ProjectHistoryEvent,
> {
  read(input: {
    readonly projectId: string;
    readonly after: ProjectHistoryReplayCursor | null;
    readonly limit: number;
  }): Promise<ProjectHistoryIngestBatch<TSourceEvent>>;
}

/** Project-local read model. It has no scheduler, admission, or execution methods. */
export interface ProjectHistoryStore<
  TSourceEvent extends ProjectHistoryEvent = ProjectHistoryEvent,
> {
  readonly projectId: string;
  readonly databaseId: string;
  ingest(
    events: readonly ProjectHistoryEvent<TSourceEvent>[],
  ): ProjectHistoryIngestResult;
  ingestBatch(
    batch: ProjectHistoryIngestBatch<TSourceEvent>,
  ): ProjectHistoryIngestResult;
  snapshot(capturedAtMs?: number): ProjectHistorySnapshot;
  readSnapshot(maxBytes?: number): ProjectHistoryReadSnapshot<TSourceEvent>;
  listEvents(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryEventRecord<TSourceEvent>>;
  listJobs(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryJobRecord<TSourceEvent>>;
  listSessions(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistorySessionRecord<TSourceEvent>>;
  listFileReferences(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryFileReference<TSourceEvent>>;
  setAlias(alias: string, nowMs: number): ProjectHistorySnapshot;
  removeAlias(alias: string, nowMs: number): ProjectHistorySnapshot;
  /** Atomically replace/reset the single project label if the stored revision matches. */
  setProjectAlias(
    alias: string | null,
    expectedRevision: ProjectHistoryRevision,
    nowMs: number,
  ): ProjectHistorySnapshot;
  /** Atomically set/reset a project-bound agent, client, or session display label. */
  setAgentAlias(
    identity: ProjectHistoryAgentAliasIdentity,
    alias: string | null,
    expectedRevision: ProjectHistoryRevision,
    nowMs: number,
  ): ProjectHistorySnapshot;
  /** Atomically change monitoring lifecycle only when the DB revision still matches. */
  setLifecycleIfRevision(
    lifecycle: ProjectHistoryProjectLifecycle,
    expectedRevision: ProjectHistoryRevision,
  ): ProjectHistorySnapshot;
  /** Holds this project's SQLite writer lock for the entire synchronous operation. */
  withActivityFence<T>(
    operation: (
      fence: ProjectHistoryActivityFence,
    ) => ProjectHistorySynchronousResult<T>,
  ): T;
  setLifecycle(
    lifecycle: ProjectHistoryProjectLifecycle,
  ): ProjectHistorySnapshot;
  close(): void;
}
