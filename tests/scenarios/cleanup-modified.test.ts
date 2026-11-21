import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, remaining } from "./test-support";
import { runScenarios } from "./runner";
import * as programs from "./programs";

for (const modified of [false, true]) {
  for (const expected of [false, true, undefined]) {
    test(`unsaved cleanup checks modified=${modified}, expected=${expected} in the close turn`, async (t) => {
      const { directory, model, backend } = await fixture(t);
      const [report] = await runScenarios(
        backend,
        [
          {
            id: "modified-phase",
            scope: "exclusive-instance",
            requires: ["documents", "fixture-export"],
            async run(session) {
              if (expected !== undefined)
                session.expectCleanupModified(expected);
              if (modified) {
                const changed = await model.execute(
                  programs.program(
                    "import adsk.core\napp = adsk.core.Application.get()\napp.activeDocument.isModified = True",
                  ),
                );
                assert.equal(changed.success, true);
              }
              assert.equal(session.report.cleanupExpectedModified, expected);
              const persisted = JSON.parse(
                fs.readFileSync(
                  path.join(session.directory, "report.json"),
                  "utf8",
                ),
              ) as { cleanupExpectedModified?: boolean };
              assert.equal(persisted.cleanupExpectedModified, expected);
            },
          },
        ],
        directory,
        1,
      );
      assert.ok(report);
      const beforeClose = report.requests.find(
        (row) => row.phase === "cleanup",
      );
      assert.ok(beforeClose, "real close dispatch must be attempted");
      const mismatch = expected !== undefined && modified !== expected;
      assert.equal(
        report.cleanup,
        mismatch ? "failed" : "complete",
        JSON.stringify(report),
      );
      const documents = ((await remaining(model)) as { documents: unknown[] })
        .documents;
      assert.equal(documents.length, mismatch ? 1 : 0);
      if (mismatch) {
        assert.match(report.cleanupError || "", /modification state differs/u);
        assert.equal(beforeClose.result?.state, "failed");
      }
    });
  }
}

test("cleanup phase cannot be inferred after an uncertain request", async (t) => {
  const { directory, backend } = await fixture(t);
  const [report] = await runScenarios(
    backend,
    [
      {
        id: "unknown-phase",
        requires: ["documents", "fixture-export"],
        async run(session) {
          session.expectCleanupModified(false);
          assert.throws(
            () => session.deferCleanup("unknown original"),
            /unknown original/u,
          );
          assert.throws(
            () => session.expectCleanupModified(true),
            /unsettled request/u,
          );
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(report?.cleanup, "deferred");
  assert.equal(report.cleanupExpectedModified, false);
  assert.equal(
    report.requests.some((row) => row.phase === "cleanup"),
    false,
  );
});
