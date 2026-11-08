import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./src/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { prepareCadScript, catalog } = load("./src/cad") as {
  prepareCadScript: typeof import("../src/composition/cad").prepareCadScript;
  catalog: Record<string, { example: Record<string, unknown> }>;
};
for (const operation of [
  "sketch.build",
  "entity.find",
  "spring.evaluate",
  "thread.custom-profile",
  "seal.evaluate",
  "cam.evaluate",
]) {
  test(
    `${operation}: generated public program passes pinned production admission`,
    { timeout: 300_000 },
    async () => {
      const example = catalog[operation]?.example;
      assert.ok(example, `${operation} must have an executable public example`);
      const typingRoot = path.join(root, "dist/runtime/python/typing");
      const checker = createPythonChecker({
        typingRoot,
        definitionsRoot: typingRoot,
        pythonPlatform: "Windows",
      });
      const artifact = prepareCadScript(operation, example, {
        doc: "Owned model",
        docId: "modeling-owner-A",
        docFileId: "file-A",
      });
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(report.provenance.checker, "basedpyright");
      assert.equal(
        report.provenance.definitionsHash,
        "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
      );
    },
  );
}
