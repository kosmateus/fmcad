import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  CadContext,
  CadData,
} from "../packages/core/src/application/cad/contracts.js";
import type { SaveBinding } from "../packages/core/src/application/documents/save.js";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Publication = typeof import("../src/composition/document-publication.js");
const current = load("./src/document-publication.js") as Publication;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const previous = historical(
  "a9cf665303cec7f3676416de7291f391c60cd897",
  "src/document-publication.js",
) as Publication;

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
    const results: unknown[] = [];
    for (const [name, api] of [
      ["previous", previous],
      ["current", current],
    ] as const) {
      const trace: Record<string, unknown>[] = [];
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
      const execute = async (
        actualClient: typeof client,
        operation: string,
        payload: CadData,
        target: CadContext,
      ) => {
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
        assert.equal(payload["creationId"], "creation");
        assert.equal(payload["fileId"], "file");
        assert.equal(payload["version"], 3);
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
          plan(binding: SaveBinding) {
            trace.push({ stage: "plan", binding });
            return "planned";
          },
          started(binding: SaveBinding) {
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
