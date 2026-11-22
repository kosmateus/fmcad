import assert from "node:assert/strict";
import test from "node:test";

import {
  serializeDocumentUnlockError,
  serializeDocumentUnlockStatus,
  type DocumentUnlockErrorResolution,
  type DocumentUnlockResolvedBlocker,
  type DocumentUnlockServerResolution,
  type DocumentUnlockState,
} from "../src/document-unlock-diagnostics.js";

const target = { docId: "creation-1", docFileId: "file-1" } as const;

function status(
  state: DocumentUnlockState,
  extra: Partial<DocumentUnlockServerResolution> = {},
) {
  return serializeDocumentUnlockStatus({ state, target, ...extra });
}

test("status next covers each state without treating a checkpoint as geometry proof", () => {
  assert.deepEqual(status("clear", { executionFence: "released" }).next, {
    kind: "continue",
    reason: "no_unlock_required",
    instruction: "Continue normal work with a fresh operation request ID.",
    geometryValidated: false,
  });

  const active = status("execution_unfenced", { executionFence: "active" });
  assert.equal(active.state, "execution_unfenced");
  assert.equal(active.executionFence, "active");
  assert.equal(active.next.kind, "command");
  if (active.next.kind === "command") {
    assert.equal(active.next.action, "status");
    assert.equal(active.next.requiredFreshRequestId, false);
    assert.deepEqual(active.next.mcp.arguments, {
      action: "status",
      target,
    });
  }

  const unknownFence = status("clear", { executionFence: "unknown" });
  assert.equal(unknownFence.state, "execution_unfenced");
  assert.equal(
    unknownFence.next.kind === "operator_action" && unknownFence.next.action,
    "establish_runtime_barrier",
  );
  const missingFence = status("clear");
  assert.equal(missingFence.state, "execution_unfenced");
  assert.equal(missingFence.executionFence, "unknown");
  const inspectRequired = status("inspection_required", {
    executionFence: "released",
  });
  assert.equal(
    inspectRequired.next.kind === "command" && inspectRequired.next.action,
    "inspect",
  );

  const currentObservation = status("inspection_required", {
    executionFence: "released",
    currentObservation: {
      observationId: "observation-current",
      coverage: ["document_identity", "document_version", "parameter_readback"],
    },
  });
  assert.deepEqual(currentObservation.observation, {
    observationId: "observation-current",
    coverage: ["document_identity", "document_version", "parameter_readback"],
    geometryValidated: false,
  });
  assert.equal(currentObservation.next.kind, "command");
  if (currentObservation.next.kind === "command") {
    assert.equal(currentObservation.next.action, "accept");
    assert.equal(currentObservation.next.requiredFreshRequestId, true);
    assert.deepEqual(currentObservation.next.mcp.arguments, {
      action: "accept",
      target,
      requestId: "REPLACE_WITH_FRESH_REQUEST_ID",
      observationId: "observation-current",
    });
    assert.deepEqual(currentObservation.next.cli.arguments.slice(-4), [
      "--request-id",
      "REPLACE_WITH_FRESH_REQUEST_ID",
      "--observation-id",
      "observation-current",
    ]);
  }

  const checkpoint = status("checkpoint_current", {
    executionFence: "released",
  });
  assert.equal(checkpoint.state, "checkpoint_current");
  assert.equal(
    checkpoint.next.kind === "continue" && checkpoint.next.geometryValidated,
    false,
  );
  assert.match(
    checkpoint.next.kind === "continue" ? checkpoint.next.instruction : "",
    /not a geometry-validation result/,
  );

  const unproven = status("scope_unproven", {
    executionFence: "released",
  });
  assert.equal(
    unproven.next.kind === "operator_action" && unproven.next.action,
    "prove_scope_and_barrier",
  );
  assert.notEqual(
    unproven.next.kind === "command" && unproven.next.action,
    "accept",
  );

  const unavailable = status("target_unavailable", {
    executionFence: "released",
  });
  assert.equal(unavailable.state, "target_unavailable");
  assert.equal(
    unavailable.next.kind === "operator_action" && unavailable.next.action,
    "choose_verified_target",
  );
  assert.match(
    unavailable.next.kind === "operator_action"
      ? unavailable.next.instruction
      : "",
    /does not prove deletion/,
  );
  assert.match(
    unavailable.next.kind === "operator_action"
      ? unavailable.next.instruction
      : "",
    /cannot recover unsaved geometry/,
  );

  const unavailableWithoutFence = status("target_unavailable", {
    executionFence: "unknown",
  });
  assert.equal(unavailableWithoutFence.state, "target_unavailable");
  assert.equal(unavailableWithoutFence.executionFence, "unknown");
  assert.equal(
    unavailableWithoutFence.next.kind === "operator_action" &&
      unavailableWithoutFence.next.action,
    "choose_verified_target",
  );
  assert.match(
    unavailableWithoutFence.next.kind === "operator_action"
      ? unavailableWithoutFence.next.instruction
      : "",
    /does not prove deletion/,
  );
});

test("strict next request templates carry exact targets and separate CLI arguments", () => {
  const awkwardId = `doc '"; $(touch /tmp/unlock-injected) Ω`;
  const result = serializeDocumentUnlockStatus({
    state: "inspection_required",
    target: { docId: awkwardId },
    executionFence: "released",
  });
  assert.deepEqual(result.target, { docId: awkwardId });
  assert.equal(result.next.kind, "command");
  if (result.next.kind !== "command") return;

  assert.deepEqual(Object.keys(result.next.mcp.arguments).sort(), [
    "action",
    "requestId",
    "target",
  ]);
  assert.deepEqual(result.next.mcp.arguments, {
    action: "inspect",
    target: { docId: awkwardId },
    requestId: "REPLACE_WITH_FRESH_REQUEST_ID",
  });
  assert.equal(result.next.requiredFreshRequestId, true);
  assert.deepEqual(result.next.cli, {
    executable: "fmcad",
    arguments: [
      "queue",
      "document-unlock",
      "--action",
      "inspect",
      `--doc-id=${awkwardId}`,
      "--request-id",
      "REPLACE_WITH_FRESH_REQUEST_ID",
    ],
  });
  assert.equal(Array.isArray(result.next.cli.arguments), true);
  assert.equal(
    result.next.cli.arguments.includes(`--doc-id=${awkwardId}`),
    true,
  );
  assert.equal("shellCommand" in result.next.cli, false);
  const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
  assert.deepEqual(roundTripped.target, { docId: awkwardId });
  assert.equal(
    roundTripped.next.kind === "command" && roundTripped.next.cli.arguments[4],
    `--doc-id=${awkwardId}`,
  );
});

test("CLI target flags keep IDs beginning with dashes in one argv element", () => {
  const targetWithLeadingDashes = { docId: "--fixture-id" };
  const result = serializeDocumentUnlockStatus({
    state: "inspection_required",
    target: targetWithLeadingDashes,
    executionFence: "released",
  });

  assert.deepEqual(
    result.next.kind === "command" ? result.next.mcp.arguments.target : null,
    targetWithLeadingDashes,
  );
  assert.deepEqual(
    result.next.kind === "command" ? result.next.cli.arguments : null,
    [
      "queue",
      "document-unlock",
      "--action",
      "inspect",
      "--doc-id=--fixture-id",
      "--request-id",
      "REPLACE_WITH_FRESH_REQUEST_ID",
    ],
  );
});

test("status and error serialization only disclose authorized blockers", () => {
  const visible = status("inspection_required", {
    disclosableBlockers: [
      {
        jobId: "authorized-job",
        requestId: "authorized-request",
        scope: "/PRIVATE_SCOPE_PATH_SENTINEL",
        executionFence: "PRIVATE_FENCE_SENTINEL",
        owner: "PRIVATE_OWNER_SENTINEL",
        token: "PRIVATE_TOKEN_SENTINEL",
      } as unknown as DocumentUnlockResolvedBlocker,
    ],
  });
  const visibleJson = JSON.stringify(visible);
  assert.match(visibleJson, /authorized-job/);
  assert.match(visibleJson, /authorized-request/);
  assert.doesNotMatch(
    visibleJson,
    /PRIVATE_(?:SCOPE_PATH|FENCE|OWNER|TOKEN)_SENTINEL/,
  );
  const visibleBlocker = visible.blockers[0];
  assert.ok(visibleBlocker && visibleBlocker.visibility === "authorized_scope");
  assert.equal(visibleBlocker.scope, "unknown");

  const hiddenResolution = {
    state: "clear" as const,
    target,
    executionFence: "unknown" as const,
    hasOperatorOnlyBlocker: true,
    foreignBlockers: [
      {
        jobId: "foreign-job-secret",
        requestId: "foreign-request-secret",
      },
    ],
  };
  const hidden = serializeDocumentUnlockStatus(hiddenResolution);
  const hiddenJson = JSON.stringify(hidden);
  assert.equal(hidden.state, "scope_unproven");
  assert.equal(hidden.blockers.length, 1);
  assert.deepEqual(hidden.blockers[0], { visibility: "operator_only" });
  assert.doesNotMatch(hiddenJson, /foreign-(?:job|request)-secret/);
  assert.equal(hidden.executionFence, undefined);
  assert.equal(
    hidden.next.kind === "operator_action" && hidden.next.action,
    "prove_scope_and_barrier",
  );
});

test("known errors are mapped to static safe messages and concrete next actions", () => {
  const codes = [
    "DOCUMENT_UNLOCK_REQUIRED",
    "DOCUMENT_STATE_CHANGED",
    "CHECKPOINT_CHANGED",
    "DOCUMENT_TARGET_UNAVAILABLE",
    "UNKNOWN_SCOPE_UNPROVEN",
    "NOT_AUTHORIZED",
    "STORAGE_UNAVAILABLE",
    "SDK_TURN_ACTIVE",
    "SDK_QUIESCENCE_UNPROVEN",
    "REQUEST_CONFLICT",
  ] as const;
  const expectedNext = {
    DOCUMENT_UNLOCK_REQUIRED: "status",
    DOCUMENT_STATE_CHANGED: "status",
    CHECKPOINT_CHANGED: "status",
    DOCUMENT_TARGET_UNAVAILABLE: "choose_verified_target",
    UNKNOWN_SCOPE_UNPROVEN: "prove_scope_and_barrier",
    NOT_AUTHORIZED: "obtain_document_authorization",
    STORAGE_UNAVAILABLE: "repair_canonical_store",
    SDK_TURN_ACTIVE: "status",
    SDK_QUIESCENCE_UNPROVEN: "establish_runtime_barrier",
    REQUEST_CONFLICT: "review_original_request_without_replay",
  } as const;
  for (const code of codes) {
    const result = serializeDocumentUnlockError({
      code,
      target,
      currentRequestId: "current-request",
      state: "inspection_required",
      disclosableBlockers: [
        {
          jobId: "authorized-job",
          requestId: "authorized-request",
          scope: "document",
          executionFence: "released",
        },
      ],
      privateMessage: "PRIVATE_MESSAGE_SENTINEL",
      stack: "PRIVATE_STACK_SENTINEL",
      cause: { message: "PRIVATE_CAUSE_SENTINEL" },
    } as DocumentUnlockErrorResolution);
    assert.equal(result.error.code, code);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE_(?:MESSAGE|STACK|CAUSE)_SENTINEL/,
    );
    const nextAction =
      result.next.kind === "command"
        ? result.next.action
        : result.next.kind === "operator_action"
          ? result.next.action
          : undefined;
    assert.equal(nextAction, expectedNext[code]);
  }

  const blocked = serializeDocumentUnlockError({
    code: "DOCUMENT_UNLOCK_REQUIRED",
    target,
    currentRequestId: "blocked-request-1",
  });
  assert.equal(blocked.requestId, "blocked-request-1");
  assert.equal(blocked.executionOutcome, "not_started");
  assert.equal(blocked.userScriptSubmitted, false);
  assert.match(blocked.error.message, /was not executed/);
  assert.equal(blocked.next.kind, "command");
  if (blocked.next.kind === "command") {
    assert.equal(blocked.next.action, "status");
    assert.deepEqual(blocked.next.mcp.arguments, {
      action: "status",
      target,
    });
    assert.equal(blocked.next.cli.arguments.includes("--request-id"), false);
  }

  const active = serializeDocumentUnlockError({
    code: "SDK_TURN_ACTIVE",
    target,
    state: "execution_unfenced",
  });
  assert.equal(active.next.kind, "command");
  if (active.next.kind === "command")
    assert.equal(active.next.action, "status");

  const conflict = serializeDocumentUnlockError({
    code: "REQUEST_CONFLICT",
    target,
    currentRequestId: "PRIVATE_CONFLICT_REQUEST_ID",
    disclosableBlockers: [
      {
        jobId: "PRIVATE_CONFLICT_JOB",
        requestId: "PRIVATE_CONFLICT_BLOCKER",
        scope: "document",
        executionFence: "released",
      },
    ],
  });
  assert.equal(conflict.error.code, "REQUEST_CONFLICT");
  assert.match(conflict.error.message, /request ID.*different content/i);
  assert.match(conflict.error.message, /fresh request ID/i);
  assert.equal(conflict.target, undefined);
  assert.equal(conflict.blockers, undefined);
  assert.equal(conflict.requestId, undefined);
  assert.equal(
    conflict.next.kind === "operator_action" && conflict.next.action,
    "review_original_request_without_replay",
  );
  assert.doesNotMatch(
    JSON.stringify(conflict),
    /PRIVATE_CONFLICT_(?:REQUEST_ID|JOB|BLOCKER)/,
  );
});

test("unknown Throwable details and unauthorized targets are never serialized", () => {
  const raw = Object.assign(new Error("PRIVATE_ERROR_MESSAGE_SENTINEL"), {
    code: "PRIVATE_ERROR_CODE_SENTINEL",
    target: { docId: "PRIVATE_TARGET_SENTINEL" },
    hasOperatorOnlyBlocker: true,
    disclosableBlockers: [
      {
        jobId: "PRIVATE_BLOCKER_ID_SENTINEL",
        requestId: "PRIVATE_BLOCKER_REQUEST_SENTINEL",
        scope: "global",
        executionFence: "unknown",
      },
    ],
    currentObservation: {
      observationId: "PRIVATE_OBSERVATION_SENTINEL",
      coverage: ["document_identity"],
    },
    owner: "PRIVATE_OWNER_SENTINEL",
    token: "PRIVATE_TOKEN_SENTINEL",
    requestId: "PRIVATE_REQUEST_ID_SENTINEL",
    currentRequestId: "PRIVATE_CURRENT_REQUEST_ID_SENTINEL",
    path: "/PRIVATE_PATH_SENTINEL",
    result: "PRIVATE_RESULT_SENTINEL",
    cause: new Error("PRIVATE_CAUSE_SENTINEL"),
  });
  const unknown = serializeDocumentUnlockError(
    raw as unknown as DocumentUnlockErrorResolution,
  );
  const unknownJson = JSON.stringify(unknown);
  assert.equal(unknown.error.code, "DOCUMENT_UNLOCK_ERROR");
  assert.doesNotMatch(
    unknownJson,
    /PRIVATE_(?:ERROR_MESSAGE|ERROR_CODE|TARGET|BLOCKER_ID|BLOCKER_REQUEST|OBSERVATION|OWNER|TOKEN|CURRENT_REQUEST_ID|REQUEST_ID|PATH|RESULT|CAUSE)_SENTINEL/,
  );
  assert.equal(unknown.target, undefined);
  assert.equal(unknown.blockers, undefined);
  assert.equal(
    unknown.next.kind === "operator_action" && unknown.next.action,
    "review_original_request_without_replay",
  );

  const denied = serializeDocumentUnlockError({
    code: "NOT_AUTHORIZED",
    target,
    hasOperatorOnlyBlocker: true,
    disclosableBlockers: [
      {
        jobId: "foreign-job-secret",
        requestId: "foreign-request-secret",
        scope: "document",
        executionFence: "unknown",
      },
    ],
  });
  const deniedJson = JSON.stringify(denied);
  assert.equal(denied.target, undefined);
  assert.equal(denied.blockers, undefined);
  assert.equal(
    denied.next.kind === "operator_action" && denied.next.action,
    "obtain_document_authorization",
  );
  assert.doesNotMatch(
    deniedJson,
    /creation-1|file-1|foreign-(?:job|request)-secret/,
  );
});
