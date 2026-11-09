interface Fixture {
  dir: string;
  state: {
    epoch: Parameters<
      ReturnType<
        typeof import("../src/composition/library-saved-runtime").createSavedRuntime
      >["firstSaveEvidence"]
    >[1];
  };
  job: { id: string };
  jobDirectory: string;
}
import { createRequire } from "node:module";
const root = process.cwd();
const load = createRequire(
  path.join(root, "tests", "saved-first-save-evidence.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { firstSaveEvidence } = load(
  "../src/queue-saved-first-save-evidence",
) as Pick<
  ReturnType<
    typeof import("../src/composition/library-saved-runtime").createSavedRuntime
  >,
  "firstSaveEvidence"
>;

test("FAKE first-save ledger requires exact worker/SDK/postflight and accepted output before publication", (t) => {
  const f = (
    load("./fixtures/saved-first-save-evidence.cjs") as (
      t: test.TestContext,
      root: string,
    ) => Fixture
  )(t, root);
  const value = firstSaveEvidence(f.dir, f.state.epoch, f.job.id);
  assert.equal(value.reply.accepted, true);
  assert.equal(value.reply.status, "pending");
  assert.equal(value.job.id, f.job.id);
  assert.ok(value.evidence.length >= 8);
});

for (const mode of [
  "foreign-job",
  "failed-physical",
  "wrong-scope",
  "postflight-doc",
  "failed-envelope",
])
  test("FAKE first-save evidence refuses " + mode, (t) => {
    const f = (
      load("./fixtures/saved-first-save-evidence.cjs") as (
        t: test.TestContext,
        root: string,
      ) => Fixture
    )(t, root);
    let id = f.job.id;
    if (mode === "foreign-job") id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    if (mode === "failed-physical") {
      const record = api.readJson(path.join(f.jobDirectory, "rpc-1.json")) as {
        receipt: string;
      };
      api.durable(record.receipt, {
        ...(api.readJson(record.receipt) as Record<string, unknown>),
        outcome: "failed",
      });
    }
    if (mode === "wrong-scope") {
      const file = path.join(f.jobDirectory, "rpc-1.json"),
        record = api.readJson(file) as { binding: { auditFirstSave: boolean } };
      record.binding.auditFirstSave = false;
      api.durable(file, record);
    }
    if (mode === "postflight-doc")
      api.durable(path.join(f.jobDirectory, "postflight.json"), {
        documentState: {
          status: "complete",
          state: { identity: { creationId: "user-file" } },
        },
      });
    if (mode === "failed-envelope")
      fs.writeFileSync(
        path.join(f.jobDirectory, "stdout.txt"),
        JSON.stringify({ success: false }),
      );
    assert.throws(() => firstSaveEvidence(f.dir, f.state.epoch, id), {
      code: "SAVED_FIRST_SAVE_EVIDENCE_REQUIRED",
    });
  });
