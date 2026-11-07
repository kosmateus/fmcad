/** Private composition contracts for the existing shared broker. No port grants
 * SDK ownership: admission and all fences remain in the canonical composition. */
import type { ChildProcess, spawn } from "node:child_process";
import type { Agent } from "node:http";
import type { QueueDomain } from "../packages/core/src/domain/queue";
import type {
  QueueJob,
  QueueRequest,
  QueueSnapshot,
} from "../packages/core/src/domain/queue-model";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
} from "../packages/core/src/domain/python-artifact";
import type { PythonCheckReport } from "../packages/core/src/domain/python-checker";
import type {
  DocumentSelector,
  DocumentSnapshot,
} from "../packages/core/src/domain/document";
import type { BrokerControlFence } from "../packages/core/src/application/broker-control";
import type { QueueGate } from "../packages/node-adapters/dist/execution/gate";

export interface Instance {
  pid: number;
  birth: string;
  version: string;
  activeCommand?: string;
  documents?: Array<{ isModified?: boolean; creationId?: string }>;
  documentState?: DocumentSnapshot;
}
export interface Identity {
  configHash: string;
  buildHash: string;
  instance: Instance;
  sourceCommit?: string;
}
export interface Owner {
  pid: number;
  birth: string;
  nonce: string;
  protocol: number;
}
export interface Reference {
  path: string;
  sha256: string;
}
export interface Epoch {
  epochId: string;
  root: string;
  document: { name: string; creationId: string; fileId: null };
  currentInstance: Instance;
  originalInstance: Instance;
  ownerClientId: string;
  ownerTokenHash: string;
  succession?: Reference;
}
export interface ToolArguments extends Record<string, unknown> {
  code?: string;
  persistent?: boolean;
  session_id?: unknown;
  remember_as?: unknown;
  featureType?: string;
  object?: { script?: string; readOnly?: boolean };
}
export interface Rpc extends Record<string, unknown> {
  jsonrpc: string;
  method: string;
  id?: string | number | undefined;
  params?: { name?: string; arguments?: ToolArguments };
}
export interface Reply {
  jsonrpc: string;
  id?: string | number | undefined;
  result?: unknown;
  error?: unknown;
}
export interface Response {
  status: number;
  raw: string;
}
export interface Request extends QueueRequest, Record<string, unknown> {
  backend?: string;
  protocolVersion?: string;
  sessionId?: string | undefined;
  rpc?: { payload?: Rpc; sessionId?: string };
  isolatedEpoch?: string;
  inputFiles?: Array<{ path: string; sha256: string }>;
  payload?: Payload | undefined;
}
export interface Invocation {
  kind?: string;
  operation?: string;
}
export interface Payload extends Record<string, unknown> {
  kind?: string;
  invocation?: Invocation;
  operation?: string;
  method?: string;
  jsonrpc?: string;
}
export type Job = Omit<QueueJob, "request"> & { request: Request };
/** status/submit project public metadata, never the retained request or hash. */
export type PublicJob = Pick<
  Job,
  | "id"
  | "requestId"
  | "clientId"
  | "kind"
  | "state"
  | "order"
  | "submittedAt"
  | "queueDeadline"
  | "timeoutMs"
  | "sequenceId"
  | "sequenceState"
  | "sequenceMode"
  | "dispatch"
  | "code"
  | "physicalTurns"
  | "sdkRemainingMs"
>;
export type Snapshot = Omit<QueueSnapshot, "jobs" | "controlBlocked"> & {
  jobs: Record<string, Job>;
  controlBlocked?: { rpcId: string };
};
export type State = Omit<
  QueueDomain,
  "data" | "status" | "next" | "lookup" | "submit"
> & {
  data: Snapshot;
  epoch: Epoch | null;
  admissionMode: string;
  status(id: string): PublicJob;
  status(): Omit<Snapshot, "jobs"> & { jobs: Record<string, PublicJob> };
  lookup(id: string): Job;
  next(): Job | null;
  submit(request: Request, preparedId?: string): PublicJob;
  assertEpoch(normal?: boolean): void;
  isHistorical(id: string): boolean;
  findAnyRequest(clientId: string, requestId: string): PublicJob | null;
};
export interface Binding {
  jobId: string;
  rpcId: string;
  requestHash: string;
  buildHash: string;
  sourceHash?: string;
  observationKind?: string;
  observationTargetJobId?: string;
  observationIdentityHash?: string;
  [key: string]: unknown;
}
export interface RemoteReceipt extends Binding {
  terminal: boolean;
  outcome: string;
  instance: Instance;
}
export interface RecordEvidence {
  binding: Binding;
  instance: Instance;
  receipt?: string;
  request?: Rpc;
  wireRequest?: Rpc;
  method: string;
  terminal: boolean;
  response?: Response;
  failed?: boolean;
  nonterminal?: boolean;
  nativeCompletion?: unknown;
  remoteReceipt?: RemoteReceipt;
  pythonArtifact?: Pick<
    PythonArtifactManifest,
    "version" | "sha256" | "artifactHash" | "sourceMap"
  > & {
    units: Array<
      Pick<
        PreparedPythonArtifact["units"][number],
        "id" | "filename" | "role" | "sha256"
      >
    >;
  };
  pythonCheck?: PythonCheckReport;
  dispatchClass?: string;
  dispatchIndex?: number;
}
export interface NativeProof {
  rpcId: string;
  outcome: string;
  native: {
    kind: string;
    identity: AtomicIdentity;
    state: Record<string, unknown>;
  };
}
export interface Certificate {
  kind: string;
  report?: PythonCheckReport;
  fence(payload: Rpc): void;
}
export interface Prepared {
  outgoing: Rpc;
  record: RecordEvidence;
  rpcId: string;
  pythonArtifact?: PreparedPythonArtifact | undefined;
  contextEpoch: number;
  metadataOnly: boolean;
  pythonCertificate: Certificate;
  journal?: string;
  dispatchRemaining?: number;
}
export interface PreparedPost {
  outgoing: Rpc;
  pythonCertificate: Certificate;
  contextEpoch: number;
  metadataOnly?: boolean;
}
export interface ResetMarker extends Owner {
  buildHash: string;
  resetPause?: { requestId: string; instanceId: string; generation: number };
}
export interface PauseIntent {
  status: string;
  binding: {
    action: string;
    clientId: string;
    requestId: string;
    instanceId: string;
    expectedGeneration: number;
    buildHash: string;
  };
  result: {
    instanceId: string;
    generation: number;
    phase: string;
    activeOperations: number;
    unresolved: boolean;
  };
}
export interface ProbeRecord {
  jobId: string;
  buildHash: string;
  instance: Instance;
  binding: Binding;
  receipt: string;
  completed?: boolean;
}
export interface WorkerResult {
  jobId: string;
  terminal?: boolean;
  nonterminal?: boolean;
  workflowOutcome?: unknown;
  code: number;
}
export interface AdapterOutcome {
  jobId: string;
  buildHash: string;
  unknown?: boolean;
  rpcId?: string;
}
export interface Acceptance {
  kind: string;
  targetJobId: string;
  targetRequestId: string;
  clientId: string;
  acceptedOutcome: string;
  resolvedState: string;
  observerJobId: string;
  proofPath: string;
  proofSha256: string;
  observerBuildHash: string;
  reportFingerprint: string;
  reportPath: string;
  identity: AtomicIdentity;
  instance: Instance;
  originalBuildHash: string;
  paused: boolean;
  controlGeneration: number;
  contextEpoch: number;
}
export interface Origin {
  readonly artifact?: unknown;
  readonly [key: string]: unknown;
}
export interface Send<Result = unknown> {
  (): Promise<Result>;
  fence(): void;
}
export interface ToolResult {
  text: string;
  failed: boolean;
}
export interface Client {
  server: Config;
  reqOpts?: { agent?: Agent };
  capabilities?: unknown;
  serverInfo?: unknown;
  negotiatedProtocolVersion?: string;
  _parse(raw: string): unknown;
  _post(payload: Rpc, sessionId?: string, options?: unknown): Promise<Response>;
  _openSession(): Promise<string>;
  preparePost?(
    payload: Rpc,
    origin?: Origin,
  ): Promise<{ fence(): void; send(sessionId?: string): Promise<Response> }>;
  callTool(
    args: ToolArguments,
    name?: string,
    origin?: Origin,
  ): Promise<ToolResult>;
  listTools(): Promise<Array<{ name: string }>>;
  executeUiGuardedScript(script: string, origin?: Origin): Promise<ToolResult>;
  prepareCallTool?: (...args: unknown[]) => Promise<Send>;
  prepareUiGuardedScript?: (...args: unknown[]) => Promise<Send>;
  prepareListTools?: (...args: unknown[]) => Promise<Send>;
  withRequest?<T>(
    settings: {
      timeoutMs?: number;
      headers?: Record<string, string>;
      protocolVersion?: string | undefined;
    },
    action: () => T,
  ): T;
}
export interface Config {
  routing?: string;
  backend?: string;
  tool?: string;
  transport?: string;
  protocolVersion?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  [key: string]: unknown;
}
export interface Options {
  confirmOwnership?: boolean;
  confirmVersionTransition?: boolean;
  dir?: string;
  createBackend?: (config: Config) => Client;
  /** Explicit physical test adapter only. Production always uses its WSL/native mapping. */
  nativePath?: (file: string) => string;
  stateOptions?: Record<string, unknown>;
  startPaused?: boolean;
  autoReconcile?: boolean;
  fusionResetNonce?: string;
  atomicMigrationNonce?: string;
  epochRuntimeUpgradeNonce?: string;
  deadEpochSuccessorNonce?: string;
  testAtomicWorkflowScope?: AtomicScopeConfig;
  testFusionProcessAlive?: (instance: Instance) => boolean;
  spawnWorker?: typeof spawn;
  pollMs?: number;
}
export interface Budget {
  remaining(): number;
  freeze(): void;
  resume(): void;
  close(): void;
}
export interface Context {
  job: Job;
  token: string;
  pending: Set<Promise<unknown>>;
  dispatched: boolean;
  unknown: boolean;
  timedOut: boolean;
  workerClosed: boolean;
  executionFailed: boolean;
  deadline: number;
  contextEpoch: number;
  turnRpcs: Array<{ record: RecordEvidence; journal: string }>;
  localDispatchErrors?: Set<unknown>;
  budget?: Budget;
  timeoutPromise?: Promise<never>;
  child?: ChildProcess;
  nativeActivityId?: string;
  workflowUnknown?: boolean;
  waitingForPause?: boolean;
  rpcBudget?: Budget | undefined;
  rpcDeadline?: number;
  publicationError?: boolean;
  lastRpc?: {
    rpcId: string;
    failed: boolean;
    record: RecordEvidence;
    journal: string;
  };
  phaseError?: BrokerError;
  preconditionCode?: string;
  workflowObservation?: ObservationScope;
}
export interface BrokerError {
  message?: string;
  code?: string;
  probeNotSubmitted?: boolean;
  probeCompleted?: boolean;
  observation?: Instance;
  pythonCheck?: unknown;
  notStarted?: boolean;
}
export interface WorkerMessage {
  jobId: string;
  workerToken: string;
  method: "callTool" | "listTools" | "executeUiGuardedScript";
  args: unknown[];
  rpcTimeoutMs: number;
}
export interface Flight {
  binding: Binding;
  receipt: string;
  send: Send<Instance>;
}
export interface ProbeOptions {
  mapPath?: (file: string) => string;
  receiptPath?: string;
  binding?: Binding | Record<string, unknown>;
  requireIdle?: boolean;
  diagnosticPath?: string | undefined;
  documentSelector?: DocumentSelector | null | undefined;
  prepared?: Flight | undefined;
  onObservation?: (instance: Instance) => void | Promise<void>;
}
export interface ResetProof {
  nonce: string;
  clientId: string;
  pid: number;
  birth: string;
  fence: BrokerControlFence;
  nonterminal: boolean;
  probeRpcId?: string;
}
export interface AtomicScopeConfig {
  jobId: string;
  [key: string]: unknown;
}
export interface AtomicIdentity {
  commandId: string;
  runId: string;
  requestHash: string;
  backend: string;
  sessionNonce: string;
  documentIdentity: {
    expected: { creationId: string };
    resolved: { creationId: string };
  };
  resolvedIdentity: { creationId: string };
}
export interface AtomicSummary {
  identity?: AtomicIdentity;
  identityMatches?: boolean;
  outcome: string;
  status: string;
  completed: boolean;
  destroyed: boolean;
  idle: boolean;
  cleanupCompleted?: boolean;
  definitionDeleted?: boolean;
}
export interface AtomicPrepared {
  scope: { kind: string; projectDirectory: string; reportPath: string };
  identity: AtomicIdentity;
  reportFingerprint: string;
  originalInvocationHash: string;
  sourceEnvelope: { sha256: string };
  snapshot: unknown;
  expectedContext: { docId: string };
  artifact: PreparedPythonArtifact;
  script: string;
  atomicRuntimeAbi?: { proof: unknown; hash: string };
}
export type BoundAtomicPrepared = AtomicPrepared & {
  atomicRuntimeAbi: { proof: unknown; hash: string };
};
export interface AtomicProof {
  version: number;
  kind: string;
  targetJobId: string;
  targetRequestId: string;
  observerJobId: string;
  observerRequestId: string;
  clientId: string;
  projectDirectory: string;
  reportPath: string;
  reportFingerprint: string;
  originalBuildHash: string;
  observerBuildHash: string;
  observerInstance: Instance;
  readOnlyOperation: string;
  remoteOutcome: string;
  toolFailed: boolean;
  identityMatches: boolean;
  identity: AtomicIdentity;
  summary: AtomicSummary | null;
  originalInvocationHash: string;
  sourceEnvelope: unknown;
  binding: Binding;
  receipt: string;
  rpcId: string;
}
export interface ObservationScope {
  targetJob: Job;
  observerJob: Job;
  clientId: string;
  prepared: BoundAtomicPrepared;
  expectedInstance: Instance;
  instanceBuildHash: string;
  initialState: Pick<
    Snapshot,
    | "active"
    | "blocked"
    | "paused"
    | "controlGeneration"
    | "contextEpoch"
    | "lease"
  >;
  initialActiveIds: string[];
  originalActiveIds: string[];
  expectedToolCode: string;
  startPath: string;
  resultPath: string;
  toolStarted: boolean;
  proof: AtomicProof | null;
  originalContext: Context | null;
  observerContext?: Context;
  rpcId?: string;
  rpcJournal?: string;
}
export interface AuditScope {
  purpose: string;
  owner: Owner;
  buildHash: string;
  originalInstance: Instance;
  currentInstance: Instance;
  migrationAudit: string;
  auditResponseRecovery?: unknown;
  epochPrerequisite?: {
    clientId: string;
    hash: string;
    currentInstance: Instance;
  };
}
export interface ScriptScope {
  post(payload: Rpc, sessionId?: string): Promise<Response>;
  origin?: Origin;
}
export interface Message extends Partial<WorkerMessage> {
  action: string;
  auth?: { clientId: string; clientToken: string } | undefined;
  clientId?: string;
  clientToken?: string;
  jobId?: string;
  requestId?: string;
  request?: unknown;
  expectedRequest?: unknown;
  sequenceId?: string;
  observationJobId?: string;
  control?: BrokerControlFence & {
    buildHash?: string;
    generation?: number;
    contextEpoch?: number;
  };
  acceptedOutcome?: string;
  onlyIfQuiescent?: boolean;
  expectedBuildHash?: string;
  expectedRevision?: number;
  [key: string]: unknown;
}
export interface Recovery {
  jobId: string;
  status: string;
  at: number;
  observationJobId?: string;
  code?: string;
}
export type GateSnapshot = ReturnType<QueueGate["snapshot"]>;
