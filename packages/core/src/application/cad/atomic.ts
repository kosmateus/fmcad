import {
  record,
  type CadContext,
  type CadData,
  type CadOutput,
  type CadExecutionRequest,
  type CadExecutionReply,
} from "./contracts";
import type { PreparedPythonArtifact } from "../../domain/python-artifact";
import type { BatchCatalog, BatchStep, BatchValidation } from "./batch-plan";
import { errorMessage } from "./batch-plan";
import type { BatchJournal, BatchReport } from "./batch";
import { clone, hash, resolveReferences } from "./json";

export interface AtomicServices {
  catalog: BatchCatalog;
  backend: string;
  supported: boolean;
  isLocal(operation: string): boolean;
  reportPath(data: CadData): string;
  open(reportPath: string): Promise<BatchJournal>;
  now(): number;
  timestamp(): string;
  nonce(): string;
  redact(value: unknown): string;
  prepare(args: CadData): PreparedPythonArtifact;
  /** Same prepared-artifact turn as CAD; adapter enforces the finalize reserve. */
  execution: {
    execute(
      request: CadExecutionRequest,
      deadline?: number,
    ): Promise<CadExecutionReply>;
  };
  wait(): Promise<void>;
  faultSteps(steps: BatchStep[]): BatchStep[];
}
function callAtomic(
  services: Pick<AtomicServices, "prepare" | "execution">,
  args: CadData,
  readOnly: boolean,
  deadline?: number,
): Promise<CadOutput> {
  const artifact = services.prepare(args);
  const context: CadContext = {};
  for (const key of [
    "doc",
    "component",
    "projectId",
    "docId",
    "docFileId",
  ] as const) {
    const value = args[key];
    if (typeof value === "string" || value === null) context[key] = value;
  }
  return services.execution
    .execute(
      { operation: String(args["operation"]), context, artifact, readOnly },
      deadline,
    )
    .then((out) => {
      const text = out.text || "";
      const line = text
        .split(/\r?\n/)
        .find((value) => value.startsWith("FMCAD_RESULT "));
      if (out.failed || !line)
        throw new Error(
          `Atomic batch ${String(args["operation"])} failed; ${text}`,
        );
      const result: unknown = JSON.parse(line.slice("FMCAD_RESULT ".length));
      if (!record(result))
        throw new Error(
          "Atomic batch returned a non-object result; outcome unknown",
        );
      return result;
    });
}
export interface AtomicReport extends BatchReport {
  commandId: string;
  sessionNonce: string;
  outcome: string;
  documentIdentity: {
    expected: CadData;
    resolved: unknown;
    assertionsOnly: boolean;
  };
  atomic: {
    requested?: unknown;
    effective: true;
    supported: boolean;
    backend: string;
  };
}
const sameJson = (left: unknown, right: unknown): boolean =>
  hash(left) === hash(right);
const terminal = (value: unknown): value is string =>
  value === "committed" || value === "aborted";
/** Authorization of persisted identity/history is pure; readers only supply JSON. */
export function validateAtomicHistory(
  records: readonly unknown[],
): AtomicReport {
  const first = records[0];
  const field = (value: unknown, key: string): unknown =>
    record(value) ? value[key] : undefined;
  const stable = (value: unknown): string =>
    JSON.stringify([
      field(value, "runId"),
      field(value, "requestHash"),
      field(value, "commandId"),
      field(field(value, "documentIdentity"), "expected"),
      field(field(value, "atomic"), "backend"),
      field(value, "sessionNonce"),
    ]);
  let resolvedIdentity: unknown = null;
  let identityHistoryValid = true;
  for (const value of records) {
    const resolved = field(field(value, "documentIdentity"), "resolved");
    if (resolvedIdentity && !sameJson(resolved, resolvedIdentity))
      identityHistoryValid = false;
    if (!resolvedIdentity && resolved) resolvedIdentity = resolved;
    if (resolvedIdentity && !resolved) identityHistoryValid = false;
  }
  if (
    !record(first) ||
    first["version"] !== 2 ||
    first["operation"] !== "batch.run" ||
    !first["commandId"] ||
    !first["sessionNonce"] ||
    !first["requestHash"] ||
    field(first["atomic"], "effective") !== true ||
    field(first["atomic"], "backend") !== "addin" ||
    !/^fmcad_atomic_[0-9a-f]{32}$/.test(String(first["commandId"])) ||
    !/^[0-9a-f]{32}$/.test(String(first["sessionNonce"])) ||
    hash({ request: first["request"], context: first["context"] }) !==
      first["requestHash"] ||
    !identityHistoryValid ||
    records.some(
      (value, index) =>
        !record(value) ||
        stable(value) !== stable(first) ||
        value["sequence"] !== index ||
        hash({ request: value["request"], context: value["context"] }) !==
          value["requestHash"],
    )
  )
    throw new Error(
      "Atomic journal identity/sequence mismatch; outcome unknown",
    );
  return records.at(-1) as AtomicReport;
}
export function isTransactional(
  operation: string,
  catalog: BatchCatalog,
): boolean {
  const spec = Object.hasOwn(catalog, operation)
    ? catalog[operation]
    : undefined;
  if (spec?.nonTransactional === true || spec?.batchAllowed === false)
    return false;
  if (/^(export\.|checkpoint\.(create|open)|import\.)/.test(operation))
    return false;
  return ![
    "document.clear",
    "document.save_as",
    "shot.pack",
    "texture.heightmap",
    "motion.sample",
    "animation.joints",
    "animation.export",
    "explode.render",
  ].includes(operation);
}
export function atomicRpcArgs(
  report: AtomicReport,
  operation: string,
  data?: unknown,
): CadData {
  const context = report.context;
  return {
    operation,
    commandId: report.commandId,
    runId: report.runId,
    requestHash: report.requestHash,
    sessionNonce: report.sessionNonce,
    backend: report.atomic.backend,
    doc: context.doc,
    component: context.component ?? null,
    projectId: context.projectId ?? null,
    docId: context.docId ?? null,
    docFileId: context.docFileId ?? null,
    documentIdentity: report.documentIdentity,
    ...(data === undefined ? {} : { data }),
  };
}
export function finalizeReport(
  report: AtomicReport,
  final: CadOutput,
  validation: BatchValidation,
  redact: AtomicServices["redact"],
): void {
  report["terminationReason"] = final["terminationReason"] ?? null;
  report["rollbackVerified"] = final["rollbackVerified"] === true;
  report["rollback"] = final["rollback"] ?? null;
  report.outcome =
    typeof final["outcome"] === "string" ? final["outcome"] : "unknown";
  report["errorStep"] = final["errorStep"] ?? null;
  if (final["error"]) report.error = { message: String(final["error"]) };
  const results = record(final["results"]) ? final["results"] : {};
  if (final["outcome"] === "committed") {
    report.success = true;
    report.status = "success";
    report.created = Array.isArray(final["created"]) ? final["created"] : [];
    try {
      report["exports"] = resolveReferences(validation.exports, results);
    } catch (error) {
      report["publication"] = {
        status: "failed",
        message: redact(errorMessage(error)),
      };
    }
    for (const step of report.steps) {
      step.status = "success";
      const output = results[step.id];
      if (record(output)) step.output = output;
    }
  } else if (final["outcome"] === "aborted") {
    report.success = false;
    report.status = "failed";
    const errorIndex = validation.operations!.findIndex(
      (step) => step.id === final["errorStep"],
    );
    report.steps.forEach((step, index) => {
      if (index === errorIndex) {
        step.status = "failed";
        if (final["error"]) step.error = { message: String(final["error"]) };
      } else if (errorIndex === -1 || index < errorIndex) {
        step.status = "success";
        step.mutationStatus = report["rollbackVerified"]
          ? "rolled_back"
          : "unknown";
      } else step.status = "skipped";
    });
  } else {
    report.success = false;
    report.status = "unknown";
    report.outcome = "unknown";
    report.steps.forEach((step) => {
      step.status = "unknown";
    });
  }
}

export async function runAtomicBatch(
  data: CadData,
  context: CadContext,
  validation: BatchValidation,
  services: AtomicServices,
): Promise<CadOutput | AtomicReport> {
  const started = services.now();
  if (!context.doc)
    throw new Error("Atomic batch run requires an explicit context.doc");
  const request = clone(data);
  delete request["mode"];
  delete request["reportPath"];
  request["atomic"] = true;
  const executionContext = clone(context),
    requestHash = hash({ request, context: executionContext });
  const reportPath = services.reportPath(data),
    backend = services.backend;
  const reasons: string[] = [];
  if (data["recipe"] !== undefined)
    reasons.push("Atomic batches do not support definition.recipe metadata");
  if (!services.supported)
    reasons.push(
      "Atomic batch execution is unsupported on the " +
        backend +
        " backend (no atomicBatch capability); select --backend addin or use atomic: false for per-step execution.",
    );
  for (const step of validation.operations!) {
    if (services.isLocal(step.operation))
      reasons.push(
        `Step ${step.id}: local/node-only operation cannot run inside a Fusion command transaction`,
      );
    else if (!isTransactional(step.operation, services.catalog))
      reasons.push(
        `Step ${step.id}: ${step.operation} is an external-effect operation (save/export/document lifecycle) and cannot be transacted`,
      );
  }
  if (reasons.length)
    return {
      operation: "batch.run",
      runId: data["runId"],
      success: false,
      status: "failed",
      outcome: "rejected",
      atomic: {
        requested: Object.hasOwn(data, "atomic") ? data["atomic"] : undefined,
        effective: true,
        supported: services.supported,
        backend,
      },
      errors: reasons,
      reportPath,
      mutated: false,
      steps: validation.operations!.map((step) => ({
        id: step.id,
        operation: step.operation,
        status: "skipped",
      })),
    };
  const steps = services.faultSteps(validation.operations!);
  const journalPort = await services.open(reportPath);
  const commandId = "fmcad_atomic_" + services.nonce(),
    sessionNonce = services.nonce();
  const report: AtomicReport = {
    version: 2,
    success: false,
    operation: "batch.run",
    runId: String(data["runId"]),
    requestHash,
    request,
    context: executionContext,
    status: "running",
    outcome: "unknown",
    createdAt: services.timestamp(),
    reportPath,
    atomic: {
      ...(Object.hasOwn(data, "atomic") ? { requested: data["atomic"] } : {}),
      effective: true,
      supported: true,
      backend,
    },
    commandId,
    sessionNonce,
    session: { backend, nonce: sessionNonce },
    created: [],
    affected: [],
    documentIdentity: {
      expected: {
        fileId: executionContext.docFileId ?? null,
        creationId: executionContext.docId ?? null,
        name: executionContext.doc,
      },
      resolved: null,
      assertionsOnly: true,
    },
    terminationReason: null,
    rollbackVerified: false,
    errorStep: null,
    steps: validation.operations!.map((step) => ({
      id: step.id,
      operation: step.operation,
      status: "pending",
    })),
  };
  // These arrays are not part of the initial v2 wire schema; materialize only on commit.
  delete report["created"];
  delete report["affected"];
  let sequence = 0,
    preserveLock = false;
  async function persist(): Promise<void> {
    report.sequence = sequence;
    report.updatedAt = services.timestamp();
    report.elapsedMs = services.now() - started;
    await journalPort.publish(report);
    sequence++;
  }
  async function journal(event: string, fields: CadData = {}): Promise<void> {
    report["journal"] = {
      event,
      at: services.timestamp(),
      commandId,
      runId: data["runId"],
      requestHash,
      documentIdentity: report.documentIdentity,
      backend,
      sessionNonce,
      ...fields,
    };
    await persist();
  }
  const budget = validation.plan!.timeBudgetMs ?? 180000,
    deadline = started + budget;
  const call = (
    operation: string,
    readOnly: boolean,
    extra: CadData = {},
  ): Promise<CadOutput> =>
    callAtomic(
      services,
      { ...atomicRpcArgs(report, operation), ...extra },
      readOnly,
      deadline,
    );
  async function unknown(
    event: string,
    error: unknown,
    fields: CadData = {},
    notSubmitted = false,
  ): Promise<AtomicReport> {
    report.status = notSubmitted ? "failed" : "unknown";
    report.outcome = notSubmitted ? "rejected" : "unknown";
    if (notSubmitted) report["mutated"] = false;
    report.error = { message: services.redact(errorMessage(error)) };
    report.steps.forEach((step) => {
      step.status = "unknown";
    });
    try {
      await journal(event, { error: report.error, ...fields });
    } catch (publicationError) {
      report["publication"] = {
        status: "failed",
        message: services.redact(errorMessage(publicationError)),
      };
    }
    return report;
  }
  try {
    await journalPort.assertEmpty();
    if (services.now() >= deadline) {
      report.status = "failed";
      report.outcome = "rejected";
      report["mutated"] = false;
      report.error = {
        code: "FMCAD_BATCH_BUDGET_EXHAUSTED",
        message: "Deadline reached before atomic submit; no request was sent.",
      };
      report.steps.forEach((step) => {
        step.status = "skipped";
      });
      await journal("not_submitted");
      return report;
    }
    await journal("identity_resolution_uncertain");
    let resolved: CadOutput;
    try {
      resolved = await call("atomic_resolve", true);
    } catch (error) {
      const notSubmitted =
        record(error) &&
        [
          "FMCAD_BATCH_BUDGET_EXHAUSTED",
          "FMCAD_RPC_NOT_SUBMITTED_BUDGET",
        ].includes(String(error["code"]));
      report.status = "failed";
      report.outcome = "rejected";
      report["mutated"] = false;
      report.error = { message: services.redact(errorMessage(error)) };
      if (notSubmitted)
        report.steps.forEach((step) => {
          step.status = "skipped";
        });
      await journal(notSubmitted ? "not_submitted" : "identity_unavailable", {
        error: report.error,
      });
      return report;
    }
    if (
      resolved["status"] !== "resolved" ||
      !record(resolved["resolvedIdentity"])
    ) {
      report.status = "failed";
      report.outcome = "rejected";
      report["mutated"] = false;
      report["identityResolution"] = {
        status: resolved["status"],
        candidates: resolved["candidates"] ?? [],
        unavailableEvidence: resolved["unavailableEvidence"] ?? [],
      };
      await journal(
        resolved["status"] === "ambiguous"
          ? "identity_ambiguous"
          : "identity_unavailable",
      );
      return report;
    }
    report.documentIdentity.resolved = resolved["resolvedIdentity"];
    await journal("submit_uncertain");
    try {
      const testFault = steps.some(
        (step) =>
          step.id === "__test_fault" && step.operation === "__test.fault",
      );
      await call("atomic_start", false, {
        steps,
        ...(testFault ? { testFault: true } : {}),
      });
    } catch (error) {
      const notSubmitted =
        record(error) &&
        [
          "FMCAD_BATCH_BUDGET_EXHAUSTED",
          "FMCAD_RPC_NOT_SUBMITTED_BUDGET",
        ].includes(String(error["code"]));
      await unknown(
        notSubmitted ? "not_submitted" : "submit_unknown",
        error,
        {},
        notSubmitted,
      );
      return report;
    }
    let final: CadOutput | null = null;
    while (services.now() < deadline) {
      let status: CadOutput;
      try {
        status = await call("atomic_status", true);
      } catch (error) {
        return await unknown("status_unknown", error);
      }
      if (status["destroyed"] === true) {
        try {
          final = await call("atomic_finalize", false);
        } catch (error) {
          return await unknown("finalize_unknown", error, {
            observedDestroyed: true,
          });
        }
        if (final["status"] !== "cleanup_pending") break;
        final = null;
      }
      await services.wait();
    }
    if (!final) {
      report.status = "unknown";
      report.outcome = "unknown";
      report.error = {
        message:
          "Atomic batch did not finalize within budget; command outcome unknown; inspect the model, never replay",
      };
      report.steps.forEach((step) => {
        step.status = "unknown";
      });
      await persist();
      return report;
    }
    finalizeReport(report, final, validation, services.redact);
    try {
      await journal("finalized", {
        nativeOutcome: final["outcome"] ?? "unknown",
      });
    } catch (error) {
      if (final["outcome"] !== "committed") throw error;
      report["publication"] = {
        status: "failed",
        message: services.redact(errorMessage(error)),
      };
      preserveLock = true;
    }
    return report;
  } finally {
    await journalPort.close(preserveLock);
  }
}

function expectedIdentity(report: AtomicReport): CadData {
  return {
    commandId: report.commandId,
    runId: report.runId,
    requestHash: report.requestHash,
    backend: report.atomic.backend,
    sessionNonce: report.sessionNonce,
    documentIdentity: report.documentIdentity,
    resolvedIdentity: report.documentIdentity.resolved,
  };
}
export async function reconcileAtomicBatch(
  report: AtomicReport,
  observe: unknown,
  services: Pick<
    AtomicServices,
    "supported" | "prepare" | "execution" | "catalog"
  >,
): Promise<CadOutput> {
  if (!Array.isArray(observe) || observe.length > 100)
    throw new Error("observe must be an array of at most 100 read operations");
  if (!report.documentIdentity?.resolved) {
    const resolution = record(report["identityResolution"])
      ? report["identityResolution"]
      : {};
    return {
      operation: "batch.reconcile",
      runId: report.runId,
      outcome: "rejected",
      status: "not_submitted",
      nativeOutcome: null,
      receiptOutcome: "rejected",
      observation: { status: "not_started" },
      candidates: resolution["candidates"] ?? [],
      unavailableEvidence: resolution["unavailableEvidence"] ?? [
        "atomic submit was not durably authorized",
      ],
    };
  }
  if (!services.supported) {
    const receiptOutcome = terminal(report.outcome) ? report.outcome : null;
    return {
      operation: "batch.reconcile",
      outcome: receiptOutcome ?? "unknown",
      status: "unavailable",
      receiptOutcome,
      nativeOutcome: null,
      observation: { status: "unsupported_backend" },
      candidates: [],
      unavailableEvidence: [
        "backend does not support atomic batch holder inspection",
      ],
    };
  }
  for (const request of observe)
    if (
      !record(request) ||
      typeof request["operation"] !== "string" ||
      !record(request["data"]) ||
      services.catalog[request["operation"]]?.readOnly !== true
    )
      throw new Error("observe permits existing read-only CAD handlers only");
  const observation = await callAtomic(
    services,
    atomicRpcArgs(report, "atomic_status"),
    true,
  );
  const expected = expectedIdentity(report);
  if (observation["status"] === "unavailable") {
    const receiptOutcome = terminal(report.outcome) ? report.outcome : null;
    return {
      operation: "batch.reconcile",
      outcome: receiptOutcome ?? "unknown",
      status: "unavailable",
      nativeOutcome: null,
      receiptOutcome,
      observation: { status: "unavailable", destroyed: false },
      candidates: [],
      unavailableEvidence: ["live holder receipt"],
    };
  }
  if (observation["status"] === "identity_mismatch")
    return {
      operation: "batch.reconcile",
      outcome: "unknown",
      status: "identity_mismatch",
      nativeOutcome: null,
      observation: { status: "identity_mismatch" },
      candidates: observation["candidates"] ?? [],
      unavailableEvidence: observation["unavailableEvidence"] ?? [
        "resolved document identity changed",
      ],
    };
  if (!observation["identity"] || !sameJson(observation["identity"], expected))
    return {
      operation: "batch.reconcile",
      outcome: "unknown",
      status: "identity_mismatch",
      nativeOutcome: null,
      observation: { status: "identity_mismatch" },
      candidates: [observation["identity"]].filter(Boolean),
      unavailableEvidence: [
        "live holder identity does not match durable journal",
      ],
    };
  if (observation["ambiguous"] === true)
    return {
      operation: "batch.reconcile",
      outcome: "unknown",
      status: "ambiguous",
      nativeOutcome: null,
      observation: { status: "ambiguous" },
      candidates: observation["candidates"] ?? [],
      unavailableEvidence: observation["unavailableEvidence"] ?? [],
    };
  if (
    terminal(report.outcome) &&
    terminal(observation["outcome"]) &&
    report.outcome !== observation["outcome"]
  )
    return {
      operation: "batch.reconcile",
      runId: report.runId,
      outcome: "unknown",
      status: "receipt_mismatch",
      receiptOutcome: report.outcome,
      nativeOutcome: observation["outcome"],
      observation: {
        status: observation["status"],
        destroyed: observation["destroyed"] === true,
      },
      candidates: [],
      unavailableEvidence: ["durable report and live native outcome disagree"],
    };
  const observed: unknown[] = [];
  if (observe.length) {
    const readOnlyOperations = Object.keys(services.catalog).filter(
      (operation) =>
        services.catalog[operation]?.readOnly === true &&
        services.catalog[operation]?.nodeOnly !== true &&
        services.catalog[operation]?.offline !== true,
    );
    const result = await callAtomic(
      services,
      {
        ...atomicRpcArgs(report, "atomic_observe", observe),
        readOnlyOperations,
      },
      true,
    );
    if (
      result["status"] !== "observed" ||
      !sameJson(result["identity"], expected)
    )
      return {
        operation: "batch.reconcile",
        outcome: "unknown",
        status: result["status"] || "unknown",
        nativeOutcome: null,
        observation: { status: result["status"] || "unknown" },
        candidates: result["candidates"] ?? [],
        unavailableEvidence: result["unavailableEvidence"] ?? [],
      };
    if (Array.isArray(result["results"])) observed.push(...result["results"]);
  }
  return {
    operation: "batch.reconcile",
    runId: report.runId,
    requestHash: report.requestHash,
    outcome: terminal(report.outcome) ? report.outcome : "unknown",
    nativeOutcome:
      observation["destroyed"] === true
        ? (observation["outcome"] ?? "unknown")
        : null,
    observation: {
      status: observation["status"],
      destroyed: observation["destroyed"] === true,
      completed: observation["completed"] === true,
      cleanupCompleted: observation["cleanupCompleted"] === true,
    },
    observed,
    candidates: observation["candidates"] ?? [],
    unavailableEvidence: observation["unavailableEvidence"] ?? [],
  };
}

export async function finalizeAtomicBatch(
  report: AtomicReport,
  services: Pick<
    AtomicServices,
    "supported" | "prepare" | "execution" | "timestamp" | "redact"
  >,
  open: () => Promise<BatchJournal>,
): Promise<CadOutput> {
  if (!report.documentIdentity?.resolved)
    return {
      operation: "batch.finalize",
      outcome: report.outcome === "rejected" ? "rejected" : "unknown",
      status: "blocked",
      cleanupCompleted: false,
      unavailableEvidence: ["atomic command identity was never resolved"],
    };
  const journal = record(report["journal"]) ? report["journal"] : {};
  if (
    journal["event"] === "finalize_ack" &&
    report["cleanupCompleted"] === true &&
    terminal(report.outcome)
  )
    return {
      operation: "batch.finalize",
      outcome: report.outcome,
      status: "already_finalized",
      cleanupCompleted: true,
    };
  if (!services.supported)
    throw new Error(
      "batch finalize requires the addin atomicBatch capability; no native request sent",
    );
  const port = await open();
  let preserveLock = false;
  try {
    const observation = await callAtomic(
      services,
      atomicRpcArgs(report, "atomic_status"),
      true,
    );
    const expected = expectedIdentity(report);
    if (
      !observation["identity"] ||
      !sameJson(observation["identity"], expected)
    )
      return {
        operation: "batch.finalize",
        outcome: "unknown",
        status: "identity_mismatch",
        cleanupCompleted: false,
      };
    if (
      observation["ambiguous"] ||
      observation["status"] === "identity_mismatch" ||
      !["completed", "terminated"].includes(String(observation["status"])) ||
      observation["destroyed"] !== true ||
      observation["idle"] !== true
    )
      return {
        operation: "batch.finalize",
        outcome: "unknown",
        status: observation["ambiguous"] ? "ambiguous" : "blocked",
        cleanupCompleted: false,
        candidates: observation["candidates"] ?? [],
        unavailableEvidence: observation["unavailableEvidence"] ?? [],
      };
    if (
      terminal(report.outcome) &&
      terminal(observation["outcome"]) &&
      report.outcome !== observation["outcome"]
    )
      return {
        operation: "batch.finalize",
        outcome: "unknown",
        status: "receipt_mismatch",
        cleanupCompleted: false,
        receiptOutcome: report.outcome,
        nativeOutcome: observation["outcome"],
      };
    if (
      journal["event"] === "finalize_ack" &&
      observation["cleanupCompleted"] === true &&
      journal["nativeOutcome"] === observation["outcome"]
    )
      return {
        operation: "batch.finalize",
        outcome: report.outcome,
        status: "already_finalized",
        cleanupCompleted: true,
      };
    const receipt = await callAtomic(
      services,
      atomicRpcArgs(report, "atomic_finalize"),
      false,
    );
    if (
      receipt["cleanupCompleted"] !== true ||
      !sameJson(receipt["identity"], expected)
    )
      return {
        operation: "batch.finalize",
        outcome: "unknown",
        status: receipt["status"] || "unknown",
        cleanupCompleted: false,
      };
    if (report.outcome === "committed" && receipt["outcome"] !== "committed")
      return {
        operation: "batch.finalize",
        outcome: "committed",
        status: "receipt_mismatch",
        cleanupCompleted: true,
      };
    if (terminal(receipt["outcome"])) {
      report.outcome = receipt["outcome"];
      report.status = report.outcome === "committed" ? "success" : "failed";
      report.success = report.outcome === "committed";
      report["cleanupCompleted"] = true;
      report["rollbackVerified"] = receipt["rollbackVerified"] === true;
      report["rollback"] = receipt["rollback"] ?? null;
      const results = record(receipt["results"]) ? receipt["results"] : {};
      if (report.outcome === "committed")
        report.steps = report.steps.map((step) => {
          const output = results[step.id];
          return {
            ...step,
            status: "success",
            ...(record(output) ? { output } : {}),
          };
        });
      else {
        const failedIndex = report.steps.findIndex(
          (step) => step.id === receipt["errorStep"],
        );
        report.steps = report.steps.map((step, index) => ({
          ...step,
          status:
            index === failedIndex
              ? "failed"
              : failedIndex < 0 || index < failedIndex
                ? "success"
                : "skipped",
          ...(index === failedIndex && receipt["error"]
            ? { error: { message: String(receipt["error"]) } }
            : {}),
          ...(index < failedIndex
            ? {
                mutationStatus: report["rollbackVerified"]
                  ? "rolled_back"
                  : "unknown",
              }
            : {}),
        }));
      }
      report["journal"] = {
        event: "finalize_ack",
        at: services.timestamp(),
        runId: report.runId,
        requestHash: report.requestHash,
        commandId: report.commandId,
        documentIdentity: report.documentIdentity,
        backend: report.atomic.backend,
        sessionNonce: report.sessionNonce,
        nativeOutcome: receipt["outcome"],
      };
      report.sequence = report.sequence! + 1;
      report.updatedAt = services.timestamp();
      try {
        await port.publish(report);
      } catch (error) {
        preserveLock = receipt["outcome"] === "committed";
        return {
          operation: "batch.finalize",
          outcome: receipt["outcome"],
          status: "publication_failed",
          cleanupCompleted: true,
          publication: {
            status: "failed",
            message: services.redact(errorMessage(error)),
          },
        };
      }
    }
    return {
      operation: "batch.finalize",
      outcome: receipt["outcome"] ?? report.outcome ?? "unknown",
      status: "finalized",
      cleanupCompleted: true,
      nativeOutcome: receipt["outcome"] ?? "unknown",
    };
  } finally {
    await port.close(preserveLock);
  }
}
