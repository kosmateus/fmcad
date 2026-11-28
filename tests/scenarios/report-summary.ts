import type { ScenarioReport } from "./runner";

/** Console summaries expose categories and phase names, never payloads or exception text. */
interface Summary {
  failureType?: string;
  failureCode?: string;
  lastPhase?: string;
  failurePhase?: string;
  executionState?: string;
  sdkSettled?: boolean;
  mayHaveMutated?: boolean;
}
export function scenarioSummary(report: ScenarioReport): Summary {
  if (report.status === "passed") return {};
  const last = report.requests.at(-1);
  const failed =
    report.requests.find((request) => request.result?.state !== "succeeded") ??
    report.requests
      .filter((request) => !request.phase.startsWith("cleanup"))
      .at(-1) ??
    last;
  const error = report.error ?? "";
  const types = [
    "AssertionError",
    "AttributeError",
    "TypeError",
    "ValueError",
    "RuntimeError",
    "NotImplementedError",
    "SyntaxError",
  ] as const;
  const codes = [
    "INVALID_PYTHON_ARTIFACT",
    "PYTHON_CHECK_FAILED",
    "PYTHON_CHECK_REJECTED",
    "LOCAL_PHASE_TIMEOUT",
    "LOCAL_EXECUTION_FAILED",
    "CHECKER_PROVENANCE_CHANGED",
    "CHECKER_TIMEOUT",
    "QUEUE_TIMEOUT",
    "DOCUMENT_IDENTITY_MISMATCH",
    "RUNNER_EXECUTION_UNKNOWN",
  ] as const;
  const failureType =
    types.find(
      (name) => error.includes(name + ":") || error.startsWith(name),
    ) ??
    (/Expected|expected|!==|does not|differs/u.test(error)
      ? "ContractError"
      : "ScenarioError");
  const code = codes.find((name) => error.includes(name));
  const safePhase = (value: string | undefined) =>
    value && /^[a-zA-Z0-9_.-]{1,120}$/u.test(value) ? value : "unavailable";
  return {
    failureType,
    ...(code ? { failureCode: code } : {}),
    lastPhase: safePhase(last?.phase),
    failurePhase: safePhase(failed?.phase),
    executionState: failed?.result?.state ?? "no-terminal-receipt",
    sdkSettled: failed?.result?.sdkSettled ?? false,
    mayHaveMutated: failed?.result?.mayHaveMutated ?? true,
  };
}
