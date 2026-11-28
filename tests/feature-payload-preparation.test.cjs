const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { prepareCadScript } = require("../src/cad.js");
const { prepareRunScript } = require("../src/run.js");
const { prepareReceiptScript } = require("../src/queue-instance.js");
const {
  createPythonChecker,
} = require("../packages/node-adapters/dist/python/checker.js");
const {
  pythonUnitContexts,
  retainPythonOrigin,
  pythonArtifactManifest,
} = require("../packages/node-adapters/dist/python/context-binding.js");
const {
  guardedFeatureModeProbeSource,
} = require("../dist/tests/scenarios/native-feature-modes-cases.js");

const identity = {
  name: "FeaturePayloadFixture",
  creationId: "feature-payload-offline",
};

// Representative inputs from native-feature-modes-cases.ts: component setup,
// stock, through-all participant cut, and offset to-entity extrusion. References
// are offline-only selectors, not claims that a corresponding SDK entity exists.
const cases = [
  { operation: "component.create", data: { name: "FeatureComponent" } },
  {
    operation: "shape.box",
    data: {
      name: "Stock",
      width: "20 mm",
      depth: "20 mm",
      height: "10 mm",
    },
  },
  {
    operation: "model.extrude",
    data: {
      name: "ThroughAll",
      profile: { kind: "profile", token: "offline-cut-profile" },
      extent: "throughAll",
      direction: "positive",
      operation: "cut",
      participants: [{ kind: "body", token: "offline-stock" }],
    },
  },
  {
    operation: "model.extrude",
    data: {
      name: "ToEntity",
      profile: { kind: "profile", token: "offline-section" },
      extent: "toEntity",
      target: { kind: "plane", token: "offline-target" },
      offset: "-1 mm",
      startOffset: "2 mm",
    },
  },
];

function checker() {
  const typingRoot =
    process.env.FMCAD_FEATURE_TYPING_ROOT ??
    path.resolve("runtime/python/typing");
  return createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonExecutable: process.env.FMCAD_FEATURE_PYTHON,
    pythonPlatform: "Windows",
  });
}

function retainReceipt(prepared, directory) {
  return retainPythonOrigin(
    prepareReceiptScript(
      prepared.script,
      true,
      path.join(directory, "receipt.json"),
      { jobId: "feature-payload-offline" },
      { mapPath: (value) => value },
    ),
    pythonArtifactManifest(prepared),
  );
}

async function check(artifact, label, source) {
  const report = await checker().check({
    artifact,
    context: { kind: "raw" },
    unitContexts: pythonUnitContexts(artifact),
  });
  const units = artifact.units.map(({ id, source, sha256 }) => ({
    id,
    bytes: Buffer.byteLength(source),
    sha256,
  }));
  if (process.env.FMCAD_FEATURE_EVIDENCE) {
    const output = path.resolve(process.env.FMCAD_FEATURE_EVIDENCE, label);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "wire.py"), artifact.script);
    if (source) fs.writeFileSync(path.join(output, "input.py"), source);
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    fs.writeFileSync(
      path.join(output, "units.json"),
      JSON.stringify(units, null, 2),
    );
  }
  console.log(
    JSON.stringify({
      label,
      bytes: Buffer.byteLength(artifact.script),
      unitCount: units.length,
      status: report.status,
      reasons: report.reasons,
      diagnosticCount: report.diagnostics.length,
    }),
  );
  return report;
}

function temporary(t) {
  const parent = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(parent, "feature-payload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function guardedRun(directory, body) {
  const source = await guardedFeatureModeProbeSource(
    identity,
    async () => ({
      documents: [{ ...identity, saved: false, modified: false }],
    }),
    body,
  );
  const filename = path.join(directory, "feature-probe.py");
  fs.writeFileSync(filename, source);
  const prepared = prepareRunScript(
    filename,
    [],
    false,
    identity.name,
    { docId: identity.creationId },
    "cad-v1",
    [],
  );
  const artifact = retainReceipt(prepared, directory);
  const userUnit = artifact.units.find((unit) => unit.filename === filename);
  assert.ok(userUnit, "Retained user source must remain in the final artifact");
  assert.equal(pythonUnitContexts(artifact)[userUnit.id]?.kind, "cad-v1");
  assert.equal(pythonUnitContexts(artifact)[userUnit.id]?.deferredFacade, true);
  return { artifact, source };
}

test("representative feature variant inputs use public CAD preparation without changing caller data", () => {
  for (const { operation, data } of cases) {
    const before = structuredClone(data);
    const prepared = prepareCadScript(operation, data, {
      doc: identity.name,
      docId: identity.creationId,
      component: "root",
    });
    assert.ok(prepared.script.length > 0, operation);
    assert.deepEqual(data, before, operation);
  }
});

test("feature-mode component.create passes the shared checker at the receipt seam", async (t) => {
  const prepared = prepareCadScript(cases[0].operation, cases[0].data, {
    doc: identity.name,
    docId: identity.creationId,
    component: "root",
  });
  const report = await check(
    retainReceipt(prepared, temporary(t)),
    "direct-component",
  );
  assert.equal(report.status, "passed", JSON.stringify(report.reasons));
  assert.deepEqual(report.diagnostics, []);
});

test("current guarded feature variants pass real run preparation, receipt/origin and checker", async (t) => {
  const body = cases
    .map(
      ({ operation, data }, index) =>
        `result${index} = FMCAD.call(${JSON.stringify(operation)}, ${JSON.stringify(data)}, component="root")`,
    )
    .concat("FMCAD.emit(result0)")
    .join("\n");
  const { artifact, source } = await guardedRun(temporary(t), body);
  const report = await check(artifact, "guarded-variants", source);
  assert.equal(report.status, "passed", JSON.stringify(report.reasons));
  assert.deepEqual(report.diagnostics, []);
});

test("receipt/origin preserves rejection and source attribution for an invalid guarded user value", async (t) => {
  const { artifact, source } = await guardedRun(
    temporary(t),
    'result = FMCAD.call("component.create", {"name": "FeatureComponent"}, component="root")\nfeature_payload_invalid: int = "not an integer"\nFMCAD.emit(result)',
  );
  const report = await check(artifact, "guarded-invalid-value", source);
  assert.equal(report.status, "failed");
  const userUnit = artifact.units.find((unit) =>
    unit.filename.endsWith("feature-probe.py"),
  );
  assert.ok(userUnit);
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.unitId === userUnit.id &&
        diagnostic.rule === "reportAssignmentType" &&
        diagnostic.filename.endsWith("feature-probe.py"),
    ),
    JSON.stringify(report.diagnostics),
  );
});
