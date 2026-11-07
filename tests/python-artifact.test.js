const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  preparePythonArtifact,
  verifyPythonArtifact,
  pythonLiteral,
  pythonValue,
} = require("../packages/node-adapters/dist/python/artifact");
const {
  prepareCadBundle,
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
  pythonStringLiteral,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  mapPythonPosition,
} = require("../packages/core/dist/domain/python-artifact");
const {
  prepareWireArtifact,
} = require("../packages/node-adapters/dist/python/source-units");
const root = path.resolve(__dirname, "..");

test("prepared artifact is deterministic, immutable and retains exact bytes and embedded code", () => {
  const user = 'def run(context):\n    return "😀"\n';
  const inputs = [
    {
      id: "user",
      filename: "/user.py",
      source: user,
      role: "user",
      embedded: true,
    },
    {
      id: "wrapper",
      filename: "<wrapper>",
      source: `exec(compile(${pythonValue(user)}, '/user.py', 'exec'))`,
      role: "wrapper",
    },
  ];
  const metadata = {
    request: { ok: true, omitted: undefined },
    context: { doc: "日本語" },
  };
  const first = preparePythonArtifact(inputs, metadata);
  assert.deepEqual(first, preparePythonArtifact(inputs, metadata));
  assert.equal(first.units.length, 2);
  assert.equal(first.sourceMap.length, 1);
  assert.equal(Buffer.from(first.bytes).toString("utf8"), first.script);
  assert.equal(
    createHash("sha256").update(Buffer.from(first.bytes)).digest("hex"),
    first.sha256,
  );
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.bytes));
  assert.ok(Object.isFrozen(first.context));
  verifyPythonArtifact(first);
  assert.throws(
    () => verifyPythonArtifact({ ...first, runtimeVersion: "future" }),
    /version/,
  );
  assert.throws(
    () => verifyPythonArtifact({ ...first, script: first.script + "\npass" }),
    /bytes changed/,
  );
  assert.throws(
    () => verifyPythonArtifact({ ...first, context: {} }),
    /identity changed/,
  );
  assert.deepEqual(mapPythonPosition(first, "/user.py", 2), {
    filename: "/user.py",
    line: 2,
    unitId: "user",
  });
  assert.deepEqual(mapPythonPosition(first, "<fmcad-artifact>", 1), {
    filename: "<wrapper>",
    line: 1,
    unitId: "wrapper",
  });
});

test("legacy operation and atomic builders expose the exact prepared script", () => {
  const ops = require("../src/ops");
  const atomic = require("../src/batch-atomic");
  const prepared = ops.prepareOpScript("stats", []);
  assert.equal(prepared.script, ops.buildOpScript("stats", []));
  assert.equal(
    ops.prepareExportScript(["x"]).script,
    ops.buildExportScript(["x"]),
  );
  const request = { operation: "atomic_status", runId: "fixture" };
  const batch = atomic.prepareAtomicScript(request);
  assert.equal(batch.script, atomic.buildAtomicScript(request));
  assert.deepEqual(batch.request, request);
  assert.equal(batch.units.at(-1).role, "wrapper");
  verifyPythonArtifact(batch);
});

test("source maps account for separators, multiline and trailing newlines", () => {
  const artifact = preparePythonArtifact([
    { id: "a", filename: "a.py", source: "x = 1\n", role: "runtime" },
    {
      id: "b",
      filename: "b.py",
      source: "y = 2\nraise ValueError()",
      role: "wrapper",
    },
  ]);
  assert.deepEqual(mapPythonPosition(artifact, "<fmcad-artifact>", 5), {
    filename: "b.py",
    line: 2,
    unitId: "b",
  });
  assert.equal(mapPythonPosition(artifact, "<fmcad-artifact>", 3), null);
  assert.throws(
    () =>
      preparePythonArtifact([
        { id: "a", filename: "a.py", source: "", role: "runtime" },
        { id: "a", filename: "b.py", source: "", role: "runtime" },
      ]),
    /Duplicate/,
  );
});

test("manifest rejects missing modules/dependencies, duplicates and cycles before execution", () => {
  assert.throws(
    () =>
      cadBundleUnits(
        root,
        "full",
        cadBundleManifest.filter((item) => item.id !== "model"),
      ),
    /inventory/,
  );
  const module = (id, dependencies) => ({
    id,
    path: `assets/cad/${id}.py`,
    dependencies,
  });
  assert.throws(
    () => orderBundle([module("a", ["missing"])], ["a"]),
    /Incomplete/,
  );
  assert.throws(
    () => orderBundle([module("a", ["b"]), module("b", ["a"])], ["a"]),
    /Cyclic/,
  );
  assert.throws(
    () => orderBundle([module("a", []), module("a", [])], ["a"]),
    /duplicate/,
  );
  const ordered = orderBundle([module("b", ["a"]), module("a", [])], ["b"]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["a", "b"],
  );
});

test("prepared handler owners are explicit, escaped Python string literals", () => {
  const ownerUnits = cadBundleUnits(root).filter(
    (unit) =>
      unit.id !== "core" && unit.source.startsWith("CAD_HANDLERS.owner = "),
  );
  assert.ok(ownerUnits.length > 0);
  for (const unit of ownerUnits) {
    const manifest = cadBundleManifest.find((item) => item.id === unit.id);
    assert.ok(manifest);
    const owner = manifest.owner ?? manifest.id;
    const line = unit.source.split("\n", 1)[0];
    assert.equal(line, `CAD_HANDLERS.owner = ${pythonStringLiteral(owner)}`);
    assert.doesNotMatch(line, /__import__\(['"]json['"]\)\.loads/);
  }

  const value = `owner 'quoted' \\\n\u2028\u2029`;
  const source = `value = ${pythonStringLiteral(value)}\nassert value == ${pythonValue(value)}\n`;
  const result = spawnSync("python3", ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("prepared compatibility loaders resolve every dependency without executing loader code", (t) => {
  const declaredAssets = [
    ...new Set(
      cadBundleManifest
        .map((item) => item.compatibilityPath ?? item.path)
        .filter((file) => file.startsWith("assets/cad/")),
    ),
  ].sort();
  const dynamicAssets = declaredAssets.filter((file) =>
    /\bexec\s*\(\s*compile\s*\(/.test(
      fs.readFileSync(path.join(root, file), "utf8"),
    ),
  );
  assert.equal(dynamicAssets.length, 19);

  const units = cadBundleUnits(root, "full");
  assert.equal(units.length, cadBundleManifest.length);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  assert.ok(byId.has("inspection-domain"));
  assert.ok(byId.has("inspection"));
  assert.equal(
    units.filter(
      (unit) => !["inspection-domain", "inspection"].includes(unit.id),
    ).length,
    units.length - 2,
  );
  for (const file of dynamicAssets) {
    const manifest = cadBundleManifest.find(
      (item) => item.path === file || item.compatibilityPath === file,
    );
    assert.ok(manifest, file);
    const unit = byId.get(manifest.id);
    assert.ok(unit, manifest.id);
    assert.equal(unit.filename, file);
    assert.doesNotMatch(unit.source, /\bexec\s*\(|\bcompile\s*\(/, manifest.id);
    assert.match(unit.source, /Prepared compatibility boundary/);

    const original = fs.readFileSync(path.join(root, file), "utf8");
    const originalHash = createHash("sha256")
      .update(original, "utf8")
      .digest("hex");
    assert.ok(
      unit.source.includes(`original-sha256=${originalHash}`),
      manifest.id,
    );
    assert.match(original, /\bexec\s*\(\s*compile\s*\(/, file);

    const provenance = unit.source.match(
      /^# Resolved manifest source units: (.+)$/m,
    );
    assert.ok(provenance, manifest.id);
    for (const record of provenance[1].split(", ")) {
      const [id, filename, expectedHash] = record.split(":");
      const dependency = byId.get(id);
      assert.ok(dependency, `${manifest.id} dependency ${id}`);
      assert.equal(dependency.filename, filename);
      assert.equal(
        createHash("sha256").update(dependency.source, "utf8").digest("hex"),
        expectedHash,
      );
    }
  }

  const prepared = prepareCadBundle(root, "# wrapper");
  assert.equal(prepared.units.length, units.length + 1);
  assert.equal(prepared.sourceMap.length, units.length + 1);
  assert.deepEqual(
    prepared.sourceMap.map((entry) => entry.unitId),
    prepared.units.map((unit) => unit.id),
  );

  const temporaryRoot = fs.mkdtempSync(
    "/tmp/opencode/fmcad-compatibility-loader-",
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryRoot, "assets/cad"), { recursive: true });
  for (const file of declaredAssets)
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  fs.cpSync(
    path.join(root, "runtime/python"),
    path.join(temporaryRoot, "runtime/python"),
    { recursive: true },
  );
  const { geometryFamilies } = require("../packages/node-adapters/dist/python/geometry-manifest");
  for (const family of geometryFamilies) {
    const applicationPath = path.join(
      temporaryRoot,
      `runtime/python/fmcad/application/geometry_${family}.py`,
    );
    const application = fs.readFileSync(applicationPath, "utf8");
    const legacyMarker = `globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), '${family}'))`;
    const assignmentMarker = `_FMCAD_GEOMETRY_LOADED = (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), '${family}')`;
    const previous = application.includes(legacyMarker)
      ? legacyMarker
      : application.includes(assignmentMarker)
        ? assignmentMarker
        : null;
    assert.ok(previous, family);
    const replacement = previous === legacyMarker ? assignmentMarker : legacyMarker;
    fs.writeFileSync(
      applicationPath,
      application.replace(previous, replacement),
    );
  }
  assert.equal(
    cadBundleUnits(temporaryRoot, "full").length,
    cadBundleManifest.length,
  );
  const curveApplicationPath = path.join(
    temporaryRoot,
    "runtime/python/fmcad/application/geometry_curve.py",
  );
  const curveApplication = fs.readFileSync(curveApplicationPath, "utf8");
  const curveMarker = [
    "_FMCAD_GEOMETRY_LOADED = (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'curve')",
    "globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'curve'))",
  ].find((marker) => curveApplication.includes(marker));
  assert.ok(curveMarker);
  fs.writeFileSync(
    curveApplicationPath,
    curveApplication.replace(curveMarker, curveMarker.replace("'curve'", "'other'")),
  );
  assert.throws(
    () => cadBundleUnits(temporaryRoot, "full"),
    /Compatibility geometry marker is not set/,
  );
  fs.writeFileSync(curveApplicationPath, curveApplication);
  fs.appendFileSync(
    path.join(temporaryRoot, "assets/cad/assembly.py"),
    "\nCAD_HANDLERS['unmanifested'] = lambda ctx, data: None\n",
  );
  assert.throws(
    () => cadBundleUnits(temporaryRoot, "full"),
    /Unrecognized compatibility loader source/,
  );
});

test("light document-status profile carries strict handler and wrapper context", () => {
  const { prepareCadScript } = require("../src/cad");
  const context = {
    doc: "InspectionScratch",
    docId: "creation-123",
    docFileId: "file-123",
  };
  const status = prepareCadScript("document.status", {}, context);
  assert.deepEqual(
    status.units.map((unit) => unit.id),
    [
      "values",
      "fusion-values",
      "core",
      "identity",
      "document_snapshot",
      "wrapper",
    ],
  );
  const core = status.units.find((unit) => unit.id === "core").source;
  for (const signature of [
    'def _entity_resolve_reference(ctx: "CadContext", ref: "JsonObject",',
    'def _entity_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord": ...',
    'def _entity_find(ctx: "CadContext", data: "JsonObject") -> "JsonRecord": ...',
    'def _datum_frame(ctx: "CadContext", data: "JsonObject") -> "JsonObject": ...',
    'def _datum_existing(ctx: "CadContext", data: "JsonObject",',
  ])
    assert.ok(core.includes(signature), signature);
  const values = status.units.find((unit) => unit.id === "values").source;
  assert.ok(values.includes("class _CadAttributes(_Protocol):"));
  assert.ok(
    core.includes(
      '_cad_cast("_CadAttributes", ctx.root.attributes).itemByName',
    ),
  );
  const wrapper = status.units.at(-1).source;
  assert.match(
    wrapper,
    /def _document_status_minimal\(ctx: "CadContext", data: "JsonObject"\) -> "JsonRecord"/,
  );

  const full = cadBundleUnits(root, "full");
  const fullCore = full.find((unit) => unit.id === "core").source;
  assert.ok(
    !fullCore.includes('def _entity_resolve_reference(ctx: "CadContext"'),
  );
  const entity = full.find((unit) => unit.id === "entity").source;
  const datum = full.find((unit) => unit.id === "geometry-datum-fusion").source;
  assert.ok(entity.includes('_cad_cast("_CadAttributes | None"'));
  for (const [source, signature] of [
    [
      entity,
      'def _entity_resolve_reference(ctx: "CadContext", ref: "JsonObject"',
    ],
    [
      entity,
      'def _entity_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":',
    ],
    [
      entity,
      'def _entity_find(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":',
    ],
    [
      datum,
      'def _datum_frame(ctx: "CadContext", data: "JsonObject") -> "JsonObject":',
    ],
    [datum, 'def _datum_existing(ctx: "CadContext", data: "JsonObject"'],
  ])
    assert.ok(source.includes(signature), signature);
});

test("full manifest bundle imports with fake SDK; lightweight profile omits modeling and dispatches once", () => {
  const artifact = prepareCadBundle(root, "# prepared wrapper");
  assert.deepEqual(artifact, prepareCadBundle(root, "# prepared wrapper"));
  const setup = `import sys, types\nadsk = types.ModuleType('adsk')\nadsk.core = types.ModuleType('adsk.core')\nadsk.fusion = types.ModuleType('adsk.fusion')\nsys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})\n`;
  const check = `\nassert len(CAD_HANDLERS) > 200\nassert CAD_HANDLERS.owners['shape.helix'] == 'spring'\ntry:\n    CAD_HANDLERS['shape.helix'] = lambda ctx, data: None\nexcept ValueError:\n    pass\nelse:\n    raise AssertionError('duplicate accepted')\ncalls = []\nCAD_HANDLERS['__fixture'] = lambda ctx, data: calls.append(data) or {'ok': True}\nctx = object.__new__(CadContext)\nassert ctx.call('__fixture', {}) == {'ok': True}\nassert calls == [{}]\n`;
  const out = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      setup +
        `exec(compile(sys.stdin.read(), '<fmcad-artifact>', 'exec'))` +
        check,
    ],
    { input: artifact.script, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(out.status, 0, out.stderr);
  const light = prepareCadBundle(root, "# wrapper", {}, "document-status");
  assert.ok(light.bytes.length < artifact.bytes.length / 10);
  assert.ok(!light.units.some((unit) => unit.id === "model"));
});

test("payload nonfinite and Unicode policy remains compatible", () => {
  const expression = pythonValue({
    value: NaN,
    infinity: Infinity,
    name: "😀日本語",
    nested: [undefined],
  });
  assert.doesNotMatch(expression, /[^\x00-\x7f]/);
  const result = spawnSync(
    "python3",
    ["-c", `import json; print(json.dumps(${expression}))`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    value: null,
    infinity: null,
    name: "😀日本語",
    nested: [null],
  });
  assert.throws(() => pythonValue(undefined), /JSON serializable/);
});

test("final receipt preparation includes transport wrapper and nested literal user code before dispatch", () => {
  const { prepareReceiptScript } = require("../src/queue-instance");
  const code = 'def run(context):\n    return "日本語"\n';
  const outer = `def run(context):\n    exec(compile(${pythonValue(code)}, '/user.py', 'exec'), {})\n`;
  const binding = {
    jobId: "fixture",
    rpcId: "rpc",
    sourceHash: createHash("sha256").update(outer).digest("hex"),
  };
  const prepared = prepareReceiptScript(
    outer,
    true,
    "/mnt/c/receipt.json",
    binding,
  );
  assert.ok(
    prepared.units.some(
      (unit) => unit.filename === "/user.py" && unit.source === code,
    ),
  );
  assert.ok(
    prepared.units.some(
      (unit) => unit.filename === "<fmcad-queue>" && unit.source === outer,
    ),
  );
  assert.equal(prepared.units.at(-1).filename, "<fmcad-wire>");
  assert.deepEqual(prepared.request, binding);
  verifyPythonArtifact(prepared);
  assert.deepEqual(
    prepared,
    prepareReceiptScript(outer, true, "/mnt/c/receipt.json", binding),
  );
  assert.throws(
    () =>
      prepareReceiptScript("def broken(", true, "/mnt/c/receipt.json", binding),
    /before dispatch/,
  );
  const changed = prepareReceiptScript(
    outer,
    true,
    "/mnt/c/other.json",
    binding,
  );
  assert.notEqual(changed.sha256, prepared.sha256);
  assert.throws(
    () => verifyPythonArtifact({ ...prepared, script: changed.script }),
    /bytes changed/,
  );
});

test("offline literal extraction never executes source and finds syntax errors hidden in compile strings", () => {
  const runtime = path.join(root, "runtime/python");
  const nested = `exec(compile(${pythonValue("def bad(")}, '/bad.py', 'exec'))`;
  assert.throws(() => prepareWireArtifact(runtime, nested), /before dispatch/);
  const artifact = prepareWireArtifact(
    runtime,
    'raise RuntimeError("must not execute")',
  );
  assert.equal(artifact.units.length, 1);
});

test("actual CAD and cad-v1 run wrappers retain prepared units and original source pinning", (t) => {
  const { prepareCadScript, buildCadScript } = require("../src/cad");
  const status = prepareCadScript("document.status", {}, { doc: "fixture" });
  assert.equal(
    status.script,
    buildCadScript("document.status", {}, { doc: "fixture" }),
  );
  assert.ok(!status.units.some((unit) => unit.id === "model"));
  const directory = fs.mkdtempSync("/tmp/opencode/python-source-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "日本語.py");
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context):\n    return {"passed": True}\n';
  fs.writeFileSync(file, source);
  const invocation = {};
  const run = require("../src/run");
  const artifact = require("../src/invocation").context.run(invocation, () =>
    run.prepareRunScript(
      file,
      [true, null],
      true,
      "fixture",
      { docId: "creation-id" },
      "cad-v1",
    ),
  );
  assert.equal(
    invocation.sourceHash,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(invocation.sourcePath, file);
  const user = artifact.units.find((unit) => unit.role === "user");
  assert.equal(user.filename, file);
  assert.ok(user.source.includes(`ARGS = ${pythonLiteral([true, null])}`));
  assert.ok(user.source.includes(`DOC_NAME = ${pythonLiteral("fixture")}`));
  assert.ok(artifact.units.some((unit) => unit.id === "helpers"));
  assert.ok(artifact.units.some((unit) => unit.id === "identity"));
  const wire = prepareWireArtifact(
    path.join(root, "runtime/python"),
    artifact.script,
  );
  assert.equal(
    wire.units.find((unit) => unit.filename === file).source,
    user.source,
  );
  const plain = run.prepareRunScript(file, [], false, undefined);
  assert.equal(plain.script, source);
  assert.equal(plain.units.length, 1);
});
