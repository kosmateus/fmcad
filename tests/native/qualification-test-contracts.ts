/** Narrow public ports exercised by the offline qualification harness tests. */
export interface OwnedDocument {
  name: string;
  creationId: string;
  fileId?: string | null;
  isActive?: boolean;
  isSaved?: boolean;
  isModified?: boolean;
}
export interface QualificationFeature {
  id: string;
  ticket?: string;
  requiredCases?: string[];
  deferredAdapter?: { capability: string };
}
export interface QualificationManifest {
  hold: { jobs: string[] };
  features: QualificationFeature[];
  firstSmoke: {
    entrypoint: string;
    executor: string;
    operations: string[];
    retryPolicy: string;
  };
}
export interface FeatureResult {
  status: string;
  requiresReconciliation?: boolean;
  unsupportedCapability?: string;
}
export interface QualificationReport {
  candidate: { base: string; sourceBlobs: { equivalentCommit: string }[] };
  features: FeatureResult[];
  fusionSessions: number;
  nativeQualification: string;
}
export interface SweepResult {
  status: string;
  features: FeatureResult[];
  stoppedForUnknown?: boolean;
  requiresReconciliation?: boolean;
}
export interface QueueObservation {
  phase: string;
  buildHash: string;
  paused: boolean;
  active: unknown;
  blocked: unknown;
  lease: unknown;
  unresolved: boolean;
  activeOperations: number;
  nonterminalJobCount: number;
  held?: boolean;
  stopping?: boolean;
}
export interface RunScriptRequest {
  document: OwnedDocument;
}
export interface RunScriptResult {
  status: string;
  requestId: string;
  jobId?: string;
  reason?: string;
  fmcadResult?: { success: boolean; result?: object };
}
export interface PortCalls {
  status: number;
  list: number;
  create: number;
  run: number;
  cleanup: number;
}
export interface QualificationPort {
  calls: PortCalls;
  status(): Promise<QueueObservation>;
  listDocuments(): Promise<object>;
  createScratch(input: {
    name: string;
    baselineDocuments: OwnedDocument[];
    requestId: string;
    baselineRequestId: string;
    baselineJobId: string;
    afterListRequestId: string;
  }): Promise<object>;
  runScript(input: RunScriptRequest): Promise<RunScriptResult>;
  cleanupScratch(input: {
    document: OwnedDocument;
    beforeDocuments: OwnedDocument[];
    requestIds: { post: string; [phase: string]: string };
  }): Promise<object>;
}
export interface QualificationRunner {
  buildReport(): QualificationReport;
  classifyFeature(
    feature: QualificationFeature,
    proof: object,
    context: object,
  ): FeatureResult;
  gateReadiness(
    evidenceDir: string,
    manifest: QualificationManifest,
    candidateCommit: string,
  ): { ready: boolean };
}
export interface QualificationExecutor {
  createPrivateWorkspace(root: string): { project: string; home: string };
  parseDocumentList(text: string): OwnedDocument[];
  queueIsClear(status: QueueObservation, buildHash: string): boolean;
  queueJob(stdout: string, stderr: string, requestId: string): RunScriptResult;
  releasedGateMatches(
    receipt: object,
    manifest: { hold: { jobs: string[] } },
    commit: string,
  ): boolean;
  runNativeSweep(input: {
    manifest: { features: QualificationFeature[]; hold?: { jobs: string[] } };
    candidateCommit: string;
    workingTreeClean: boolean;
    evidenceDir: string;
    gateReceipt: object;
    bindings: object;
    port: Pick<QualificationPort, "status">;
    optIn: boolean;
  }): Promise<SweepResult>;
  validateBrokerStateHome(path: string): string;
  validateExplicitConfig(path: string): string;
}
interface DeferredResult {
  status: string;
  unsupportedCapability: string;
}
interface SketchDeferredResult extends DeferredResult {
  calls: {
    clientId: string;
    epochId: string;
    toolRequest: {
      action: string;
      invocation: {
        version: number;
        kind: string;
        operation: string;
        doc: string;
        docId: string;
      };
    };
  }[];
  document: OwnedDocument;
  unsupportedCases: string[];
  cleanup: { ownerJobs: { targetJobId: string; observationJobId: string } };
  caseResults: Record<string, { status: string }>;
  casePhases: Record<string, unknown>;
}
export interface DeferredAdapters {
  BREP_PHASES: Record<string, unknown>;
  BREP_CASES: string[];
  CAPTURE_PHASES: string[];
  CAPTURE_CASES: string[];
  SELECTION_PHASES: string[];
  SELECTION_CASES: string[];
  SKETCH_OPERATIONS: string[];
  SKETCH_CASES: string[];
  SKETCH_ALLOWED_OPERATIONS: Set<string>;
  validateBrepRequest(input: object): DeferredResult;
  validateCaptureRequest(input: object): DeferredResult;
  validateSelectionRequest(input: object): DeferredResult;
  validateSketchRequest(input: object): SketchDeferredResult;
}
