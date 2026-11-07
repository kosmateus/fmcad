"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const current = require("../src/document-publication");
const previous = require("./fixtures/historical-module.cjs")(
  "a9cf665303cec7f3676416de7291f391c60cd897",
  "src/document-publication.js",
);

for (const expected of ["complete", "noop", "unknown"]) {
  test(`publication retains ${expected} evidence, stage binding and one submission`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "publication-parity-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const context = {
      doc: "Owned",
      docId: "creation",
      docFileId: "file",
      projectId: "project",
    };
    const results = [];
    for (const [name, api] of [
      ["previous", previous],
      ["current", current],
    ]) {
      const trace = [];
      let reads = 0,
        saves = 0;
      const data = {
        requestId: "request",
        operationId: "operation",
        projectId: "project",
        fileId: "file",
        creationId: "creation",
        expectedVersion: 3,
        confirm: true,
        reportPath: path.join(root, name),
        timeBudgetMs: 50,
      };
      const client = { fixture: name };
      const execute = async (actualClient, operation, payload, target) => {
        assert.equal(actualClient, client);
        assert.deepEqual(target, context);
        trace.push({ operation, payload, target });
        if (operation === "document.status") {
          reads++;
          return {
            success: true,
            result: {
              name: "Owned",
              creationId: "creation",
              fileId: "file",
              projectId: "project",
              saved: true,
              version: reads === 1 ? 3 : 4,
              modified: reads === 1 && expected !== "noop",
              isComplete: true,
              isReadOnly: false,
            },
          };
        }
        assert.equal(operation, "document.save_native");
        assert.equal(payload.creationId, "creation");
        assert.equal(payload.fileId, "file");
        assert.equal(payload.version, 3);
        saves++;
        if (expected === "unknown") throw new Error("reply lost after submit");
        return {
          success: true,
          result: { status: "accepted", accepted: true },
        };
      };
      const deps = {
        now: () => 0,
        sleep: async () => {},
        stages: {
          plan(binding) {
            trace.push({ stage: "plan", binding });
            return "planned";
          },
          started(binding) {
            trace.push({ stage: "started", binding });
            return "started";
          },
        },
      };
      const first = await api.execute(
        client,
        "document.save.once",
        data,
        context,
        execute,
        deps,
      );
      assert.equal(first.status, expected);
      const replay = await api.execute(
        client,
        "document.save.once",
        data,
        context,
        execute,
        deps,
      );
      assert.equal(replay.replayedReceipt, true);
      assert.equal(saves, expected === "noop" ? 0 : 1);
      results.push({ first, replay, trace });
    }
    assert.deepEqual(results[1], results[0]);
  });
}
