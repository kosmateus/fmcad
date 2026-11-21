import type { OwnedDocument } from "./qualification-test-contracts";
export interface RuntimeUpgrade {
  kind: string;
  epochId: string;
  document: OwnedDocument;
  previousBuildHash: string;
  sourceCommit: string;
  buildHash: string;
  rejectedJobIds: string[];
  ownerClientId: string;
  clientId: string;
  ownerTokenBound: boolean;
  sdkRequestsSent: number;
  historicalOutcome: string;
  grantScopeChanged: boolean;
  gateClosed: boolean;
  operationalQueueBudget?: { idleMs: number; leaseMs: number };
}
export interface AuthorityResult {
  epochId: string;
  clientId: string;
  document: OwnedDocument;
  sourceCommit: string;
  buildHash: string;
  factsRequestId: string;
  ownerJobs: { targetJobId: string; observationJobId: string };
  runtimeUpgrade?: RuntimeUpgrade;
}
export interface EntityRef {
  token?: string;
  kind: string;
  name: string;
}
export interface InvocationData {
  name?: string;
  sketch?: EntityRef;
  geometry?: { name: string }[];
  plane?: string;
  profile?: { index: number };
  distance?: string;
}
export interface SmokeInvocation {
  version: number;
  kind: string;
  operation: string;
  data: InvocationData;
  doc: string;
  docId: string;
  docFileId?: string;
  projectId?: string;
}
export interface RequestOptions {
  requestId: string;
  sessionId?: string;
  sequence: { action: string; id?: string; mode?: string };
  queueTimeoutMs?: number;
  expectedRevision?: number;
}
export interface ApiPayload {
  sketch?: { token?: string; kind: string; name?: string | undefined };
  entities?: EntityRef[];
  refs?: Record<string, EntityRef[]>;
  profiles?: object[];
  feature?: { token: string; kind: string; name: string | undefined };
  bodies?: { token: string; kind: string; name: string | undefined }[];
  healthState?: number;
  message?: string;
  token?: string;
  kind?: string;
  name?: string;
  isSolid?: boolean;
  boundingBox?: { min: number[]; max: number[]; units: string };
  value?: number;
  units?: string | { length: string; angle: string };
  dimension?: string;
  creationId?: string;
  saved?: boolean;
  modified?: boolean;
  fileId?: null;
  schemaVersion?: number;
  status?: string;
}
export interface SmokeReceipt {
  version: number;
  requestId: string;
  jobId: string;
  sequenceId?: string | null | undefined;
  sequenceState?: string | null;
  state: string;
  result: {
    success: boolean;
    operation: string;
    document: string;
    result: ApiPayload;
  } | null;
  outcome?: {
    version: number;
    requestId: string;
    jobId: string;
    acceptance: string;
    executionOutcome: string;
    mayHaveMutated: boolean;
    code: string;
    validation?: object;
  };
  pythonChecks?: { status: string; reasons: string[] }[];
}
export interface Execution {
  invocation: SmokeInvocation;
  options: RequestOptions;
}
export interface SmokeStatus {
  version: number;
  build: string;
  sourceCommit?: string;
  blocked: boolean;
  active: boolean;
  clientId: string;
  isolatedScratch: {
    epochId: string;
    document: OwnedDocument;
    admission: string;
  };
}
export interface FakeServiceOptions {
  statusRows?: (index: number) => SmokeStatus;
  resultFactory?: (
    invocation: SmokeInvocation,
    options: RequestOptions,
    jobId: string,
  ) => SmokeReceipt;
  onExecute?: (
    input: Execution & { executions: Execution[] },
  ) => SmokeReceipt | void;
  onResult?: (input: {
    jobId: string;
    executions: Execution[];
    resultByJob: Map<string, SmokeReceipt>;
  }) => SmokeReceipt | undefined;
}
export interface SmokeServices {
  versions: Record<string, number>;
  execute(
    invocation: SmokeInvocation,
    options: RequestOptions,
  ): Promise<SmokeReceipt | void>;
  query: {
    validate(invocation: SmokeInvocation): SmokeInvocation;
    catalog(): { operation: string }[];
    status(): Promise<SmokeStatus>;
    result(jobId: string): Promise<SmokeReceipt | undefined>;
    request(requestId: string): Promise<SmokeReceipt | null>;
  };
  control(): Promise<never>;
  executions: Execution[];
  start?(): Promise<void>;
  dispose?(): Promise<void>;
}
export interface CloseRequest {
  targetJobId: string;
  observationJobId: string;
  requestId: string;
  epochId: string;
  document: OwnedDocument;
}
export interface CloseReceipt {
  status: string;
  kind?: string;
  requestId?: string;
  jobId?: string;
  observationJobId?: string;
  clientId?: string;
  activation?: {
    epochId: string;
    document: OwnedDocument;
    admission: string;
    historicalOutcome: string;
  };
  sdkRequestsSent?: number;
}
export interface ErrorProof {
  name: string;
  code: string | null;
  messageSha256: string;
}
export interface ReadErrorProof {
  attempts: number;
  firstError: ErrorProof;
  lastError: ErrorProof;
}
export interface SmokeReport {
  status: string;
  reason?: string;
  ledger?: string;
  geometry?: {
    volume: { value: number; units: string };
    bounds: { spans: number[] };
  };
  cleanup?: { admission: string };
  executionStatus?: string;
  jobId?: string;
  requestId?: string;
  phase?: string;
  receipt?: SmokeReceipt;
  readErrorProof?: ReadErrorProof;
  executeError?: ErrorProof;
  reconciliationRequired?: boolean;
}
export interface SmokeLedger {
  kind: string;
  status: string;
  state: string;
  sequenceId: string;
  currentPhase: string;
  lastError: string;
  authority: {
    sourceCommit: string;
    buildHash: string;
    runtimeUpgrade?: RuntimeUpgrade;
  };
  steps: {
    phase: string;
    state: string;
    jobId: string;
    requestId: string;
    sequenceId: string;
    tokenSha256?: string;
    receipt?: SmokeReceipt;
    sameJobReadErrorProof?: ReadErrorProof;
  }[];
  continuation: {
    newSketchCreated: boolean;
    consumedGeometryRequestId: string;
    newGeometryRequestId: string;
    proofSha256: string;
    decisionSha256: string;
  };
  recovery: {
    kind: string;
    requestReceipt: SmokeReceipt;
    resultReceipt: SmokeReceipt;
  };
  lastSameJobReadErrorProof?: ReadErrorProof;
  lastExecuteError?: ErrorProof;
  lastRequestLookup?: { requestId: string; result: string };
}
export interface FirstSmokeModule {
  CONTRACT_VERSIONS: Record<string, number>;
  F708_RUNTIME: { sourceCommit: string; buildHash: string };
  OPERATIONS: string[];
  SEQUENCE_PHASES: (
    | "sketchCreate"
    | "sketchGeometry"
    | "sketchInspect"
    | "extrude"
    | "bodyInspect"
    | "volume"
  )[];
  validateAuthority(input: unknown): AuthorityResult;
  executeFirstSmoke(input: object): Promise<SmokeReport>;
}
