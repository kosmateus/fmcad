const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  preparePythonArtifact,
  pythonLiteral,
} = require("../packages/node-adapters/dist/python/artifact");
const {
  measuredFastenerBundleManifest,
  measuredFastenerHandlers,
  withMeasuredFasteners,
} = require("../packages/node-adapters/dist/python/measured-fasteners-manifest");
const root = path.resolve(__dirname, "..");

function withoutMeasuredFasteners() {
  return cadBundleManifest.filter(
    (unit) => !unit.id.startsWith("measured-fasteners-"),
  );
}

test("canonical family manifest includes measured fasteners once after its prerequisites", () => {
  const units = cadBundleUnits(root, "full", cadBundleManifest);
  const family = units.filter((unit) =>
    unit.id.startsWith("measured-fasteners-"),
  );
  assert.deepEqual(
    family.map((unit) => unit.id),
    measuredFastenerBundleManifest.map((unit) => unit.id),
  );
  for (const dependency of ["core", "measure", "fastener", "sequence"]) {
    assert.ok(
      units.findIndex((unit) => unit.id === dependency) <
        units.findIndex((unit) => unit.id === "measured-fasteners-fusion"),
    );
  }
  assert.deepEqual(
    cadBundleUnits(root, "document-status", cadBundleManifest).map(
      (unit) => unit.id,
    ),
    cadBundleUnits(root, "document-status").map((unit) => unit.id),
  );
  assert.deepEqual(
    withMeasuredFasteners(withoutMeasuredFasteners()).map((unit) => unit.id),
    cadBundleManifest.map((unit) => unit.id),
  );
  assert.throws(
    () => withMeasuredFasteners(cadBundleManifest),
    /already present/,
  );
  assert.throws(
    () =>
      orderBundle(
        [...cadBundleManifest, ...measuredFastenerBundleManifest],
        ["measured-fasteners-handlers"],
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      orderBundle(measuredFastenerBundleManifest, [
        "measured-fasteners-handlers",
      ]),
    /Incomplete.*core/,
  );
  for (const item of measuredFastenerBundleManifest) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.dependencies));
  }
});

test("canonical prepared artifact exports the owned handler without checkout access", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "measured-fastener-bundle-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const units = cadBundleUnits(root, "full", cadBundleManifest);
  const artifact = preparePythonArtifact(units);
  const baseline = preparePythonArtifact(
    cadBundleUnits(root, "full", withoutMeasuredFasteners()),
  );
  assert.equal(artifact.script, units.map((unit) => unit.source).join("\n\n"));
  assert.notEqual(artifact.sha256, baseline.sha256);
  const script = `import sys, types, builtins, pathlib, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
payload = json.loads(sys.stdin.read())
def denied(*args, **kwargs):
    raise AssertionError('prepared runtime attempted checkout filesystem access')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
baseline_ns = {}
exec(compile(payload['baseline'], '<base-bundle>', 'exec'), baseline_ns)
ns = {}
exec(compile(payload['bundle'], '<measured-fasteners-bundle>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
expected = ${JSON.stringify(measuredFastenerHandlers)}
assert set(registry) - set(baseline_ns['CAD_HANDLERS']) == set(expected)
for name in expected:
    assert callable(registry[name])
    assert registry.owners[name] == 'measured-fasteners'
assert registry['fastener.measured-check'] is ns['measured_fasteners_check_operation']
try:
    registry['fastener.measured-check'](None, {'schemaVersion': 1, 'mode': 'declared', 'native': {}})
except ValueError:
    pass
else:
    raise AssertionError('prepared measured-fastener handler skipped application validation')
print(len(registry))
`;
  const result = spawnSync("python3", ["-B", "-c", script], {
    input: JSON.stringify({
      baseline: baseline.script,
      bundle: artifact.script,
    }),
    encoding: "utf8",
    cwd: directory,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Number(result.stdout.trim()) > 250);
});

test("typed CLI and MCP use the canonical measured-fastener contract and broker artifact", async (t) => {
  const { main: cliMain } = require("../src/cli");
  const { executeInvocation } = require("../src/catalog/execute");
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  const {
    mcpTools,
    contracts,
    cliContracts,
    validateInvocation,
  } = require("../src/catalog");
  const { classifyEvidence } = require("../packages/core/dist/domain/evidence");
  const operation = "fastener.measured-check";
  const request = {
    schemaVersion: 1,
    mode: "native",
    native: {
      schemaVersion: 1,
      frame: {
        space: "assembly",
        component: { kind: "component", name: "root" },
      },
      tolerance: {
        axisOffset: "0.05 mm",
        axisAngle: "1 deg",
        minimumEngagement: "4 mm",
      },
      screw: {
        axis: { kind: "axis", name: "ScrewAxis" },
        headBearing: { kind: "point", name: "HeadBearing" },
        tip: { kind: "point", name: "ScrewTip" },
        threadStart: { kind: "point", name: "ScrewThreadStart" },
        threadEnd: { kind: "point", name: "ScrewThreadEnd" },
      },
      receptacle: {
        kind: "blind",
        axis: { kind: "axis", name: "HoleAxis" },
        threadStart: { kind: "point", name: "HoleThreadStart" },
        threadEnd: { kind: "point", name: "HoleThreadEnd" },
        bottom: { kind: "point", name: "HoleBottom" },
      },
      layers: [
        {
          id: "bracket",
          start: { kind: "point", name: "StackNear" },
          end: { kind: "point", name: "StackFar" },
        },
      ],
    },
    declaredEvidence: {
      operation: "fastener.check",
      schemaVersion: 1,
      frame: "component",
      screw: { length: "12 mm", threadLength: "10 mm" },
      stack: [{ id: "bracket", thickness: "5 mm" }],
      minimumEngagement: "4 mm",
    },
  };
  const result = {
    schemaVersion: 1,
    operation,
    mode: "native",
    status: "fail",
    success: false,
    frame: request.native.frame,
    units: { length: "mm", angle: "rad" },
    nativeMeasurements: {
      schemaVersion: 1,
      sourceVersion: 1,
      frame: request.native.frame,
      status: "fail",
      measurements: {
        actualEngagement: {
          status: "measured",
          value: 3,
          units: "mm",
          sourceVersion: 1,
          provenance: [
            {
              source: "Fusion native entity geometry",
              sourceRef: { kind: "point", name: "ScrewThreadEnd" },
              sourceVersion: 1,
              frame: request.native.frame,
              coverage: "selected axial thread-boundary point",
            },
          ],
        },
      },
      checks: [{ check: "actual-engagement", status: "fail" }],
      coverage: { status: "complete", missingMeasurements: [] },
      limitations: [
        "Axial interval overlap is not exact thread-flank engagement.",
      ],
    },
    declaredEvidence: {
      status: "reported",
      operation: "fastener.check",
      sourceVersion: 1,
      frame: {
        space: "component",
        component: { kind: "component", name: "root" },
      },
      units: { length: "mm" },
      result: { status: "pass", engagement: { value: 5, units: "mm" } },
    },
    toolAccess: { status: "notEvaluated" },
    checks: [{ check: "actual-engagement", status: "fail" }],
    limitations: [],
  };
  const calls = [];
  const broker = {
    async callTool(call) {
      assert.equal(call.featureType, "script");
      assert.equal(call.object.readOnly, true);
      assert.match(call.object.script, /measured_fasteners_check_operation/);
      assert.match(call.object.script, /_FMCAD_REQUEST: "_FMCADRequest" = \{/);
      assert.ok(
        call.object.script.includes(`"operation": ${pythonLiteral(operation)}`),
        "prepared artifact carries the public operation",
      );
      assert.ok(
        call.object.script.includes(`"data": ${pythonLiteral(request)}`),
        "prepared artifact carries the exact validated input",
      );
      calls.push(operation);
      assert.equal(classifyEvidence(result), "fail");
      return { failed: false, text: "FMCAD_RESULT " + JSON.stringify(result) };
    },
  };

  const contract = contracts[operation];
  assert.equal(contract.service.kind, "python");
  assert.equal(contract.service.handler, operation);
  assert.equal(contract.readOnlyRequested, true);
  assert.equal(contract.requirements.sdk, "required");
  assert.equal(cliContracts([])[operation].operation, operation);
  const mcpTool = mcpTools.find(
    (tool) => tool._meta.fmcad.operation === operation,
  );
  assert.ok(mcpTool);
  assert.equal(mcpTool.name, "fmcad_cad_fastener_measured_check");
  const incompleteNative = structuredClone(request);
  delete incompleteNative.native.screw.threadEnd;
  delete incompleteNative.native.layers;
  assert.doesNotThrow(() =>
    validateInvocation({
      version: 1,
      kind: "cad",
      operation,
      doc: "Synthetic",
      data: incompleteNative,
    }),
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation,
        doc: "Synthetic",
        data: { ...request, extra: true },
      }),
    /Unknown CAD inputs/,
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation,
        doc: "Synthetic",
        data: {
          ...request,
          native: { ...request.native, tolerance: { axisOffset: "0.05 mm" } },
        },
      }),
    /native\.tolerance/,
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation,
        doc: "Synthetic",
        data: {
          ...request,
          declaredEvidence: { ...request.declaredEvidence, frame: "assembly" },
        },
      }),
    /fastener.check requires schemaVersion:1 and frame:component/,
  );
  assert.equal(classifyEvidence(result), "fail");
  assert.equal(
    result.nativeMeasurements.measurements.actualEngagement.value,
    3,
  );
  assert.equal(result.declaredEvidence.result.status, "pass");

  const previous = process.cwd();
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-measured-fastener-cli-"),
  );
  process.chdir(temp);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  const code = await cliMain(
    [
      "fastener",
      "measured-check",
      "--doc",
      "Synthetic",
      "--data",
      JSON.stringify(request),
      "--json",
    ],
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      loadConfig: () => ({
        cfg: { routing: "queue", backend: "mcp", timeoutMs: 5000, headers: {} },
      }),
      createFmcad: () => ({
        async start() {},
        async execute(payload, options) {
          const invocation =
            payload.kind === "cad-command" ? payload.invocation : payload;
          const output = await executeInvocation(invocation, broker);
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
      setExitCode() {},
    },
  );
  assert.equal(code, 1, stderr);
  assert.equal(JSON.parse(stdout).operation, operation);
  assert.match(stderr, /^FMCAD_QUEUE_REQUEST /);

  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("measured fasteners must use the typed catalog path");
    },
    services() {
      return {
        async start() {},
        async execute(payload, options) {
          const invocation =
            payload.kind === "cad-command" ? payload.invocation : payload;
          const output = await executeInvocation(invocation, broker);
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
        id: 1,
        method: "tools/call",
        params: {
          name: mcpTool.name,
          arguments: { doc: "Synthetic", data: request },
          _meta: { fmcad: { requestId: "measured-fastener-mcp" } },
        },
      })
    ).raw,
  );
  assert.equal(response.result.structuredContent.operation, operation);
  assert.equal(response.result.structuredContent.status, "fail");
  assert.deepEqual(calls, [operation, operation]);
  const { manualHelp } = require("../src/help-manual");
  const { commands } = require("../src/commands");
  assert.match(
    manualHelp(commands.find((command) => command.target === operation)),
    /axial thread-boundary overlap/,
  );
});
