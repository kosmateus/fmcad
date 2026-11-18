import test from "node:test";
import assert from "node:assert/strict";
import { queueExecReceipt, queueExecution } from "./queue-backend";
const owner = { clientId: "owner" };
const job = { clientId: "owner", requestId: "original", state: "succeeded" };

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
