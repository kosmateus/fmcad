/** Existing v1 snapshot, kept byte-compatible with the broker's durable store. */
export type SequenceMode = "automatic" | "exclusive";
export interface QueueRequest {
  requestId: string;
  clientId: string;
  kind: "command" | "rpc";
  timeoutMs: number;
  queueTimeoutMs?: number | undefined;
  expectedRevision?: number | undefined;
  clientContext?: McpQueueContext | undefined;
  ownerToken?: string | undefined;
  buildHash?: string | undefined;
  description?: string | undefined;
  argv?: string[] | undefined;
  cwd?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  phased?: boolean | undefined;
  sequence?:
    | {
        action: "begin" | "continue" | "end";
        id?: string | undefined;
        mode?: SequenceMode | undefined;
      }
    | undefined;
}
/** Broker-authored, single-call recovery observation metadata; never accepted from clients. */
export interface AtomicWorkflowObservation {
  readonly version: 1;
  readonly kind: "atomic-holder-status";
  readonly targetJobId: string;
  readonly targetRequestId: string;
  readonly targetClientId: string;
  readonly targetJobHash: string;
  readonly observerJobHash: string;
  readonly targetBuildHash: string;
  readonly observerBuildHash: string;
  readonly projectDirectory: string;
  readonly paused: boolean;
  readonly controlGeneration: number;
  readonly contextEpoch: number;
  readonly reportPath: string;
  readonly reportFingerprint: string;
  readonly commandId: string;
  readonly sessionNonce: string;
  readonly docId: string;
}
export interface McpQueueContext {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly projectDirectory: string;
  readonly projectId?: string;
  readonly doc?: string;
  readonly docId?: string;
  readonly docFileId?: string;
  readonly purpose?: string;
  readonly expectedRevision?: number;
}
export interface QueueDetails {
  [key: string]: unknown;
  state?: string | undefined;
  code?: string | undefined;
  reason?: unknown;
  rpcCount?: number | undefined;
  completedCount?: number | undefined;
  rpcState?: string | undefined;
}
export interface QueueJob {
  id: string;
  requestId: string;
  clientId: string;
  kind: "command" | "rpc";
  request: QueueRequest;
  hash: string;
  order: number;
  state: string;
  submittedAt: number;
  queueDeadline: number | null;
  timeoutMs: number;
  sequenceId: string | null;
  sequenceState: string | null;
  sequenceMode?: SequenceMode | undefined;
  sequenceParentId?: string | undefined;
  description?: string | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  runDeadline?: number | undefined;
  revision?: number | undefined;
  code?: string | undefined;
  contextEnded?: boolean | undefined;
  contextRefreshRequired?: boolean | undefined;
  sequencePauseMs?: number | undefined;
  physicalTurns?: number | undefined;
  sdkRemainingMs?: number | undefined;
  sdkReadyAt?: number | undefined;
  details?: QueueDetails | undefined;
  dispatch?:
    | {
        dispatchCount: number;
        rpcCount: number;
        completedCount: number;
        updatedAt: number;
        rpcState?: string | undefined;
        details?: QueueDetails | undefined;
      }
    | undefined;
  /** Present only on the one broker-authorized observer for the blocked atomic job. */
  workflowObservation?: AtomicWorkflowObservation | undefined;
}
export interface QueueLease {
  id: string;
  clientId: string;
  ownerToken: string | null;
  epoch: number;
  createdAt: number;
  idleUntil: number;
  holdUntil: number;
  pauseBase?: number | undefined;
}
export interface QueueBlock {
  id: string;
  reason: unknown;
  at: number;
}
export interface QueueSnapshot {
  version: 1;
  paused: boolean;
  revision: number;
  epoch: number;
  blocked: QueueBlock | null;
  active: string | null;
  lease: QueueLease | null;
  jobs: Record<string, QueueJob>;
  lastClient: string | null;
  localUnknown?: QueueBlock | undefined;
  controlBlocked?: unknown;
  controlGeneration?: number | undefined;
  contextEpoch?: number | undefined;
  pauseStartedAt?: number | undefined;
  controlRequests?:
    Record<string, { paused: boolean; generation: number }> | undefined;
  lastInstanceTransitionId?: string | undefined;
}
export interface QueueDomainOptions {
  /** False only when continuing a live in-memory snapshot, not restoring after restart. */
  recover?: boolean;
  snapshot?: QueueSnapshot | undefined;
  maxQueued?: number | undefined;
  maxPerClient?: number | undefined;
  idleMs?: number | undefined;
  leaseMs?: number | undefined;
  now: () => number;
  newId: () => string;
  hash: (canonicalInput: string) => string;
  /** Persist the proposed snapshot before publishing it. Throws poison this instance. */
  commit?: ((snapshot: QueueSnapshot) => void) | undefined;
}
export function initialQueueSnapshot(): QueueSnapshot {
  return {
    version: 1,
    paused: false,
    revision: 0,
    epoch: 0,
    blocked: null,
    active: null,
    lease: null,
    jobs: {},
    lastClient: null,
  };
}
