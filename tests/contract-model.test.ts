import { createRequire } from "node:module";
import { object, number, present } from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "contract-model.test.ts"),
);
const core = load(
  "../packages/core/dist",
) as typeof import("../packages/core/src/index.js");
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state.js");

const result = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  requestId: null,
  jobId: null,
  acceptance: "accepted",
  executionOutcome: "unknown",
  mayHaveMutated: null,
  validation: {
    status: "not_checked",
    source: null,
    artifactId: null,
    measurements: {},
  },
  code: null,
  ...extra,
});

test("result roundtrip keeps acceptance, unknown mutation, partial evidence and explicit units", () => {
  for (const executionOutcome of [
    "not_started",
    "active",
    "partial",
    "succeeded",
    "failed",
    "unknown",
  ]) {
    for (const status of [
      "not_checked",
      "pass",
      "fail",
      "partial",
      "unknown",
      "unavailable",
    ]) {
      const dto = result({
        executionOutcome,
        validation: {
          status,
          source: "fixture",
          artifactId: core.id("artifact", "a1"),
          measurements: {
            length: { value: 10, unit: "mm" },
            missing: { value: null, unit: "cm3" },
          },
        },
      });
      assert.deepEqual(
        core.decodeResult(
          JSON.parse(core.encodeResult(core.decodeResult(dto))),
        ),
        dto,
      );
    }
  }
  assert.equal(
    core.decodeResult(result({ executionOutcome: "succeeded" })).validation
      .status,
    "not_checked",
  );
  assert.equal(
    core.decodePublicResult({ success: true, accepted: true }).executionOutcome,
    "unknown",
  );
  assert.equal(
    core.decodePublicResult({
      executionOutcome: "not_started",
      mayHaveMutated: null,
    }).mayHaveMutated,
    null,
  );
  assert.equal(
    core.decodePublicResult({ executionOutcome: null, state: "succeeded" })
      .executionOutcome,
    "unknown",
  );
  assert.equal(
    core.decodePublicResult({ success: true, result: { sampledPassed: true } })
      .validation.status,
    "partial",
  );
  assert.equal(
    core.decodePublicResult({ success: true, result: { passed: null } })
      .validation.status,
    "unknown",
  );
  for (const status of ["pass", "fail", "partial", "unknown", "unavailable"])
    assert.equal(
      core.decodePublicResult({ success: true, result: { status } }).validation
        .status,
      status,
    );
  for (const executionOutcome of [
    "completed_postflight_not_submitted",
    "previous_turns_complete_current_not_started",
  ])
    assert.equal(
      core.decodePublicResult({ executionOutcome, mayHaveMutated: true })
        .executionOutcome,
      "partial",
    );
});

test("strict decoders reject future formats, malformed fields, live objects, secrets and nonfinite geometry", () => {
  for (const dto of [
    result({ version: 2 }),
    result({ token: "SECRET" }),
    result({ credentialStore: "/secret" }),
    result({ runtime: new Date() }),
    result({ acceptance: null }),
    result({ executionOutcome: "completed" }),
    result({ mayHaveMutated: "false" }),
    result({ executionOutcome: "not_started", mayHaveMutated: true }),
    new Date(),
    null,
  ])
    assert.throws(() => core.decodeResult(dto));
  for (const quantity of [
    { value: NaN, unit: "mm" },
    { value: Infinity, unit: "mm" },
    { value: 1, unit: "inferred" },
    { value: 1, unit: "mm", token: "SECRET" },
  ])
    assert.throws(() =>
      core.decodeResult(
        result({
          validation: {
            status: "partial",
            source: null,
            artifactId: null,
            measurements: { length: quantity },
          },
        }),
      ),
    );
  assert.throws(() => core.decodePublicResult({ version: 99, success: true }));
  assert.throws(() => core.decodePublicResult({ arbitrary: true }));
  assert.throws(() =>
    core.decodePublicResult({ executionOutcome: "future_success" }),
  );
  assert.throws(() =>
    core.decodePublicResult({
      executionOutcome: {
        toString() {
          return "succeeded";
        },
      },
    }),
  );
  assert.throws(() =>
    core.decodeResult({ ...result(), [Symbol("private")]: "SECRET" }),
  );
  assert.throws(() =>
    core.decodeResult(
      Object.defineProperty(result(), "code", {
        get() {
          throw new Error("must not execute");
        },
      }),
    ),
  );
  const projected = core.decodePublicResult({
    success: true,
    token: "SECRET",
    credentialsPath: "/secret",
    process: { env: { TOKEN: "SECRET" } },
  });
  assert.doesNotMatch(
    core.encodeResult(projected),
    /SECRET|credentialsPath|process/,
  );
});

test("request identity is explicit and does not accept credentials or runtime properties", () => {
  const context = {
    version: 1,
    clientId: "c",
    requestId: "r",
    sessionId: null,
    projectId: null,
    documentId: null,
    instanceId: null,
    purpose: null,
  };
  assert.deepEqual(
    core.decodeRequestContext(JSON.parse(JSON.stringify(context))),
    context,
  );
  const request = {
    context,
    operation: "geometry.inspect",
    arguments: { limit: null, list: [1, "mm"] },
  };
  assert.deepEqual(
    core.decodeRequest(
      JSON.parse(core.encodeRequest(core.decodeRequest(request))),
    ),
    request,
  );
  const event = {
    version: 1,
    context,
    jobId: null,
    atMs: 100,
    name: "execution.observed",
    data: { available: null },
  };
  assert.deepEqual(
    core.decodeEvent(JSON.parse(core.encodeEvent(core.decodeEvent(event)))),
    event,
  );
  assert.throws(() => core.decodeEvent({ ...event, version: 2 }));
  assert.throws(() =>
    core.decodeEvent({ ...event, data: { authorization: "SECRET" } }),
  );
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  for (const args of [
    { token: "SECRET" },
    { nested: { credentialsPath: "/private" } },
    { runtime: new Date() },
    { value: undefined },
    { value: Infinity },
    cycle,
  ])
    assert.throws(() => core.decodeRequest({ ...request, arguments: args }));
  for (const change of [
    { version: 2 },
    { token: "SECRET" },
    { clientId: "" },
    { purpose: "\n" },
    { purpose: "a".repeat(1001) },
    { sessionId: {} },
  ])
    assert.throws(() => core.decodeRequestContext({ ...context, ...change }));
});

test("real persisted queue snapshot projects IDs without request internals and rejects future versions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new QueueState(directory);
  state.submit({
    clientId: "client",
    requestId: "request",
    kind: "command",
    argv: ["run", "part.py"],
    timeoutMs: 1000,
    cwd: directory,
  });
  const snapshot = object(
    JSON.parse(
      fs.readFileSync(path.join(directory, "queue-state.json"), "utf8"),
    ),
  );
  const job = object(present(Object.values(object(snapshot["jobs"]))[0]));
  const dto = core.decodePersistedJob(job, number(snapshot["version"]));
  assert.equal(dto.jobId, job["id"]);
  assert.equal(dto.requestId, job["requestId"]);
  assert.equal(dto.executionOutcome, "not_started");
  assert.equal(dto.mayHaveMutated, false);
  assert.doesNotMatch(
    core.encodeResult(core.decodeResult(dto)),
    /cwd|code.*pass/,
  );
  assert.throws(() => core.decodePersistedJob(job, 2));
  assert.equal(
    core.decodePersistedJob({ ...job, state: "needs_reconciliation" }, 1)
      .executionOutcome,
    "unknown",
  );
  assert.equal(
    core.decodePersistedJob({ ...job, state: "needs_reconciliation" }, 1)
      .mayHaveMutated,
    null,
  );
  assert.equal(
    core.decodePersistedJob(
      { ...job, state: "succeeded", details: { executionOutcome: null } },
      1,
    ).executionOutcome,
    "unknown",
  );
  assert.throws(() => core.decodePersistedJob({ ...job, state: "future" }, 1));
});

test("receipt compatibility never mistakes nonterminal or unknown receipt for success", () => {
  assert.equal(
    core.decodePersistedReceipt({ terminal: false }).executionOutcome,
    "unknown",
  );
  for (const outcome of ["succeeded", "failed"]) {
    const dto = core.decodePersistedReceipt({
      terminal: true,
      outcome,
      requestId: "r",
      jobId: "j",
      receiptPath: "/private",
      token: "SECRET",
    });
    assert.equal(dto.executionOutcome, outcome);
    assert.equal(dto.validation.status, "not_checked");
    assert.equal(dto.mayHaveMutated, null);
    assert.doesNotMatch(
      core.encodeResult(core.decodeResult(dto)),
      /private|SECRET/,
    );
  }
  for (const receipt of [
    { terminal: true, outcome: "unknown" },
    { terminal: "true", outcome: "succeeded" },
    { version: 2, terminal: true, outcome: "succeeded" },
  ])
    assert.throws(() => core.decodePersistedReceipt(receipt));
});

test("deadline/cancellation stop observation or local work, never Fusion implicitly", () => {
  assert.equal(core.deadlineExpired(100, 110, 10), true);
  assert.equal(core.deadlineExpired(100, 110, null), false);
  assert.throws(() => core.deadlineExpired(100, 110, -1));
  for (const phase of [
    "queue",
    "sdk",
    "pause",
    "prepare",
    "finalize",
  ] as const) {
    const interruption = core.interruption(phase, "deadline", phase === "sdk");
    assert.equal(interruption.fusionCancelled, false);
    assert.equal(interruption.requiresReconciliation, phase === "sdk");
    assert.equal(
      interruption.stopped,
      phase === "sdk"
        ? "observation"
        : ["prepare", "finalize"].includes(phase)
          ? "local_process"
          : "waiting",
    );
  }
});

test("transitional facade shares unchanged legacy exit policy", () => {
  for (const value of [
    { success: true },
    { status: "unknown" },
    { result: { passed: false } },
  ])
    assert.equal(
      (
        load("../src/outcome") as typeof import("../packages/core/src/index.js")
      ).failedOutcome(value),
      core.failedOutcome(value),
    );
  assert.equal(
    core.failedOutcome({ success: true, metadata: { status: "failed" } }),
    false,
  );
  assert.equal(
    core.failedOutcome({ success: true, result: { passed: false } }),
    true,
  );
  assert.equal(
    core.failedOutcome({
      success: true,
      result: { restored: false, leftRequestedState: true },
    }),
    false,
  );
  assert.equal(core.failedOutcome(result()), true);
  assert.equal(
    core.failedOutcome(result({ executionOutcome: "succeeded" })),
    false,
  );
  assert.equal(
    core.failedOutcome(result({ version: 2, executionOutcome: "succeeded" })),
    true,
  );
});
