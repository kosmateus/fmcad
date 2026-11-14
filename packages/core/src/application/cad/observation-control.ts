import { record } from "./contracts";
export interface ObservationTarget {
  id: string;
  clientId: string;
  request: {
    backend: string;
    cwd: string;
    buildHash: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface ObservationScope {
  reportPath: string;
  commandId: string;
  sessionNonce: string;
  [key: string]: unknown;
}
export interface ObservationControl {
  instanceId: string;
  buildHash: string;
  generation: number;
  contextEpoch: number;
}
export interface ObservationPolicy {
  isCandidate(
    target: ObservationTarget,
    buildHash: string,
    scope: ObservationScope,
  ): boolean;
  projection(
    target: ObservationTarget,
    scope: ObservationScope,
  ): {
    invocation: {
      doc: string;
      docId: string;
      docFileId?: unknown;
      component?: unknown;
      projectId?: unknown;
    };
  } | null;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
/** Only the authenticated broker derives this request; no raw argv/identity override. */
export function observationRequest(
  policy: ObservationPolicy,
  message: Record<string, unknown>,
  clientId: string,
  target: ObservationTarget | null | undefined,
  control: ObservationControl,
  scope: ObservationScope,
) {
  if (
    Object.keys(message).some(
      (key) =>
        !["action", "auth", "jobId", "requestId", "control"].includes(key),
    ) ||
    !identifier(message["jobId"]) ||
    !identifier(message["requestId"])
  )
    fail(
      "INVALID_REQUEST",
      "Atomic observation requires jobId and a stable requestId only",
    );
  if (!target || target.clientId !== clientId)
    fail(
      "NOT_OWNER",
      "Only the original authenticated job owner may observe this atomic holder",
    );
  const fence = message["control"];
  if (
    !record(fence) ||
    Object.keys(fence).sort().join(",") !==
      "buildHash,contextEpoch,generation,instanceId"
  )
    fail(
      "INVALID_REQUEST",
      "Atomic observation requires the complete current broker control fence",
    );
  if (fence["instanceId"] !== control.instanceId)
    fail("INSTANCE_CHANGED", "Broker owner changed before atomic observation");
  if (fence["buildHash"] !== control.buildHash)
    fail("BUILD_CHANGED", "Broker build changed before atomic observation");
  if (
    fence["generation"] !== control.generation ||
    fence["contextEpoch"] !== control.contextEpoch
  )
    fail(
      "STATE_CONFLICT",
      "Broker pause/reset context changed before atomic observation",
    );
  if (!policy.isCandidate(target, target.request?.buildHash, scope))
    fail(
      "WORKFLOW_TYPE_NOT_ALLOWED",
      "Atomic observation is restricted to the exact approved unresolved holder",
    );
  const projection = policy.projection(target, scope);
  if (!projection)
    fail(
      "WORKFLOW_TYPE_NOT_ALLOWED",
      "Original atomic invocation is no longer available",
    );
  const original = projection.invocation;
  const invocation = {
    version: 1,
    kind: "cad",
    operation: "batch.reconcile",
    data: {
      reportPath: scope.reportPath,
      operations: [],
      blockedJobId: target.id,
      commandId: scope.commandId,
      sessionNonce: scope.sessionNonce,
    },
    doc: original.doc,
    docId: original.docId,
    docFileId: original.docFileId ?? null,
    component: original.component ?? null,
    projectId: original.projectId ?? null,
    preview: false,
  };
  return {
    kind: "command",
    requestId: message["requestId"],
    clientId,
    backend: target.request.backend,
    buildHash: control.buildHash,
    timeoutMs: 30000,
    argv: [
      "cad",
      "batch",
      "reconcile",
      "--doc",
      original.doc,
      "--doc-id",
      original.docId,
    ],
    cwd: target.request.cwd,
    clientContext: {
      clientId,
      requestId: message["requestId"],
      projectDirectory: target.request.cwd,
      doc: original.doc,
      docId: original.docId,
    },
    payload: {
      version: 1,
      kind: "cad-command",
      invocation,
      output: { json: false, summary: false },
    },
  };
}
export async function observeAtomic(
  client: { call(action: string, message?: unknown): Promise<unknown> },
  {
    jobId,
    requestId,
    buildHash,
  }: { jobId: string; requestId: string; buildHash: string },
) {
  if (!identifier(jobId) || !identifier(requestId))
    fail(
      "INVALID_REQUEST",
      "observe-atomic requires --job and an explicit stable --request-id",
    );
  const status = await client.call("queue-summary");
  if (
    !record(status) ||
    !record(status["features"]) ||
    status["features"]["atomicWorkflowObserve"] !== true
  )
    fail(
      "ATOMIC_OBSERVATION_UNSUPPORTED",
      "Installed broker has no owner-bound atomic observation control; no job submitted",
    );
  const control = status["control"];
  if (!record(control) || control["buildHash"] !== buildHash)
    fail(
      "BUILD_CHANGED",
      "CLI and broker must use the same approved observer build; no job submitted",
    );
  return client.call("observe-atomic", {
    jobId,
    requestId,
    control: {
      instanceId: control["instanceId"],
      buildHash: control["buildHash"],
      generation: control["generation"],
      contextEpoch: control["contextEpoch"],
    },
  });
}
