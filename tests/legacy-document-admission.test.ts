import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { prepareOpScript } = load(
  "./src/ops",
) as typeof import("../packages/node-adapters/src/python/legacy-operations");
const typingRoot = path.join(root, "dist/runtime/python/typing");

test(
  "plane and component commands pass production admission with the shared document guard",
  { timeout: 180_000 },
  async () => {
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const [operation, args] of [
      ["plane_list", ["Model"]],
      ["plane_add", ["Offset", "offset", "XY", "10 mm", "Model"]],
      ["plane_rename", ["Offset", "Renamed", "Model"]],
      ["plane_delete", ["Renamed", "Model"]],
      ["comp_list", ["Model"]],
      ["comp_add", ["Child", "Parent", "Model"]],
    ] as const) {
      const artifact = prepareOpScript(operation, args);
      assert.equal(artifact.units.length, 2);
      assert.equal(
        artifact.units[0]?.filename,
        "runtime/python/fmcad/adapters/fusion/legacy_document.py",
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
    }
  },
);

for (const persistent of [false, true]) {
  test(
    `checker cleanup ${persistent ? "fails after bounded attempts" : "survives transient directory visibility"}`,
    { timeout: 60_000 },
    () => {
      // A fresh process installs the filesystem fault before Node caches rimraf's bindings.
      const child = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "fixtures/checker-cleanup.cjs"),
          String(persistent),
        ],
        { encoding: "utf8", timeout: 50_000 },
      );
      assert.equal(child.status, 0, child.stderr || String(child.error));
      const outcome: unknown = JSON.parse(child.stdout);
      assert.ok(
        outcome &&
          typeof outcome === "object" &&
          "failures" in outcome &&
          "status" in outcome &&
          "remaining" in outcome,
      );
      assert.equal(outcome.status, persistent ? "ENOTEMPTY" : "passed");
      assert.equal(typeof outcome.failures, "number");
      if (persistent)
        assert.ok(
          Number(outcome.failures) > 1,
          "Persistent cleanup failure must be retried and still reported",
        );
      else {
        assert.equal(outcome.failures, 1);
        assert.deepEqual(outcome.remaining, []);
      }
    },
  );
}
