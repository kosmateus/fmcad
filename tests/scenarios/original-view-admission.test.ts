import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import { nativeCadRuntime } from "./native-cad-runtime";
import {
  captureOriginalView,
  restoreOriginalView,
} from "./original-view-programs";

test("default native probe runtime retains its original document-status profile without wrapper declarations", () => {
  const load = createRequire(path.join(process.cwd(), "package.json"));
  const { prepareCadScript } = load(
    "./src/cad",
  ) as typeof import("../../src/composition/cad");
  const expected = prepareCadScript(
    "document.status",
    {},
    { doc: "FMCAD_ORIGINAL_USER_VIEW", component: "root" },
  )
    .units.filter((unit) => unit.role === "runtime")
    .map((unit) => unit.source)
    .join("\n\n");
  assert.equal(nativeCadRuntime(), expected);
});

for (const strict of [false, true]) {
  test(`complete original-view capture/restore passes production admission: strict=${strict}`, async (t) => {
    const root = path.resolve(__dirname, "../../..");
    const load = createRequire(path.join(root, "package.json"));
    const { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker");
    const { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact");
    const { prepareRunScript } = load(
      "./src/run",
    ) as typeof import("../../src/composition/run");
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "original-view-admission-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    const camera = {
      eye: [8, 6, 5],
      target: [1, 0.6, 0.5],
      up: [0, 0, 1],
      cameraType: "OrthographicCameraType",
      extents: [10, 6],
      document: { name: "Original", creationId: "original-id", fileId: null },
      units: "cm",
    };
    const snapshot = {
      documents: [
        {
          name: "Original",
          creationId: "original-id",
          fileId: null,
          saved: false,
          modified: false,
        },
      ],
      active: { name: "Original", creationId: "original-id", fileId: null },
      workspace: "FusionSolidEnvironment",
      camera,
      nativeCamera: camera,
      restorationProfile: strict
        ? "motion-absolute-1e-7"
        : "style-relative-1e-5",
    };
    for (const [phase, source] of [
      ["capture", captureOriginalView(strict)],
      ["restore", restoreOriginalView(snapshot)],
      [
        "capture-context",
        captureOriginalView(strict, {
          baseline: snapshot.documents,
          peers: [],
          roots: {},
          blocked: [],
        }),
      ],
      [
        "restore-peers",
        restoreOriginalView(snapshot, {
          baseline: snapshot.documents,
          peers: [],
        }),
      ],
    ]) {
      assert.ok(source);
      assert.equal(source.includes("class _FMCADRequest"), false);
      const filename = path.join(directory, phase + ".py");
      fs.writeFileSync(filename, source);
      // The live QueueScenarioBackend submits this full program via public
      // `run`, without helper injection or a target for original-view phases.
      const prepared = prepareRunScript(filename, undefined, false);
      const artifact = preparePythonArtifact([
        {
          id: "original-view-" + phase,
          filename: "original-view.py",
          role: "user",
          source: prepared.script + '\nrun("")\n',
        },
      ]);
      const report = await checker.check({
        artifact,
        context: { kind: "run" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(report.provenance.checkerVersion, "1.40.2");
      assert.equal(
        report.provenance.definitionsHash,
        "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
      );
    }
  });
}
