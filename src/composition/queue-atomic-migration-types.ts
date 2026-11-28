import type { PythonArtifactManifest } from "@fmcad/core";
import type {
  MigrationApproval,
  MigrationBinding,
  MigrationJob,
  MigrationOwner,
  MigrationSnapshot,
  MigrationUpgrade,
} from "../../packages/core/src/application/cad/owner-migration";
import type {
  FileDigest,
  TreeInventory,
} from "../../packages/node-adapters/src/persistence/migration-files";
import type { ProcessIdentity } from "../queue-instance-liveness";

import type {
  AtomicRuntimeAbi,
  PreparedAtomicObservation,
} from "./library-atomic-workflow-observation";

export interface HolderScope {
  jobId: string;
  requestId: string;
  reportPath: string;
  [key: string]: unknown;
}
export interface Owner extends MigrationOwner {
  pid: number;
  birth: string;
}
export type ProcessOwner = Pick<Owner, "pid" | "birth">;
export interface Job extends MigrationJob {
  requestId: string;
  hash: string;
  request: { ownerToken: string };
  dispatch: { rpcCount: number };
}
type BaseState = MigrationSnapshot["state"];
export interface RuntimeState extends BaseState {
  jobs: Record<string, Job>;
  controlRequests?: Record<string, { paused?: boolean }>;
}
export interface Snapshot extends MigrationSnapshot {
  state: RuntimeState;
  owner: Owner;
  identity: {
    buildHash: string;
    configHash: string;
    instance: ProcessIdentity;
  };
}
export interface FileReference {
  path: string;
  sha256: string;
  size?: number;
}
export interface Upgrade extends MigrationUpgrade {
  identity: unknown;
  originalInvocationHash: string;
  sourceEnvelope: unknown;
  reportFingerprint: string;
  observationProof: FileReference;
  previousComplete: FileReference;
  epochPrerequisite?: {
    files: { migrationComplete: FileReference };
    [key: string]: unknown;
  };
  auditResponseRecovery?: {
    files: { migrationComplete: FileReference };
    [key: string]: unknown;
  };
  currentInstance?: ProcessIdentity;
}
export interface Approval extends MigrationApproval {
  version: number;
  sourceCommit: string;
  admissionModuleSha256: string;
  checkerFingerprint: string;
  candidateRoot: string;
  installRoot: string;
  qualification: FileReference;
  purpose?: string;
}
export interface QualifiedApproval extends Approval {
  checkerContentFingerprint: string;
  admission: unknown;
}
export interface Intent {
  binding: MigrationBinding;
  approved: QualifiedApproval;
  nonce: string;
  ownerTokenHash: string;
}
export interface Guard {
  kind: string;
  nonce: string;
  audit: string;
  clientId: string;
}
export interface Backup {
  audit: string;
  manifest: string;
  sha256: string;
  sourceStateHash: string;
}
export interface BackupManifest {
  sourceStateHash: string;
  queue: TreeInventory;
  report: TreeInventory;
  runtime: TreeInventory;
  generatorDependencies?: Record<string, TreeInventory>;
}
/** Migration wire requires the identity witness produced by buildAtomicRuntimeAbi. */
export type Abi = AtomicRuntimeAbi & { proof: { identityHash: string } };
export interface Evidence {
  originalInvocationHash: string;
  sourceEnvelope: unknown;
  reportFingerprint: string;
  receipts: ({ receipt: string } & FileDigest)[];
  identity: unknown;
  reportInventory: TreeInventory;
  auditUpgrade?: Upgrade;
  atomicRuntimeAbi?: Abi;
}
export type PreparedObservation = Pick<
  PreparedAtomicObservation,
  | "script"
  | "artifact"
  | "identity"
  | "originalInvocationHash"
  | "sourceEnvelope"
  | "reportFingerprint"
> & { atomicRuntimeAbi?: Abi };
export interface RpcBinding {
  jobId: string;
  buildHash: string;
  rpcId: string;
  requestHash: string;
  sourceHash: string;
  [key: string]: unknown;
}
export interface RpcRecord {
  binding: RpcBinding;
  receipt: string;
  instance: ProcessIdentity;
}
export interface TransportReceipt extends RpcBinding {
  terminal: boolean;
  outcome: string;
  instance: ProcessIdentity;
}
export interface Qualification {
  sourceCommit: string;
  buildHash: string;
  productionAdmission: boolean;
  passed: boolean;
  auditUpgradeQualified?: boolean;
  processLossAuditQualified?: boolean;
  isolatedEpochQualified?: boolean;
  auditFactsCaptureQualified?: boolean;
}
export interface Descriptor {
  version: number;
  production: boolean;
  finalByteCertificate: boolean;
  status: string;
  purpose?: string;
  buildHash: string;
  sourceModuleHash: string;
  checkerFingerprint: string;
  artifactHash: string;
  sourceHash: string;
  auditBindingHash?: string;
  originArtifactHash: string;
  executedUnits: PythonArtifactManifest["units"];
  scopedAtomicObservation?: boolean;
  atomicRuntimeAbiHash?: string;
  observationKind?: string;
  observationTargetJobId?: string;
  observationIdentityHash?: string;
  abiPinnedUnits?: unknown[];
}
export interface RuntimeClient {
  auth: { clientId: string; clientToken: string };
  call(action: "queue-summary"): Promise<Snapshot["status"]>;
  call(
    action: "find-request",
    input: { requestId: string },
  ): Promise<{ job?: Job }>;
  call(
    action: "pause",
    input: {
      control: {
        requestId: string;
        instanceId: string;
        expectedGeneration: number;
      };
    },
  ): Promise<unknown>;
}
export interface RuntimeStages {
  initial: Snapshot;
  paused: Snapshot;
  complete: Record<string, unknown>;
  evidence: Evidence;
  "worker-ready": { buildHash: string; owner: Owner };
  worker: ProcessOwner;
  "worker-error": { code: string };
  "pause-adoption": unknown;
  "handoff-audit-upgrade": unknown;
  "handoff-abi": Abi;
}
