import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  legacyQueueReceipt,
  queueExecReceipt,
  queueExecution,
  scenarioQueueJobId,
} from "./queue-backend";
import { cliInspectionArguments } from "./contracts";
const owner = { clientId: "owner" };
const job = { clientId: "owner", requestId: "original", state: "succeeded" };

test("typed document inventory selects the public JSON CLI command without a script", () => {
  assert.deepEqual(cliInspectionArguments("doc-list-json"), [
    "doc",
    "list",
    "--json",
  ]);
});

test("public queue exec receipts bind the original owner, request and job", () => {
  const stderr = [
    `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId: "original", clientId: "owner" })}`,
    `FMCAD_QUEUE_JOB ${JSON.stringify({ jobId: "job-1", requestId: "original" })}`,
    `FMCAD_QUEUE_RESULT ${JSON.stringify({ id: "job-1", requestId: "original", state: "succeeded" })}`,
  ].join("\n");
  assert.deepEqual(queueExecReceipt(stderr, owner, "original"), {
    jobId: "job-1",
    state: "succeeded",
  });

  assert.throws(
    () => queueExecReceipt(stderr, { clientId: "other" }, "original"),
    /request receipt has a foreign identity/,
  );
  assert.throws(
    () =>
      queueExecReceipt(
        stderr.replace('"id":"job-1"', '"id":"foreign"'),
        owner,
        "original",
      ),
    /terminal receipt has a foreign identity/,
  );
  assert.throws(
    () =>
      queueExecReceipt(
        stderr.split("\n").slice(0, 1).join("\n"),
        owner,
        "original",
      ),
    /job receipt is missing or mismatched/,
  );
});

test("terminal queue job without usable SDK evidence remains unknown and retains diagnostics", () => {
  for (const execution of [
    undefined,
    null,
    [],
    "settled",
    {},
    { sdkSettled: false },
  ]) {
    const original = { job, execution, stdout: "mutation already happened" };
    const decoded = queueExecution(original, owner, "original");
    assert.equal(decoded.state, "unknown");
    assert.equal(decoded.sdkSettled, false);
    assert.equal(decoded.mayHaveMutated, true);
    assert.equal(decoded.stdout, original.stdout);
    assert.equal(decoded.error, JSON.stringify(original));
  }
});
test("queue decoding preserves affirmative SDK evidence and exact original identity", () => {
  for (const state of ["succeeded", "failed"] as const) {
    const result = queueExecution(
      {
        job: { ...job, state },
        execution: { sdkSettled: true, mayHaveMutated: false },
      },
      owner,
      "original",
    );
    assert.equal(result.state, state);
    assert.equal(result.sdkSettled, true);
    assert.equal(result.mayHaveMutated, false);
    assert.equal(result.stdout, "");
  }
  for (const mismatch of [{ clientId: "foreign" }, { requestId: "another" }])
    assert.throws(
      () => queueExecution({ job: { ...job, ...mismatch } }, owner, "original"),
      /Foreign original job result/,
    );
});

test("durable preflight no-dispatch proof settles only its exact accepted failed job", () => {
  const original = {
    job: {
      ...job,
      id: "job-1",
      state: "failed",
      code: "NOT_DISPATCHED",
      operationResult: {
        version: 1,
        requestId: "original",
        jobId: "job-1",
        acceptance: "accepted",
        executionOutcome: "not_started",
        mayHaveMutated: false,
        code: "NOT_DISPATCHED",
      },
    },
    execution: {
      state: "failed",
      code: "NOT_DISPATCHED",
      executionOutcome: "not_started",
      userScriptSubmitted: false,
      mayHaveMutated: false,
      preflightCompleted: true,
      source: "durable-preflight-evidence",
    },
  };
  const result = queueExecution(original, owner, "original");
  assert.equal(result.state, "failed");
  assert.equal(result.sdkSettled, true);
  assert.equal(result.mayHaveMutated, false);
  for (const [section, key, value] of [
    ["execution", "sdkSettled", false],
    ["execution", "source", undefined],
    ["execution", "preflightCompleted", false],
    ["execution", "userScriptSubmitted", true],
    ["execution", "mayHaveMutated", true],
    ["execution", "executionOutcome", "unknown"],
    ["execution", "code", "OTHER"],
    ["execution", "state", "unknown"],
    ["job", "state", "running"],
    ["job", "code", "OTHER"],
    ["job", "id", ""],
    ["job", "dispatch", { rpcCount: 1 }],
    ["job", "physicalTurns", 1],
    ["operationResult", "jobId", "foreign"],
    ["operationResult", "requestId", "foreign"],
    ["operationResult", "acceptance", "rejected"],
    ["operationResult", "version", 2],
    ["operationResult", "executionOutcome", "unknown"],
    ["operationResult", "mayHaveMutated", true],
    ["operationResult", "code", "OTHER"],
  ] as const) {
    const changed =
      section === "operationResult"
        ? {
            ...original,
            job: {
              ...original.job,
              operationResult: {
                ...original.job.operationResult,
                [key]: value,
              },
            },
          }
        : { ...original, [section]: { ...original[section], [key]: value } };
    const refused = queueExecution(changed, owner, "original");
    assert.equal(refused.state, "unknown", `${section}.${key}`);
    assert.equal(refused.sdkSettled, false, `${section}.${key}`);
  }
});

test("legacy child receipt lookup uses the selected scenario artifact root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-queue-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyOwner = {
      runId: "11111111-1111-4111-8111-111111111111",
      scenarioId: "native-legacy-0",
      clientId: "scenario:11111111-1111-4111-8111-111111111111:native-legacy-0",
    },
    receiptId = "22222222-2222-4222-8222-222222222222",
    requestId = legacyOwner.clientId + ":legacy:" + receiptId,
    receipt = path.join(
      root,
      legacyOwner.runId,
      legacyOwner.scenarioId,
      "legacy",
      "queue-receipts",
      receiptId + ".json",
    );
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      version: 1,
      owner: legacyOwner,
      requestId,
      jobId: "original-job",
    }),
  );

  assert.equal(
    legacyQueueReceipt(root, legacyOwner, requestId),
    "original-job",
  );
  assert.equal(
    legacyQueueReceipt(
      root,
      legacyOwner,
      legacyOwner.clientId + ":legacy:invalid",
    ),
    undefined,
  );
  assert.equal(
    legacyQueueReceipt(
      root,
      legacyOwner,
      legacyOwner.clientId +
        ":legacy:" +
        "33333333-3333-4333-8333-333333333333",
    ),
    undefined,
  );
});

test("scenario recovery reads candidate job IDs from its owner-bound report", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-queue-job-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = "11111111-1111-4111-8111-111111111111",
    scenarioId = "native-legacy-0",
    clientId = `scenario:${runId}:${scenarioId}`,
    requestId = clientId + ":0",
    owner = { runId, scenarioId, clientId },
    report = path.join(root, runId, scenarioId, "report.json");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(
    report,
    JSON.stringify({
      owner,
      requests: [
        {
          requestId,
          result: {
            brokerReceipt: {
              requestId,
              clientId,
              jobId: "candidate-job",
              state: "succeeded",
            },
          },
        },
      ],
    }),
  );

  assert.equal(scenarioQueueJobId(root, owner, requestId), "candidate-job");
  assert.equal(
    scenarioQueueJobId(root, owner, clientId + ":unlisted"),
    undefined,
  );
});

test("recovery audit reads its original coordinator result sidecar", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-queue-job-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = "11111111-1111-4111-8111-111111111111",
    clientId = `scenario:${runId}:coordinator`,
    requestId = clientId + ":before",
    owner = { runId, scenarioId: "coordinator", clientId },
    result = path.join(root, runId, "_coordinator", "before.result.json");
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(
    result,
    JSON.stringify({
      requestId,
      brokerReceipt: {
        requestId,
        clientId,
        jobId: "coordinator-job",
        state: "succeeded",
      },
    }),
  );

  assert.equal(scenarioQueueJobId(root, owner, requestId), "coordinator-job");
});
