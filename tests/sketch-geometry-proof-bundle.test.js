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
  preparePythonArtifact,
} = require("../packages/node-adapters/dist/python/artifact");
const {
  sketchGeometryProofBundleManifest,
  sketchGeometryProofHandlers,
  withSketchGeometryProofModules,
} = require("../packages/node-adapters/dist/python/sketch-geometry-proof-manifest");
const {
  sketchGeometryProofPublicRoutes,
} = require("../packages/node-adapters/dist/python/sketch-geometry-proof-public-routes");
const root = path.resolve(__dirname, "..");

test("isolated sketch geometry proof manifest composes on the canonical graph without changing profiles", () => {
  const manifest = cadBundleManifest;
  const units = cadBundleUnits(root, "full", manifest);
  const family = units.filter((unit) =>
    unit.id.startsWith("sketch-geometry-proof-"),
  );
  assert.deepEqual(
    family.map((unit) => unit.id),
    sketchGeometryProofBundleManifest.map((unit) => unit.id),
  );
  assert.ok(
    units.findIndex((unit) => unit.id === "geometry-curve-fusion") <
      units.findIndex((unit) => unit.id === "sketch-geometry-proof-fusion"),
  );
  assert.ok(
    units.findIndex((unit) => unit.id === "geometry-sketch-fusion") <
      units.findIndex((unit) => unit.id === "sketch-geometry-proof-fusion"),
  );
  assert.deepEqual(
    cadBundleUnits(root, "document-status", manifest),
    cadBundleUnits(root, "document-status"),
  );
  assert.deepEqual(
    manifest.map((unit) => unit.id),
    withSketchGeometryProofModules(
      cadBundleManifest.filter(
        (unit) => !unit.id.startsWith("sketch-geometry-proof-"),
      ),
    ).map((unit) => unit.id),
  );
  assert.throws(
    () => withSketchGeometryProofModules(manifest),
    /already present/,
  );
  assert.throws(
    () =>
      orderBundle(
        [...manifest, ...sketchGeometryProofBundleManifest],
        ["core"],
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      orderBundle(sketchGeometryProofBundleManifest, [
        "sketch-geometry-proof-fusion",
      ]),
    /Incomplete.*core/,
  );
  for (const item of sketchGeometryProofBundleManifest) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.dependencies));
  }
});

test("real prepared family bundle exports exactly its owned registry handlers without filesystem access", () => {
  const manifest = cadBundleManifest;
  const units = cadBundleUnits(root, "full", manifest);
  const artifact = preparePythonArtifact(units);
  const baselineManifest = cadBundleManifest.filter(
    (unit) => !unit.id.startsWith("sketch-geometry-proof-"),
  );
  const baselineUnits = cadBundleUnits(root, "full", baselineManifest);
  const baseline = preparePythonArtifact(baselineUnits);
  assert.equal(artifact.script, units.map((unit) => unit.source).join("\n\n"));
  assert.notEqual(artifact.sha256, baseline.sha256);
  const script = `import sys, types, builtins, pathlib
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
payload = __import__('json').loads(sys.stdin.read())
def denied(*args, **kwargs):
    raise AssertionError('prepared runtime attempted filesystem loading')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
base = {}
exec(compile(payload['baseline'], '<canonical-prepared-bundle>', 'exec'), base)
before = dict(base['CAD_HANDLERS'])
ns = {}
exec(compile(payload['prepared'], '<canonical-prepared-bundle-with-family>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
expected = ${JSON.stringify(sketchGeometryProofHandlers)}
assert set(registry) - set(before) == set(expected)
for name in expected:
    assert callable(registry[name])
    assert registry.owners[name] == 'sketch_geometry_proof'
assert registry['sketch.coordinate-check'] is ns['sketch_coordinate_check']
assert registry['sketch.profile-query'] is ns['sketch_profile_query']
for name in expected:
    try:
        registry[name](None, {})
    except ValueError:
        pass
    else:
        raise AssertionError('invalid request reached SDK adapter: ' + name)
print(len(expected))
`;
  const result = spawnSync("python3", ["-B", "-c", script], {
    input: JSON.stringify({
      baseline: baseline.script,
      prepared: artifact.script,
    }),
    encoding: "utf8",
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    Number(result.stdout.trim()),
    sketchGeometryProofHandlers.length,
  );
});

test("public route descriptor fixes existing CLI and MCP projection spellings", () => {
  assert.deepEqual(sketchGeometryProofPublicRoutes, [
    {
      operation: "sketch.coordinate-check",
      catalogPath: "src/catalog/sketch-geometry-proof.json",
      cli: "sketch coordinate-check",
      mcp: "fmcad_cad_sketch_coordinate_check",
      requiresDocument: true,
      readOnlyRequested: true,
    },
    {
      operation: "sketch.profile-query",
      catalogPath: "src/catalog/sketch-geometry-proof.json",
      cli: "sketch profile-query",
      mcp: "fmcad_cad_sketch_profile_query",
      requiresDocument: true,
      readOnlyRequested: true,
    },
  ]);
  const manuals = require("../src/help-manual").manuals;
  for (const route of sketchGeometryProofPublicRoutes) {
    assert.ok(manuals[route.operation]);
    assert.ok(
      manuals[route.operation].audit.tests.includes(
        "tests/sketch-geometry-proof-bundle.test.js",
      ),
    );
    assert.equal(route.cli, route.operation.replaceAll(".", " "));
    assert.equal(
      route.mcp,
      `fmcad_cad_${route.operation.replaceAll(".", "_").replaceAll("-", "_")}`,
    );
  }
  const catalog = require("../src/catalog");
  const { commands, findCommand } = require("../src/commands");
  const { createCatalogServices } = require("../src/dist/api");
  const api = createCatalogServices();
  for (const route of sketchGeometryProofPublicRoutes) {
    const declaration = catalog.catalog[route.operation];
    const contract = catalog.contracts[route.operation];
    assert.ok(declaration);
    assert.equal(contract.cli.key, route.cli);
    assert.equal(contract.readOnlyRequested, true);
    assert.equal(contract.requirements.document, true);
    const command = commands.find((item) => item.target === route.operation);
    assert.ok(command, route.cli);
    assert.equal(findCommand(route.cli.split(" ")), command);
    assert.ok(
      catalog.mcpTools.some(
        (tool) =>
          tool.name === route.mcp &&
          tool._meta.fmcad.operation === route.operation,
      ),
    );
    assert.ok(api.list().some((item) => item.operation === route.operation));
    const validated = api.validateData(route.operation, declaration.example);
    assert.deepEqual(validated, declaration);
    const fromMcp = catalog.mcpInvocation(route.mcp, {
      data: declaration.example,
      doc: "Section",
    });
    assert.equal(fromMcp.operation, route.operation);
    assert.deepEqual(fromMcp.invocation.data, declaration.example);
  }
  assert.throws(
    () =>
      catalog.validateCad("sketch.coordinate-check", {
        schemaVersion: 1,
        sketch: "Section",
        expectations: [{ entity: "Arc" }],
      }),
    /expectation needs a coordinate or dimension/,
  );
  assert.throws(
    () =>
      catalog.validateCad("sketch.profile-query", {
        schemaVersion: 1,
        sketch: "Section",
        query: { area: "15 cm^2" },
      }),
    /area must be a positive finite cm\^2 number/,
  );
});
