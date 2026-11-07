import type { PythonCheckReport } from "../domain/python-checker.js";
import type { PreparedPythonArtifact } from "../domain/python-artifact.js";

/** A checker result is local evidence, never evidence of SDK execution. */
export function requirePythonAdmission(
  artifact: PreparedPythonArtifact,
  report: PythonCheckReport,
): void {
  if (
    report.status !== "passed" ||
    report.diagnostics.some((item) => item.severity !== "information") ||
    report.reasons.length !== 0 ||
    report.provenance.artifactHash !== artifact.artifactHash ||
    report.provenance.wireHash !== artifact.sha256 ||
    !report.provenance.analysisHash ||
    !report.provenance.checkerHash ||
    !report.provenance.configHash ||
    !report.provenance.typingHash
  ) {
    throw Object.assign(
      new Error(`Python admission rejected: ${report.status}`),
      {
        code: "PYTHON_CHECK_REJECTED",
        pythonCheck: report,
        executionOutcome: "not_started",
        notStarted: true,
        userScriptSubmitted: false,
        mayHaveMutated: false,
      },
    );
  }
}
