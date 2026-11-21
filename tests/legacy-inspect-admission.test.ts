import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  path.join(root, "packages/node-adapters/dist/python/checker.js"),
) as typeof import("../packages/node-adapters/src/python/checker.js");
const { prepareOpScript } = load(
  path.join(root, "src/ops.js"),
) as typeof import("../packages/node-adapters/src/python/legacy-operations.js");
const typingRoot = path.join(root, "dist/runtime/python/typing");

test(
  "legacy inspection operations pass the real strict checker with their actual argument injection",
  async () => {
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const [operation, args] of [
      ["stats", ["Model"]],
      ["bbox", ["Model"]],
      ["bodies", ["Model"]],
      ["rollback", ["1", "Model"]],
      ["units", ["mm", "Model"]],
    ] as const) {
      const artifact = prepareOpScript(operation, [...args]);
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(
        report.status,
        "passed",
        `${operation}: ${JSON.stringify(report)}`,
      );
      assert.equal(report.provenance.checker, "basedpyright");
    }
  },
);
