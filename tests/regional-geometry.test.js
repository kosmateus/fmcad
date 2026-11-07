const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  withRegionalGeometryModules,
} = require("../packages/node-adapters/dist/python/regional-geometry-manifest");
const { pythonLiteral } = require("../packages/node-adapters/dist/python/artifact");
const {
  contracts,
  mcpTools,
  cliContracts,
  validateInvocation,
} = require("../src/catalog");
const { main: cliMain } = require("../src/cli");
const { executeInvocation } = require("../src/catalog/execute");
const root = path.resolve(__dirname, "..");

test("regional dedicated manifest is dependency-ordered, duplicate-safe and preserves light profile", () => {
  const manifest = cadBundleManifest;
  assert.ok(
    manifest.some((unit) => unit.id === "measure-baseline-application"),
  );
  assert.ok(manifest.some((unit) => unit.id === "measure-baseline-fusion"));
  const ordered = orderBundle(
    manifest,
    manifest.map((unit) => unit.id),
  );
  const ids = ordered.map((unit) => unit.id);
  assert.ok(
    ids.indexOf("regional-geometry-domain") <
      ids.indexOf("regional-geometry-fusion"),
  );
  assert.ok(
    ids.indexOf("regional-geometry-fusion") <
      ids.indexOf("regional-geometry-application"),
  );
  assert.ok(ids.indexOf("measure") < ids.indexOf("regional-geometry-fusion"));
  assert.ok(
    ids.indexOf("regional-geometry-application") <
      ids.indexOf("measure-baseline-application"),
  );
  assert.throws(() => withRegionalGeometryModules(manifest), /already present/);
  assert.deepEqual(
    cadBundleUnits(root, "document-status", manifest).map((unit) => unit.id),
    cadBundleUnits(root, "document-status").map((unit) => unit.id),
  );
});

test("regional runtime prepares without SDK/filesystem imports or a second comparator", () => {
  const files = [
    "runtime/python/fmcad/domain/regional_geometry.py",
    "runtime/python/fmcad/adapters/fusion/regional_geometry.py",
    "runtime/python/fmcad/application/regional_geometry.py",
  ];
  const source = files
    .map((file) => readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  const script = `import sys, builtins
source = sys.stdin.read()
def denied(*args, **kwargs):
    raise AssertionError('filesystem access during regional module assembly')
builtins.open = denied
class Registry(dict):
    def __init__(self):
        super().__init__(); self.owner = None; self.owners = {}
    def update(self, values):
        for key, value in values.items():
            self[key] = value; self.owners[key] = self.owner
CAD_HANDLERS = Registry()
ns = {}
ns['CAD_HANDLERS'] = CAD_HANDLERS
exec(compile(source, '<regional-modules>', 'exec'), ns)
assert callable(ns['regional_geometry_compare'])
assert callable(ns['regional_geometry_fusion_handler'])
assert set(CAD_HANDLERS) == {'geometry.delta', 'geometry.compare-region'}
assert '_measure_compare_bodies' not in ns
`;
  const run = spawnSync("python3", ["-B", "-c", script], {
    input: source,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(source, /return _measure_compare_bodies\(/);
  assert.doesNotMatch(
    source,
    /\.bRepBodies\.add\(|\.deleteMe\(|\.pointContainment\(/,
  );
});

test("public catalog, CLI and MCP keep both commands on the typed Python/broker path", async (t) => {
  const operations = ["geometry.delta", "geometry.compare-region"];
  for (const retained of [
    "measure.baseline.capture",
    "measure.baseline.inspect",
    "measure.baseline.compare",
    "curve.fit",
    "assembly.interference",
    "document.save_as",
  ]) {
    assert.ok(contracts[retained], "retain canonical operation " + retained);
  }
  for (const operation of operations) {
    const contract = contracts[operation];
    assert.equal(contract.service.kind, "python");
    assert.equal(contract.service.handler, operation);
    assert.equal(contract.requirements.sdk, "required");
    assert.ok(
      mcpTools.some((tool) => tool._meta.fmcad.operation === operation),
    );
    assert.equal(cliContracts([])[operation].operation, operation);
  }
  assert.equal(
    mcpTools.some((tool) => tool._meta.fmcad.operation.startsWith("geometry.")),
    true,
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation: "geometry.compare-region",
        data: {
          before: "A",
          after: "B",
          frame: { space: "assembly", component: "root" },
          allowed: {
            include: [{ type: "box", min: [0, 0, 0], max: [1, 1, 1] }],
          },
        },
        doc: "Synthetic",
      }),
    /unsupported fields|explicit entity reference/i,
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation: "geometry.delta",
        data: {
          before: { kind: "face", name: "not-a-solid" },
          after: "B",
          frame: {
            space: "assembly",
            component: { kind: "component", name: "root" },
          },
        },
        doc: "Synthetic",
      }),
    /explicit entity reference/i,
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-regional-route-"),
  );
  const previous = process.cwd();
  process.chdir(directory);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const calls = [];
  const result = (operation) => ({
    success: true,
    operation,
    result: {
      schemaVersion: 1,
      operation,
      status: "pass",
      passed: true,
      precision: "pass",
      coverage: "pass",
      controls: { outsideAllowedUnchanged: true, protectedUnchanged: true },
      delta: {
        removed: { total: { empty: true, volume: 0, bounds: null } },
        added: { total: { empty: true, volume: 0, bounds: null } },
      },
    },
  });
  const fakeBroker = {
    async callTool(request) {
      assert.equal(request.featureType, "script");
      assert.equal(request.object.readOnly, true);
      const script = request.object.script;
      assert.match(script, /regional_geometry_register\(CAD_HANDLERS\)/);
      assert.match(script, /regional_geometry_fusion_handler/);
      assert.match(script, /def _measure_compare_bodies\(/);
      assert.match(script, /_FMCAD_REQUEST: "_FMCADRequest" = \{/);
      const operation = ["geometry.delta", "geometry.compare-region"].find((item) =>
        script.includes(`"operation": ${pythonLiteral(item)}`),
      );
      assert.ok(operation, "prepared request must use the canonical CAD wrapper");
      assert.ok(script.includes(`"data": ${pythonLiteral(data)}`));
      calls.push(operation);
      return {
        failed: false,
        text: "FMCAD_RESULT " + JSON.stringify(result(operation)),
      };
    },
  };

  const data = {
    before: "Before",
    after: "After",
    frame: { space: "assembly", component: "root" },
    allowed: { include: ["Allowed"] },
  };

  let stdout = "";
  let stderr = "";
  const code = await cliMain(
    [
      "geometry",
      "compare-region",
      "--doc",
      "Synthetic",
      "--data",
      JSON.stringify(data),
      "--json",
    ],
    {
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
      stderr: {
        write: (value) => {
          stderr += value;
        },
      },
      loadConfig: () => ({
        cfg: {
          routing: "queue",
          backend: "mcp",
          timeoutMs: 5000,
          headers: {},
        },
      }),
      createFmcad: () => ({
        async start() {},
        async execute(payload, options) {
          const invocation =
            payload.kind === "cad-command" ? payload.invocation : payload;
          const output = await executeInvocation(invocation, fakeBroker);
          return {
            version: 1,
            requestId: options.requestId,
            jobId: null,
            state: "succeeded",
            result: output,
            outcome: {
              acceptance: "accepted",
              executionOutcome: "succeeded",
              validation: { status: "not_checked" },
            },
          };
        },
        async dispose() {},
      }),
      setExitCode: () => {},
    },
  );
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).operation, "geometry.compare-region");
  assert.match(stderr, /^FMCAD_QUEUE_REQUEST /);
  assert.equal(calls.length, 1);

  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("regional catalog calls must not use raw-tool forwarding");
    },
    services() {
      return {
        async start() {},
        async execute(payload, options) {
          const invocation =
            payload.kind === "cad-command" ? payload.invocation : payload;
          const output = await executeInvocation(invocation, fakeBroker);
          return {
            version: 1,
            requestId: options.requestId,
            jobId: null,
            state: "succeeded",
            result: output,
            outcome: {
              acceptance: "accepted",
              executionOutcome: "succeeded",
              validation: { status: "not_checked" },
            },
          };
        },
      };
    },
  });
  const response = JSON.parse(
    (
      await application({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "fmcad_cad_geometry_delta",
          arguments: {
            doc: "Synthetic",
            data,
          },
          _meta: { fmcad: { requestId: "regional-mcp-request" } },
        },
      })
    ).raw,
  );
  const mcpResult = response.result.structuredContent;
  assert.equal(mcpResult.operation, "geometry.delta");
  assert.equal(mcpResult.result.status, "pass");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, ["geometry.compare-region", "geometry.delta"]);

  const { manualHelp } = require("../src/help-manual");
  const { commands } = require("../src/commands");
  assert.match(
    manualHelp(commands.find((command) => command.target === "geometry.delta")),
    /finite solid masks/i,
  );
  assert.match(
    manualHelp(
      commands.find((command) => command.target === "geometry.compare-region"),
    ),
    /protected/i,
  );
});

test("whole canonical bundle plus regional hook imports offline and registers only two owned handlers", () => {
  const source = cadBundleUnits(root, "full", cadBundleManifest)
    .map((unit) => unit.source)
    .join("\n\n");
  const script = `import sys, types, builtins, pathlib
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
source = sys.stdin.read()
def denied(*args, **kwargs):
    raise AssertionError('bundled regional runtime attempted a filesystem load')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
ns = {}
exec(compile(source, '<regional-full-bundle>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
comparator = ns['_measure_compare_bodies']
assert 'geometry.delta' in registry
assert 'geometry.compare-region' in registry
assert registry.owners['geometry.delta'] == 'regional-geometry'
assert registry.owners['geometry.compare-region'] == 'regional-geometry'
assert '_FMCAD_REGIONAL_GEOMETRY_LOADED' in ns
assert 'measure.baseline.capture' in registry
assert 'measure.baseline.compare' in registry
assert registry.owners['measure.baseline.capture'] == 'measure-baseline'
assert 'assembly.interference' in registry
assert 'document.save_as' in registry
assert ns['_measure_compare_bodies'] is comparator
`;
  const run = spawnSync("python3", ["-B", "-c", script], {
    input: source,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
