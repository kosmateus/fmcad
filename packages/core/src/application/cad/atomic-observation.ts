import type { QueueSnapshot } from "../../domain/queue-model";
import type { CadContext } from "./contracts";
import type { AtomicReport } from "./atomic";
import { hash as canonicalHash } from "./json";
export interface AtomicObservationAdmissionPrepared {
  scope: {
    jobId: string;
    requestId: string;
    clientId: string;
    reportPath: string;
    commandId: string;
    sessionNonce: string;
    docId: string;
  };
  jobHash: string;
  originalBuildHash: string;
  originalRpcCount: number;
  observerBuildHash: string;
  identity: {
    commandId: string;
    sessionNonce: string;
    documentIdentity: AtomicReport["documentIdentity"];
  };
  expectedContext: CadContext;
}
const same = (left: unknown, right: unknown): boolean =>
  canonicalHash(left) === canonicalHash(right);
const field = (value: unknown, key: string): unknown =>
  object(value) ? value[key] : undefined;
export interface AtomicObservationAdmissionFence {
  prepared: AtomicObservationAdmissionPrepared;
  jobId: string;
  observerJobId: string;
  clientId: string;
  state: QueueSnapshot;
  initialState: QueueSnapshot;
  initialActiveIds: string[];
  activeIds: string[];
  originalActiveIds?: string[];
  inFlight?: boolean;
  resetActive: unknown;
  owner: unknown;
  expectedOwner: unknown;
  buildHash: string;
  expectedBuildHash: string;
  instance: unknown;
  expectedInstance: unknown;
  instanceAlive: boolean;
  resuming?: boolean;
  adminTransition?: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}
export function atomicStatusSummaryFromReply(
  reply: unknown,
): Record<string, unknown> {
  if (
    !object(reply) ||
    reply["error"] ||
    !object(reply["result"]) ||
    reply["result"]["isError"] === true
  ) {
    fail(
      "WORKFLOW_OBSERVATION_FAILED",
      "Atomic status tool call did not return a successful MCP result",
    );
  }
  const result = reply["result"];
  let stdout =
    object(result["structuredContent"]) &&
    typeof result["structuredContent"]["stdout"] === "string"
      ? result["structuredContent"]["stdout"]
      : null;
  if (stdout === null) {
    const content = Array.isArray(result["content"])
      ? result["content"].find(
          (item: unknown): item is { type: "text"; text: string } =>
            object(item) &&
            item["type"] === "text" &&
            typeof item["text"] === "string",
        )
      : null;
    if (!content)
      fail(
        "WORKFLOW_OBSERVATION_OUTPUT",
        "Atomic status response contains no bounded text result",
      );
    try {
      const wrapped: unknown = JSON.parse(content["text"]);
      stdout =
        object(wrapped) && typeof wrapped["stdout"] === "string"
          ? wrapped["stdout"]
          : content["text"];
    } catch {
      stdout = content["text"];
    }
  }
  if (utf8ByteLength(stdout) > 65536)
    fail(
      "WORKFLOW_OBSERVATION_OUTPUT",
      "Atomic status response exceeds the bounded summary size",
    );
  const line = stdout
    .split(/\r?\n/)
    .find((value) => value.startsWith("FMCAD_RESULT "));
  if (!line)
    fail(
      "WORKFLOW_OBSERVATION_OUTPUT",
      "Atomic status response contains no typed result",
    );
  let summary: unknown;
  try {
    summary = JSON.parse(line.slice("FMCAD_RESULT ".length));
  } catch {
    fail("WORKFLOW_OBSERVATION_OUTPUT", "Atomic status result is malformed");
  }
  const allowed = new Set([
    "status",
    "accepted",
    "completed",
    "destroyed",
    "cleanupCompleted",
    "definitionDeleted",
    "outcome",
    "terminationReason",
    "idle",
    "createdCount",
    "executeCount",
    "executeCompleted",
    "terminationCompleted",
    "notStarted",
    "identity",
    "unavailableEvidence",
  ]);
  const validIdentityPart = (value: unknown): boolean =>
    object(value) &&
    Object.keys(value).length === 3 &&
    ["name", "creationId", "fileId"].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    typeof value["name"] === "string" &&
    value["name"].length <= 256 &&
    (value["creationId"] === null ||
      (typeof value["creationId"] === "string" &&
        value["creationId"].length <= 256)) &&
    (value["fileId"] === null ||
      (typeof value["fileId"] === "string" && value["fileId"].length <= 256));
  const validIdentity = (value: unknown): boolean =>
    object(value) &&
    Object.keys(value).length === 7 &&
    [
      "commandId",
      "runId",
      "requestHash",
      "backend",
      "sessionNonce",
      "documentIdentity",
      "resolvedIdentity",
    ].every((key) => Object.hasOwn(value, key)) &&
    typeof value["commandId"] === "string" &&
    value["commandId"].length <= 64 &&
    typeof value["runId"] === "string" &&
    value["runId"].length <= 256 &&
    typeof value["requestHash"] === "string" &&
    /^[a-f0-9]{64}$/.test(value["requestHash"]) &&
    value["backend"] === "addin" &&
    typeof value["sessionNonce"] === "string" &&
    /^[a-f0-9]{32}$/.test(value["sessionNonce"]) &&
    object(value["documentIdentity"]) &&
    Object.keys(value["documentIdentity"]).length === 3 &&
    Object.hasOwn(value["documentIdentity"], "expected") &&
    Object.hasOwn(value["documentIdentity"], "resolved") &&
    typeof value["documentIdentity"]["assertionsOnly"] === "boolean" &&
    validIdentityPart(value["documentIdentity"]["expected"]) &&
    validIdentityPart(value["documentIdentity"]["resolved"]) &&
    validIdentityPart(value["resolvedIdentity"]);
  if (
    !object(summary) ||
    Object.keys(summary).some((key) => !allowed.has(key)) ||
    utf8ByteLength(JSON.stringify(summary)) > 65536 ||
    (summary["status"] !== undefined &&
      (typeof summary["status"] !== "string" ||
        summary["status"].length > 128)) ||
    (summary["outcome"] !== undefined &&
      summary["outcome"] !== null &&
      (typeof summary["outcome"] !== "string" ||
        !["committed", "aborted", "unknown"].includes(summary["outcome"]))) ||
    (summary["terminationReason"] !== undefined &&
      summary["terminationReason"] !== null &&
      !(
        typeof summary["terminationReason"] === "string" &&
        summary["terminationReason"].length <= 128
      ) &&
      !(
        typeof summary["terminationReason"] === "number" &&
        Number.isSafeInteger(summary["terminationReason"]) &&
        summary["terminationReason"] >= 0
      )) ||
    [
      "accepted",
      "completed",
      "destroyed",
      "cleanupCompleted",
      "definitionDeleted",
      "idle",
      "executeCompleted",
      "terminationCompleted",
      "notStarted",
    ].some(
      (key) =>
        summary[key] !== undefined &&
        summary[key] !== null &&
        typeof summary[key] !== "boolean",
    ) ||
    ["createdCount", "executeCount"].some(
      (key) =>
        summary[key] !== undefined &&
        summary[key] !== null &&
        (typeof summary[key] !== "number" ||
          !Number.isSafeInteger(summary[key]) ||
          summary[key] < 0),
    ) ||
    (summary["identity"] !== undefined &&
      !validIdentity(summary["identity"])) ||
    (summary["unavailableEvidence"] !== undefined &&
      (!Array.isArray(summary["unavailableEvidence"]) ||
        summary["unavailableEvidence"].length > 16 ||
        summary["unavailableEvidence"].some(
          (value) => typeof value !== "string" || value.length > 256,
        )))
  ) {
    fail(
      "WORKFLOW_OBSERVATION_OUTPUT",
      "Atomic status result is outside the bounded identity-only schema",
    );
  }
  return summary;
}

export function validateAtomicReconcileInvocation(
  invocation: unknown,
  prepared: AtomicObservationAdmissionPrepared,
) {
  const invocationKeys = new Set([
    "version",
    "kind",
    "operation",
    "data",
    "doc",
    "docId",
    "docFileId",
    "component",
    "projectId",
    "purpose",
    "preview",
  ]);
  if (
    !object(invocation) ||
    invocation["version"] !== 1 ||
    invocation["kind"] !== "cad" ||
    invocation["operation"] !== "batch.reconcile" ||
    !object(invocation["data"]) ||
    Object.keys(invocation).some((key) => !invocationKeys.has(key))
  ) {
    fail(
      "WORKFLOW_TYPE_NOT_ALLOWED",
      "Scoped holder observation accepts typed batch.reconcile only",
    );
  }
  const allowedData = new Set([
    "reportPath",
    "operations",
    "blockedJobId",
    "commandId",
    "sessionNonce",
  ]);
  if (
    Object.keys(invocation["data"]).some((key) => !allowedData.has(key)) ||
    invocation["data"]["reportPath"] !== prepared.scope.reportPath ||
    (invocation["data"]["operations"] !== undefined &&
      (!Array.isArray(invocation["data"]["operations"]) ||
        invocation["data"]["operations"].length !== 0))
  ) {
    fail(
      "WORKFLOW_OBSERVATION_NOT_ALLOWED",
      "Scoped reconciliation is atomic_status only; no additional operations are admitted",
    );
  }
  const scopedKeys = ["blockedJobId", "commandId", "sessionNonce"];
  const data = invocation["data"];
  const scoped = scopedKeys.every(
    (key) => typeof data[key] === "string" && data[key].trim(),
  );
  if (!scoped) {
    fail(
      "INVALID_WORKFLOW_SCOPE",
      "Scoped reconcile requires blockedJobId, commandId and sessionNonce together",
    );
  }
  if (
    invocation["data"]["blockedJobId"] !== prepared.scope.jobId ||
    invocation["data"]["commandId"] !== prepared.scope.commandId ||
    invocation["data"]["sessionNonce"] !== prepared.scope.sessionNonce
  ) {
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Scoped reconcile fields differ from the validated blocked job/report identity",
    );
  }
  const context = prepared.expectedContext;
  for (const key of [
    "doc",
    "docId",
    "docFileId",
    "component",
    "projectId",
  ] as const) {
    const expected = context[key] ?? null;
    const actual = invocation[key] ?? null;
    if (actual !== expected)
      fail(
        "WORKFLOW_IDENTITY_MISMATCH",
        `Reconcile invocation ${key} differs from the exact report pin`,
      );
  }
  if (invocation["preview"] === true)
    fail(
      "WORKFLOW_OBSERVATION_NOT_ALLOWED",
      "Atomic holder observation cannot be previewed or redirected",
    );
  return true;
}

export function verifyAtomicObservationAdmission({
  prepared,
  jobId,
  observerJobId,
  clientId,
  state,
  initialState,
  initialActiveIds,
  activeIds,
  originalActiveIds = [],
  inFlight = true,
  resetActive,
  owner,
  expectedOwner,
  buildHash,
  expectedBuildHash,
  instance,
  expectedInstance,
  instanceAlive,
  resuming = false,
  adminTransition = null,
}: AtomicObservationAdmissionFence) {
  const currentJob = state?.jobs?.[jobId];
  const observerJob = state?.jobs?.[observerJobId];
  if (
    !prepared ||
    prepared.scope.jobId !== jobId ||
    prepared.scope.clientId !== clientId ||
    !currentJob ||
    currentJob.id !== jobId ||
    currentJob.clientId !== clientId ||
    currentJob.requestId !== prepared.scope.requestId ||
    currentJob.hash !== prepared.jobHash ||
    currentJob.request?.buildHash !== prepared.originalBuildHash ||
    currentJob.state !== "needs_reconciliation" ||
    (currentJob.dispatch?.rpcCount || 0) !== prepared.originalRpcCount ||
    !observerJob ||
    observerJob.id !== observerJobId ||
    observerJob.state !== "running" ||
    observerJob.workflowObservation?.targetJobId !== jobId ||
    observerJob.workflowObservation?.observerJobHash !== observerJob.hash ||
    observerJob.clientId !== clientId ||
    prepared.identity.commandId !== prepared.scope.commandId ||
    prepared.identity.sessionNonce !== prepared.scope.sessionNonce ||
    prepared.identity.documentIdentity?.expected?.["creationId"] !==
      prepared.scope.docId ||
    field(prepared.identity.documentIdentity?.resolved, "creationId") !==
      prepared.scope.docId
  ) {
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Scoped observation identity changed before SDK admission",
    );
  }
  if (
    !initialState ||
    typeof initialState.paused !== "boolean" ||
    !Number.isSafeInteger(initialState.controlGeneration) ||
    !Number.isSafeInteger(initialState.contextEpoch)
  ) {
    fail(
      "WORKFLOW_GATE_STATE_UNAVAILABLE",
      "Initial pause/generation/context fence is unavailable",
    );
  }
  if (
    !state ||
    state.active !== observerJobId ||
    state.blocked?.id !== jobId ||
    initialState?.active !== observerJobId ||
    initialState?.blocked?.id !== jobId ||
    state.paused !== initialState?.paused ||
    (state.controlGeneration || 0) !== initialState?.controlGeneration ||
    (state.contextEpoch || 0) !== initialState?.contextEpoch ||
    !same(state.lease ?? null, initialState?.lease ?? null) ||
    state.controlBlocked ||
    state.localUnknown ||
    !Array.isArray(initialActiveIds) ||
    !Array.isArray(activeIds) ||
    !Array.isArray(originalActiveIds) ||
    !same([...initialActiveIds].sort(), [...originalActiveIds].sort()) ||
    !same(
      [...activeIds].filter((id) => originalActiveIds.includes(id)).sort(),
      [...originalActiveIds].sort(),
    ) ||
    (inFlight
      ? activeIds.length !== originalActiveIds.length + 1
      : !same([...activeIds].sort(), [...originalActiveIds].sort())) ||
    resuming ||
    adminTransition
  ) {
    fail(
      "WORKFLOW_GATE_CHANGED",
      "Queue holder, pause, reset or active-operation fence changed before observation",
    );
  }
  if (state.paused !== true && state.blocked?.id !== jobId) {
    fail(
      "WORKFLOW_GATE_OPEN",
      "Scoped observation requires the original closed admission gate",
    );
  }
  if (resetActive)
    fail(
      "FUSION_RESET_IN_PROGRESS",
      "A guarded Fusion reset owns the broker directory",
    );
  if (!owner || !expectedOwner || !same(owner, expectedOwner)) {
    fail(
      "BROKER_OWNER_CHANGED",
      "Broker owner changed before scoped observation",
    );
  }
  if (instanceAlive !== true)
    fail(
      "INSTANCE_CHANGED",
      "Original Fusion PID/birth identity is not currently alive",
    );
  if (
    buildHash !== prepared.observerBuildHash ||
    buildHash !== expectedBuildHash
  )
    fail(
      "BUILD_CHANGED",
      "Observer broker build changed before scoped observation",
    );
  if (!same(instance, expectedInstance))
    fail(
      "INSTANCE_CHANGED",
      "Pinned Fusion instance changed before scoped observation",
    );
  return true;
}
