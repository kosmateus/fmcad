/** Adapters own credentials, paths, handles, and host objects. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
declare const identity: unique symbol;
export type Id<K extends string> = string & { readonly [identity]: K };
export type ClientId = Id<"client">;
export type SessionId = Id<"session">;
export type RequestId = Id<"request">;
export type JobId = Id<"job">;
export type ProjectId = Id<"project">;
export type DocumentId = Id<"document">;
export type InstanceId = Id<"instance">;
export type ArtifactId = Id<"artifact">;
export function id<K extends string>(kind: K, value: string): Id<K> {
  if (
    !kind ||
    !value.trim() ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error("Invalid identity");
  return value as Id<K>;
}
export const CONTRACT_VERSION = 1;
export const PROTOCOL_VERSIONS = {
  request: 1,
  result: 1,
  event: 1,
  persistedQueue: 1,
  receipt: 0, // Existing remote receipts are explicitly unversioned.
} as const;
export interface RequestContext {
  readonly version: 1;
  readonly clientId: ClientId;
  readonly requestId: RequestId;
  readonly sessionId: SessionId | null;
  readonly projectId: ProjectId | null;
  readonly documentId: DocumentId | null;
  readonly instanceId: InstanceId | null;
  readonly purpose: string | null;
}
export type Acceptance = "accepted" | "rejected" | "unknown";
export type ExecutionOutcome =
  "not_started" | "active" | "partial" | "succeeded" | "failed" | "unknown";
export type EvidenceStatus =
  | "pass"
  | "fail"
  | "partial"
  | "unknown"
  | "unsupported"
  | "missing"
  | "stale"
  | "blocked";
export type ValidationStatus = "not_checked" | EvidenceStatus | "unavailable";
export interface GeometryQuantity {
  readonly value: number | null;
  readonly unit:
    | "mm"
    | "cm"
    | "m"
    | "mm2"
    | "cm2"
    | "m2"
    | "mm3"
    | "cm3"
    | "m3"
    | "rad"
    | "deg"
    | "unitless";
}
export interface ValidationEvidence {
  readonly status: ValidationStatus;
  readonly source: string | null;
  readonly artifactId: ArtifactId | null;
  readonly measurements: Readonly<Record<string, GeometryQuantity>>;
}
export interface OperationResult {
  readonly version: 1;
  readonly requestId: RequestId | null;
  readonly jobId: JobId | null;
  readonly acceptance: Acceptance;
  readonly executionOutcome: ExecutionOutcome;
  /** null means unknown, never proof that no mutation occurred. */
  readonly mayHaveMutated: boolean | null;
  readonly validation: ValidationEvidence;
  readonly code: string | null;
}
export interface OperationRequest {
  readonly context: RequestContext;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export interface DomainEvent {
  readonly version: 1;
  readonly context: RequestContext;
  readonly jobId: JobId | null;
  readonly atMs: number;
  readonly name: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}
