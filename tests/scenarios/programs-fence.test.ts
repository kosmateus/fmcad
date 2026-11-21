import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cadFence, close } from "./programs";
import { prepareScenarioHelpers } from "./simulator";
import type { ScriptRequest } from "./contracts";

test("generated fenced CAD run payload passes pinned production admission", async (t) => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json")),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    { pythonArtifactManifest, pythonUnitContexts, retainPythonOrigin } = load(
      "./packages/node-adapters/dist/python/context-binding",
    ) as typeof import("../../packages/node-adapters/src/python/context-binding"),
    typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    document = {
      name: "FMCAD_SCENARIO_programs_fence_owner",
      creationId: "programs-fence-owned-creation-id",
    },
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-programs-fence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const request: ScriptRequest = {
      owner: {
        runId: "programs-fence-run",
        scenarioId: "programs-fence-owner",
        clientId: "scenario:programs-fence-run:programs-fence-owner",
      },
      requestId: "scenario:programs-fence-run:programs-fence-owner:1",
      source: cadFence(
        document,
        "shape.box",
        {
          name: "ExportBody",
          width: "10 mm",
          depth: "20 mm",
          height: "30 mm",
        },
        [
          {
            creationId: "baseline-creation-id",
            name: "Baseline",
            fileId: "baseline-file-id",
            saved: true,
            modified: false,
          },
        ],
        [{ creationId: "peer-creation-id", name: "Peer" }],
        ["closed-peer-creation-id"],
        "root",
        "scenario:programs-fence-run:programs-fence-owner:1",
        [
          {
            document: { creationId: "saved-original", name: "BeforeSave" },
            savedDocument: {
              creationId: "saved-current",
              name: "AfterSave",
              file: {
                fileId: "saved-file",
                version: 1,
                projectId: "project",
                folderId: "folder",
              },
            },
            savedState: "open",
          },
        ],
      ),
      directory,
      target: document,
      helpers: "cad-v1",
    },
    prepared = prepareScenarioHelpers(root, request);
  assert.ok(prepared);
  const source = prepared.script + '\nrun("")\n',
    wire = preparePythonArtifact([
      {
        id: "scenario",
        filename: "scenario.py",
        role: "user",
        source,
      },
    ]),
    artifact = retainPythonOrigin(wire, pythonArtifactManifest(prepared)),
    report = await checker.check({
      artifact,
      context: { kind: "bundle" },
      unitContexts: pythonUnitContexts(artifact),
    });

  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.checker, "basedpyright");
  assert.equal(report.provenance.checkerVersion, "1.40.2");
  assert.equal(report.provenance.artifactHash, artifact.artifactHash);
  assert.equal(
    report.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );

  const closeArtifact = preparePythonArtifact([
      {
        id: "cleanup",
        filename: "cleanup.py",
        role: "user",
        source: close(document) + '\nrun("")\n',
      },
    ]),
    closeReport = await checker.check({
      artifact: closeArtifact,
      context: { kind: "run" },
    });
  assert.equal(closeReport.status, "passed", JSON.stringify(closeReport));
  assert.deepEqual(closeReport.diagnostics, []);
  assert.equal(closeReport.provenance.checker, "basedpyright");
  assert.equal(closeReport.provenance.checkerVersion, "1.40.2");
  assert.equal(
    closeReport.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
});
