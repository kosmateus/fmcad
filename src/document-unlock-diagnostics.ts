const IDENTIFIER_MAX_LENGTH = 256;
const FRESH_REQUEST_ID_PLACEHOLDER = "REPLACE_WITH_FRESH_REQUEST_ID";

export type DocumentUnlockState =
  | "clear"
  | "execution_unfenced"
  | "inspection_required"
  | "checkpoint_current"
  | "scope_unproven"
  | "target_unavailable";

export type DocumentUnlockScope = "document" | "runtime" | "global" | "unknown";
export type DocumentUnlockExecutionFence = "active" | "released" | "unknown";
export type DocumentUnlockCoverage =
  "document_identity" | "document_version" | "parameter_readback";

export type DocumentUnlockTarget =
  | { readonly docId: string; readonly docFileId?: string }
  | { readonly docId?: string; readonly docFileId: string };

export interface DocumentUnlockResolvedBlocker {
  readonly jobId?: string;
  readonly requestId?: string;
  readonly scope: DocumentUnlockScope;
  readonly executionFence: DocumentUnlockExecutionFence;
}

export interface DocumentUnlockCurrentObservation {
  /** An observation freshly verified by the controller for this exact target. */
  readonly observationId: string;
  readonly coverage: readonly DocumentUnlockCoverage[];
  /** Only the authenticated original readback for this exact observation. */
  readonly observed?: ParamCheckpointGuardV1;
  readonly stateDigest?: string;
}

/**
 * Server-side facts resolved by the controller. Never construct this object
 * from the public request: the serializer does not perform authorization.
 */
export interface DocumentUnlockServerResolution {
  /** Include only after resolving and authorizing this exact target. */
  readonly target?: DocumentUnlockTarget;
  readonly state?: DocumentUnlockState;
  /** Already filtered to blockers visible in this actor's authorized scope. */
  readonly disclosableBlockers?: readonly DocumentUnlockResolvedBlocker[];
  /** Represents one or more hidden blockers, without identifying them. */
  readonly hasOperatorOnlyBlocker?: boolean;
  /** Fence for this exact target, when the actor may see it. */
  readonly executionFence?: DocumentUnlockExecutionFence;
  /** Include only a current observation for this exact target. */
  readonly currentObservation?: DocumentUnlockCurrentObservation;
}

export type DocumentUnlockMcpRequest =
  | { readonly action: "status"; readonly target: DocumentUnlockTarget }
  | {
      readonly action: "inspect";
      readonly target: DocumentUnlockTarget;
      readonly requestId: string;
    }
  | {
      readonly action: "accept";
      readonly target: DocumentUnlockTarget;
      readonly requestId: string;
      readonly observationId: string;
    };

export type DocumentUnlockNext =
  | {
      readonly kind: "command";
      readonly action: DocumentUnlockMcpRequest["action"];
      readonly requiredFreshRequestId: boolean;
      readonly mcp: {
        readonly name: "fmcad_document_unlock";
        readonly arguments: DocumentUnlockMcpRequest;
      };
      /** CLI args stay separate; callers must not join them into a shell line. */
      readonly cli: {
        readonly executable: "fmcad";
        readonly arguments: readonly string[];
      };
      readonly instruction: string;
    }
  | {
      readonly kind: "continue";
      readonly reason: "no_unlock_required" | "checkpoint_current";
      readonly instruction: string;
      readonly geometryValidated: false;
    }
  | {
      readonly kind: "operator_action";
      readonly action:
        | "establish_runtime_barrier"
        | "prove_scope_and_barrier"
        | "choose_verified_target"
        | "obtain_document_authorization"
        | "repair_canonical_store"
        | "review_original_request_without_replay";
      readonly instruction: string;
    };

export interface DocumentUnlockPublicBlocker {
  readonly visibility: "authorized_scope";
  readonly jobId?: string;
  readonly requestId?: string;
  readonly scope: DocumentUnlockScope;
  readonly executionFence: DocumentUnlockExecutionFence;
}

export interface DocumentUnlockOperatorOnlyBlocker {
  readonly visibility: "operator_only";
}

export interface DocumentUnlockPublicObservation {
  readonly observationId: string;
  readonly coverage: readonly DocumentUnlockCoverage[];
  readonly geometryValidated: false;
}

export interface DocumentUnlockPublicStatus {
  readonly state: DocumentUnlockState;
  readonly target?: DocumentUnlockTarget;
  readonly blockers: readonly (
    DocumentUnlockPublicBlocker | DocumentUnlockOperatorOnlyBlocker
  )[];
  readonly executionFence?: DocumentUnlockExecutionFence;
  readonly observation?: DocumentUnlockPublicObservation;
  readonly observed?: ParamCheckpointGuardV1;
  readonly next: DocumentUnlockNext;
}

export type DocumentUnlockKnownErrorCode =
  | "DOCUMENT_UNLOCK_REQUIRED"
  | "DOCUMENT_STATE_CHANGED"
  | "CHECKPOINT_CHANGED"
  | "DOCUMENT_TARGET_UNAVAILABLE"
  | "UNKNOWN_SCOPE_UNPROVEN"
  | "NOT_AUTHORIZED"
  | "STORAGE_UNAVAILABLE"
  | "SDK_TURN_ACTIVE"
  | "SDK_QUIESCENCE_UNPROVEN"
  | "REQUEST_CONFLICT";

export interface DocumentUnlockErrorResolution extends DocumentUnlockServerResolution {
  /** A code only; raw Error, message, stack, cause and details are not inputs. */
  readonly code: string;
  /** The rejected current request ID, never a predecessor/blocker ID. */
  readonly currentRequestId?: string;
}

export interface DocumentUnlockPublicError {
  readonly error: {
    readonly code: DocumentUnlockKnownErrorCode | "DOCUMENT_UNLOCK_ERROR";
    readonly message: string;
  };
  readonly requestId?: string;
  readonly executionOutcome?: "not_started";
  readonly userScriptSubmitted?: false;
  readonly target?: DocumentUnlockTarget;
  readonly blockers?: readonly (
    DocumentUnlockPublicBlocker | DocumentUnlockOperatorOnlyBlocker
  )[];
  readonly next: DocumentUnlockNext;
}

const SAFE_ERROR_MESSAGES: Record<DocumentUnlockKnownErrorCode, string> = {
  DOCUMENT_UNLOCK_REQUIRED:
    "The new operation was not executed because this document requires an explicit unlock.",
  DOCUMENT_STATE_CHANGED:
    "The document changed after it was observed. Check its current status before inspecting again.",
  CHECKPOINT_CHANGED:
    "The accepted checkpoint is no longer current. Check the document status before continuing.",
  DOCUMENT_TARGET_UNAVAILABLE:
    "The exact document target is unavailable. This does not prove that it was deleted.",
  UNKNOWN_SCOPE_UNPROVEN:
    "The earlier operation's scope is not proven. A document read cannot unlock an unbounded operation.",
  NOT_AUTHORIZED:
    "The current actor is not authorized for this document operation.",
  STORAGE_UNAVAILABLE:
    "The durable unlock record is unavailable. Do not clear or replace the canonical store.",
  SDK_TURN_ACTIVE: "A Fusion SDK turn is still active for this scope.",
  SDK_QUIESCENCE_UNPROVEN:
    "It is not proven that the earlier Fusion SDK turn can no longer change the model.",
  REQUEST_CONFLICT:
    "This request ID is already bound to different content. Use a fresh request ID for any new request; do not retry the same ID with changed content.",
};

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH
  );
}

function copyTarget(
  target: DocumentUnlockTarget | undefined,
): DocumentUnlockTarget {
  if (!target) throw new Error("A resolved document target is required.");
  const docId = target.docId;
  const docFileId = target.docFileId;
  if (docId !== undefined && !validIdentifier(docId))
    throw new Error("The resolved document target is invalid.");
  if (docFileId !== undefined && !validIdentifier(docFileId))
    throw new Error("The resolved document target is invalid.");
  if (docId === undefined && docFileId === undefined)
    throw new Error("The resolved document target is invalid.");
  if (docId !== undefined && docFileId !== undefined)
    return { docId, docFileId };
  if (docId !== undefined) return { docId };
  if (docFileId !== undefined) return { docFileId };
  throw new Error("The resolved document target is invalid.");
}

function safeScope(scope: unknown): DocumentUnlockScope {
  switch (scope) {
    case "document":
    case "runtime":
    case "global":
    case "unknown":
      return scope;
    default:
      return "unknown";
  }
}

function safeFence(fence: unknown): DocumentUnlockExecutionFence | undefined {
  switch (fence) {
    case "active":
    case "released":
    case "unknown":
      return fence;
    default:
      return undefined;
  }
}

function safeState(state: unknown): DocumentUnlockState {
  switch (state) {
    case "clear":
    case "execution_unfenced":
    case "inspection_required":
    case "checkpoint_current":
    case "scope_unproven":
    case "target_unavailable":
      return state;
    default:
      return "scope_unproven";
  }
}

function safeBlockers(
  resolution: DocumentUnlockServerResolution,
): (DocumentUnlockPublicBlocker | DocumentUnlockOperatorOnlyBlocker)[] {
  const blockers: (
    DocumentUnlockPublicBlocker | DocumentUnlockOperatorOnlyBlocker
  )[] = (resolution.disclosableBlockers ?? []).map((blocker) => {
    const jobId = validIdentifier(blocker.jobId) ? blocker.jobId : undefined;
    const requestId = validIdentifier(blocker.requestId)
      ? blocker.requestId
      : undefined;
    return {
      visibility: "authorized_scope",
      ...(jobId === undefined ? {} : { jobId }),
      ...(requestId === undefined ? {} : { requestId }),
      scope: safeScope(blocker.scope),
      executionFence: safeFence(blocker.executionFence) ?? "unknown",
    };
  });
  if (resolution.hasOperatorOnlyBlocker === true)
    blockers.push({ visibility: "operator_only" });
  return blockers;
}

function publicObservation(
  observation: DocumentUnlockCurrentObservation | undefined,
): DocumentUnlockPublicObservation | undefined {
  if (!observation || !validIdentifier(observation.observationId))
    return undefined;
  const allowed = new Set<DocumentUnlockCoverage>([
    "document_identity",
    "document_version",
    "parameter_readback",
  ]);
  const coverage = [
    ...new Set(observation.coverage.filter((item) => allowed.has(item))),
  ];
  return {
    observationId: observation.observationId,
    coverage,
    geometryValidated: false,
  };
}

function commandNext(
  action: DocumentUnlockMcpRequest["action"],
  target: DocumentUnlockTarget,
  observationId?: string,
  instruction = "Use a new request ID for this action.",
): DocumentUnlockNext {
  const requiredFreshRequestId = action !== "status";
  let mcpArguments: DocumentUnlockMcpRequest;
  switch (action) {
    case "status":
      mcpArguments = { action, target };
      break;
    case "inspect":
      mcpArguments = {
        action,
        target,
        requestId: FRESH_REQUEST_ID_PLACEHOLDER,
      };
      break;
    case "accept":
      if (!validIdentifier(observationId))
        throw new Error("A current observation is required for accept.");
      mcpArguments = {
        action,
        target,
        requestId: FRESH_REQUEST_ID_PLACEHOLDER,
        observationId,
      };
      break;
  }
  const cliArguments = [
    "queue",
    "document-unlock",
    "--action",
    action,
    ...(target.docId === undefined ? [] : [`--doc-id=${target.docId}`]),
    ...(target.docFileId === undefined
      ? []
      : [`--doc-file-id=${target.docFileId}`]),
    ...(requiredFreshRequestId
      ? ["--request-id", FRESH_REQUEST_ID_PLACEHOLDER]
      : []),
  ];
  if (mcpArguments.action === "accept")
    cliArguments.push("--observation-id", mcpArguments.observationId);
  return {
    kind: "command",
    action,
    requiredFreshRequestId,
    mcp: { name: "fmcad_document_unlock", arguments: mcpArguments },
    cli: { executable: "fmcad", arguments: cliArguments },
    instruction,
  };
}

function operatorNext(
  action: Extract<DocumentUnlockNext, { kind: "operator_action" }>["action"],
  instruction: string,
): DocumentUnlockNext {
  return { kind: "operator_action", action, instruction };
}

function resolvedState(resolution: DocumentUnlockServerResolution): {
  state: DocumentUnlockState;
  fence: DocumentUnlockExecutionFence;
  target: DocumentUnlockTarget | undefined;
} {
  const target = resolution.target ? copyTarget(resolution.target) : undefined;
  const suppliedFence = safeFence(resolution.executionFence);
  const blockerFences = (resolution.disclosableBlockers ?? []).map(
    (blocker) => safeFence(blocker.executionFence) ?? "unknown",
  );
  const fence =
    suppliedFence === "active" || blockerFences.includes("active")
      ? "active"
      : suppliedFence === "released" &&
          blockerFences.every((blockerFence) => blockerFence === "released")
        ? "released"
        : "unknown";
  let state = safeState(resolution.state);

  if (resolution.hasOperatorOnlyBlocker === true || state === "scope_unproven")
    state = "scope_unproven";
  else if (
    state !== "target_unavailable" &&
    (state === "execution_unfenced" || fence !== "released")
  )
    state = "execution_unfenced";

  return { state, fence, target };
}

function nextForState(
  state: DocumentUnlockState,
  target: DocumentUnlockTarget,
  fence: DocumentUnlockExecutionFence | undefined,
  observation: DocumentUnlockPublicObservation | undefined,
): DocumentUnlockNext {
  switch (state) {
    case "clear":
      return {
        kind: "continue",
        reason: "no_unlock_required",
        instruction: "Continue normal work with a fresh operation request ID.",
        geometryValidated: false,
      };
    case "execution_unfenced":
      if (fence === "active")
        return commandNext(
          "status",
          target,
          undefined,
          "Wait for the active SDK turn to finish, then check status again.",
        );
      return operatorNext(
        "establish_runtime_barrier",
        "Do not inspect or accept yet. Establish a runtime barrier proving the earlier SDK turn can no longer change the model, then check status.",
      );
    case "inspection_required":
      return observation
        ? commandNext(
            "accept",
            target,
            observation.observationId,
            "Review the shown readback, then explicitly accept it using a fresh request ID.",
          )
        : commandNext(
            "inspect",
            target,
            undefined,
            "Read the exact current target with a fresh request ID; acceptance is a separate action.",
          );
    case "checkpoint_current":
      return {
        kind: "continue",
        reason: "checkpoint_current",
        instruction:
          "Continue with a new operation request ID; the current checkpoint is scoped to this target and is not a geometry-validation result.",
        geometryValidated: false,
      };
    case "scope_unproven":
      return operatorNext(
        "prove_scope_and_barrier",
        "The previous operation may have had wider effects. An operator must prove or narrow its scope (and establish a runtime barrier when needed) before a per-document read can be accepted.",
      );
    case "target_unavailable":
      return operatorNext(
        "choose_verified_target",
        "Resolve a separately verified target before continuing. This result does not prove deletion and cannot recover unsaved geometry.",
      );
  }
}

/** Whitelist a controller-resolved status without invoking the SDK. */
export function serializeDocumentUnlockStatus(
  resolution: DocumentUnlockServerResolution & {
    readonly target: DocumentUnlockTarget;
    readonly state: DocumentUnlockState;
  },
): DocumentUnlockPublicStatus {
  const { state, fence, target } = resolvedState(resolution);
  if (!target) throw new Error("A resolved document target is required.");
  let observed: ParamCheckpointGuardV1 | undefined;
  const supplied = resolution.currentObservation;
  if (state === "inspection_required" && supplied?.observed !== undefined) {
    try {
      if (!target.docId) throw new Error("Resolved identity required");
      const decoded = decodeDocumentCheckpointReadback(supplied.observed, {
        creationId: target.docId,
        ...(target.docFileId === undefined ? {} : { fileId: target.docFileId }),
      });
      if (canonicalHash(decoded) !== supplied.stateDigest)
        throw new Error("Original observed state changed");
      observed = decoded;
    } catch {
      // Invalid facts must never disclose an unverified parameter snapshot or
      // advertise it as an observation ready to accept.
    }
  }
  const observation =
    state === "inspection_required" &&
    (supplied?.observed === undefined || observed !== undefined)
      ? publicObservation(resolution.currentObservation)
      : undefined;
  const blockers = safeBlockers(resolution);
  const outputFence =
    state === "execution_unfenced"
      ? fence === "active"
        ? "active"
        : "unknown"
      : state === "scope_unproven" || resolution.hasOperatorOnlyBlocker === true
        ? undefined
        : fence;
  return {
    state,
    target,
    blockers,
    ...(outputFence === undefined ? {} : { executionFence: outputFence }),
    ...(observation === undefined ? {} : { observation }),
    ...(observed === undefined ? {} : { observed }),
    next: nextForState(state, target, fence, observation),
  };
}

function knownErrorCode(
  value: string,
): DocumentUnlockKnownErrorCode | undefined {
  return typeof value === "string" && Object.hasOwn(SAFE_ERROR_MESSAGES, value)
    ? (value as DocumentUnlockKnownErrorCode)
    : undefined;
}

function nextForError(
  code: DocumentUnlockKnownErrorCode | undefined,
  resolution: DocumentUnlockErrorResolution,
  target: DocumentUnlockTarget | undefined,
): DocumentUnlockNext {
  if (code === undefined)
    return operatorNext(
      "review_original_request_without_replay",
      "Check the original request's durable status before retrying. This result does not establish whether it ran.",
    );
  if (code === "NOT_AUTHORIZED")
    return operatorNext(
      "obtain_document_authorization",
      "Obtain ordinary authorization for the exact document before retrying this control action.",
    );
  if (code === "STORAGE_UNAVAILABLE")
    return operatorNext(
      "repair_canonical_store",
      "Repair or restore the canonical durable store. Do not clear it, replace it with an empty store, or retry an uncertain mutation.",
    );
  if (code === "REQUEST_CONFLICT")
    return operatorNext(
      "review_original_request_without_replay",
      "Check the original request's durable status before retrying. This result does not establish whether it ran.",
    );
  const state = resolution.state ? safeState(resolution.state) : undefined;
  const fence = safeFence(resolution.executionFence);
  if (
    resolution.hasOperatorOnlyBlocker === true ||
    code === "UNKNOWN_SCOPE_UNPROVEN"
  )
    return operatorNext(
      "prove_scope_and_barrier",
      "Prove the operation's scope before accepting a per-document read. Do not treat a document read as proof about a global operation.",
    );
  if (code === "SDK_TURN_ACTIVE" && target)
    return commandNext(
      "status",
      target,
      undefined,
      "Wait for the active SDK turn to finish, then check status again.",
    );
  if (code === "DOCUMENT_TARGET_UNAVAILABLE")
    return operatorNext(
      "choose_verified_target",
      "Resolve a separately verified target; this error does not prove deletion or recover unsaved geometry.",
    );
  if (
    code === "SDK_QUIESCENCE_UNPROVEN" ||
    (state === "execution_unfenced" && fence !== "active")
  )
    return operatorNext(
      "establish_runtime_barrier",
      "Establish a runtime barrier proving the earlier SDK turn can no longer change the model before inspecting or accepting.",
    );
  if (!target)
    return operatorNext(
      "review_original_request_without_replay",
      "Check the original request's durable status before retrying. This result does not establish whether it ran.",
    );
  if (fence === "active")
    return commandNext(
      "status",
      target,
      undefined,
      "Wait for the active SDK turn to finish, then check status again.",
    );
  return commandNext(
    "status",
    target,
    undefined,
    "Check the current status before choosing another action.",
  );
}

/** Map known errors to static public text; never serialize a Throwable. */
export function serializeDocumentUnlockError(
  resolution: DocumentUnlockErrorResolution,
): DocumentUnlockPublicError {
  const code = knownErrorCode(resolution.code);
  const target =
    code === undefined ||
    code === "NOT_AUTHORIZED" ||
    code === "REQUEST_CONFLICT" ||
    !resolution.target
      ? undefined
      : copyTarget(resolution.target);
  const blockers = target === undefined ? undefined : safeBlockers(resolution);
  const publicCode = code ?? "DOCUMENT_UNLOCK_ERROR";
  const requestId =
    code === "DOCUMENT_UNLOCK_REQUIRED" &&
    target !== undefined &&
    validIdentifier(resolution.currentRequestId)
      ? resolution.currentRequestId
      : undefined;
  const isNotStarted = code === "DOCUMENT_UNLOCK_REQUIRED";
  return {
    error: {
      code: publicCode,
      message:
        code === undefined
          ? "The document unlock operation failed. No private error details are available."
          : SAFE_ERROR_MESSAGES[code],
    },
    ...(requestId === undefined ? {} : { requestId }),
    ...(isNotStarted
      ? {
          executionOutcome: "not_started" as const,
          userScriptSubmitted: false as const,
        }
      : {}),
    ...(target === undefined ? {} : { target }),
    ...(blockers === undefined ? {} : { blockers }),
    next: nextForError(code, resolution, target),
  };
}
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script";
import { hash as canonicalHash } from "../packages/core/src/application/cad/json";
import { decodeDocumentCheckpointReadback } from "./document-checkpoint-readback";
