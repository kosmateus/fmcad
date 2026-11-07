const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  withGeometryModules,
  geometryFamilies,
} = require("../packages/node-adapters/dist/python/geometry-manifest");
const root = path.resolve(__dirname, "..");
const baseline = require("./fixtures/python-geometry/baseline.json");

test("geometry family graph prepares explicit layers once, retaining owners and light profile", () => {
  const manifest = cadBundleManifest;
  const units = cadBundleUnits(root, "full", manifest);
  for (const family of geometryFamilies) {
    const indexes = ["domain", "fusion", "application"].map((layer) =>
      units.findIndex((unit) => unit.id === `geometry-${family}-${layer}`),
    );
    assert.ok(
      indexes[0] >= 0 && indexes[1] > indexes[0] && indexes[2] > indexes[1],
      family,
    );
    assert.ok(
      units.findIndex((unit) => unit.id === family) > indexes[2],
      family,
    );
  }
  assert.deepEqual(
    cadBundleUnits(root, "document-status", manifest).map((unit) => unit.id),
    cadBundleUnits(root, "document-status").map((unit) => unit.id),
  );
  assert.throws(
    () => orderBundle(withGeometryModules(manifest), ["core"]),
    /duplicate/,
  );
});

test("geometry prepared bundle imports with SDK stub without checkout/filesystem access", () => {
  const manifest = cadBundleManifest;
  const source = cadBundleUnits(root, "full", manifest)
    .map((unit) => unit.source)
    .join("\n\n");
  const expectedOrder = [...baseline.handlerOrder];
  expectedOrder.splice(
    expectedOrder.indexOf("datum.frame") + 1,
    0,
    "inspect.pack",
  );
  const expectedHandlers = [...baseline.handlers, "inspect.pack"].sort();
  const masterExtensions = [
    'fastener.measured-check', 'mechanism.drive-test', 'mechanism.motion-link.create',
    'selection.rule.define', 'selection.rule.inspect', 'selection.rule.resolve', 'selection.rule.check',
    'selection.rule.define_internal', 'selection.rule.inspect_internal',
    'selection.rule.resolve_internal', 'selection.rule.check_internal',
    'frame.context_audit', 'snapshot.capture_v2', 'snapshot.diff_v2',
    'sketch.coordinate-check', 'sketch.profile-query',
  ];
  const script = `import sys, types, builtins, pathlib
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
source = sys.stdin.read()
def denied(*args, **kwargs):
    raise AssertionError('bundled runtime attempted a filesystem load')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
ns = {}
exec(compile(source, '<geometry-bundle>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
family_registry = [key for key in registry if key not in ('geometry.delta', 'geometry.compare-region', 'measure.section-series', 'measure.witness-check', *${JSON.stringify(masterExtensions)})]
assert sorted(family_registry) == ${JSON.stringify(expectedHandlers)}
assert family_registry == ${JSON.stringify(expectedOrder)}
assert registry.owners['geometry.delta'] == 'regional-geometry'
assert registry.owners['geometry.compare-region'] == 'regional-geometry'
assert registry.owners['measure.section-series'] == 'section-witness'
assert registry.owners['measure.witness-check'] == 'section-witness'
assert registry.owners['model.thread'] == 'thread'
assert registry.owners['shape.helix'] == 'spring'
assert registry.owners['sketch.geometry'] == 'sketch'
assert registry.owners['feature.edit'] == 'feature'
assert len(ns['_FMCAD_GEOMETRY_LOADED']) == 8
assert all(callable(value) for value in registry.values())
print(len(registry))
`;
  const result = spawnSync("python3", ["-B", "-c", script], {
    input: source,
    encoding: "utf8",
    cwd: "/tmp/opencode",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Number(result.stdout.trim()) > 250);
  assert.throws(
    () => orderBundle([...manifest, manifest[0]], ["core"]),
    /duplicate/,
  );
});

test("geometry pure import, AST preservation and fake SDK transcript match captured baseline", () => {
  const result = spawnSync(
    "python3",
    ["-B", path.join(__dirname, "python_geometry_test.py")],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
