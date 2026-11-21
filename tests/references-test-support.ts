import type { createReferenceWorkflow } from "../packages/node-adapters/src/persistence/reference-workflow";
import type { ReferenceApplyResult } from "../packages/core/src/application/documents/references-apply";
import type { ReferenceInput } from "../packages/core/src/application/documents/references";
import type {
  ReferenceParameter,
  PolicyDocument,
} from "../packages/core/src/application/documents/reference-policy-types";
type Workflow = ReturnType<typeof createReferenceWorkflow>;
type BasePlan = ReturnType<
  typeof import("../packages/core/src/application/documents/reference-plan").makePlan
>;
type Plan = Omit<BasePlan, "documents"> & {
  documents: (BasePlan["documents"][number] & {
    metadataCoverage?: { occurrence: string };
    health?: { healthy?: boolean; repairRequired?: boolean; status?: string };
  })[];
};
export interface FixtureDocument extends PolicyDocument {
  parameters?: ReferenceParameter[];
  metadataCoverage?: unknown;
  health?: { healthy?: boolean; repairRequired?: boolean; status?: string };
}
export interface FixtureEdge {
  edgeId: string;
  ownerFileId: string;
  sourceFileId: string;
  kind: string;
  ownerProjectId?: string;
  ownerContext?: unknown;
  sourceProjectId?: string | null;
  baselineVersion: number;
  latestVersion: number;
  versionSource?: string;
  selfReference?: boolean;
  status: string;
  targetVersion?: number | null;
  sourceParameterVersion?: number;
  sourceDocumentModified?: boolean;
  sourceParameters?: ReferenceParameter[];
  derivedParameters?: ReferenceParameter[];
}
export interface FixtureSnapshot {
  schemaVersion: number;
  documents: FixtureDocument[];
  edges: FixtureEdge[];
  graphComplete: boolean;
  [key: string]: unknown;
}
interface Report extends ReferenceApplyResult {
  latestReceipt: { requestId: string; result: ReferenceApplyResult };
  replayedReceipt: boolean;
  unknown: unknown[];
  lifecycleEffects: { type: string }[];
}
export interface StepPayload extends Record<string, unknown> {
  method?: string;
  timeBudgetMs: number;
  nativeRpcTimeoutMs: number;
  plannedMethod?: string;
  nativeRoute?: string;
  ownedCreationId?: string;
  openedByRequest?: boolean;
  root: { version: number };
  policy?: string;
  fileId?: string;
}
// Public JS compatibility tests deliberately inject incomplete and failed SDK
// readbacks. Input is checked by the workflow at runtime; keep outputs observable.
type Dependencies = Omit<Parameters<Workflow["apply"]>[3], "step"> & {
  step?: (
    action: string,
    payload: StepPayload,
    input: ReferenceInput,
    context: Record<string, unknown>,
  ) => Promise<unknown>;
};
export type ReferenceApi = Omit<Workflow, "apply" | "execute"> &
  typeof import("../packages/core/src/application/documents/reference-input") &
  Omit<
    typeof import("../packages/core/src/application/documents/reference-plan"),
    "makePlan"
  > & {
    makePlan(
      ...args: Parameters<
        typeof import("../packages/core/src/application/documents/reference-plan").makePlan
      >
    ): Plan;
    apply(
      client: unknown,
      input: ReferenceInput,
      plan: unknown,
      deps: Dependencies,
    ): Promise<Report>;
    execute(
      client: unknown,
      data: Record<string, unknown>,
      context: Record<string, unknown>,
      deps?: Dependencies,
    ): Promise<Report>;
    staleBeforeStep(
      plan: unknown,
      snapshot: unknown,
      fileId: string,
    ): string | null;
    planFreshness(plan: unknown, snapshot: unknown): { reason: string }[];
  };
