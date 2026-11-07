import {
  id,
  type ClientId,
  type DocumentId,
  type ProjectId,
  type RequestId,
  type SessionId,
  type ValidationEvidence,
} from "../domain/contracts";

export type McpRequestState =
  | "rejected-before-admission"
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_reconciliation";

export interface McpExecutionContext {
  readonly clientId: ClientId;
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly projectDirectory: string | null;
  readonly projectId: ProjectId | null;
  readonly doc: string | null;
  readonly docId: DocumentId | null;
  readonly docFileId: DocumentId | null;
  readonly purpose: string | null;
  readonly expectedRevision: number | null;
}

export interface McpExecutionContextInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly projectDirectory?: string | null;
  readonly projectId?: string | null;
  readonly doc?: string | null;
  readonly docId?: string | null;
  readonly docFileId?: string | null;
  readonly purpose?: string | null;
  readonly expectedRevision?: number | null;
}

export interface McpRequestResult<T = unknown> {
  readonly status: McpRequestState;
  readonly requestId: RequestId;
  readonly jobId: string | null;
  readonly context: McpExecutionContext;
  readonly validation: McpValidationResult | null;
  readonly result: T | null;
}

export type McpValidationResult =
  | ValidationEvidence
  | { readonly status: "required"; readonly diagnostics: readonly string[] };

export function createMcpExecutionContext(
  input: McpExecutionContextInput,
): McpExecutionContext {
  const text = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return null;
    if (!value.trim() || value.length > 4096)
      throw new Error(`${key} must contain 1..4096 characters`);
    return value;
  };
  const doc = text("doc", input.doc);
  const docId = text("docId", input.docId);
  const docFileId = text("docFileId", input.docFileId);
  if ((docId || docFileId) && !doc)
    throw new Error("Document identity pins require doc");
  const purpose = text("purpose", input.purpose);
  if (
    purpose !== null &&
    (Array.from(purpose).length > 1000 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(purpose))
  )
    throw new Error(
      "purpose must contain at most 1000 characters without controls",
    );
  const expectedRevision = input.expectedRevision ?? null;
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  )
    throw new Error("expectedRevision must be a nonnegative safe integer");
  const projectDirectory = text("projectDirectory", input.projectDirectory);
  if (
    projectDirectory !== null &&
    !(
      projectDirectory.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(projectDirectory) ||
      projectDirectory.startsWith("\\\\")
    )
  )
    throw new Error("projectDirectory must be absolute");
  return Object.freeze({
    clientId: id("client", input.clientId),
    sessionId: id("session", input.sessionId),
    requestId: id("request", input.requestId),
    projectDirectory,
    projectId: input.projectId ? id("project", input.projectId) : null,
    doc,
    docId: docId ? id("document", docId) : null,
    docFileId: docFileId ? id("document", docFileId) : null,
    purpose,
    expectedRevision,
  });
}

export function mcpRequestState(state: unknown): McpRequestState {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
    case "sending":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "cancelled":
    case "expired":
      return "failed";
    case "needs_reconciliation":
      return "needs_reconciliation";
    case "preparing":
    case "processing":
      return "accepted";
    default:
      return "needs_reconciliation";
  }
}
