import test from "node:test";
import assert from "node:assert/strict";
import { object, rows, present } from "./modeling-unit-test-support.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  CadApi,
  CommandsApi,
  CliPorts,
  ToolRequest,
} from "./cad-test-support";
const load = createRequire(path.join(process.cwd(), "tests/cad.test.ts"));
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { catalog, validateCad, buildCadScript, prepareCadScript, executeCad } =
  load("../src/cad") as CadApi;
const { cadBundleUnits } = load(
  "../packages/node-adapters/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { preparePythonArtifact, verifyPythonArtifact } = load(
  "../packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { parseCadInput } = load("../src/cad-input") as {
  parseCadInput(
    words: string[],
    inputs?: Record<string, unknown>,
  ): { data: Record<string, unknown> };
};
const { scriptConfig } = load("./helpers/legacy") as {
  scriptConfig(
    script: string,
    names: string[],
  ): {
    _FMCAD_REQUEST: {
      operation: string;
      data: { version: number; digest: string };
    };
  };
};
const context = {
  doc: 'Review "Model"\n\\test',
  component: null,
  projectId: null,
  preview: false,
};
const pythonEntries = Object.entries(catalog).filter(
  ([, entry]) => !entry.nodeOnly && !entry.internalOnly,
);
const INTERNAL_PYTHON_OPERATIONS = [
  "document.save_native",
  "measure.baseline.capture",
  "measure.baseline.inspect",
  "measure.baseline.compare",
  "measure.baseline.capture_internal",
  "measure.baseline.compare_internal",
  "selection.rule.define",
  "selection.rule.inspect",
  "selection.rule.resolve",
  "selection.rule.check",
  "selection.rule.define_internal",
  "selection.rule.inspect_internal",
  "selection.rule.resolve_internal",
  "selection.rule.check_internal",
];

test("CAD integration: prepared status artifact binds its request and preserves the lightweight profile", () => {
  const prepared = prepareCadScript("document.status", {}, context);
  assert.deepEqual(prepared, prepareCadScript("document.status", {}, context));
  assert.equal(prepared.script, buildCadScript("document.status", {}, context));
  assert.equal(prepared.request.operation, "document.status");
  assert.ok(prepared.units.some((unit) => unit.id === "values"));
  assert.ok(!prepared.units.some((unit) => unit.id === "model"));
  assert.ok(Object.isFrozen(prepared.bytes));
});

// Only imports and handler registration execute. No Fusion application is available.
const stubImports = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
`;
function python(program: string, input: string) {
  const result = spawnSync("python3", ["-B", "-c", program], {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function parameterTestProgram(
  faults: { failRestore?: boolean; corruptCoverage?: boolean } = {},
) {
  return (
    stubImports +
    `adsk.fusion.FeatureHealthStates = types.SimpleNamespace(
    HealthyFeatureHealthState=0, WarningFeatureHealthState=1,
    ErrorFeatureHealthState=2, SuppressedFeatureHealthState=3)
import re
exec(sys.stdin.read())
_BaseCadContext = CadContext
_FAIL_RESTORE = ${faults.failRestore ? "True" : "False"}
_CORRUPT_COVERAGE = ${faults.corruptCoverage ? "True" : "False"}

class Parameter:
    objectType = 'adsk::fusion::UserParameter'
    name = 'd1'
    unit = 'mm'
    def __init__(self):
        self._expression = '10 mm'
    @property
    def expression(self):
        return self._expression
    @expression.setter
    def expression(self, value):
        if _FAIL_RESTORE and value == '10 mm' and self._expression != '10 mm':
            raise RuntimeError('fixture restore setter failed')
        self._expression = value

class Context(_BaseCadContext):
    def __init__(self, doc, component, project, doc_id=None, doc_file_id=None):
        self.doc_id, self.doc_file_id = doc_id, doc_file_id
        self.doc = types.SimpleNamespace(name=doc)
        self.app = types.SimpleNamespace(activeDocument=self.doc)
        self.root = types.SimpleNamespace(
            objectType='adsk::fusion::Component', allOccurrences=[])
        self.component, self.occurrence = self.root, None
        self.design = types.SimpleNamespace(timeline=[], computeAll=lambda: 0)
        self.created = []
        self.parameter = Parameter()
        self.circle = types.SimpleNamespace(
            objectType='adsk::fusion::SketchCircle',
            parentComponent=self.root,
            assemblyContext=None,
            geometry=types.SimpleNamespace(objectType='adsk::core::Circle3D'))
    def assert_identity(self):
        pass
    def activate_target(self):
        pass
    def resolve(self, ref, kind=None):
        if ref == 'd1': return self.parameter
        if ref == 'circle': return self.circle
        raise ValueError('Unknown fixture reference')
    def ref(self, entity):
        return {'kind': 'component', 'name': 'root'}
    def _expression(self, expression, units=None, unitless=False):
        if not isinstance(expression, str):
            raise TypeError('expression must be text')
        match = re.fullmatch(r'\\s*(-?[0-9]+(?:\\.[0-9]+)?)\\s*(mm|cm)\\s*', expression)
        if not match: raise ValueError('unsupported fixture expression')
        value = float(match.group(1))
        if match.group(2) == 'mm': value /= 10
        return expression, value
    def call(self, operation, data):
        if operation == 'measure.radius':
            return {'value': float(self.parameter.expression.split()[0]),
                    'dimension': 'length', 'units': 'mm'}
        result = super().call(operation, data)
        if operation == 'parameter.test' and _CORRUPT_COVERAGE:
            result['coverage']['completed'] = 0
        return result

CadContext = Context
run('')
`
  );
}
async function generatedParameterTest(
  data: Record<string, unknown>,
  faults: { failRestore?: boolean; corruptCoverage?: boolean } = {},
) {
  let sourceOutput: Record<string, unknown> | undefined;
  const client = {
    callTool: async (request: ToolRequest) => {
      const text = python(parameterTestProgram(faults), request.object.script);
      const line = text
        .split("\n")
        .find((row) => row.startsWith("FMCAD_RESULT "));
      assert.ok(line, text);
      sourceOutput = JSON.parse(line.slice("FMCAD_RESULT ".length)) as Record<
        string,
        unknown
      >;
      return { text };
    },
  };
  const result = (await executeCad(
    client,
    "parameter.test",
    data,
    context,
  )) as unknown as { success: boolean; result: Record<string, unknown> };
  return { source: present(sourceOutput), result };
}
function parameterTestData(firstExpected = "12 mm") {
  const check = (expected: string) => ({
    measurement: {
      operation: "measure.radius",
      data: { ref: "circle", units: "mm" },
    },
    expected,
    tolerance: "0 mm",
  });
  return {
    confirm: true,
    timeBudgetMs: 10_000,
    cases: [
      {
        id: "radius-12",
        assign: [{ parameter: "d1", expression: "12 mm" }],
        checks: [check(firstExpected)],
      },
      {
        id: "radius-8",
        assign: [{ parameter: "d1", expression: "8 mm" }],
        checks: [check("8 mm")],
      },
    ],
  };
}
function registeredPython(script: string, afterRegistration: string) {
  return python(
    stubImports +
      `import ast
tree = ast.parse(sys.stdin.read())
class Registry(dict):
    def update(self, entries):
        for key, handler in entries.items():
            assert key not in self, 'Duplicate handler: ' + key
            assert callable(handler), key
            self[key] = handler
namespace = {'Registry': Registry}
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CAD_HANDLERS' for t in node.targets):
        node.value = ast.Call(func=ast.Name(id='Registry', ctx=ast.Load()), args=[], keywords=[])
ast.fix_missing_locations(tree)
exec(compile(tree, '<cad-registry>', 'exec'), namespace)
` +
      afterRegistration,
    script,
  );
}

test("CAD integration: every catalog example validates through the actual dispatcher", async (t) => {
  for (const [operation, entry] of Object.entries(catalog)) {
    await t.test(operation, async () => {
      assert.equal(validateCad(operation, entry.example), entry);
      const input = parseCadInput(
        ["--doc", context.doc, "--data", JSON.stringify(entry.example)],
        entry.inputs,
      );
      assert.deepEqual(input.data, entry.example);
      const result = await executeCad(null, operation, input.data, {
        ...context,
        preview: true,
      });
      assert.equal(result.success, true, JSON.stringify(result));
    });
  }
});

test("joint.rigid catalog accepts opt-in regular mode while rejecting unsupported rotation vectors", () => {
  const data = {
    name: "Regular",
    mode: "regular",
    occurrenceOne: "A:1",
    occurrenceTwo: "B:1",
    confirm: true,
    originOne: { ref: { token: "origin-a", kind: "JointOrigin" } },
    originTwo: { point: "P_B", xAxis: "X_B", zAxis: "Z_B" },
    posePolicy: "moveSecond",
    angle: "30 deg",
    offset: "2 mm",
    isFlipped: true,
    linearTolerance: "0.01 mm",
    angularTolerance: "0.01 deg",
    groundingPolicy: "reject",
  };
  assert.equal(validateCad("joint.rigid", data), catalog["joint.rigid"]);
  assert.throws(
    () =>
      validateCad("joint.rigid", { ...data, rotationAxisVector: [0, 0, 1] }),
    /Unknown CAD inputs/,
  );
});

test("CAD integration: every generated Python request compiles and round-trips JSON", () => {
  for (const [operation, entry] of pythonEntries) {
    const script = buildCadScript(operation, entry.example, context);
    if (entry.curve) {
      const request = scriptConfig(script, ["_FMCAD_REQUEST"])._FMCAD_REQUEST;
      assert.equal(request.operation, operation);
      assert.deepEqual(
        request.data,
        load("../src/curve").prepare(operation, entry.example),
      );
      continue;
    }
    if (entry.dataImport) {
      const request = scriptConfig(script, ["_FMCAD_REQUEST"])._FMCAD_REQUEST;
      assert.equal(request.operation, operation);
      assert.equal(request.data.version, 1);
      assert.ok(request.data.digest);
      continue; // File adapters serialize their validated plan, not CLI-host paths/raw records.
    }
    const expectedData =
      operation === "inspect.pack"
        ? load("../src/dist/core/application/inspection").planInspection(
            entry.example,
            load("../src/catalog").contracts,
            validateCad,
          )
        : entry.example;
    assert.deepEqual(scriptConfig(script, ["_FMCAD_REQUEST"])._FMCAD_REQUEST, {
      operation,
      data: expectedData,
      doc: context.doc,
      component: null,
      projectId: null,
    });
  }
});

test("CAD integration: full executable Python registry matches the non-Node catalog without overwrites", () => {
  const artifact = preparePythonArtifact(cadBundleUnits(process.cwd()));
  verifyPythonArtifact(artifact);
  const output = registeredPython(
    artifact.script,
    "print(json.dumps(sorted(namespace['CAD_HANDLERS'])))",
  );
  assert.deepEqual(
    JSON.parse(output),
    [
      ...pythonEntries.map(([operation]) => operation),
      ...INTERNAL_PYTHON_OPERATIONS,
    ].sort(),
  );
  assert.deepEqual(
    Object.entries(catalog)
      .filter(([, e]) => e.nodeOnly)
      .map(([op]) => op)
      .sort(),
    [
      "batch.finalize",
      "batch.preview",
      "batch.reconcile",
      "batch.run",
      "batch.summary",
      "batch.validate",
      "capabilities.inspect",
      "capabilities.probe",
      "component.externalize",
      "definition.expand",
      "definition.inspect",
      "definition.instantiate",
      "document.save.observe",
      "document.save.once",
      "drawing.check",
      "drawing.export",
      "drawing.package",
      "measure.baseline.capture",
      "measure.baseline.compare",
      "measure.baseline.inspect",
      "reference.calibrate",
      "reference.compare",
      "reference.layout",
      "references.refresh",
      "selection.rule.check",
      "selection.rule.define",
      "selection.rule.inspect",
      "selection.rule.resolve",
      "ui.inspect",
      "ui.resolve",
      "ui.respond",
    ],
  );
});

test("CAD integration: selected status artifact binds its request to the measurement handler", () => {
  const prepared = prepareCadScript("status", {}, context);
  const fullUnits = cadBundleUnits(process.cwd());
  const measure = prepared.units.find(
    (unit) =>
      unit.filename === "runtime/python/fmcad/adapters/fusion/measure.py",
  );

  assert.equal(prepared.request.operation, "status");
  assert.equal(
    scriptConfig(prepared.script, ["_FMCAD_REQUEST"])._FMCAD_REQUEST.operation,
    "status",
  );
  assert.ok(prepared.units.length < fullUnits.length);
  assert.ok(
    measure,
    "The selected artifact must retain the source handler unit",
  );
  assert.match(measure.source, /'status': _measure_status/);

  const result = JSON.parse(
    registeredPython(
      prepared.script,
      `namespace['_measure_snapshot'] = lambda ctx, data: {
    'document': {'name': 'Fixture'},
    'counts': {'bodies': 1},
    'issues': ['timeline warning'],
    'limitations': ['snapshot only']}
result = namespace['CAD_HANDLERS']['status'](object(), {})
print(json.dumps(result))`,
    ),
  );
  assert.deepEqual(result, {
    document: { name: "Fixture" },
    counts: { bodies: 1 },
    issues: ["timeline warning"],
    observedHealth: "issues",
    acceptance: "notEvaluated",
    limitations: ["snapshot only"],
  });
});

test("new Node-only routes dispatch through their explicit coordinators, not the Python registry", async (t) => {
  const client = {
    callTool: async () =>
      assert.fail("Node routing must not directly submit a generic CAD script"),
  };
  const external = load("../src/externalization"),
    references = load("../src/references-refresh"),
    ui = load("../src/ui");
  const documentPublication = load("../src/document-publication");
  t.mock.method(
    external,
    "execute",
    async (
      c: unknown,
      data: unknown,
      ctx: unknown,
      adapter: { step: unknown; refresh: unknown; inspectUi: unknown },
    ) => {
      assert.equal(c, client);
      assert.equal(typeof adapter.step, "function");
      assert.equal(typeof adapter.refresh, "function");
      return { route: "externalization" };
    },
  );
  t.mock.method(
    references,
    "execute",
    async (
      c: unknown,
      data: unknown,
      ctx: unknown,
      adapter: { step: unknown; refresh: unknown; inspectUi: unknown },
    ) => {
      assert.equal(c, client);
      assert.equal(typeof adapter.step, "function");
      assert.equal(typeof adapter.inspectUi, "function");
      return { route: "references" };
    },
  );
  t.mock.method(ui, "execute", async (c: unknown, operation: string) => {
    assert.equal(c, client);
    return { route: operation };
  });
  t.mock.method(
    documentPublication,
    "execute",
    async (
      c: unknown,
      operation: string,
      data: unknown,
      ctx: unknown,
      execute: unknown,
    ) => {
      assert.equal(c, client);
      assert.equal(typeof execute, "function");
      return { route: operation };
    },
  );
  for (const [operation, route] of [
    ["component.externalize", "externalization"],
    ["references.refresh", "references"],
    ["ui.inspect", "ui.inspect"],
    ["ui.resolve", "ui.resolve"],
    ["ui.respond", "ui.respond"],
    ["document.save.once", "document.save.once"],
    ["document.save.observe", "document.save.observe"],
  ] as [string, string][]) {
    assert.deepEqual(
      await executeCad(client, operation, catalog[operation]!.example, context),
      { route },
    );
  }
  for (const operation of ["batch.reconcile", "batch.finalize"])
    await assert.rejects(
      executeCad(null, operation, catalog[operation]!.example, context),
      /requires the selected addin backend/,
    );
  const { commands } = load("../src/commands") as CommandsApi;
  assert.equal(
    commands.some((command) => command.target === "document.save_native"),
    false,
    "internal save primitive must not be exposed as a CLI command",
  );
});

test("CAD integration: aliases have unique owners, exact targets and collision-free help", () => {
  const { commands, findCommand } = load("../src/commands") as CommandsApi;
  const { detail } = load("../src/help") as {
    detail(...words: string[]): string;
  };
  const owners = new Map();
  for (const command of commands) {
    for (const spelling of [command.key, ...(command.aliases || [])]) {
      assert.equal(owners.has(spelling), false, `Collision: ${spelling}`);
      owners.set(spelling, command);
      assert.equal(findCommand(spelling.split(" ")), command, spelling);
      if (command.aliases?.includes(spelling))
        assert.ok(
          detail(...spelling.split(" ")).includes(command.usage),
          spelling,
        );
    }
  }
  assert.deepEqual(
    commands
      .filter((c) => c.kind === "cad")
      .map((c) => c.target)
      .sort(),
    Object.keys(catalog)
      .filter((operation) => !catalog[operation]!.internalOnly)
      .sort(),
  );
  assert.equal(findCommand(["export", "step"]).kind, "export");
  assert.equal(findCommand(["cad", "export", "step"]).target, "export.step");
});

test("CAD integration: CLI previews for every catalog route and alias never load config or construct a client", async () => {
  const { commands } = load("../src/commands") as CommandsApi;
  const { main } = load("../src/cli") as {
    main(words: string[], ports: CliPorts): Promise<number>;
  };
  let networkAttempts = 0;
  const forbidden = () => {
    networkAttempts++;
    throw new Error("Preview must stay offline");
  };
  for (const command of commands.filter((c) => c.kind === "cad")) {
    for (const spelling of [command.key, ...(command.aliases || [])]) {
      let stdout = "",
        stderr = "";
      const code = await main(
        [
          ...spelling.split(" "),
          "--doc",
          context.doc,
          "--doc-id",
          catalog[command.target]!.example.scope?.document?.creationId ||
            "preview-document-creation",
          ...(catalog[command.target]!.example.scope?.document?.fileId
            ? [
                "--doc-file-id",
                catalog[command.target]!.example.scope!.document!.fileId!,
              ]
            : []),
          "--data",
          JSON.stringify(catalog[command.target]!.example),
          "--preview",
          "--json",
        ],
        {
          loadConfig: forbidden,
          McpClient: class {
            constructor() {
              forbidden();
            }
          },
          stdout: {
            write: (s) => {
              stdout += s;
            },
          },
          stderr: {
            write: (s) => {
              stderr += s;
            },
          },
          setExitCode: () => {},
        },
      );
      assert.equal(code, 0, `${spelling}: ${stderr}`);
      assert.equal(JSON.parse(stdout).success, true, spelling);
    }
  }
  assert.equal(networkAttempts, 0);
});

test("CAD integration: unsupported input flags and keys fail before any executor call", async () => {
  let calls = 0;
  const client = {
    callTool: async () => {
      calls++;
      assert.fail("Invalid input reached executor");
    },
  };
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.throws(
      () => parseCadInput(["--unsupported-review-flag", "true"], entry.inputs),
      /Unknown CAD option/,
    );
    await assert.rejects(
      executeCad(
        client,
        operation,
        { ...entry.example, unsupportedReviewFlag: true },
        context,
      ),
      /Unknown CAD inputs/,
    );
  }
  assert.equal(calls, 0);
});

test("CAD integration: transport readOnly and generated activation agree for every Python operation", async () => {
  for (const [operation, entry] of pythonEntries) {
    let request: ToolRequest | undefined;
    const client = {
      callTool: async (args: ToolRequest) => {
        request = args;
        return {
          text:
            "FMCAD_RESULT " +
            JSON.stringify({ success: true, operation, result: {} }),
        };
      },
    };
    await executeCad(client, operation, entry.example, context);
    assert.equal(request!.object.readOnly, entry.readOnly, operation);
    const keepActive =
      entry.readOnly ||
      operation === "document.clear" ||
      operation === "selection.highlight" ||
      (operation.startsWith("camera.") && operation !== "camera.set") ||
      operation === "shot.pack";
    python(
      stubImports +
        `exec(sys.stdin.read())
calls = []
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.app = types.SimpleNamespace(activeDocument=object())
        self.doc = types.SimpleNamespace(name='Review', activate=self.activate)
        self.created = []
    def activate(self):
        calls.append('activate')
        self.app.activeDocument = self.doc
        return True
    def call(self, operation, data):
        assert (self.app.activeDocument == self.doc) == ${keepActive ? "False" : "True"}
        calls.append('handler')
        return {}
CadContext = Context
run('')
assert calls == ${keepActive ? "['handler']" : "['activate', 'handler']"}, calls
`,
      request!.object.script,
    );
  }
});

test("CAD integration: generated trailer must not turn failed handler evidence into success", () => {
  const script = buildCadScript(
    "parameter.test",
    catalog["parameter.test"]!.example,
    context,
  );
  const text = python(
    stubImports +
      `exec(sys.stdin.read())
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.doc = types.SimpleNamespace(name='Review')
        self.app = types.SimpleNamespace(activeDocument=self.doc)
        self.created = []
    def call(self, operation, data):
        return {'passed': False, 'status': 'fail', 'restored': False, 'restoreErrors': ['restore setter failed']}
CadContext = Context
run('')
`,
    script,
  );
  const output = JSON.parse(
    text
      .split("\n")
      .find((s) => s.startsWith("FMCAD_RESULT "))!
      .slice(13),
  );
  assert.equal(output.success, false, JSON.stringify(output));
});

test("CAD integration: parameter.test v2 public outcome validates generated evidence", async () => {
  const good = await generatedParameterTest(parameterTestData());
  const sourceReport = object(good.source["result"]);
  const publicReport = object(good.result.result);
  assert.equal(good.source["success"], true);
  assert.equal(sourceReport["passed"], true);
  assert.equal(sourceReport["restored"], true);
  assert.deepEqual(sourceReport["coverage"], {
    required: 2,
    completed: 2,
    skipped: 0,
  });
  assert.equal(good.result.success, true);
  assert.equal(publicReport["passed"], true);

  const failedCheck = await generatedParameterTest(parameterTestData("13 mm"));
  const failedCheckReport = object(failedCheck.source["result"]);
  const failedCases = rows(failedCheckReport["cases"]);
  assert.equal(failedCheck.source["success"], false);
  const failedCase = present(failedCases[0]);
  assert.equal(present(rows(failedCase["checks"])[0])["passed"], false);
  assert.equal(failedCheck.result.success, false);

  const failedRestore = await generatedParameterTest(parameterTestData(), {
    failRestore: true,
  });
  const failedRestoreReport = object(failedRestore.source["result"]);
  assert.equal(failedRestoreReport["passed"], false);
  assert.equal(failedRestoreReport["restored"], false);
  assert.ok(rows(failedRestoreReport["restoreErrors"]).length > 0);
  assert.equal(failedRestore.result.success, false);

  const corruptCoverage = await generatedParameterTest(parameterTestData(), {
    corruptCoverage: true,
  });
  const corruptReport = object(corruptCoverage.source["result"]);
  assert.equal(corruptCoverage.source["success"], true);
  assert.equal(corruptReport["passed"], true);
  assert.deepEqual(corruptReport["coverage"], {
    required: 2,
    completed: 0,
    skipped: 0,
  });
  assert.equal(corruptCoverage.result.success, false);
});

test("CAD integration: batch stops and refuses replay on nested failed CAD evidence", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-cad-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const client = {
    callTool: async () => {
      calls++;
      return {
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            success: true,
            operation: calls === 1 ? "check" : "sketch.create",
            result:
              calls === 1
                ? { passed: false, status: "fail" }
                : { sketch: { token: "mock-sketch" } },
            created: [],
          }),
      };
    },
  };
  const data = {
    runId: "nested-failure",
    atomic: false,
    reportPath: dir,
    operations: [
      {
        id: "gate",
        operation: "check",
        data: catalog["check"]!.example,
        onExisting: "reuse",
      },
      {
        id: "later",
        operation: "sketch.create",
        data: catalog["sketch.create"]!.example,
        onExisting: "reuse",
      },
    ],
  };
  const result = await executeCad(client, "batch.run", data, context);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.steps[1]!.status, "skipped");
  await assert.rejects(
    executeCad(client, "batch.run", data, context),
    /inspection|failed/,
  );
});

test("CAD integration: advertised component input flag is not swallowed by context parsing", () => {
  const input = parseCadInput(
    [
      "--doc",
      "Model",
      "--input-component",
      "Bracket",
      "--name",
      "MountBracket",
    ],
    catalog["component.rename"]!.inputs,
  );
  assert.equal(
    validateCad("component.rename", input.data),
    catalog["component.rename"],
  );
  assert.equal(input.data["component"], "Bracket");
});

test("CAD integration: explicit extrude directions dispatch using existing model API stubs", () => {
  python(
    `import sys
sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), "tests"))})
import model_test as model
for direction in ('positive', 'negative'):
    ctx = model.Context()
    data = dict(model.CATALOG['model.extrude']['example'], direction=direction)
    result = model.HANDLERS['model.extrude'](ctx, data)
    assert result['feature']
`,
    "",
  );
});

test("CAD integration: selection highlight respects its already-active-document contract", () => {
  const script = buildCadScript(
    "selection.highlight",
    { refs: [], replace: true },
    context,
  );
  python(
    stubImports +
      `exec(sys.stdin.read())
activations = []
class Context(CadContext):
    def __init__(self, *args):
        self.doc_id = self.doc_file_id = None
        self.doc = types.SimpleNamespace(name='Review', activate=self.activate)
        self.app = types.SimpleNamespace(activeDocument=object(), userInterface=types.SimpleNamespace(
            activeSelections=types.SimpleNamespace(clear=lambda: True, count=0)))
        self.created = []
    def activate(self):
        activations.append(True)
        self.app.activeDocument = self.doc
    def call(self, operation, data):
        return CAD_HANDLERS[operation](self, data)
CadContext = Context
try:
    run('')
except ValueError as error:
    assert 'already be active' in str(error)
assert not activations, 'Generated trailer activated a document despite selection.highlight contract'
`,
    script,
  );
});
