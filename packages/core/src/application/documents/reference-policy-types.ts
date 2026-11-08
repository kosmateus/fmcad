import type { ReferenceInput } from "./references";
export interface ReferencePin {
  edgeId: string;
  sourceFileId: string;
  version: number;
}
export interface ReferenceBinding {
  edgeId: string;
  sourceParameter: string;
  consumerAlias?: string;
  nativeDerivedParameter?: string;
}
interface LeaseTarget extends Record<string, unknown> {
  fileId: string;
  name: string;
  creationId?: string;
  commandId?: unknown;
}
interface UiLease extends Record<string, unknown> {
  target: LeaseTarget;
  lease: {
    requestId: string;
    id: string;
    operationId: string;
    expiresAt: number;
    target: LeaseTarget;
  };
}
export interface ReferencePolicyInput extends ReferenceInput {
  schemaVersion: number;
  policy: string;
  lifecycle: string;
  nativeFallback: string;
  durability: string;
  confirm?: unknown;
  maxFiles: number;
  maxUpdates: number;
  timeBudgetMs: number;
  allowedProjectIds: string[];
  pins: ReferencePin[];
  parameterBindings: ReferenceBinding[];
  callerNamespaces: Record<string, unknown>;
  uiLeases?: Record<string, UiLease>;
}
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0;
export const boundedInteger = (
  value: unknown,
  min: number,
  max: number,
): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

export interface ReferenceParameter extends Record<string, unknown> {
  name: string;
  expression?: unknown;
  internal_value?: unknown;
  internal_unit?: unknown;
  dependsOn?: string[];
}
export interface PolicyDocument extends Record<string, unknown> {
  fileId: string;
  projectId: string;
  version: number;
  latestVersion?: number;
  parameters?: ReferenceParameter[];
  health?: { healthy?: boolean; repairRequired?: boolean };
  history?: { healthy?: boolean; repairRequired?: boolean };
  referenceCycle?: boolean;
  repairRequired?: boolean;
  consumedBodiesVerified?: boolean;
  historySnapshotSupported?: boolean;
  available?: boolean;
  dirty?: boolean;
  modified?: boolean;
  isComplete?: boolean;
  readOnly?: boolean;
  timelineAtEnd?: boolean;
  pendingSnapshot?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  creationId?: unknown;
}
export interface BindingCoverage {
  complete: boolean;
  expected: string[];
  mapped: {
    sourceParameter: string;
    nativeDerivedParameter: string;
    consumerAlias: string | null;
  }[];
  valuesMatch: boolean | null;
  valueMismatches: Record<string, unknown>[];
}
export interface PolicyEdge extends Record<string, unknown> {
  edgeId: string;
  ownerFileId: string;
  sourceFileId: string;
  kind: string;
  ownerProjectId?: string;
  sourceProjectId?: string | null;
  edgeIdentityUnique?: boolean;
  baselineVersion: number;
  latestVersion: number;
  sourceLatestVersion?: number;
  targetVersion: number | null;
  targetVersionSource?: string | null;
  status: string;
  selfReference?: boolean;
  getterError?: unknown;
  versionSource?: string;
  derivedParameters?: ReferenceParameter[];
  sourceParameters?: ReferenceParameter[];
  bindingCoverage?: BindingCoverage;
  bindingValuesMatch?: boolean | null;
  bindingValueMismatch?: boolean;
  blockedReason?: string;
  explicitPin?: boolean;
  sourceAvailable?: boolean;
  projectAllowed?: boolean;
  isOccurrenceReference?: boolean;
  bindingReadError?: unknown;
  sourceParameterVersion?: number;
  sourceParameterFileId?: string;
  sourceDocumentModified?: boolean;
}
export interface PolicySnapshot extends Record<string, unknown> {
  documents: PolicyDocument[];
  edges: PolicyEdge[];
  graphComplete?: boolean;
  getterErrors?: unknown[];
  lifecycleEffects?: unknown[];
  coverage?: unknown;
  environment?: Record<string, unknown>;
  document?: PolicyDocument;
  status?: unknown;
  reason?: unknown;
  error?: unknown;
  identity?: unknown;
}
