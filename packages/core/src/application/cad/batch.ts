import type { CadContext, CadData, CadOutput } from "./contracts";
import { record } from "./contracts";
import { clone, hash, resolveReferences } from "./json";
import {
  ATOMIC_BACKENDS,
  atomicInfo,
  errorMessage,
  limitations,
  validateBatch,
  type BatchCatalog,
  type BatchValidation,
} from "./batch-plan";

export interface BatchProgress {
  id: string;
  operation: string;
  status: string;
  expectFail?: boolean;
  mutationStatus?: string;
  request?: { operation: string; data: unknown; context: CadContext };
  output?: CadOutput;
  error?: { message: string; code?: string };
  timeout?: boolean;
}
export interface BatchReport {
  version: number;
  success: boolean;
  operation: string;
  runId: string;
  requestHash: string;
  request: CadData;
  context: CadContext;
  status: string;
  reportPath: string;
  steps: BatchProgress[];
  sequence?: number;
  updatedAt?: string;
  elapsedMs?: number;
  created?: unknown[];
  affected?: unknown[];
  error?: { message: string; code?: string };
  [key: string]: unknown;
}
export interface BatchJournal {
  /** Adapter validates contiguous history; application authorizes replay. */
  latest(): Promise<BatchReport | undefined>;
  assertEmpty(): Promise<void>;
  publish(report: BatchReport): Promise<void>;
  close(preserveLock?: boolean): Promise<void>;
}
export interface BatchServices {
  catalog: BatchCatalog;
  isLocal(operation: string): boolean;
  local(operation: string, data: CadData): CadOutput;
  execute:
    | ((
        operation: string,
        data: CadData,
        context: CadContext,
      ) => Promise<CadOutput>)
    | undefined;
  atomic(
    data: CadData,
    context: CadContext,
    validation: BatchValidation,
  ): Promise<unknown>;
  beforeRun?(
    data: CadData,
    context: CadContext,
    validation: BatchValidation,
    atomic: boolean,
  ): Promise<void> | void;
  reportPath(data: CadData): string;
  open(reportPath: string): Promise<BatchJournal>;
  now(): number;
  timestamp(): string;
  redact(value: unknown): string;
  failed(value: unknown): boolean;
}
function batchBinding(data: CadData, context: CadContext) {
  const request = clone(data);
  delete request["mode"];
  delete request["reportPath"];
  const executionContext = clone(context);
  return {
    request,
    context: executionContext,
    requestHash: hash({ request, context: executionContext }),
  };
}
function sameReplayBinding(
  saved: BatchReport,
  current: ReturnType<typeof batchBinding>,
): boolean {
  // Verify the original binding before considering the old optional-field
  // representation. Never rewrite a receipt or normalize its stored hash.
  if (
    hash({ request: saved.request, context: saved.context }) !==
    saved.requestHash
  )
    return false;
  if (saved.requestHash === current.requestHash) return true;
  if (!record(saved.context)) return false;
  for (const context of [saved.context, current.context])
    for (const key of ["docId", "docFileId"] as const) {
      const value = context[key];
      if (typeof value !== "string" || !value.trim()) return false;
    }
  const withoutNullSelectors = (context: CadContext): CadContext => {
    const result = { ...context };
    for (const key of ["component", "projectId"] as const)
      if (result[key] === null) delete result[key];
    return result;
  };
  return (
    hash({
      request: saved.request,
      context: withoutNullSelectors(saved.context),
    }) ===
    hash({
      request: current.request,
      context: withoutNullSelectors(current.context),
    })
  );
}
export function expectedFail(
  step: { expectFail?: boolean },
  output: unknown,
): boolean {
  if (step.expectFail !== true || !record(output)) return false;
  const result = output["result"];
  if (
    output["restored"] === false ||
    output["rollbackVerified"] === false ||
    (record(result) && result["restored"] === false)
  )
    return false;
  return (
    (output["status"] ?? (record(result) ? result["status"] : undefined)) ===
    "fail"
  );
}
export async function runBatchEntry(
  data: CadData,
  context: CadContext,
  services: BatchServices,
): Promise<unknown> {
  const validation = validateBatch(data, services.catalog, services.isLocal);
  const mode = context.preview
    ? "preview"
    : Object.hasOwn(data, "mode")
      ? data["mode"]
      : "run";
  if (!validation.success || mode !== "run") {
    const result: CadOutput = {
      ...validation,
      operation: `batch.${String(mode)}`,
      mode,
      mutated: false,
      atomicCapability: { ...ATOMIC_BACKENDS },
    };
    if (
      mode === "run" &&
      validation.atomic.effective &&
      (validation.operations || []).some(
        (step) => services.catalog[step.operation]?.batchAllowed === false,
      )
    ) {
      result["outcome"] = "rejected";
      result["status"] = "failed";
    }
    return result;
  }
  if (validation.atomic.effective) {
    await services.beforeRun?.(data, context, validation, true);
    return services.atomic(data, context, validation);
  }
  return runBatch(data, context, services, validation);
}

export async function runBatch(
  data: CadData,
  context: CadContext,
  services: BatchServices,
  checked?: BatchValidation,
): Promise<BatchReport | CadOutput> {
  const validation =
    checked ?? validateBatch(data, services.catalog, services.isLocal);
  const mode = context.preview
    ? "preview"
    : Object.hasOwn(data, "mode")
      ? data["mode"]
      : "run";
  if (!validation.success || mode !== "run")
    return {
      ...validation,
      operation: `batch.${String(mode)}`,
      mode,
      mutated: false,
    };
  if (!context.doc || typeof services.execute !== "function")
    throw new Error(
      "Batch run requires an explicit context.doc and executeCad function",
    );
  const operations = validation.operations!,
    plan = validation.plan!;
  const started = services.now();
  const batch = batchBinding(data, context);
  const { request, context: executionContext, requestHash } = batch;
  const reportPath = services.reportPath(data);
  const journal = await services.open(reportPath);
  let report: BatchReport;
  let sequence = 0;
  async function persist(): Promise<void> {
    report.sequence = sequence;
    report.updatedAt = services.timestamp();
    report.elapsedMs = services.now() - started;
    await journal.publish(report);
    sequence++;
  }
  async function budgetExhausted(): Promise<boolean> {
    if (
      plan.timeBudgetMs === null ||
      services.now() - started < plan.timeBudgetMs
    )
      return false;
    report.status = "failed";
    report.error = {
      code: "FMCAD_BATCH_BUDGET_EXHAUSTED",
      message:
        "Execution scheduling budget exhausted; no further calls submitted. Completed calls are retained; remote calls were not cancelled.",
    };
    for (const step of report.steps)
      if (["pending", "running"].includes(step.status)) {
        step.status = "skipped";
        step.mutationStatus = "not_started";
      }
    await persist();
    return true;
  }
  try {
    const saved = await journal.latest();
    if (saved) {
      if (saved.version !== 1 || !sameReplayBinding(saved, batch))
        throw new Error("Saved request/context hash differs; replay refused");
      if (
        saved.status !== "success" ||
        saved.success !== true ||
        saved.operation !== "batch.run" ||
        saved.runId !== String(data["runId"]) ||
        saved.steps.length !== operations.length ||
        saved.steps.some(
          (step, index) =>
            step.id !== operations[index]!.id ||
            step.operation !== operations[index]!.operation ||
            (step.expectFail === true) !==
              (operations[index]!.expectFail === true) ||
            step.status !== "success" ||
            !(
              expectedFail(operations[index]!, step.output) ||
              (step.output?.["success"] === true &&
                !services.failed(step.output))
            ),
        )
      )
        throw new Error(
          "Saved run contains failed, unknown, pending, or in-progress steps; operator inspection required, no automatic retry",
        );
      if (operations.some((step) => step.onExisting !== "reuse"))
        throw new Error(
          "Existing run requires onExisting: reuse for every successful step",
        );
      return { ...saved, replayed: true, reportPath };
    }
    await journal.assertEmpty();
    await services.beforeRun?.(data, context, validation, false);
    report = {
      version: 1,
      success: false,
      operation: "batch.run",
      runId: String(data["runId"]),
      requestHash,
      request,
      context: executionContext,
      status: "running",
      createdAt: services.timestamp(),
      reportPath,
      atomic: {
        ...(atomicInfo(data).requested === undefined
          ? {}
          : { requested: atomicInfo(data).requested }),
        effective: false,
      },
      documentIdentity: {
        fileId: executionContext.docFileId ?? null,
        creationId: executionContext.docId ?? null,
        name: executionContext.doc,
        assertionsOnly: true,
      },
      associativity: data["recipe"] ? "recipeRegeneration" : "snapshot",
      units: "per-step result",
      frame: "per-step component/sketch",
      created: [],
      affected: [],
      warnings: [],
      provenance: {
        sourceHash: hash(request),
        formatVersion: data["formatVersion"] ?? "legacy",
      },
      limitations: [...limitations],
      checks: validation.checks,
      steps: operations.map((step) => ({
        id: step.id,
        operation: step.operation,
        status: "pending",
        ...(step.expectFail === true ? { expectFail: true } : {}),
      })),
      plan,
    };
    await persist();
    if (await budgetExhausted()) return report;
    if (data["recipe"]) {
      try {
        const recipe = await services.execute(
          "definition.recipe",
          {
            action: "begin",
            recipe: data["recipe"],
            source: request,
            sourceHash: hash(request),
          },
          executionContext,
        );
        report["recipe"] = recipe;
        if (services.failed(recipe) || recipe["success"] !== true)
          throw new Error("Recipe begin failed");
      } catch (error) {
        report.status = "unknown";
        report.error = { message: services.redact(errorMessage(error)) };
        report.steps.forEach((step) => {
          step.status = "skipped";
        });
        await persist();
        return report;
      }
    }
    const results: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (let index = 0; index < operations.length; index++) {
      if (await budgetExhausted()) return report;
      const step = operations[index]!,
        progress = report.steps[index]!;
      const localStep = services.isLocal(step.operation);
      let resolvedData: CadData = {},
        resolvedContext: CadContext = {};
      try {
        resolvedData = resolveReferences(step.data, results) as CadData;
        resolvedContext = {
          ...executionContext,
          ...(Object.hasOwn(step, "component")
            ? {
                component: resolveReferences(step.component, results) as
                  string | null,
              }
            : {}),
        };
      } catch (error) {
        progress.status = "failed";
        progress.mutationStatus = "not_started";
        progress.error = { message: services.redact(errorMessage(error)) };
      }
      if (progress.status !== "failed") {
        progress.status = "running";
        progress.mutationStatus =
          localStep || services.catalog[step.operation]?.readOnly === true
            ? "none"
            : "unknown";
        progress.request = {
          operation: step.operation,
          data: resolvedData,
          context: resolvedContext,
        };
        await persist();
        if (await budgetExhausted()) return report;
        try {
          const output = localStep
            ? services.local(step.operation, resolvedData)
            : await services.execute(
                step.operation,
                clone(resolvedData),
                clone(resolvedContext),
              );
          progress.output = clone(output);
          report.created!.push(
            ...(Array.isArray(output["created"])
              ? clone(output["created"])
              : []),
          );
          report.affected!.push(
            ...(Array.isArray(output["affected"])
              ? clone(output["affected"])
              : []),
          );
          if (
            expectedFail(step, output) ||
            (output["success"] === true && !services.failed(output))
          ) {
            progress.status = "success";
            progress.mutationStatus =
              localStep || services.catalog[step.operation]?.readOnly === true
                ? "none"
                : "completed";
            results[step.id] = progress.output;
          } else {
            progress.status = "failed";
            progress.error = {
              message:
                "Executor returned an unsuccessful or unrecognized result",
            };
          }
        } catch (error) {
          const code = record(error) ? error["code"] : undefined;
          progress.status = "unknown";
          progress.error = {
            message: services.redact(errorMessage(error)),
            ...(typeof code === "string"
              ? { code: services.redact(code) }
              : {}),
          };
          progress.timeout = /timeout|timed out|ETIMEDOUT/i.test(
            `${String(code || "")} ${errorMessage(error)}`,
          );
        }
      }
      if (progress.status !== "success") {
        report.status = progress.status;
        for (const remaining of report.steps.slice(index + 1))
          remaining.status = "skipped";
        await persist();
        return report;
      }
      if (index === operations.length - 1) {
        if (await budgetExhausted()) return report;
        try {
          report["exports"] = resolveReferences(validation.exports, results);
          if (data["recipe"]) {
            if (await budgetExhausted()) return report;
            const recipe = await services.execute(
              "definition.recipe",
              {
                action: "complete",
                recipe: data["recipe"],
                sourceHash: hash(request),
                bindings: resolveReferences(
                  validation.recipe!["bindings"],
                  results,
                ),
                exports: report["exports"],
                created: report.steps.flatMap(
                  (progress) => progress.output?.["created"] ?? [],
                ),
              },
              executionContext,
            );
            report["recipe"] = recipe;
            if (services.failed(recipe) || recipe["success"] !== true)
              throw new Error("Recipe completion failed");
          }
          if (await budgetExhausted()) return report;
          report.status = "success";
          report.success = true;
        } catch (error) {
          report.status = "unknown";
          report.error = { message: services.redact(errorMessage(error)) };
        }
      }
      await persist();
    }
    return report;
  } finally {
    await journal.close();
  }
}
