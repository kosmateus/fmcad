import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
const { selectRunBundle } = load(
  "./packages/node-adapters/dist/python/source-selection.js",
);
const { prepareCadScript, catalog } = load("./src/cad.js");
const { createPythonChecker } = load("./src/python.js");

for (const operation of ["camera.save", "camera.restore"]) {
  test(`${operation} does not ship unrelated model-mutating handlers`, () => {
    const source = `result = FMCAD.call(${JSON.stringify(operation)}, {})\nFMCAD.emit(result)\n`;
    const units = selectRunBundle(root, source);
    const shipped = units.map((unit) => unit.source).join("\n");
    for (const name of ["_cad_param_apply", "_cad_datum_plane"]) {
      assert.ok(
        !new RegExp(`^\\s*def ${name}\\(`, "m").test(shipped),
        `${operation} retained unrelated mutation handler ${name}`,
      );
    }
    assert.match(shipped, /def _io_camera/);
  });
}

test("selected camera handlers pass the production Python checker", async () => {
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
    pythonExecutable: process.env.FMCAD_TEST_PYTHON ?? "python3",
  });
  for (const operation of ["camera.save", "camera.restore"]) {
    const artifact = prepareCadScript(operation, catalog[operation].example, {
      doc: "CameraMinimalityOfflineFixture",
      docId: "camera-minimality-offline-fixture",
    });
    assert.ok(!/def _cad_param_apply\(/.test(artifact.script));
    const report = await checker.check({
      artifact,
      context: { kind: "bundle" },
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(report.diagnostics, []);
  }
});
