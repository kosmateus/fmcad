import type {
  ExecutionOutcome,
  OperationResult,
  ValidationStatus,
} from "./contracts";
import { classifyEvidence } from "./evidence";
const failures = [
  "fail",
  "failed",
  "blocked",
  "unknown",
  "unsupported",
  "missing",
  "stale",
  "unavailable",
];
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function acceptedPendingDocumentSave(value: Record<string, unknown>): boolean {
  if (value["operation"] !== "document.save_as" || value["success"] !== true)
    return false;
  if (
    (value["status"] !== undefined && value["status"] !== "pending") ||
    value["error"] !== undefined
  )
    return false;
  const result = record(value["result"]);
  if (!result) return false;
  const current = record(result["current"]);
  const target = record(result["target"]);
  if (!current || !target) return false;
  return !!(
    result["accepted"] === true &&
    result["pending"] === true &&
    result["status"] === "pending" &&
    result["targetObserved"] === true &&
    current["saved"] === true &&
    current["modified"] === false &&
    current["isComplete"] === false &&
    ["creationId", "fileId", "fileName", "projectId", "folderId"].every(
      (key) => typeof current[key] === "string" && current[key],
    ) &&
    target["name"] === current["fileName"] &&
    target["projectId"] === current["projectId"] &&
    target["folderId"] === current["folderId"]
  );
}
function passedParameterTestV2(
  output: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  const coverage = record(result["coverage"]);
  const cases = result["cases"];
  if (
    output["success"] !== true ||
    result["version"] !== 2 ||
    result["status"] !== "pass" ||
    result["passed"] !== true ||
    result["primaryError"] !== null ||
    !Array.isArray(result["restoreErrors"]) ||
    result["restoreErrors"].length !== 0 ||
    result["restored"] !== true ||
    result["budgetExhausted"] !== false ||
    !coverage ||
    !Array.isArray(cases) ||
    cases.length === 0 ||
    !Number.isInteger(coverage["required"]) ||
    coverage["required"] !== cases.length ||
    coverage["completed"] !== cases.length ||
    coverage["skipped"] !== 0
  )
    return false;
  const caseIds = new Set<string>();
  return cases.every((item) => {
    const testCase = record(item);
    if (
      !testCase ||
      typeof testCase["id"] !== "string" ||
      !testCase["id"].trim() ||
      caseIds.has(testCase["id"]) ||
      testCase["status"] !== "pass" ||
      testCase["passed"] !== true ||
      testCase["primaryError"] !== null ||
      !Array.isArray(testCase["restoreErrors"]) ||
      testCase["restoreErrors"].length !== 0 ||
      testCase["restored"] !== true ||
      testCase["healthPassed"] !== true ||
      !Array.isArray(testCase["health"]) ||
      !Array.isArray(testCase["restoredHealth"]) ||
      !Array.isArray(testCase["checks"]) ||
      (testCase["callbackPassed"] !== undefined &&
        testCase["callbackPassed"] !== true) ||
      (testCase["restoredCallbackPassed"] !== undefined &&
        testCase["restoredCallbackPassed"] !== true)
    )
      return false;
    caseIds.add(testCase["id"]);
    return testCase["checks"].every((check) => {
      const value = record(check);
      return value?.["passed"] === true && value["status"] === "pass";
    });
  });
}
/** Transitional public exit-code policy, independent of SDK outcome. */
export function failedOutcome(output: unknown): boolean {
  const value = record(output);
  if (value && "version" in value) {
    const validation = record(value["validation"]);
    return (
      value["version"] !== 1 ||
      !["accepted", "unknown"].includes(String(value["acceptance"])) ||
      !["not_started", "active", "succeeded"].includes(
        String(value["executionOutcome"]),
      ) ||
      !validation ||
      !["not_checked", "pass", "partial"].includes(String(validation["status"]))
    );
  }
  if (value && value["operation"] === "parameter.test") {
    const result = record(value["result"]);
    if (result && "version" in result)
      return !passedParameterTestV2(value, result);
  }
  if (value && acceptedPendingDocumentSave(value)) return false;
  if (
    !value ||
    value["success"] === false ||
    failures.includes(String(value["status"]))
  )
    return true;
  const evidence = record(value["result"]);
  return !!(evidence && failures.includes(classifyEvidence(evidence)));
}
/** Transport success alone is not execution or model validation. */
export function legacyResult(
  value: unknown,
  { allowUnknownExecutionOutcome = false }: { allowUnknownExecutionOutcome?: boolean } = {},
): OperationResult {
  const output = record(value);
  if (!output || "version" in output)
    throw new Error("Unsupported legacy result");
  const legacyExplicit = output["executionOutcome"];
  const explicit =
    legacyExplicit === null
      ? "unknown"
      : allowUnknownExecutionOutcome && legacyExplicit === "completed"
        ? output["state"] === "succeeded" || output["state"] === "failed"
          ? output["state"]
          : "unknown"
      : typeof legacyExplicit === "string" &&
          [
            "completed_postflight_not_submitted",
            "previous_turns_complete_current_not_started",
          ].includes(legacyExplicit)
        ? "partial"
        : legacyExplicit;
  const supported = [
    "not_started",
    "active",
    "partial",
    "succeeded",
    "failed",
    "unknown",
  ];
  if (
    explicit !== undefined &&
    (typeof explicit !== "string" ||
      (!allowUnknownExecutionOutcome && !supported.includes(explicit)))
  )
    throw new Error("Unsupported execution outcome");
  let executionOutcome: ExecutionOutcome = "unknown";
  if (
    typeof explicit === "string" &&
    supported.includes(explicit)
  )
    executionOutcome = explicit as ExecutionOutcome;
  else if (
    explicit === undefined &&
    (output["state"] === "succeeded" || output["state"] === "failed")
  )
    executionOutcome = output["state"];
  const evidence = record(output["result"]);
  let status: ValidationStatus = "not_checked";
  if (evidence) status = classifyEvidence(evidence);
  return {
    version: 1,
    requestId: null,
    jobId: null,
    acceptance:
      output["accepted"] === true
        ? "accepted"
        : output["accepted"] === false
          ? "rejected"
          : "unknown",
    executionOutcome,
    mayHaveMutated:
      output["mayHaveMutated"] === null
        ? null
        : typeof output["mayHaveMutated"] === "boolean"
          ? output["mayHaveMutated"]
          : executionOutcome === "not_started"
            ? false
            : null,
    validation: { status, source: null, artifactId: null, measurements: {} },
    code: typeof output["code"] === "string" ? output["code"] : null,
  };
}
