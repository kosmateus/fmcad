import { decodeResult } from "../domain/codec";
import type { ConsoleRow } from "./console-read-model";

/** Allowlisted observation projection; command/path enrichment belongs to adapters. */
export function projectConsoleOperation(
  job: Readonly<Record<string, unknown>>,
  text: (value: string) => string = (value) => value,
): ConsoleRow {
  const result: ConsoleRow = {};
  if (job["operationResult"])
    result.operationResult = decodeResult(job["operationResult"]);
  for (const key of [
    "id",
    "requestId",
    "clientId",
    "sessionId",
    "state",
    "kind",
    "submittedAt",
    "startedAt",
    "finishedAt",
    "timeoutMs",
    "sequenceId",
    "revision",
    "httpStatus",
    "outcomeScope",
    "order",
    "document",
    "code",
    "executionOutcome",
    "userScriptSubmitted",
    "mayHaveMutated",
    "contextRefreshRequired",
    "sourcePath",
    "sourceHash",
    "exitCode",
  ]) {
    const value = job[key];
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      result[key] = typeof value === "string" ? text(value) : value;
  }
  result.label =
    typeof job["label"] === "string" && job["label"]
      ? text(job["label"])
      : typeof job["kind"] === "string"
        ? job["kind"]
        : "operation";
  const details = job["details"];
  if (details && typeof details === "object") {
    for (const key of [
      "executionOutcome",
      "userScriptSubmitted",
      "mayHaveMutated",
      "exitCode",
    ]) {
      const value = (details as Record<string, unknown>)[key];
      if (
        value === null ||
        ["string", "boolean", "number"].includes(typeof value)
      )
        result[key] = typeof value === "string" ? text(value) : value;
    }
  }
  return result;
}
