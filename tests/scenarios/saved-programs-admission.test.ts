import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import * as saved from "./saved-programs";

test("saved identity scripts pass pinned production Python admission", async () => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json")),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    document = { creationId: "before-id", name: "Housing" },
    folder = { projectId: "project", folderId: "folder" },
    current = {
      creationId: "after-id",
      name: "Housing v0",
      file: { ...folder, fileId: "file", version: 1 },
    },
    sources = [
      saved.save(
        document,
        folder,
        { runId: "run", scenarioId: "saved", clientId: "owner" },
        "owner:2",
        "save-intent.json",
        "save-transition.json",
      ),
      saved.observeSave(current, folder, document.name),
      saved.fileOperation(current, false, document.name),
      saved.fileOperation(current, true, document.name),
    ];
  for (const [index, source] of sources.entries()) {
    const artifact = preparePythonArtifact([
      {
        id: "saved-" + index,
        filename: "saved.py",
        role: "user",
        source: source + '\nrun("")\n',
      },
    ]);
    const result = await checker.check({ artifact, context: { kind: "run" } });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.provenance.checkerVersion, "1.40.2");
    assert.equal(
      result.provenance.definitionsHash,
      "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
    );
  }
});
