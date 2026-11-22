const IDENTIFIER_MAX_LENGTH = 256;

export interface DocumentUnlockTarget {
  readonly docId?: string;
  readonly docFileId?: string;
}

export type DocumentUnlockRequest =
  | {
      readonly action: "status";
      readonly target: DocumentUnlockTarget;
      readonly requestId?: string;
    }
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

export type DocumentUnlockKnownErrorCode =
  | "DOCUMENT_UNLOCK_REQUIRED"
  | "DOCUMENT_STATE_CHANGED"
  | "REQUEST_CONFLICT"
  | "CHECKPOINT_CHANGED"
  | "DOCUMENT_TARGET_UNAVAILABLE"
  | "UNKNOWN_SCOPE_UNPROVEN"
  | "NOT_AUTHORIZED"
  | "STORAGE_UNAVAILABLE"
  | "SDK_TURN_ACTIVE"
  | "SDK_QUIESCENCE_UNPROVEN";

export type DocumentUnlockPublicErrorCode =
  DocumentUnlockKnownErrorCode | "DOCUMENT_UNLOCK_ERROR";

export type DocumentUnlockScope = "document" | "runtime" | "global" | "unknown";
export type DocumentUnlockExecutionFence = "active" | "released" | "unknown";
export type DocumentUnlockCoverage =
  "document_identity" | "document_version" | "parameter_readback";

export type DocumentUnlockPublicBlocker =
  | {
      readonly visibility: "authorized_scope";
      readonly jobId?: string;
      readonly requestId?: string;
      readonly scope: DocumentUnlockScope;
      readonly executionFence: DocumentUnlockExecutionFence;
    }
  | { readonly visibility: "operator_only" };

export type DocumentUnlockPublicNext =
  | {
      readonly kind: "command";
      readonly action: DocumentUnlockRequest["action"];
      readonly requiredFreshRequestId: boolean;
      readonly mcp: {
        readonly name: "fmcad_document_unlock";
        readonly arguments: DocumentUnlockRequest;
      };
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

export interface DocumentUnlockPublicError {
  readonly error: {
    readonly code: DocumentUnlockPublicErrorCode;
    readonly message: string;
  };
  readonly requestId?: string;
  readonly executionOutcome?: "not_started";
  readonly userScriptSubmitted?: false;
  readonly target?: DocumentUnlockTarget;
  readonly blockers?: readonly DocumentUnlockPublicBlocker[];
  readonly next: DocumentUnlockPublicNext;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains an unexpected field`);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH
  )
    throw new Error(
      `${label} must contain 1..${IDENTIFIER_MAX_LENGTH} characters`,
    );
  return value;
}

function target(value: unknown): DocumentUnlockTarget {
  const input = object(value, "target");
  exactKeys(input, ["docId", "docFileId"], "target");
  const docId = Object.hasOwn(input, "docId")
    ? identifier(input["docId"], "target.docId")
    : undefined;
  const docFileId = Object.hasOwn(input, "docFileId")
    ? identifier(input["docFileId"], "target.docFileId")
    : undefined;
  if (docId === undefined && docFileId === undefined)
    throw new Error("target requires docId or docFileId");
  return {
    ...(docId === undefined ? {} : { docId }),
    ...(docFileId === undefined ? {} : { docFileId }),
  };
}

/** Decode the strict, broker-only document unlock control request. */
export function decodeDocumentUnlockRequest(
  value: unknown,
): DocumentUnlockRequest {
  const input = object(value, "document unlock request");
  exactKeys(
    input,
    ["action", "target", "requestId", "observationId"],
    "document unlock request",
  );
  const action = input["action"];
  if (action !== "status" && action !== "inspect" && action !== "accept")
    throw new Error("action must be status, inspect, or accept");
  const decodedTarget = target(input["target"]);
  Object.freeze(decodedTarget);
  const hasRequestId = Object.hasOwn(input, "requestId");
  const hasObservationId = Object.hasOwn(input, "observationId");

  if (action === "status") {
    if (hasObservationId)
      throw new Error("status does not accept observationId");
    return Object.freeze({
      action,
      target: decodedTarget,
      ...(hasRequestId
        ? { requestId: identifier(input["requestId"], "requestId") }
        : {}),
    });
  }
  if (!hasRequestId) throw new Error(`${action} requires requestId`);
  const requestId = identifier(input["requestId"], "requestId");
  if (action === "inspect") {
    if (hasObservationId)
      throw new Error("inspect does not accept observationId");
    return Object.freeze({ action, target: decodedTarget, requestId });
  }
  if (!hasObservationId) throw new Error("accept requires observationId");
  return Object.freeze({
    action,
    target: decodedTarget,
    requestId,
    observationId: identifier(input["observationId"], "observationId"),
  });
}

const SAFE_PUBLIC_ERROR_MESSAGES: Record<
  DocumentUnlockPublicErrorCode,
  string
> = {
  DOCUMENT_UNLOCK_REQUIRED:
    "The new operation was not executed because this document requires an explicit unlock.",
  DOCUMENT_STATE_CHANGED:
    "The document changed after it was observed. Check its current status before inspecting again.",
  REQUEST_CONFLICT:
    "This request ID is already bound to different content. Use a fresh request ID for any new request; do not retry the same ID with changed content.",
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
  DOCUMENT_UNLOCK_ERROR:
    "The document unlock operation failed. No private error details are available.",
};
export const DOCUMENT_UNLOCK_IPC_FAILURE_MESSAGE =
  SAFE_PUBLIC_ERROR_MESSAGES.DOCUMENT_UNLOCK_ERROR;

const SAFE_NEXT_INSTRUCTIONS = new Set([
  "Use a new request ID for this action.",
  "Continue normal work with a fresh operation request ID.",
  "Continue with a new operation request ID; the current checkpoint is scoped to this target and is not a geometry-validation result.",
  "Wait for the active SDK turn to finish, then check status again.",
  "Do not inspect or accept yet. Establish a runtime barrier proving the earlier SDK turn can no longer change the model, then check status.",
  "Read the exact current target with a fresh request ID; acceptance is a separate action.",
  "Review the shown readback, then explicitly accept it using a fresh request ID.",
  "The previous operation may have had wider effects. An operator must prove or narrow its scope (and establish a runtime barrier when needed) before a per-document read can be accepted.",
  "Resolve a separately verified target before continuing. This result does not prove deletion and cannot recover unsaved geometry.",
  "Check the original request's durable status before retrying. This result does not establish whether it ran.",
  "Obtain ordinary authorization for the exact document before retrying this control action.",
  "Repair or restore the canonical durable store. Do not clear it, replace it with an empty store, or retry an uncertain mutation.",
  "Prove the operation's scope before accepting a per-document read. Do not treat a document read as proof about a global operation.",
  "Resolve a separately verified target; this error does not prove deletion or recover unsaved geometry.",
  "Establish a runtime barrier proving the earlier SDK turn can no longer change the model before inspecting or accepting.",
  "Check the current status before choosing another action.",
  "Document unlock request failed before a safe public result was received. Check the original request's durable status before retrying.",
  "Check the original request's durable status only if authorized; do not replay it. Use a fresh request ID for genuinely new content.",
]);

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH
  );
}

function publicErrorNext(value: unknown): DocumentUnlockPublicNext {
  const input = object(value, "next");
  const instruction = input["instruction"];
  if (
    typeof instruction !== "string" ||
    !SAFE_NEXT_INSTRUCTIONS.has(instruction)
  )
    throw new Error("Invalid document unlock public error");
  if (input["kind"] === "command") {
    exactKeys(
      input,
      ["kind", "action", "requiredFreshRequestId", "mcp", "cli", "instruction"],
      "next",
    );
    const action = input["action"];
    if (action !== "status" && action !== "inspect" && action !== "accept")
      throw new Error("Invalid document unlock public error");
    const expectedFreshRequestId = action !== "status";
    if (input["requiredFreshRequestId"] !== expectedFreshRequestId)
      throw new Error("Invalid document unlock public error");
    const mcp = object(input["mcp"], "next.mcp");
    exactKeys(mcp, ["name", "arguments"], "next.mcp");
    if (mcp["name"] !== "fmcad_document_unlock")
      throw new Error("Invalid document unlock public error");
    const request = decodeDocumentUnlockRequest(mcp["arguments"]);
    if (request.action !== action)
      throw new Error("Invalid document unlock public error");
    const cli = object(input["cli"], "next.cli");
    exactKeys(cli, ["executable", "arguments"], "next.cli");
    if (cli["executable"] !== "fmcad" || !Array.isArray(cli["arguments"]))
      throw new Error("Invalid document unlock public error");
    const cliArguments = cli["arguments"];
    if (
      cliArguments.some(
        (argument) => typeof argument !== "string" || argument.length > 4096,
      )
    )
      throw new Error("Invalid document unlock public error");
    const expectedCliArguments = [
      "queue",
      "document-unlock",
      "--action",
      action,
      ...(request.target.docId === undefined
        ? []
        : [`--doc-id=${request.target.docId}`]),
      ...(request.target.docFileId === undefined
        ? []
        : [`--doc-file-id=${request.target.docFileId}`]),
      ...(request.action === "status"
        ? []
        : ["--request-id", request.requestId]),
      ...(request.action === "accept"
        ? ["--observation-id", request.observationId]
        : []),
    ];
    if (JSON.stringify(cliArguments) !== JSON.stringify(expectedCliArguments))
      throw new Error("Invalid document unlock public error");
    return Object.freeze({
      kind: "command",
      action,
      requiredFreshRequestId: expectedFreshRequestId,
      mcp: Object.freeze({
        name: "fmcad_document_unlock",
        arguments: request,
      }),
      cli: Object.freeze({
        executable: "fmcad",
        arguments: Object.freeze([...cliArguments]) as readonly string[],
      }),
      instruction,
    });
  }
  if (input["kind"] === "continue") {
    exactKeys(
      input,
      ["kind", "reason", "instruction", "geometryValidated"],
      "next",
    );
    if (
      (input["reason"] !== "no_unlock_required" &&
        input["reason"] !== "checkpoint_current") ||
      input["geometryValidated"] !== false
    )
      throw new Error("Invalid document unlock public error");
    return Object.freeze({
      kind: "continue",
      reason: input["reason"],
      instruction,
      geometryValidated: false,
    });
  }
  if (input["kind"] === "operator_action") {
    exactKeys(input, ["kind", "action", "instruction"], "next");
    const actions = [
      "establish_runtime_barrier",
      "prove_scope_and_barrier",
      "choose_verified_target",
      "obtain_document_authorization",
      "repair_canonical_store",
      "review_original_request_without_replay",
    ] as const;
    if (
      typeof input["action"] !== "string" ||
      !actions.includes(input["action"] as (typeof actions)[number])
    )
      throw new Error("Invalid document unlock public error");
    return Object.freeze({
      kind: "operator_action",
      action: input["action"] as (typeof actions)[number],
      instruction,
    });
  }
  throw new Error("Invalid document unlock public error");
}

function publicBlockers(
  value: unknown,
): readonly DocumentUnlockPublicBlocker[] {
  if (!Array.isArray(value))
    throw new Error("Invalid document unlock public error");
  return Object.freeze(
    value.map((item) => {
      const blocker = object(item, "blocker");
      if (blocker["visibility"] === "operator_only") {
        exactKeys(blocker, ["visibility"], "blocker");
        return Object.freeze({ visibility: "operator_only" as const });
      }
      exactKeys(
        blocker,
        ["visibility", "jobId", "requestId", "scope", "executionFence"],
        "blocker",
      );
      if (
        blocker["visibility"] !== "authorized_scope" ||
        (blocker["jobId"] !== undefined && !safeIdentifier(blocker["jobId"])) ||
        (blocker["requestId"] !== undefined &&
          !safeIdentifier(blocker["requestId"])) ||
        !["document", "runtime", "global", "unknown"].includes(
          String(blocker["scope"]),
        ) ||
        !["active", "released", "unknown"].includes(
          String(blocker["executionFence"]),
        )
      )
        throw new Error("Invalid document unlock public error");
      return Object.freeze({
        visibility: "authorized_scope" as const,
        ...(blocker["jobId"] === undefined ? {} : { jobId: blocker["jobId"] }),
        ...(blocker["requestId"] === undefined
          ? {}
          : { requestId: blocker["requestId"] }),
        scope: blocker["scope"] as DocumentUnlockScope,
        executionFence: blocker[
          "executionFence"
        ] as DocumentUnlockExecutionFence,
      });
    }),
  );
}

/**
 * Decode only the broker's safe public error DTO. Unknown response values are
 * not errors; malformed objects that claim to be errors are rejected.
 */
export function decodeDocumentUnlockPublicError(
  value: unknown,
): DocumentUnlockPublicError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Object.hasOwn(candidate, "error")) return undefined;
  try {
    exactKeys(
      candidate,
      [
        "error",
        "requestId",
        "executionOutcome",
        "userScriptSubmitted",
        "target",
        "blockers",
        "next",
      ],
      "document unlock public error",
    );
    const error = object(candidate["error"], "error");
    exactKeys(error, ["code", "message"], "error");
    const codes = Object.keys(SAFE_PUBLIC_ERROR_MESSAGES);
    if (
      typeof error["code"] !== "string" ||
      !codes.includes(error["code"]) ||
      error["message"] !==
        SAFE_PUBLIC_ERROR_MESSAGES[
          error["code"] as DocumentUnlockPublicErrorCode
        ]
    )
      throw new Error("Invalid document unlock public error");
    const code = error["code"] as DocumentUnlockPublicErrorCode;
    const requestId = candidate["requestId"];
    if (
      requestId !== undefined &&
      (code !== "DOCUMENT_UNLOCK_REQUIRED" || !safeIdentifier(requestId))
    )
      throw new Error("Invalid document unlock public error");
    const notStarted = candidate["executionOutcome"] !== undefined;
    if (
      notStarted !== (code === "DOCUMENT_UNLOCK_REQUIRED") ||
      (notStarted && candidate["executionOutcome"] !== "not_started") ||
      (candidate["userScriptSubmitted"] !== undefined &&
        candidate["userScriptSubmitted"] !== false) ||
      (notStarted && candidate["userScriptSubmitted"] !== false)
    )
      throw new Error("Invalid document unlock public error");
    let decodedTarget: DocumentUnlockTarget | undefined;
    if (candidate["target"] !== undefined) {
      if (
        code === "DOCUMENT_UNLOCK_ERROR" ||
        code === "NOT_AUTHORIZED" ||
        code === "REQUEST_CONFLICT"
      )
        throw new Error("Invalid document unlock public error");
      decodedTarget = target(candidate["target"]);
      Object.freeze(decodedTarget);
    }
    const blockers =
      candidate["blockers"] === undefined
        ? undefined
        : publicBlockers(candidate["blockers"]);
    if (blockers !== undefined && decodedTarget === undefined)
      throw new Error("Invalid document unlock public error");
    return Object.freeze({
      error: Object.freeze({ code, message: error["message"] as string }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(notStarted
        ? {
            executionOutcome: "not_started" as const,
            userScriptSubmitted: false as const,
          }
        : {}),
      ...(decodedTarget === undefined ? {} : { target: decodedTarget }),
      ...(blockers === undefined ? {} : { blockers }),
      next: publicErrorNext(candidate["next"]),
    });
  } catch {
    throw new Error("Invalid document unlock public error");
  }
}

/** A bounded result for an unexpected IPC failure; it makes no run claim. */
export function documentUnlockIpcFailure(): DocumentUnlockPublicError {
  return Object.freeze({
    error: Object.freeze({
      code: "DOCUMENT_UNLOCK_ERROR",
      message: SAFE_PUBLIC_ERROR_MESSAGES.DOCUMENT_UNLOCK_ERROR,
    }),
    next: Object.freeze({
      kind: "operator_action",
      action: "review_original_request_without_replay",
      instruction:
        "Document unlock request failed before a safe public result was received. Check the original request's durable status before retrying.",
    }),
  });
}
