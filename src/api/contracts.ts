import type {
  Backend,
  CatalogInvocation,
  CadWorkerInvocation,
  FmcadConfiguration,
  InvocationContextInput,
  JsonValue,
  OperationContract,
  OperationDeclaration,
  OperationResult,
  PythonCheckReport,
} from "../../packages/core/src";
import type {
  StageInspection,
  resumeStagePlan,
  revalidateStagePlan,
} from "../../packages/core/src/application/stage-journal";
export type { StageInspection } from "../../packages/core/src/application/stage-journal";

export type {
  Backend,
  CatalogInvocation,
  CadWorkerInvocation,
  FmcadConfiguration,
  InvocationContextInput,
  JsonValue,
  OperationContract,
  OperationDeclaration,
  OperationResult,
  PythonCheckReport,
};
export type {
  McpClientContextPort,
  McpClientIdentity,
  McpProjectResolution,
  McpProjectSelection,
  McpRootHint,
} from "../../packages/core/src/ports/mcp-context-port";
export type {
  McpExecutionContext,
  McpExecutionContextInput,
  McpRequestResult,
  McpRequestState,
  McpValidationResult,
} from "../../packages/core/src/application/mcp-context";

export type StageResumePlan = ReturnType<typeof resumeStagePlan>;
export interface StageServices {
  /** Read-only stage view bound to this Fmcad client's authenticated job ownership. */
  journalInspect(expectedHead?: string): StageInspection;
  resumePlan(expectedHead?: string): StageResumePlan;
  revalidate(plan: StageResumePlan): ReturnType<typeof revalidateStagePlan>;
}

export type CatalogMcpTool = ReturnType<
  typeof import("../../packages/core/src").projectMcpTools
>[number];

import type {
  GeometryCompareRegionInput,
  GeometryDeltaInput,
} from "../../packages/core/src/domain/regional-geometry";
import type {
  SectionSeriesInput,
  WitnessCheckInput,
} from "../../packages/core/src/domain/section-witness";
export type {
  GeometryCompareRegionInput,
  GeometryDeltaInput,
  RegionalDeltaEvidence,
  RegionalEntityRef,
  RegionalFrame,
  RegionalGeometryResult,
  RegionalMask,
  RegionalProvenance,
  RegionalSolidEvidence,
} from "../../packages/core/src/domain/regional-geometry";
export type {
  SectionSeriesInput,
  SectionSeriesResult,
  SectionWitnessEntityRef,
  SectionWitnessFrame,
  SectionWitnessLimits,
  SectionWitnessLoop,
  SectionWitnessStation,
  WitnessCheckInput,
  WitnessCheckResult,
} from "../../packages/core/src/domain/section-witness";
import type {
  SelectionRuleArtifactReference,
  SelectionRuleDefinitionInput,
} from "../../packages/core/src/domain/selection-rules";
import type { MeasuredFastenersCheckInput } from "../../packages/core/src/domain/measured-fasteners";
import type {
  NativeDriveMotionLinkInput,
  NativeDriveTestInput,
} from "../../packages/core/src/domain/native-drive";
export type {
  SelectionRuleArtifactReference,
  SelectionRuleCardinalityRange,
  SelectionRuleDefinitionInput,
  SelectionRuleQuery,
  SelectionRuleResolutionStatus,
} from "../../packages/core/src/domain/selection-rules";

export type {
  MeasuredFastenerAxialLayer,
  MeasuredFastenerAxisMeasurement,
  MeasuredFastenerBottoming,
  MeasuredFastenerCheck,
  MeasuredFastenerEntityRef,
  MeasuredFastenerFrame,
  MeasuredFastenerFrameResult,
  MeasuredFastenerInterval,
  MeasuredFastenerLayerRefs,
  MeasuredFastenerNativeResult,
  MeasuredFastenerProvenance,
  MeasuredFastenerReceptacleRefs,
  MeasuredFastenerScalar,
  MeasuredFastenerScrewRefs,
  MeasuredFastenerTolerance,
  MeasuredFastenerDeclaredEvidenceInput,
  MeasuredFastenerNativeInput,
  MeasuredFastenerToolObstacle,
  MeasuredFastenerToolAccessInput,
  MeasuredFastenerMetric,
  MeasuredFastenerCoverage,
  MeasuredFastenersCheckInput,
  MeasuredFastenersCheckResult,
} from "../../packages/core/src/domain/measured-fasteners";
export type {
  NativeDriveMotionLinkInput,
  NativeDriveMotionLinkResult,
  NativeDriveEntityRef,
  NativeDriveFollowerInput,
  NativeDrivePose,
  NativeDriveTestInput,
  NativeDriveTestResult,
} from "../../packages/core/src/domain/native-drive";

type MeasuredFastenerJson<T> = T extends readonly (infer Item)[]
  ? readonly MeasuredFastenerJson<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: MeasuredFastenerJson<T[Key]> }
    : T;
type MeasuredFastenersInvocationBase = Omit<
  CatalogInvocation,
  "operation" | "data" | "doc"
> & { readonly doc: string };
/** The existing CAD/broker route for measured native fastener checks. */
export type MeasuredFastenersInvocation = MeasuredFastenersInvocationBase & {
  readonly operation: "fastener.measured-check";
  readonly data: MeasuredFastenerJson<MeasuredFastenersCheckInput> &
    Record<string, JsonValue>;
};

type NativeDriveJson<T> = T extends readonly (infer Item)[]
  ? readonly NativeDriveJson<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: NativeDriveJson<Exclude<T[Key], undefined>> }
    : T;
type NativeDriveInvocationBase = Omit<
  CatalogInvocation,
  "operation" | "data" | "doc"
> & { readonly doc: string };
/** Typed public invocation; execution remains on the ordinary CAD/broker route. */
export type NativeDriveInvocation = NativeDriveInvocationBase & {
  readonly operation: "mechanism.drive-test";
  readonly data: NativeDriveJson<NativeDriveTestInput> & Record<string, JsonValue>;
};

/** Typed native fixture authoring; one real MotionLink creation, not qualification. */
export type NativeDriveMotionLinkInvocation = NativeDriveInvocationBase & {
  readonly operation: "mechanism.motion-link.create";
  readonly data: NativeDriveJson<NativeDriveMotionLinkInput> &
    Record<string, JsonValue>;
};

type SelectionRuleInvocationBase = Omit<
  CatalogInvocation,
  "operation" | "data" | "doc" | "docId" | "docFileId"
> &
  { readonly doc: string } &
  (
    | { readonly docId: string; readonly docFileId?: string }
    | { readonly docId?: string; readonly docFileId: string }
  );
type SelectionRuleJson<T> = T extends readonly (infer Item)[]
  ? readonly SelectionRuleJson<Item>[]
  : T extends object
    ? {
        readonly [Key in keyof T]: SelectionRuleJson<Exclude<T[Key], undefined>>;
      } & Record<string, JsonValue>
    : T;
export type SelectionRuleInvocation =
  | (SelectionRuleInvocationBase & {
      readonly operation: "selection.rule.define";
      readonly data: SelectionRuleJson<SelectionRuleDefinitionInput> &
        Record<string, JsonValue>;
    })
  | (SelectionRuleInvocationBase & {
      readonly operation:
        | "selection.rule.inspect"
        | "selection.rule.resolve"
        | "selection.rule.check";
      readonly data: {
        readonly artifact: SelectionRuleJson<SelectionRuleArtifactReference>;
      } & Record<string, JsonValue>;
    });

type RegionalJson<T> = T extends readonly (infer Item)[]
  ? readonly RegionalJson<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: RegionalJson<T[Key]> }
    : T;
type RegionalJsonInput<T extends object> = RegionalJson<T> &
  Record<string, JsonValue>;
type RegionalInvocationBase = Omit<
  CatalogInvocation,
  "operation" | "data" | "doc"
> & { readonly doc: string };
/** Narrowed public CAD inputs; execution still uses the ordinary CAD/broker path. */
export type RegionalGeometryInvocation =
  | (RegionalInvocationBase & {
      operation: "geometry.delta";
      data: RegionalJsonInput<GeometryDeltaInput>;
    })
  | (RegionalInvocationBase & {
      operation: "geometry.compare-region";
      data: RegionalJsonInput<GeometryCompareRegionInput>;
    });

type SectionWitnessInvocationBase = Omit<
  CatalogInvocation,
  "operation" | "data" | "doc"
> & { readonly doc: string };
type SectionWitnessJson<T> = T extends readonly (infer Item)[]
  ? readonly SectionWitnessJson<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: SectionWitnessJson<T[Key]> }
    : T;
type SectionWitnessJsonInput<T extends object> = SectionWitnessJson<T> &
  Record<string, JsonValue>;
export type SectionWitnessInvocation =
  | (SectionWitnessInvocationBase & {
      operation: "measure.section-series";
      data: SectionWitnessJsonInput<SectionSeriesInput>;
    })
  | (SectionWitnessInvocationBase & {
      operation: "measure.witness-check";
      data: SectionWitnessJsonInput<WitnessCheckInput>;
    });

import type {
  ReviewRequest,
  ReviewRunPorts,
  ReviewRunResult,
} from "../../packages/core/src/application/review";
export type {
  ReviewRequest,
  ReviewRunPorts,
  ReviewRunResult,
  ReviewExecutionPort,
  ReviewArtifactStore,
  ReviewPreparationPort,
  ReviewPlan,
} from "../../packages/core/src/application/review";

export interface ReviewInvocation {
  readonly version: 1;
  readonly kind: "review";
  readonly request: ReviewRequest;
}
export interface ReviewServices {
  execute(input: ReviewInvocation): Promise<ReviewRunResult>;
  dispose(): Promise<void>;
}
/** Advanced application composition: the execution port is an existing broker
 * gateway accepting a PreparedPythonArtifact, not a physical transport factory. */
export interface ReviewServiceOptions {
  readonly version: 1;
  readonly ports: ReviewRunPorts;
}

/** Local metadata/validation boundary shared by entrypoint adapters. */
export interface CatalogServices {
  list(): readonly OperationContract[];
  validate(input: CatalogInvocation): CatalogInvocation;
  validateData(
    operation: string,
    data: Record<string, JsonValue>,
  ): OperationDeclaration;
  tools(): readonly CatalogMcpTool[];
  fromMcp(
    name: string,
    argumentsValue?: unknown,
  ): {
    operation: string;
    invocation: CatalogInvocation;
    argv: string[];
  };
  isLocal(input: CatalogInvocation): boolean;
}

/** Each boundary has an independent major. Package versions are not wire versions. */
export interface ContractVersions {
  readonly api: 1;
  readonly dto: 1;
  readonly broker: 2;
  readonly persistedState: 1;
  readonly pythonEnvelope: 1;
  readonly controlApi: 1;
}

export interface FmcadOptions {
  readonly version: 1;
  readonly config: FmcadConfiguration;
  readonly context: InvocationContextInput & {
    readonly clientId: string;
    readonly projectDirectory?: string;
  };
}

export interface ExecuteOptions {
  /** Stable across a lost acknowledgement. Never automatically resubmitted. */
  readonly requestId: string;
  /** Distinct from the authenticated owner and the process instance. */
  readonly sessionId?: string;
  /** Broker admission controls; never select an alternate execution route. */
  readonly sequence?: {
    readonly action: "begin" | "continue" | "end";
    readonly id?: string;
    readonly mode?: "automatic" | "exclusive";
  };
  readonly expectedRevision?: number;
  readonly queueTimeoutMs?: number;
  /** Original CLI input snapshots, retained alongside the typed payload. */
  readonly inputFiles?: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface ExecutionReceipt {
  readonly version: 1;
  readonly requestId: string;
  readonly jobId: string | null;
  readonly sequenceId?: string | null;
  readonly sequenceState?: string | null;
  readonly state: string;
  readonly outcome: OperationResult;
  readonly result: JsonValue | null;
  /** Owner-only static analysis evidence; never SDK/model validation or authority. */
  readonly pythonChecks?: readonly PythonCheckReport[];
  /** Exact application streams, read only from broker-owned results. */
  readonly output?: { readonly stdout: string; readonly stderr: string };
}

export interface BrokerStatus {
  readonly version: 1;
  readonly build: string;
  /** Present after a qualified isolated-epoch runtime transition. */
  readonly sourceCommit?: string;
  readonly blocked: boolean;
  readonly active: boolean;
  /** Metadata for an explicit owner grant; never a token or grant itself. */
  readonly clientId?: string;
  readonly isolatedScratch?: {
    readonly epochId: string;
    readonly document: {
      readonly name: string;
      readonly creationId: string;
      readonly fileId: null;
    };
    readonly admission:
      | "qualified-fresh-scratch-only"
      | "normal-multidocument"
      | "qualified-first-save-only"
      | "saved-publication-or-retention-only"
      | "blocked-current-unknown"
      | "blocked-process-unavailable"
      | "cleanup-pending-or-unknown"
      | "closed";
  };
}

export interface ControlRequest {
  readonly version: 1;
  readonly action: "cancel" | "reconcile";
  readonly jobId: string;
}

/** Construction/catalog access is pure. start() connects, but never starts a broker.
 * dispose() stops local observation only; it is not SDK cancellation. */
export interface FmcadServices {
  readonly versions: ContractVersions;
  readonly query: {
    catalog(): readonly OperationContract[];
    validate(input: CatalogInvocation): CatalogInvocation;
    status(): Promise<BrokerStatus>;
    result(jobId: string): Promise<ExecutionReceipt>;
    /** Recover a lost admission acknowledgement without resubmitting. */
    request(requestId: string): Promise<ExecutionReceipt | null>;
  };
  /** Bind a read-only stage facade to a job owned by this Fmcad client. */
  stage(jobId: string): Promise<StageServices>;
  journalInspect(jobId: string, expectedHead?: string): Promise<StageInspection>;
  resumePlan(jobId: string, expectedHead?: string): Promise<StageResumePlan>;
  execute(
    input: RegionalGeometryInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  execute(
    input: SectionWitnessInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  execute(
    input: NativeDriveInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  execute(
    input: NativeDriveMotionLinkInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  execute(
    input: SelectionRuleInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  execute(
    input: CadWorkerInvocation,
    options: ExecuteOptions,
  ): Promise<ExecutionReceipt>;
  control(request: ControlRequest): Promise<ExecutionReceipt>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}
