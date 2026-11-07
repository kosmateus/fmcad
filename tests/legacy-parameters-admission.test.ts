import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { prepareOpScript } = load(
  "./src/ops",
) as typeof import("../packages/node-adapters/src/python/legacy-operations");

test(
  "shipped parameter commands pass production admission without the data-manager monolith",
  { timeout: 180_000 },
  async () => {
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const [operation, args] of [
      ["param_list", ["Model"]],
      ["param_add", ["width", "10 mm", "", "comment", "Model"]],
      ["param_set", ["width", "20 mm", "Model"]],
      ["param_rename", ["width", "newWidth", "Model"]],
      ["param_delete", ["newWidth", "Model"]],
    ] as const) {
      const artifact = prepareOpScript(operation, args);
      assert.equal(artifact.units.length, 1);
      assert.equal(
        artifact.units[0]?.filename,
        "runtime/python/fmcad/adapters/fusion/legacy_parameters.py",
      );
      assert.doesNotMatch(artifact.script, /def cmd_file_delete/);
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
