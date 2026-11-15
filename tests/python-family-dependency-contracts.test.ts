import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { PreparedPythonArtifact } from "@fmcad/core";

const root = process.cwd();
const load = createRequire(
  path.resolve("tests/python-family-dependency-contracts.test.js"),
);
const cad = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");
const run = load("../src/run") as typeof import("../src/composition/run.js");
const { fromParsedCommand, execute: executeWorker } = load(
  "../src/cad-service",
) as typeof import("../src/composition/cad-service.js");
const { executeInvocation } = load(
  "../src/catalog/execute",
) as typeof import("../src/composition/catalog-execution.js");
const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance.js").createQueueInstance
>;
const python = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact.js") &
  typeof import("../packages/node-adapters/src/python/context-binding.js") &
  typeof import("../packages/node-adapters/src/python/checker.js") &
  typeof import("../packages/node-adapters/src/python/admission.js");
const { cadBundleManifest, cadBundleUnits, orderBundle, prepareCadBundle } =
  load(
    "../packages/node-adapters/dist/python/bundle",
  ) as typeof import("../packages/node-adapters/src/python/bundle.js");

const runtime = path.resolve("dist/runtime/python");
const fixtures = path.resolve("tests/fixtures/python-family-dependencies");

function createChecker() {
  const typingRoot = path.join(runtime, "typing");
  return python.createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function prepareWire(original: PreparedPythonArtifact, id: string) {
  const receipt = prepareReceiptScript(
    original.script,
    true,
    `/offline/${id}.json`,
    { jobId: id },
    { mapPath: (value) => value },
  );
  const artifact = python.retainPythonOrigin(
    receipt,
    python.pythonArtifactManifest(original),
  );
  const request = {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call" as const,
    params: {
      name: "fusion_mcp_execute",
      arguments: {
        featureType: "script",
        object: { script: artifact.script },
      },
    },
  };
  const json = JSON.stringify(request);
  return {
    artifact,
    request,
    json,
    jsonBytes: Buffer.byteLength(json, "utf8"),
  };
}

function runtimeUnits(artifact: PreparedPythonArtifact) {
  return artifact.units.filter((unit) => unit.role === "runtime");
}

function runtimeUnitIds(artifact: PreparedPythonArtifact): string[] {
  return runtimeUnits(artifact).map((unit) => unit.id);
}

let fullFallback: PreparedPythonArtifact | undefined;
function dynamicFallback(): PreparedPythonArtifact {
  return (fullFallback ??= run.prepareRunScript(
    path.join(fixtures, "dynamic-dispatch.py"),
    [],
    false,
    "FamilyDependencyFallback",
    { docId: "family-dependency-fallback" },
    "cad-v1",
    [],
  ));
}

const familyOperations = [
  ["shape.box", "geometry-shapes-application"],
  ["shape.helix", "spring-fusion"],
  ["model.thread", "thread-fusion"],
  ["component.create", "assembly"],
  ["component.inspect", "assembly"],
  ["document.status", "document"],
  ["visibility.show", "io"],
  ["inspect.pack", "inspection"],
  ["measure.diameter", "measure"],
  ["frame.context_audit", "semantic-model-state-application"],
  ["selection.rule.define", "selection-rules-application"],
  ["geometry.delta", "regional-geometry-application"],
  ["measure.section-series", "section-witness-application"],
  ["fastener.measured-check", "measured-fasteners-handlers"],
  ["mechanism.drive-test", "native-drive-handlers"],
  ["sketch.coordinate-check", "sketch-geometry-proof-application"],
  ["measure.baseline.inspect", "measure-baseline-application"],
] as const;

const publicPolicyRoots = [
  "shape.box",
  "component.inspect",
  "inspect.pack",
  "document.status",
] as const;

const isolatedHeavyOwners = ["cam", "optics", "sheetmetal"] as const;

type CanonicalModule = (typeof cadBundleManifest)[number];

function canonicalOwner(module: CanonicalModule): string | undefined {
  return (
    module.owner ??
    (module.path.startsWith("assets/cad/") ? module.id : undefined)
  );
}

const ownerModules = new Map<string, CanonicalModule>();
for (const module of cadBundleManifest) {
  const owner = canonicalOwner(module);
  if (owner === undefined) continue;
  assert.ok(!ownerModules.has(owner), `duplicate canonical owner ${owner}`);
  ownerModules.set(owner, module);
}

const ownerDependencyClosures = new Map<string, Set<string>>();
for (const [owner, module] of ownerModules) {
  const closure = new Set(
    orderBundle(cadBundleManifest, [module.id]).map((unit) => unit.id),
  );
  ownerDependencyClosures.set(owner, closure);
}

// A cross-family owner is permitted when the actual root owner's canonical
// dependency closure declares it; unrelated owners do not legalize new edges.
function foreignFamilyEdges(
  artifact: PreparedPythonArtifact,
  rootOwner: string,
): { owner: string; units: string[] }[] {
  const declared = ownerDependencyClosures.get(rootOwner);
  assert.ok(declared, `canonical bundle has no source owner ${rootOwner}`);
  const selected = new Set(runtimeUnitIds(artifact));
  return isolatedHeavyOwners.flatMap((owner) => {
    const familyRoot = ownerModules.get(owner);
    assert.ok(familyRoot, `canonical bundle has no isolated owner ${owner}`);
    const unexpected =
      selected.has(familyRoot.id) && !declared.has(familyRoot.id)
        ? [familyRoot.id]
        : [];
    return unexpected.length ? [{ owner, units: unexpected }] : [];
  });
}

function assertCanonicalOwnerPolicy(
  artifact: PreparedPythonArtifact,
  rootOwner: string,
): void {
  assert.deepEqual(
    foreignFamilyEdges(artifact, rootOwner),
    [],
    `public owner ${rootOwner} selected undeclared isolated-family units`,
  );
}

function executeCanonicalRegistry(operations: readonly string[]) {
  const source = runtimeUnits(dynamicFallback())
    .map((unit) => unit.source)
    .join("\n\n");
  const program = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
namespace = {}
exec(compile(sys.stdin.read(), '<family-contract-runtime>', 'exec'), namespace)
registry = namespace['CAD_HANDLERS']
operations = ${JSON.stringify(operations)}
print(json.dumps({
    'owners': {operation: registry.owners.get(operation) for operation in operations},
    'shapePredecessorCaptured': namespace['_shape_helix_legacy'] is not registry['shape.helix'],
    'threadPredecessorCaptured': namespace['_original_model_thread'] is not registry['model.thread'],
    'shapePredecessorCallable': callable(namespace['_shape_helix_legacy']),
    'threadPredecessorCallable': callable(namespace['_original_model_thread']),
}))
`;
  const result = spawnSync("python3", ["-B", "-c", program], {
    input: source,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout) as {
    owners: Record<string, string | null>;
    shapePredecessorCaptured: boolean;
    threadPredecessorCaptured: boolean;
    shapePredecessorCallable: boolean;
    threadPredecessorCallable: boolean;
  };
}

test("public CAD, CLI and MCP preparation preserve family provenance and separate raw/wire baselines", async () => {
  const operation = "shape.box";
  const data = structuredClone(cad.catalog[operation]!.example);
  const context = {
    doc: "FamilyDependencyPublicRoute",
    docId: "family-dependency-public-route",
  };
  const original = cad.prepareCadScript(operation, data, context);
  const wire = prepareWire(original, "family-dependency-shape-box");
  const fallback = dynamicFallback();
  const fallbackWire = prepareWire(
    fallback,
    "family-dependency-dynamic-fallback",
  );
  const rawSourceBytes = Buffer.byteLength(original.script, "utf8");
  const fallbackRawSourceBytes = Buffer.byteLength(fallback.script, "utf8");
  const measurements =
    `units=${runtimeUnits(original).length}/${runtimeUnits(fallback).length}, ` +
    `rawSource=${rawSourceBytes}/${fallbackRawSourceBytes} B, ` +
    `wireJSON=${wire.jsonBytes}/${fallbackWire.jsonBytes} B`;

  assert.ok(runtimeUnitIds(original).includes("geometry-shapes-application"));
  assert.ok(
    runtimeUnits(original).length < runtimeUnits(fallback).length,
    `static CAD preparation retained the full fallback: ${measurements}`,
  );
  assert.ok(
    rawSourceBytes < fallbackRawSourceBytes,
    `raw-source closure did not shrink: ${measurements}`,
  );
  assert.ok(
    wire.jsonBytes < fallbackWire.jsonBytes,
    `wire JSON did not shrink independently of raw source: ${measurements}`,
  );

  const manifest = python.pythonArtifactManifest(original);
  const origin = object(wire.artifact.context)
    ? wire.artifact.context["origin"]
    : undefined;
  assert.ok(object(origin), "receipt lost original source provenance");
  assert.equal(origin["artifactHash"], original.artifactHash);
  assert.equal(origin["sha256"], original.sha256);
  assert.deepEqual(manifest.units, original.units);
  assert.deepEqual(
    origin["units"],
    manifest.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
  );
  assert.deepEqual(origin["sourceMap"], manifest.sourceMap);
  assert.ok(
    Array.isArray(origin["segments"]) && origin["segments"].length > 0,
    "receipt lost exact embedded-source segments",
  );
  assert.deepEqual(JSON.parse(wire.json), wire.request);

  const admission = python.createPythonRpcAdmission({
    runtime,
    checker: createChecker(),
  });
  const certificate = await admission.check(wire.request, wire.artifact);
  assert.equal(certificate.kind, "python");
  assert.equal(certificate.report?.status, "passed", measurements);
  assert.deepEqual(certificate.report?.diagnostics, []);
  certificate.fence(wire.request);

  const calls: Parameters<
    import("../src/composition/cad-service.js").CommandBackend["callTool"]
  >[] = [];
  const backend: import("../src/composition/cad-service.js").CommandBackend = {
    async callTool(...args) {
      calls.push(args);
      return { text: 'FMCAD_RESULT {"success":true,"result":{"value":42}}' };
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const command = fromParsedCommand({
    kind: "cad",
    operation,
    data,
    context,
    json: true,
  });
  const code = await executeWorker(command, backend, () => {}, {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });
  const result = await executeInvocation(
    { version: 1, kind: "cad", operation, data, ...context },
    backend,
  );
  assert.equal(code, 0, stderr.join(""));
  assert.deepEqual(JSON.parse(stdout.join("")), result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[1], "fusion_mcp_execute");
  assert.equal(calls[1]?.[1], "fusion_mcp_execute");
  assert.deepEqual(calls[0]?.[0], calls[1]?.[0]);
  assert.deepEqual(calls[0]?.[2], calls[1]?.[2]);
  assert.ok(
    calls[0]?.[2]?.units.some(
      (unit) => unit.id === "geometry-shapes-application",
    ),
  );
});

test("static family run closes required families; dynamic dispatch keeps the full inventory", () => {
  const prepared = run.prepareRunScript(
    path.join(fixtures, "family-operations.py"),
    [],
    false,
    "FamilyDependencyClosure",
    { docId: "family-dependency-closure" },
    "cad-v1",
    [],
  );
  const fallback = dynamicFallback();
  const ids = new Set(runtimeUnitIds(prepared));
  const fallbackIds = runtimeUnitIds(fallback);
  const rawSourceBytes = Buffer.byteLength(prepared.script, "utf8");
  const fallbackRawSourceBytes = Buffer.byteLength(fallback.script, "utf8");
  const familyWire = prepareWire(prepared, "family-dependency-closure");
  const fallbackWire = prepareWire(
    fallback,
    "family-dependency-family-fallback",
  );
  const measurements =
    `units=${ids.size}/${fallbackIds.length}, ` +
    `rawSource=${rawSourceBytes}/${fallbackRawSourceBytes} B, ` +
    `wireJSON=${familyWire.jsonBytes}/${fallbackWire.jsonBytes} B`;

  for (const [operation, unit] of familyOperations)
    assert.ok(ids.has(unit), `${operation} omitted ${unit}`);
  assert.ok(
    ids.size < fallbackIds.length,
    `static family calls did not reduce runtime closure: ${measurements}`,
  );
  assert.ok(
    rawSourceBytes < fallbackRawSourceBytes,
    `static family calls did not reduce raw source: ${measurements}`,
  );
  assert.ok(
    familyWire.jsonBytes < fallbackWire.jsonBytes,
    `static family calls did not reduce wire JSON: ${measurements}`,
  );
  assert.deepEqual(
    fallbackIds,
    cadBundleUnits(root).map((unit) => unit.id),
    "dynamic fallback must preserve the canonical full inventory",
  );

  const positions = [
    "geometry-shapes-application",
    "shapes",
    "spring-domain",
    "spring-fusion",
  ].map((id) => runtimeUnitIds(prepared).indexOf(id));
  assert.ok(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > positions[index - 1]!),
    ),
    "shape.helix lost its registered predecessor before the spring adapter",
  );
  const threadPositions = [
    "geometry-model-application",
    "model",
    "thread-domain",
    "thread-fusion",
  ].map((id) => runtimeUnitIds(prepared).indexOf(id));
  assert.ok(
    threadPositions.every(
      (position, index) =>
        position >= 0 &&
        (index === 0 || position > threadPositions[index - 1]!),
    ),
    "model.thread lost its registered predecessor before the thread adapter",
  );
});

test("canonical public roots reject injected undeclared heavy-family edges", () => {
  const owners = executeCanonicalRegistry(publicPolicyRoots).owners;
  const originalArtifacts = new Map<
    string,
    { artifact: PreparedPythonArtifact; owner: string }
  >();

  for (const operation of publicPolicyRoots) {
    const artifact = cad.prepareCadScript(
      operation,
      structuredClone(cad.catalog[operation]!.example),
      { doc: "CanonicalFamilyGuard", docId: `family-guard-${operation}` },
    );
    const owner = owners[operation];
    assert.ok(owner, `${operation} has no registry owner`);
    assertCanonicalOwnerPolicy(artifact, owner);
    originalArtifacts.set(operation, { artifact, owner });
  }

  const shape = originalArtifacts.get("shape.box");
  assert.ok(shape);
  const wrapper = shape.artifact.units.find((unit) => unit.role === "wrapper");
  assert.ok(wrapper);
  const shapeApplication = cadBundleManifest.find(
    (unit) => unit.id === "geometry-shapes-application",
  );
  const camOwner = ownerModules.get("cam");
  assert.ok(shapeApplication);
  assert.ok(camOwner);

  const copyRoot = fs.mkdtempSync(
    path.join(path.dirname(root), "fmcad-family-source-copy-"),
  );
  try {
    fs.cpSync(
      path.join(root, "assets/cad"),
      path.join(copyRoot, "assets/cad"),
      {
        recursive: true,
      },
    );
    fs.cpSync(
      path.join(root, "runtime/python"),
      path.join(copyRoot, "runtime/python"),
      { recursive: true },
    );
    const injectedPath = path.join(copyRoot, shapeApplication.path);
    const source = fs.readFileSync(injectedPath, "utf8");
    const injectionPoint = "    return _shapes_box(ctx, data)";
    assert.equal(
      source.split(injectionPoint).length - 1,
      1,
      "canonical shape-box handler injection point changed",
    );
    fs.writeFileSync(
      injectedPath,
      source.replace(
        injectionPoint,
        `    if False:\n        cam_profile(ctx, data)\n${injectionPoint}`,
      ),
    );

    const injected = prepareCadBundle(copyRoot, wrapper.source);
    const injectedWire = prepareWire(injected, "family-guard-injected-cam");
    assert.ok(
      runtimeUnitIds(injected).includes(camOwner.id),
      "canonical public preparation did not retain the injected CAM source edge",
    );
    const injectedManifest = python.pythonArtifactManifest(injected);
    const origin = object(injectedWire.artifact.context)
      ? injectedWire.artifact.context["origin"]
      : undefined;
    assert.ok(object(origin), "wire receipt lost injected source provenance");
    assert.deepEqual(
      origin["units"],
      injectedManifest.units.map(({ id, filename, role, sha256 }) => ({
        id,
        filename,
        role,
        sha256,
      })),
    );
    assert.throws(
      () => assertCanonicalOwnerPolicy(injected, shape.owner),
      /public owner shapes selected undeclared isolated-family units/,
    );
    assert.ok(
      foreignFamilyEdges(injected, shape.owner).some(
        (edge) => edge.owner === "cam",
      ),
      "the test policy did not attribute the injected source edge to its canonical owner",
    );
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
});

test("canonical runtime registrations use named handlers and preserve owner transfers", () => {
  const scanner = String.raw`
import ast, json, sys

def factory_registrations(source, filename):
    tree = ast.parse(source, filename=filename)
    rows = []

    def is_registry(value):
        return isinstance(value, ast.Name) and value.id == 'CAD_HANDLERS'

    def record(value, kind, operation):
        if isinstance(value, ast.Call):
            rows.append({'filename': filename, 'line': value.lineno, 'kind': kind,
                         'operation': ast.unparse(operation), 'factory': ast.unparse(value.func)})

    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'update' and is_registry(node.func.value)
                and node.args):
            mapping = node.args[0]
            if isinstance(mapping, ast.Dict):
                for key, value in zip(mapping.keys, mapping.values):
                    record(value, 'dict', key)
            elif isinstance(mapping, ast.DictComp):
                record(mapping.value, 'dict-comprehension', mapping.key)
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else [])
        value = getattr(node, 'value', None)
        if value is not None:
            for target in targets:
                if isinstance(target, ast.Subscript) and is_registry(target.value):
                    record(value, 'subscript', target.slice)
    return rows

items = json.load(sys.stdin)
print(json.dumps([row for item in items
                  for row in factory_registrations(item['source'], item['filename'])]))
`;

  const scan = (files: readonly string[]) => {
    const result = spawnSync("python3", ["-B", "-c", scanner], {
      input: JSON.stringify(
        files.map((filename) => ({
          filename: path.relative(root, filename),
          source: fs.readFileSync(filename, "utf8"),
        })),
      ),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      filename: string;
      line: number;
      kind: string;
      operation: string;
      factory: string;
    }[];
  };
  const fixturesWithFactories = scan([
    path.join(fixtures, "eager-factory-registration.py"),
  ]);
  assert.deepEqual(
    new Set(fixturesWithFactories.map((row) => row.kind)),
    new Set(["dict", "dict-comprehension"]),
  );
  assert.deepEqual(
    scan([path.join(fixtures, "named-registration.py")]),
    [],
    "named registration must not be classified as an eager factory",
  );

  const canonicalFiles: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith(".py"))
        canonicalFiles.push(filename);
    }
  };
  visit(path.join(root, "runtime/python/fmcad"));
  const findings = scan(canonicalFiles);
  assert.deepEqual(
    findings,
    [],
    "canonical runtime contains eagerly invoked registry factories; migrate registrations to named handlers",
  );
});

test("controlled dependency inventory rejects missing predecessors and foreign-family edges", () => {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(fixtures, "controlled-inventory.json"), "utf8"),
  ) as {
    roots: string[];
    expectedOrder: string[];
    foreignFamily: string;
    units: { id: string; path: string; dependencies: string[] }[];
  };
  const assertContract = (candidate: typeof inventory) => {
    const ordered = orderBundle(candidate.units, candidate.roots).map(
      (unit) => unit.id,
    );
    assert.deepEqual(ordered, candidate.expectedOrder);
    assert.ok(!ordered.includes(candidate.foreignFamily));
  };

  assertContract(inventory);

  const lostDeclaration = structuredClone(inventory);
  lostDeclaration.units = lostDeclaration.units.filter(
    (unit) => unit.id !== "geometry-predecessor",
  );
  assert.throws(() => assertContract(lostDeclaration));

  const lostRegistrationOrder = structuredClone(inventory);
  lostRegistrationOrder.units.find(
    (unit) => unit.id === "shape-specialized",
  )!.dependencies = ["core"];
  assert.throws(() => assertContract(lostRegistrationOrder));

  const foreignFamilyEdge = structuredClone(inventory);
  foreignFamilyEdge.units
    .find((unit) => unit.id === "shape-specialized")!
    .dependencies.push(foreignFamilyEdge.foreignFamily);
  assert.throws(() => assertContract(foreignFamilyEdge));
});

test("full registry execution retains handler owners and exact captured predecessors", () => {
  const state = executeCanonicalRegistry(
    familyOperations.map(([operation]) => operation),
  );
  assert.deepEqual(state.owners, {
    "shape.box": "shapes",
    "shape.helix": "spring",
    "model.thread": "thread",
    "component.create": "assembly",
    "component.inspect": "assembly",
    "document.status": "document",
    "visibility.show": "io",
    "inspect.pack": "inspection",
    "measure.diameter": "measure",
    "frame.context_audit": "semantic-model-state",
    "selection.rule.define": "selection-rules",
    "geometry.delta": "regional-geometry",
    "measure.section-series": "section-witness",
    "fastener.measured-check": "measured-fasteners",
    "mechanism.drive-test": "native-drive",
    "sketch.coordinate-check": "sketch_geometry_proof",
    "measure.baseline.inspect": "measure-baseline",
  });
  assert.equal(state.shapePredecessorCaptured, true);
  assert.equal(state.threadPredecessorCaptured, true);
  assert.equal(state.shapePredecessorCallable, true);
  assert.equal(state.threadPredecessorCallable, true);
});
