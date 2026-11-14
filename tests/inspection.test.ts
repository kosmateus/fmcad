import { createRequire } from "node:module";
import {
  object,
  array,
  field,
  string,
  number,
  present,
} from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(path.join(fixtureDirectory, "inspection.test.ts"));
const { planInspection } = load(
  "../src/dist/core/application/inspection",
) as typeof import("../packages/core/src/application/inspection.js");
const { catalog, contracts, validateCad, mcpTools } = load(
  "../src/catalog",
) as typeof import("../src/composition/library-catalog-registry.js");
const { prepareCadScript, executeCad } = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");
const { cadBundleUnits } = load(
  "../src/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle.js");
const { verifyPythonArtifact } = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact.js");
const context = {
  doc: "Scratch",
  docId: "creation-123",
  docFileId: "file-123",
};
const reads = [{ id: "one", operation: "entity.list", data: { kind: "body" } }];

test("pack uses the canonical opt-in registry and normal CLI/MCP declaration", () => {
  const plan = planInspection({ reads }, contracts, validateCad);
  assert.deepEqual(
    plan.inventory,
    Object.values(contracts)
      .filter(
        (c) =>
          c.declaration["inspectionSafe"] === true &&
          c.readOnlyRequested &&
          c.service.kind === "python",
      )
      .map((c) => c.operation)
      .sort(),
  );
  assert.ok(plan.inventory.includes("entity.list"));
  assert.ok(!plan.inventory.includes("inspect.pack"));
  assert.ok(!plan.inventory.includes("shot.pack"));
  assert.equal(present(catalog["inspect.pack"]).readOnly, true);
  const batch = (
    load("../src/batch") as typeof import("../src/composition/batch.js")
  ).validateBatch(
    {
      runId: "nested-inspection",
      operations: [
        { id: "nested", operation: "inspect.pack", data: { reads } },
      ],
    },
    catalog,
  );
  assert.equal(batch.success, false);
  assert.match(batch.errors.join(" "), /inspect.pack/);
  assert.ok(
    mcpTools.some((tool) => tool._meta.fmcad.operation === "inspect.pack"),
  );
});

test("malformed, excessive and nested-invalid reads reject before effects", async () => {
  let effects = 0;
  const client = {
    callTool: () => {
      effects++;
      throw new Error("effect");
    },
  };
  const invalid = [
    { reads: [] },
    { reads: Array(101).fill(reads[0]) },
    { reads: [reads[0], reads[0]] },
    { reads, maxItems: 0 },
    { reads, maxItems: null },
    { reads, maxBytes: true },
    { reads, inventory: ["model.box"] },
    { reads: [{ ...reads[0], fields: ["a.b"] }] },
    { reads: [{ ...reads[0], data: { typo: 1 } }] },
    { reads: [{ ...reads[0], data: { component: "a".repeat(262144) } }] },
  ];
  for (const data of invalid)
    await assert.rejects(() =>
      executeCad(client, "inspect.pack", data, context),
    );
  assert.equal(effects, 0);
});

test("pack preserves artifact hashes, identity, one readonly turn and light status profile", async () => {
  const artifact = prepareCadScript("inspect.pack", { reads }, context);
  verifyPythonArtifact(artifact);
  assert.equal(field(artifact.context, "docId"), context.docId);
  assert.equal(field(artifact.request, "docFileId"), context.docFileId);
  assert.match(artifact.script, /ctx.assert_identity\(\)/);
  assert.ok(artifact.units.some((unit) => unit.id === "inspection"));
  const light = prepareCadScript("document.status", {}, context);
  assert.ok(!light.units.some((unit) => unit.id === "inspection"));
  assert.ok(light.bytes.length < artifact.bytes.length / 10);
  let calls = 0;
  const result = await executeCad(
    {
      callTool: async (request) => {
        calls++;
        assert.equal(request.object.readOnly, true);
        assert.match(request.object.script, /creation-123/);
        return {
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              success: true,
              result: { status: "pass", items: [] },
            }),
        };
      },
    },
    "inspect.pack",
    { reads },
    context,
  );
  assert.equal(calls, 1);
  assert.equal(field(result, "success"), true);
  assert.throws(
    () => verifyPythonArtifact({ ...artifact, context: {} }),
    /identity changed/,
  );
  const changed = prepareCadScript(
    "inspect.pack",
    { reads },
    { ...context, docId: "different-creation" },
  );
  assert.notEqual(changed.artifactHash, artifact.artifactHash);
  assert.notEqual(changed.sha256, artifact.sha256);
});

test("actual bundled wrapper dispatches same values through one context and blocks mutations", () => {
  const artifact = prepareCadScript(
    "inspect.pack",
    {
      reads: [
        ...reads,
        {
          id: "write",
          operation: "entity.alias",
          data: { ref: "part", alias: "bad" },
        },
        { id: "broken", operation: "entity.inspect", data: { ref: "missing" } },
        { id: "again", operation: "entity.list", data: { kind: "body" } },
      ],
    },
    context,
  );
  const setup = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
exec(compile(sys.stdin.read(), '<fmcad-artifact>', 'exec'))
assert CAD_HANDLERS.owners['inspect.pack'] == 'inspection'
original = CadContext
class FakeContext:
    count = 0
    traversals = 0
    call = original.call
    def __init__(self, doc, component, project, creation, file):
        assert (doc, creation, file) == ('Scratch', 'creation-123', 'file-123')
        FakeContext.count += 1
        self.doc = types.SimpleNamespace(name=doc)
        self.created = {}
    def assert_identity(self): pass
    def _scope(self, data): return None, None
    def _entities(self, kind, component, occurrence):
        FakeContext.traversals += 1
        return [{'name':'part', 'kind':kind}]
    def describe(self, entity): return entity
CadContext = FakeContext
run('')
assert FakeContext.count == 1
assert FakeContext.traversals == 1
ctx = FakeContext('Scratch', None, None, 'creation-123', 'file-123')
ctx.call('inspect.pack', _FMCAD_REQUEST['data'])
assert '_entities' not in ctx.__dict__
assert FakeContext.traversals == 2
try:
    ctx.call('inspect.pack', {'reads': [], 'inventory': ['entity.alias']})
except ValueError as error:
    assert 'standalone CAD preparation' in str(error)
else:
    raise AssertionError('unprepared helper inventory accepted')
prepared = _FMCAD_REQUEST
_FMCAD_REQUEST = None
try:
    ctx.call('inspect.pack', {})
except ValueError as error:
    assert 'standalone CAD preparation' in str(error)
else:
    raise AssertionError('non-object prepared request accepted')
finally:
    _FMCAD_REQUEST = prepared
`;
  const out = spawnSync("python3", ["-B", "-c", setup], {
    input: artifact.script,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(out.status, 0, out.stderr);
  const result = field(
    JSON.parse(
      present(
        out.stdout.split("\n").find((line) => line.startsWith("FMCAD_RESULT ")),
      ).slice(13),
    ),
    "result",
  );
  assert.deepEqual(
    array(field(result, "items")).map((item) => field(item, "status")),
    ["pass", "unsupported", "error", "pass"],
  );
  assert.deepEqual(field(result, "items", 0, "result"), {
    entities: [{ name: "part", kind: "body" }],
  });
  assert.deepEqual(
    field(result, "items", 0, "result"),
    field(result, "items", 3, "result"),
  );
});

test("source cache reuses only validated graph content and invalidates on source/build changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-inspection-"));
  try {
    fs.cpSync(
      path.resolve(fixtureDirectory, "../assets/cad"),
      path.join(root, "assets/cad"),
      { recursive: true },
    );
    fs.cpSync(
      path.resolve(fixtureDirectory, "../runtime/python/fmcad"),
      path.join(root, "runtime/python/fmcad"),
      { recursive: true },
    );
    const first = cadBundleUnits(root);
    assert.strictEqual(cadBundleUnits(root), first);
    for (const id of ["inspection-domain", "inspection"])
      assert.doesNotMatch(
        present(first.find((unit) => unit.id === id)).source,
        /\r/,
      );
    fs.writeFileSync(
      path.join(root, "runtime-build.json"),
      '{"fingerprint":"new-build"}',
    );
    const build = cadBundleUnits(root);
    assert.notStrictEqual(build, first);
    fs.appendFileSync(
      path.join(root, "runtime/python/fmcad/domain/inspection.py"),
      "\n# changed source\n",
    );
    const changed = cadBundleUnits(root);
    assert.notStrictEqual(changed, build);
    assert.match(
      present(changed.find((unit) => unit.id === "inspection-domain")).source,
      /changed source/,
    );
    fs.writeFileSync(path.join(root, "assets/cad/unlisted.py"), "# unexpected");
    assert.throws(() => cadBundleUnits(root), /inventory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("20-read comparator measures equivalent individual, actual batch payload and pack wrappers", () => {
  const context = {
    doc: "InspectionScratch",
    docId: "creation-123",
    docFileId: "file-123",
  };
  const kinds = [
    "body",
    "sketch",
    "feature",
    "face",
    "edge",
    "vertex",
    "plane",
    "axis",
    "point",
    "parameter",
  ];
  const reads = Array.from({ length: 20 }, (_, i) => ({
    id: `read-${i}`,
    operation: "entity.list",
    data: { kind: present(kinds[i % 10]) },
  }));
  const { prepareAtomicScript } = load(
    "../src/batch-atomic",
  ) as typeof import("../src/composition/batch-atomic.js");
  const individual = reads.map((read) =>
    prepareCadScript(read.operation, read.data, context),
  );
  const batch = [
    prepareAtomicScript({
      operation: "atomic_start",
      doc: context.doc,
      identity: { creationId: context.docId, fileId: context.docFileId },
      steps: reads,
    }),
  ];
  const pack = [prepareCadScript("inspect.pack", { reads }, context)];
  const payload = Object.fromEntries(
    Object.entries({ individual, batch, pack }).map(([name, units]) => [
      name,
      units.map((unit) => {
        verifyPythonArtifact(unit);
        return unit.script;
      }),
    ]),
  );
  const result = spawnSync(
    "python3",
    ["-B", path.join(fixtureDirectory, "inspection/compare.py")],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(field(result, "status"), 0, result.stderr);
  const metrics = object(JSON.parse(result.stdout));
  assert.deepEqual(
    Object.values(metrics).map((row) => field(row, "fakeRpcCount")),
    [20, 1, 1],
  );
  assert.deepEqual(
    Object.values(metrics).map((row) => field(row, "inventoryTraversals")),
    [20, 20, 10],
  );
  assert.equal(
    new Set(
      Object.values(metrics).map((row) => field(row, "equivalentResultBytes")),
    ).size,
    1,
  );
  for (const [name, scripts] of Object.entries(payload)) {
    assert.equal(
      field(metrics, name, "fakeRequestBytes"),
      scripts.reduce(
        (sum, script) =>
          sum +
          Buffer.byteLength(
            JSON.stringify({
              featureType: "script",
              object: { script, readOnly: true },
            }),
          ),
        0,
      ),
    );
    assert.ok(
      number(field(metrics, name, "fakeResponseBytes")) >
        number(field(metrics, name, "equivalentResultBytes")),
    );
  }
});

test("benchmark requires real SDK definitions rather than silently measuring a broken checker fixture", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(fixtureDirectory, "inspection/benchmark.ts"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FMCAD_INSPECTION_DEFINITIONS_ROOT: path.join(
          os.tmpdir(),
          `inspection-absent-definitions-${process.pid}`,
        ),
      },
    },
  );
  assert.equal(field(result, "status"), 1);
  assert.match(result.stderr, /Verified SDK definitions required/);
  const recorded = JSON.parse(
    fs.readFileSync(
      path.join(
        fixtureDirectory,
        "../tests/fixtures/inspection-benchmark.json",
      ),
      "utf8",
    ),
  );
  assert.equal(field(recorded, "checkerControl", "status"), "passed");
  assert.match(
    string(field(recorded, "checkerControl", "provenance", "definitionsHash")),
    /^[a-f0-9]{64}$/,
  );
  assert.equal(field(recorded, "packDelivered"), false);
  assert.ok(
    array(field(recorded, "preparation", "pack", "checkerStatuses")).length > 0,
  );
  assert.equal(
    field(recorded, "preparation", "pack", "nativeAdmissionEligible"),
    array(field(recorded, "preparation", "pack", "checkerStatuses")).every(
      (status) => status === "passed",
    ),
  );
});
