import type {
  EpochPointer,
  SuccessionAuthority,
  Reference,
} from "../queue-epoch-lineage";
export type { Reference };
export interface Process {
  pid: number;
  birth: string;
  version?: string;
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
}
export interface Client {
  dir: string;
  auth: { clientId: string; clientToken: string };
}
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
