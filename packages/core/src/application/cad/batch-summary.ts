import { record, type CadData } from "./contracts.js";
import { clone, hash } from "./json.js";
import { expandDefinition } from "./definition.js";
import { failedOutcome } from "../../domain/outcome.js";
import type { BatchReport } from "./batch.js";

export function validateBatchReport(
  value: unknown,
  count: number,
  message: string,
): BatchReport {
  const expanded =
    record(value) && record(value["request"])
      ? expandDefinition(value["request"])["operations"]
      : null;
  if (
    !record(value) ||
    ![1, 2].some((version) => version === value["version"]) ||
    value["operation"] !== "batch.run" ||
    typeof value["success"] !== "boolean" ||
    !["running", "success", "failed", "unknown"].some(
      (status) => status === value["status"],
    ) ||
    typeof value["runId"] !== "string" ||
    !value["runId"] ||
    value["sequence"] !== count - 1 ||
    !record(value["request"]) ||
    !record(value["context"]) ||
    hash({ request: value["request"], context: value["context"] }) !==
      value["requestHash"] ||
    !Array.isArray(value["steps"]) ||
    !value["steps"].length ||
    !Array.isArray(expanded) ||
    value["steps"].length !== expanded.length ||
    value["steps"].some(
      (step: unknown, index: number) =>
        !record(step) ||
        typeof step["id"] !== "string" ||
        step["id"] !== expanded[index]?.id ||
        step["operation"] !== expanded[index]?.operation ||
        !["pending", "running", "success", "failed", "unknown", "skipped"].some(
          (status) => status === step["status"],
        ) ||
        (step["error"] !== undefined &&
          (!record(step["error"]) ||
            typeof step["error"]["message"] !== "string")),
    ) ||
    value["success"] !== (value["status"] === "success") ||
    (value["success"] &&
      value["steps"].some(
        (step: CadData) =>
          step["status"] !== "success" ||
          (!step["expectFail"] &&
            (!record(step["output"]) ||
              step["output"]["success"] !== true ||
              failedOutcome(step["output"]))),
      ))
  )
    throw new Error(message);
  return value as unknown as BatchReport;
}

function smallResult(output: unknown): CadData {
  const result = record(output) ? output["result"] : undefined;
  if (!record(result)) return {};
  return Object.fromEntries(
    [
      "value",
      "units",
      "count",
      "healthy",
      "healthState",
      "passed",
      "sampledPassed",
      "checkOutcome",
    ]
      .filter(
        (key) =>
          Object.hasOwn(result, key) &&
          (result[key] === null ||
            typeof result[key] === "number" ||
            typeof result[key] === "boolean" ||
            (typeof result[key] === "string" && result[key].length <= 256)),
      )
      .map((key) => [key, result[key]]),
  );
}
export function summarizeBatchReport(report: BatchReport) {
  return {
    operation: "batch.summary",
    historical: true as const,
    modelValidated: false as const,
    success: report.success,
    status: report.status,
    runId: report.runId,
    reportPath: report.reportPath,
    sequence: report.sequence,
    ...(report.error ? { error: clone(report.error) } : {}),
    steps: report.steps.map((step, index) => {
      const result = smallResult(step.output);
      return {
        step: index + 1,
        id: step.id,
        status: step.status,
        ...(Object.keys(result).length ? { result } : {}),
        ...(step.expectFail ? { expectFail: true } : {}),
        ...(step.error ? { error: clone(step.error) } : {}),
      };
    }),
  };
}
export type BatchSummary = ReturnType<typeof summarizeBatchReport>;

export function formatBatchSummary(report: CadData): string {
  const summary: CadData = report["historical"]
    ? report
    : report["steps"]
      ? summarizeBatchReport(report as unknown as BatchReport)
      : report;
  const text = (value: unknown): string => JSON.stringify(value ?? null);
  const steps = (summary["steps"] || []) as CadData[];
  const errors = (summary["errors"] || []) as string[];
  return (
    [
      summary["steps"]
        ? "Historical reported outcome; not current model validation (modelValidated=false)."
        : "Offline input validation only; no report or model validated.",
      `status=${String(summary["status"] || (summary["success"] ? "input-validated-only" : "failed"))} runId=${text(summary["runId"])} reportPath=${text(summary["reportPath"])}`,
      ...(summary["error"] ? [`error=${text(summary["error"])}`] : []),
      ...steps.map(
        (step) =>
          `step=${String(step["step"])} id=${text(step["id"])} status=${String(step["status"])}${step["result"] ? ` result=${text(step["result"])}` : ""}${step["error"] ? ` error=${text(step["error"])}` : ""}`,
      ),
      ...errors.map((error) => `error=${text(error)}`),
    ].join("\n") + "\n"
  );
}
