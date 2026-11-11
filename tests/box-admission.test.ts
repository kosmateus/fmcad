import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load(
  "./src/python",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { prepareRunScript } = load("./src/run") as {
  prepareRunScript(
    name: string,
    args: unknown,
    hasArgs: boolean,
    doc: string,
    identity?: { docId: string },
  ): PreparedPythonArtifact;
};

test(
  "box uses the current extent API and passes public run admission",
  async () => {
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    const historical = preparePythonArtifact([
      {
        id: "box",
        filename: "box-a262.py",
        role: "user",
        source: readFileSync(
          path.join(root, "tests/fixtures/history/box-a26222f.py.txt"),
          "utf8",
        ),
      },
    ]);
    const old = await checker.check({
      artifact: historical,
      context: { kind: "bundle" },
    });
    assert.equal(old.status, "failed");
    assert.ok(
      old.diagnostics.some((d) => d.message.includes("setDistanceExtent")),
      JSON.stringify(old),
    );
    for (const identity of [undefined, { docId: "owned" }]) {
      const artifact = prepareRunScript("box", [10], true, "Model", identity);
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
    }
  },
);
