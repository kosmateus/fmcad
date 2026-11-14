import type {
  EpochPointer,
  SuccessionAuthority,
  Reference,
  BackendTransitionProof,
  EffectivePredecessorIdentity,
} from "../queue-epoch-lineage";
export type { Reference };
export interface Process {
  pid: number;
  birth: string;
  version?: string;
}
export interface SdkProcessDeathBindings {
  authority: Reference;
  observationIntent: Reference;
  observationStart: Reference;
  observationWire: Reference;
  observationResult: Reference;
}
export interface SdkProcessDeathProof {
  version: 1;
  kind: "sdk-process-death-proof-v1";
  expectedProcess: Process;
  before: {
    state: "present";
    pid: number;
    birth: string;
    version: string;
    exe: string;
    windowHandle: string;
    observedAtUtc: string;
  };
  handleBoundExit: {
    pid: number;
    birth: string;
    hasExited: true;
    observedAtUtc: string;
  };
  after: {
    state: "absent";
    pid: number;
    observedAtUtc: string;
    errorId: string;
  };
  bindings: SdkProcessDeathBindings;
}
export interface Owner extends Process {
  nonce: string;
  protocol: number;
}
export interface Pointer extends EpochPointer {
  originalInstance: Process;
  currentInstance: Process;
  document: { fileId: unknown; creationId: string };
  quarantinedJobIds: [string, string, ...string[]];
}
export interface Authority extends SuccessionAuthority {
  priorAbortedSuccessor?: Reference;
  priorRetiredSuccessor?: Reference;
  previousOwner: Owner;
  expectedProcess: Process;
  nonce: string;
  configHash: string;
  candidateRoot: string;
}
export interface Checked {
  authority: Authority;
  audit: string;
  pointer: Pointer;
  state: unknown;
  identity: Record<string, unknown>;
  effectiveIdentity?: EffectivePredecessorIdentity;
}
export interface Approval {
  version: number;
  purpose: string;
  requestId: string;
  clientId: string;
  predecessorEpochId: string;
  previousBuildHash: string;
  pointerHash: string;
  previousOwner: Owner;
  stateHash: string;
  rootStateHash: string;
  rootIdentityHash: string;
  candidateRoot: string;
  buildHash: string;
  sourceCommit: string;
  expectedProcess: Process;
  qualification: Reference;
  physicalBackendHead?: Reference;
  priorAbortedSuccessor?: Reference;
  priorRetiredSuccessor?: Reference;
}
export interface Qualification {
  passed?: boolean;
  productionAdmission?: boolean;
  liveSdkRequestsSent?: number;
  sourceCommit?: string;
  buildHash?: string;
  publicDirectAccessRefused?: boolean;
  deadEpochSuccessorReadQualified?: boolean;
  deadEpochSuccessorRestoreQualified?: boolean;
}
export interface Inspection {
  root: string;
  runtime: string;
  audit: string;
  requestId: string;
  approvalRef: Reference;
  approval: Approval;
  clientId: string;
  ownerTokenHash: string;
  registeredTokenHash: string | undefined;
  pointer: Pointer;
  identity: { buildHash: string; configHash: string };
  previousOwner: Owner;
  snapshot: SuccessionAuthority["predecessor"];
  rootIdentity: { configHash: string };
  codeHash: string;
  configHash: string;
  qualification: Qualification;
  previousBrokerAlive: boolean | null;
  previousProcessAlive: boolean | null;
  originalProcessAlive: boolean | null;
  expectedProcessAlive: boolean | null;
  previousLifecycle: {
    owner: Owner;
    buildHash: string;
    configHash: string;
    stage: string;
  };
  pending: boolean;
  backendTransition?: BackendTransitionProof;
}
export interface Client {
  dir: string;
  auth: { clientId: string; clientToken: string };
}
export interface Sdk1MetadataWorkerProcess extends Owner {
  processProof?: {
    pid: number;
    birth: string;
    exe: string;
    exeSha256: string;
    cmdline: string[];
    childrenByTask: Record<string, string[]>;
    socketRows: string[];
  };
  interpreterProof?: { path: string; sha256: string; version: string };
}
export interface Sdk1SdkProcessObservation {
  state: "absent" | "present";
  pid: number;
  observedAtUtc: string;
  errorId?: string;
  birth?: string;
}
export interface Sdk1MetadataWorkerProcessResult {
  frozen?: boolean;
  process: NonNullable<Sdk1MetadataWorkerProcess["processProof"]>;
  retired: boolean;
  interpreter?: { path: string; sha256: string; version: string };
}
export interface Sdk1MetadataWorkerRetirementPorts {
  certify(runtime: string, sourceCommit: string, buildHash: string): void;
  deathQuery(expectedProcess: Process): Sdk1SdkProcessObservation;
  process(
    owner: Sdk1MetadataWorkerProcess,
    runtime: string,
    refs: Reference[],
    apply: boolean,
    root: string,
  ): Sdk1MetadataWorkerProcessResult;
}
export interface Sdk1MetadataWorkerRetirementPreview {
  ready: true;
  requestId: string;
  retirementPerformed: false;
  mechanism: "pidfd_send_signal:SIGKILL";
  gracefulClose: false;
  owner: Owner;
  sdkRequestsSent: 1;
  nativeOutcome: "unknown";
  historicalOutcome: "unknown";
}
export interface Sdk1MetadataWorkerRetirementPending {
  ready: false;
  retirementPending: true;
  noSignalReplay: true;
  requestId: string;
  sdkRequestsSent: 1;
  nativeOutcome: "unknown";
  historicalOutcome: "unknown";
}
export interface Sdk1MetadataWorkerRetirementComplete {
  version: 1;
  kind: "sdk1-metadata-worker-retirement-complete";
  status: "retired";
  requestId: string;
  clientId: string;
  owner: Owner;
  sdkRequestsSent: 1;
  nativeOutcome: "unknown";
  historicalOutcome: "unknown";
  protectedBytesUnchanged: true;
  before: Reference;
  effectStart: Reference;
  processDeathProof: Reference;
  sdkProcessAfter: Sdk1SdkProcessObservation;
  mechanism: "pidfd_send_signal:SIGKILL";
  gracefulClose: false;
}
export type Sdk1MetadataWorkerRetirementResult =
  | Sdk1MetadataWorkerRetirementPreview
  | Sdk1MetadataWorkerRetirementPending
  | Sdk1MetadataWorkerRetirementComplete;
export interface Guard {
  kind: string;
  nonce: string;
  audit: string;
  clientId: string;
}
export interface Intent {
  version: number;
  requestId: string;
  clientId: string;
  ownerTokenHash: string;
  nonce: string;
  approval: Reference;
  previousOwner: Owner;
}
export interface Complete {
  version: number;
  kind: string;
  requestId: string;
  authority: Reference;
  owner: Owner;
  buildHash: string;
  sourceCommit: string;
  sdkRequestsSent: number;
  modelingAdmission: string;
  historicalOutcome: string;
}
export interface Ready {
  nonce: string;
  buildHash: string;
  owner: Owner;
  sdkRequestsSent: number;
}
export interface BootstrapOptions {
  approval: string;
  requestId: string;
  preflight?: boolean;
  confirmOwnership?: boolean;
}
export interface ObservationInput {
  requestId: string;
  [key: string]: unknown;
}
export interface ObservationStatus {
  features?: { deadEpochSuccessor?: boolean };
  deadEpochSuccessor?: { observationRequestId?: string };
  control?: {
    buildHash: string;
    instanceId: string;
    generation: number;
    contextEpoch: number;
  };
}
export interface ObserverClient {
  call(action: "queue-summary"): Promise<ObservationStatus>;
  call(action: "observe-successor", input: ObservationInput): Promise<unknown>;
}
export interface AuditIdentity {
  commandId: string;
  resolvedIdentity?: { creationId?: string };
}
export interface CurrentInstance extends Process {
  version: string;
}
export interface RpcStart {
  receipt: string;
  binding: Record<string, unknown>;
  instance: Process | undefined;
  pythonCheck?: { status?: string };
}
export interface PhysicalReceipt extends Record<string, unknown> {
  terminal: boolean;
  outcome: string;
  instance: CurrentInstance;
}
export interface CurrentFacts {
  kind: string;
  authority: Reference;
  currentInstance: CurrentInstance;
  historicalOutcome: string;
  sdkRequestsSent: number;
  transportComplete: boolean;
  files: Record<string, Reference> & {
    result: Reference;
    intent: Reference;
    start: Reference;
  };
}
export interface CurrentProof {
  files: CurrentFacts["files"];
  clientId: string;
  currentInstance: CurrentInstance;
  originalInstance: Process;
  hash: string;
  historicalOutcome: string;
}
