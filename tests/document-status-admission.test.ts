import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
const load = createRequire(path.join(process.cwd(), "package.json"));
const cad = load("./src/cad") as typeof import("../src/composition/cad");
const { createPythonChecker } = load("./src/python") as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load("./packages/node-adapters/dist/python/artifact") as typeof import("../packages/node-adapters/src/python/artifact");
function prepare(): PreparedPythonArtifact {
  return cad.prepareCadScript("document.status", {}, {
    doc: "AdmissionFixture", docId: "fixture-creation", preview: false,
  });
}
const checker = () => createPythonChecker({
  typingRoot: path.resolve("dist/runtime/python/typing"),
  definitionsRoot: path.resolve("dist/runtime/python/typing"),
});
test("public document.status artifact passes the real checker without unrelated snapshot runtime", async () => {
  const artifact = prepare();
  assert.ok(artifact.bytes.length < 90_000, "Status must not expand to the full runtime to satisfy an unused dependency");
  const report = await checker().check({ artifact, context: { kind: "raw", entrypoint: "run" } });
  assert.equal(report.status, "passed", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.artifactHash, artifact.artifactHash);
  assert.equal(report.provenance.wireHash, artifact.sha256);
});
test("document.status still rejects an actual wrapper type error", async () => {
  const original = prepare();
  const artifact = preparePythonArtifact(original.units.map(unit => ({
    ...unit,
    source: unit.id === "wrapper" ? unit.source + '\n_admission_bad: int = "invalid"\n' : unit.source,
  })), { context: original.context, request: original.request });
  const report = await checker().check({ artifact, context: { kind: "raw", entrypoint: "run" } });
  assert.equal(report.status, "failed");
  assert.ok(report.diagnostics.some(item => item.rule === "reportAssignmentType"));
});
