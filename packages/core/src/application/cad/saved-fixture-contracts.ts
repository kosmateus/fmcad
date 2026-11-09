export interface EvidenceRef {
  path: string;
  sha256: string;
}
export interface SavedDocument {
  name: string;
  creationId: string;
  fileId: string | null;
  projectId?: string;
  folderId?: string;
  version?: number;
}
export interface ProcessInstance {
  pid: number;
  birth: string;
  version: string;
}
export interface SavedEpoch {
  root: string;
  epochId: string;
  kind: string;
  ownerClientId: string;
  ownerTokenHash: string;
  document: SavedDocument;
  currentInstance: ProcessInstance;
  originalInstance: ProcessInstance;
  qualificationReceipt: EvidenceRef;
  restoreActiveCreationId?: string | null;
}
export interface SourceIdentity {
  sourceCommit: string;
  buildHash: string;
}
export interface Invocation {
  kind: string;
  operation: string;
  doc: string;
  docId: string;
  docFileId?: string | null;
  projectId?: string | null;
  output?: unknown;
  data: unknown;
}
export interface SavedRequest {
  kind: string;
  clientId: string;
  requestId: string;
  ownerToken: string;
  payload: Invocation;
  argv: string[];
  phased?: unknown;
  sequenceId?: unknown;
  inputFiles?: unknown[];
}
export interface SavedJob {
  id: string;
  clientId: string;
  requestId: string;
  kind: string;
  state: string;
  request: SavedRequest;
  details?: { sdkSettled?: boolean };
  dispatch?: { rpcCount: number; completedCount: number };
  sequenceId?: unknown;
}
export interface SavedQueueState {
  jobs: Record<string, SavedJob>;
  active?: unknown;
  blocked?: unknown;
  lease?: unknown;
  localUnknown?: unknown;
  controlBlocked?: unknown;
}
export interface Destination {
  version: number;
  purpose: string;
  ownerClientId: string;
  cloudProjectId: string;
  projectName: string;
  projectUrl: string;
  hubId: string;
  region: string;
  folderName: string;
  folderId: string;
  nativeProjectId: null;
  grantIssued: boolean;
  existingDataChangesAllowed: boolean;
  retention: string;
  evidence: EvidenceRef[];
}
export interface NativeDestination {
  nativeProjectId: string;
  nativeHubId?: string;
  nativeHubName?: string;
  projectName?: string;
  folderName?: string;
  folderId?: string;
  record: EvidenceRef;
}
export interface FirstSaveGrant {
  epochId: string;
  clientId: string;
  clientTokenHash: string;
  document: SavedDocument;
  savedFirstSave: {
    version: number;
    kind: string;
    requestId: string;
    saveRequestId: string;
    sourceCommit: string;
    buildHash: string;
    destination: Destination;
    nativeDestination: NativeDestination;
  };
}
export interface ObservedDocument {
  creationId: string;
  name: string;
  fileId: string | null;
  saved: boolean;
  modified: boolean;
  fileName?: string;
  projectId?: string;
  folderId?: string;
  version?: number;
  isComplete?: boolean;
  dataFileError?: unknown;
}
export interface FirstSaveReply {
  accepted: boolean;
  status: string;
  targetObserved: boolean;
  pending: boolean;
  copyRequested: boolean;
  original: ObservedDocument;
  current: ObservedDocument;
  target: {
    name: string;
    projectName: string;
    folder: string;
    folderId: string;
    projectId: string;
  };
}
export interface Publication {
  status: string;
  saveRequestId: string;
  originDocument: SavedDocument;
  grantIssued: boolean;
  existingDataChangesAllowed: boolean;
  retention: string;
  firstSave: FirstSaveReply | null;
  observation?: ObservedDocument | null;
  cloudProjectId?: string;
  document?: SavedDocument;
}
export interface AdminBinding extends Record<string, unknown> {
  purpose: string;
  epochId: string;
  clientId: string;
  ownerTokenHash: string;
  document: SavedDocument;
  currentInstance: ProcessInstance;
  historicalInstance: ProcessInstance;
  sdkProofPath: string;
  sourceCommit: string;
  buildHash: string;
  destination?: Destination | { projectId: string; folderId: string };
  readinessJobId?: string;
  firstSaveJobId?: string;
  expectedFileId?: string | null;
  before: unknown;
  publication?: EvidenceRef;
  savedDocument?: SavedDocument | undefined;
  restoreActiveCreationId?: string | null;
}
export interface SavedProof extends Record<string, unknown> {
  destination: NativeDestination;
  observed: ObservedDocument;
  savedDocument: SavedDocument;
}
export interface AdminResult extends Record<string, unknown> {
  requestId: string;
  kind: string;
  status: string;
  sdkRequestsSent: number;
  endpointVerified: boolean;
  clientId: string;
  jobId: string;
  nativeOutcome: string;
  modelValidation: string;
  rollbackVerification: string;
  summary: SavedProof;
}
export interface WireBinding extends Record<string, unknown> {
  auditBindingHash: string;
  pythonOriginHash: string;
  purpose: string;
  buildHash: string;
  jobId: string;
  auditExpectedInstance: ProcessInstance;
  rpcId: string;
  auditFirstSave: boolean;
  auditExpectedDocument: SavedDocument;
}
export interface IntentRecord {
  binding: AdminBinding;
  sourceArtifactHash: string;
  key: { jobId: string; requestId: string; clientId: string };
}
export interface StartRecord {
  binding: WireBinding;
  receipt: string;
  pythonCheck?: { status: string };
}
export interface RemoteRecord extends Record<string, unknown> {
  terminal: boolean;
  outcome: string;
  instance: ProcessInstance;
}
export interface RpcRecord extends StartRecord {
  terminal: boolean;
  failed: boolean;
}
export interface NativeDestinationRecord extends SourceIdentity {
  version: number;
  kind: string;
  epochId: string;
  ownerClientId: string;
  ownerTokenHash: string;
  originDocument: SavedDocument;
  approvedDestination: Destination;
  readinessEvidence: EvidenceRef[];
  readinessJobId: string;
  readinessJobs: Record<string, SavedJob>;
  receipt: EvidenceRef;
  qualificationEvidence: EvidenceRef[];
  destination: NativeDestination;
}
export interface PublicationRecord extends SourceIdentity {
  version: number;
  kind: string;
  epochId: string;
  ownerClientId: string;
  ownerTokenHash: string;
  originDocument: SavedDocument;
  publication: Publication;
  firstSaveEvidence: EvidenceRef[];
  observationEvidence: EvidenceRef[];
  observationReceipt: EvidenceRef;
  firstSaveJobId: string;
}
export interface SavedMessage {
  action: string;
  auth?: unknown;
  control?: unknown;
  epochId: string;
  grantClientId: string;
  requestId: string;
  saveRequestId: string;
  authorityFile: string;
  folderProofFile: string;
  jobId: string;
}
export interface SavedPorts {
  dir: string;
  buildHash: string;
  state: {
    epoch: SavedEpoch | null;
    data: SavedQueueState;
    assertEpoch(): void;
  };
  clients(): Record<string, string>;
  assertControl(control: unknown): void;
  fence(inFlight?: boolean): void;
  snapshot(): unknown;
  closed(epoch: SavedEpoch): void;
  auditPorts: Record<string, unknown>;
}
export interface AuditController {
  handle(message: SavedMessage, clientId: string): unknown;
}
export interface AuditOptions {
  kind: string;
  priorObservationRequired: boolean;
  extraKeys: string[];
  jobDirectory(): string;
  prepareReader: SavedFixtureHost["prepareSavedFixtureReader"];
  parseSummary: SavedFixtureHost["parseSavedFixtureReader"];
  assertOwner(
    jobId: string,
    priorObservationId: unknown,
    clientId: string,
  ): void;
  inspect(
    message: SavedMessage,
    clientId: string,
  ): Promise<{
    identity: SavedDocument;
    instance: ProcessInstance;
    binding: AdminBinding;
  }>;
  fence(value: { binding: AdminBinding }, inFlight: boolean): void;
  publishComplete(
    result: AdminResult,
    prior: IntentRecord,
    receipt: string,
  ): Promise<unknown>;
}
export interface SavedFixtureHost {
  hash(value: string): string;
  buildHash(): string;
  digest(value: unknown): string;
  sameInstance(
    a: ProcessInstance | null | undefined,
    b: ProcessInstance | null | undefined,
  ): boolean;
  priorProcessAlive(identity: { pid: number; birth: string }): boolean | null;
  fileHash(file: string): { sha256: string };
  exclusive(file: string, value: unknown): void;
  epochControlDirectory(root: string, epoch: SavedEpoch | null): string;
  parseSavedFixtureReader(
    reply: unknown,
    identity: unknown,
    binding: AdminBinding,
  ): unknown;
  prepareSavedFixtureReader(
    installation: string,
    identity: unknown,
    binding: Record<string, unknown>,
    options: { directory: string },
  ): unknown;
  settledEpochEvidence(
    root: string,
    state: { jobs: Record<string, SavedJob> },
    epoch: SavedEpoch,
  ): EvidenceRef[];
  responsePath(root: string, job: SavedJob, name: string): string;
  decodeInvocation(payload: unknown): Invocation;
  policyArguments(payload: Invocation): string[];
  createRecoveryAudit(options: AuditOptions): AuditController;
  verifyScratchSdkProof(
    result: AdminResult,
    prior: IntentRecord,
    receipt: string,
    ports: Record<string, unknown>,
  ): EvidenceRef[];
}
export interface ApprovalAuthority {
  version: number;
  purpose: string;
  ownerClientId: string;
  privacyEvidence: string;
  projectName: string;
  projectId: string;
  hubId: string;
  region: string;
  projectUrl: string;
  folderName: string;
  scope: string;
}
export interface FolderProof {
  version: number;
  status: string;
  projectName: string;
  projectId: string;
  folderName: string;
  folderId: string;
  authority: EvidenceRef;
  dataFilesCreated: number;
  retention: string;
  creationIntent: EvidenceRef;
  creationResult: EvidenceRef;
  readback: EvidenceRef;
}
export interface FolderCreationIntent {
  operation: string;
  project_name: string;
  project_url: string;
  hub_id: string;
  region: string;
  folder_name: string;
}
export interface FolderCreationResult {
  success: boolean;
  project_name: string;
  folder_id: string;
}
export interface FolderReadback {
  success: boolean;
  tool: string;
  query: string;
  matches: { type: string; id: string; name: string; projectName: string }[];
}
