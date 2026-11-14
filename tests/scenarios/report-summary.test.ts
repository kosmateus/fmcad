import test from "node:test";
import assert from "node:assert/strict";
import type { ScenarioReport } from "./runner";
import { scenarioSummary } from "./report-summary";
const report = (error: string): ScenarioReport => ({
  owner: { runId: "r", scenarioId: "s", clientId: "c" },
  directory: "/private/path",
  mode: "simulator",
  qualification: "broker",
  backendIdentity: "test",
  protocol: "mcp",
  status: "failed",
  cleanup: "deferred",
  error,
  requests: [
    {
      requestId: "private-request",
      phase: "thread-0",
      result: {
        requestId: "private-request",
        state: "failed",
        sdkSettled: true,
        mayHaveMutated: false,
        stdout: "secret payload",
        error,
      },
    },
  ],
});
test("CI failure summary retains phase, category and settlement without private output", () => {
  const result = scenarioSummary(
    report("AttributeError: SECRET_TOKEN at /private/path\n{password: secret}"),
  );
  assert.equal(result.failureType, "AttributeError");
  assert.equal(result.failurePhase, "thread-0");
  assert.equal(result.sdkSettled, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|SECRET|private|password/u,
  );
});
test("missing receipt remains explicitly unsettled and unsafe phase strings are redacted", () => {
  const value = report("INVALID_PYTHON_ARTIFACT: private payload");
  value.requests.splice(0, value.requests.length, {
    requestId: "r",
    phase: "unsafe phase /secret",
  });
  const result = scenarioSummary(value);
  assert.equal(result.failureCode, "INVALID_PYTHON_ARTIFACT");
  assert.equal(result.lastPhase, "unavailable");
  assert.equal(result.executionState, "no-terminal-receipt");
  assert.equal(result.sdkSettled, false);
  assert.equal(result.mayHaveMutated, true);
});
