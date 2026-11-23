const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  planCadScript,
} = require("../packages/core/dist/application/cad/prepare.js");
const {
  prepareCadBundle,
} = require("../packages/node-adapters/dist/python/bundle.js");
const {
  pythonLiteral,
  preparePythonArtifact,
  verifyPythonArtifact,
} = require("../packages/node-adapters/dist/python/artifact.js");
const {
  createPythonChecker,
} = require("../packages/node-adapters/dist/python/checker.js");

test("prepared parameter checkpoint retains string-cast type dependencies and passes the real checker", async () => {
  const root = path.resolve(__dirname, "..");
  const entry = JSON.parse(
    fs.readFileSync(path.join(root, "src/catalog/core.json"), "utf8"),
  )["param.inspect"];
  const plan = planCadScript(
    "param.inspect",
    { includeModel: true },
    { doc: "Fixture", docId: "doc-A" },
    entry,
    pythonLiteral,
    "param-checkpoint",
  );
  const artifact = prepareCadBundle(
    root,
    plan.wrapper,
    { request: plan.request, context: plan.context },
    plan.profile,
  );
  verifyPythonArtifact(artifact);
  assert.ok(
    artifact.units.some((unit) =>
      unit.source.includes('_cad_cast("_DesignCaster",'),
    ),
    "the production helper and its string annotation must remain unchanged",
  );
  assert.ok(
    artifact.units.some((unit) => unit.source.includes("class _DesignCaster(")),
    "the checker-only provider must survive source selection",
  );
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const report = await createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  }).check({ artifact, context: "cad-v1" });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.artifactHash, artifact.artifactHash);
  const invalid = preparePythonArtifact(
    [
      ...artifact.units,
      {
        id: "invalid-annotation-guard",
        filename: "<invalid-annotation-guard>",
        source: "def invalid_annotation(value: int) -> str:\n    return value\n",
        role: "runtime",
      },
    ],
    { request: plan.request, context: plan.context },
  );
  const rejected = await createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  }).check({ artifact: invalid, context: "cad-v1" });
  assert.equal(rejected.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) =>
        diagnostic.filename === "<invalid-annotation-guard>" &&
        diagnostic.rule === "reportReturnType",
    ),
    JSON.stringify(rejected),
  );
});
