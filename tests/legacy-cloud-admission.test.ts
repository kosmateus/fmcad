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
  "all cloud commands pass production admission",
  { timeout: 180_000 },
  async () => {
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const [operation, args] of [
      ["projects", []],
      ["project_create", ["Project", "Purpose"]],
      ["project_rename", ["Project", "Renamed"]],
      ["folder_list", ["Project"]],
      ["folder_create", ["Project", "A/B"]],
      ["folder_rename", ["Project", "A/B", "C"]],
      ["folder_delete", ["Project", "A/B"]],
      ["file_rename", ["Project", "", "Part", "New"]],
      ["file_move", ["Project", "", "Part", "Destination"]],
      ["file_delete", ["Project", "", "Part"]],
      ["file_editability", []],
      ["file_editability_list", ["Project"]],
      ["tree", ["Project", ""]],
    ] as const) {
      const artifact = prepareOpScript(operation, args);
      assert.equal(artifact.units.length, 1);
      assert.equal(
        artifact.units[0]?.filename,
        "runtime/python/fmcad/adapters/fusion/legacy_cloud.py",
      );
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(
        report.status,
        "passed",
        operation + ": " + JSON.stringify(report),
      );
    }
  },
);
