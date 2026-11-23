import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { prepareExportScript } = load(
  "./src/ops",
) as typeof import("../packages/node-adapters/src/python/legacy-operations");

for (const format of ["step", "stl"]) {
  test(`legacy ${format} export passes production admission with actual injected arguments`, async () => {
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const body of ["", "Owned body"]) {
      const artifact = prepareExportScript([
        format,
        body,
        `C:/owned/export.${format}`,
        "Owned",
      ]);
      const result = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(result.status, "passed", JSON.stringify(result));
    }
  });
}
