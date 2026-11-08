const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  documentIoFamilies,
  documentIoCadManifest,
  documentIoFamilyUnits,
} = require("../packages/node-adapters/dist/python/document-io-manifest");
const {
  preparePythonArtifact,
  verifyPythonArtifact,
  pythonLiteral,
} = require("../packages/node-adapters/dist/python/artifact");
const {
  queueDocumentSnapshotUnits,
  queueDocumentSnapshotSource,
} = require("../packages/node-adapters/dist/python/document-probe");
const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "runtime/python");

test("family manifest composes a complete unique registry with real source maps", () => {
  const composed = cadBundleManifest;
  assert.deepEqual(documentIoCadManifest(composed), composed);
  assert.deepEqual(
    documentIoFamilies(),
    require("./fixtures/python-document-io-manifest.json").families,
  );
  const units = cadBundleUnits(root);
  const expectedHandlerOrder = [
    ...require("./fixtures/python-geometry/baseline.json").handlerOrder,
  ];
  expectedHandlerOrder.splice(
    expectedHandlerOrder.indexOf("datum.frame") + 1,
    0,
    "inspect.pack",
  );
  const prepared = preparePythonArtifact(units);
  verifyPythonArtifact(prepared);
  for (const unit of prepared.units.filter((unit) =>
    unit.id.startsWith("docio-"),
  ))
    assert.ok(
      prepared.sourceMap.some((entry) => entry.unitId === unit.id),
      unit.id,
    );
  assert.ok(
    prepared.sourceMap.some((item) => item.unitId === "docio-document-usecase"),
  );
  const families = documentIoFamilies().filter((family) =>
    family.compatibility.startsWith("assets/cad/"),
  );
  for (const family of families) {
    assert.ok(
      !prepared.units.some((unit) => unit.filename === family.compatibility),
    );
    assert.ok(prepared.units.some((unit) => unit.id === family.family));
  }
  const currentMasterAdditions = [
    'frame.context_audit', 'snapshot.capture_v2', 'snapshot.diff_v2',
    'measure.section-series', 'measure.witness-check',
    'geometry.delta', 'geometry.compare-region',
    'sketch.coordinate-check', 'sketch.profile-query',
    'selection.rule.define', 'selection.rule.inspect', 'selection.rule.resolve', 'selection.rule.check',
    'selection.rule.define_internal', 'selection.rule.inspect_internal',
    'selection.rule.resolve_internal', 'selection.rule.check_internal',
    'mechanism.drive-test', 'mechanism.motion-link.create', 'fastener.measured-check',
  ];
  const currentMasterOwners = {
    'geometry.delta': 'regional-geometry',
    'geometry.compare-region': 'regional-geometry',
    'frame.context_audit': 'semantic-model-state',
    'snapshot.capture_v2': 'semantic-model-state',
    'snapshot.diff_v2': 'semantic-model-state',
    'measure.section-series': 'section-witness',
    'measure.witness-check': 'section-witness',
    'selection.rule.define': 'selection-rules',
    'selection.rule.inspect': 'selection-rules',
    'selection.rule.resolve': 'selection-rules',
    'selection.rule.check': 'selection-rules',
    'selection.rule.define_internal': 'selection-rules',
    'selection.rule.inspect_internal': 'selection-rules',
    'selection.rule.resolve_internal': 'selection-rules',
    'selection.rule.check_internal': 'selection-rules',
    'mechanism.drive-test': 'native-drive',
    'mechanism.motion-link.create': 'native-drive',
    'fastener.measured-check': 'measured-fasteners',
    'sketch.coordinate-check': 'sketch_geometry_proof',
    'sketch.profile-query': 'sketch_geometry_proof',
  };
  const setup = `import sys, types, builtins, pathlib
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
source = sys.stdin.read()
def denied(*args, **kwargs):
    raise AssertionError('canonical bundle attempted a filesystem load')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
`;
  const check = `
assert len(CAD_HANDLERS) > 200
assert CAD_HANDLERS.owners['document.save_as'] == 'document'
assert CAD_HANDLERS.owners['document.status'] == 'document'
assert CAD_HANDLERS.owners['shape.helix'] == 'spring'
assert CAD_HANDLERS.owners['model.thread'] == 'thread'
assert CAD_HANDLERS.owners['simulation.capabilities'] == 'simulation'
assert CAD_HANDLERS.owners['deliver'] == 'checking'
extensions = ${JSON.stringify(currentMasterAdditions)}
assert [key for key in CAD_HANDLERS if key not in ('geometry.delta', 'geometry.compare-region', *extensions)] == ${JSON.stringify(expectedHandlerOrder)}
assert [key for key in CAD_HANDLERS if key in extensions] == extensions
assert {key: CAD_HANDLERS.owners[key] for key in extensions} == ${JSON.stringify(currentMasterOwners)}
class Context:
    def call(self, operation, data):
        return CAD_HANDLERS.dispatch(self, operation, data)
ctx = Context()
result = ctx.call('deliver', {'checks': [{'id': 'size', 'predicate': {
    'kind': 'scalar', 'actual': {'value': 1}, 'expected': {'equals': 1}},
    'source': {'status': 'OPEN'}}]})
assert result['status'] == 'unknown' and result['accepted'] is False
assert result['success'] is False
simulation = ctx.call('simulation.capabilities', {})
assert simulation['stableFEASolve']['available'] is False
assert simulation['entitlement'] == 'notChecked'
assert simulation['productAccessed'] is False
`;
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      setup + "exec(compile(source, '<fmcad-artifact>', 'exec'))" + check,
    ],
    {
      input: prepared.script,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      cwd: os.tmpdir(),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    orderBundle(composed, ["core", "identity", "document_snapshot"]).map(
      (unit) => unit.id,
    ),
    ["values", "fusion-values", "core", "identity", "document_snapshot"],
  );
  assert.throws(
    () =>
      cadBundleUnits(
        root,
        "full",
        composed.filter((unit) => unit.id !== "document"),
      ),
    /inventory/,
  );
  assert.throws(
    () =>
      cadBundleUnits(root, "full", [
        ...composed,
        {
          id: "duplicate-document-compatibility",
          path: "runtime/python/fmcad/ports/document.py",
          dependencies: [],
          compatibilityPath: "assets/cad/document.py",
        },
      ]),
    /inventory/,
  );
  assert.throws(
    () =>
      orderBundle(
        [
          {
            id: "bad",
            path: "runtime/python/fmcad/domain/document.py",
            dependencies: [],
            compatibilityPath: "../outside.py",
          },
        ],
        ["bad"],
      ),
    /Invalid/,
  );
});

test("legacy document/review/export builders consume runtime, retaining literal argument encoding", () => {
  const ops = require("../src/ops");
  const inspect = ops.prepareOpScript("stats", ["日本語", true, null]);
  const exported = ops.prepareExportScript([
    "step",
    "",
    "C:\\out.step",
    "Model",
  ]);
  for (const artifact of [inspect, exported]) {
    verifyPythonArtifact(artifact);
    assert.ok(
      artifact.units.every((unit) =>
        unit.filename.startsWith(
          "runtime/python/fmcad/adapters/fusion/legacy_",
        ),
      ),
    );
  }
  const review = require("../src/review").buildReviewScript({
    doc: "Model",
    docId: "id",
    out: "C:\\new",
  });
  assert.ok(review.includes("def verify_view_directions("));
  assert.ok(review.includes("def _document_assert_identity("));
  assert.ok(
    review.includes(
      "ARGS = " + pythonLiteral({ doc: "Model", docId: "id", out: "C:\\new" }),
    ),
  );
  assert.throws(
    () => documentIoFamilyUnits(runtime, "not-a-family"),
    /Unknown/,
  );
});

test("broker document probe helpers have a dedicated runtime API without worker wiring", () => {
  const units = queueDocumentSnapshotUnits(runtime);
  assert.deepEqual(
    units.map((unit) => unit.id),
    ["identity", "legacy-queue_document"],
  );
  assert.ok(
    units.every((unit) =>
      unit.filename.startsWith("runtime/python/fmcad/adapters/fusion/"),
    ),
  );
  const source = queueDocumentSnapshotSource(runtime);
  assert.equal(source, units.map((unit) => unit.source).join("\n\n"));
  const script = `import sys
namespace = {}
exec(compile(sys.stdin.read(), '<document-probe>', 'exec'), namespace)
assert namespace['_qd_capture'](None, None) == {'status': 'unscoped'}
assert namespace['_qd_capture'](None, {'metadataOnly': True}) == {'status': 'metadata-only'}
class App:
    @property
    def documents(self):
        raise RuntimeError('readback unavailable')
result = namespace['_qd_capture'](App(), {'creationId': 'pin'})
assert result['status'] == 'unavailable'
assert result['error']['message'] == 'readback unavailable'
`;
  const result = spawnSync("python3", ["-B", "-c", script], {
    input: source,
    encoding: "utf8",
    cwd: os.tmpdir(),
  });
  assert.equal(result.status, 0, result.stderr);
});
