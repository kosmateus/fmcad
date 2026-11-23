import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const ref = (token: string, kind: string, objectType: string) => ({
  token,
  kind,
  objectType,
});

test("motion run preserves its CAD source manifest and Python module namespace", async (t) => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json")),
    temporaryRoot = fs.existsSync("/tmp/opencode")
      ? "/tmp/opencode"
      : os.tmpdir(),
    directory = fs.mkdtempSync(
      path.join(temporaryRoot, "fmcad-motion-checker-"),
    ),
    document = {
      name: "FMCAD_MOTION_CHECKER",
      creationId: "motion-checker-doc",
    };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const fixture = [
    {
      kind: "anchor",
      occurrence: ref("occ-anchor", "occurrence", "adsk::fusion::Occurrence"),
      component: ref("comp-anchor", "component", "adsk::fusion::Component"),
      body: ref("body-anchor", "body", "adsk::fusion::BRepBody"),
    },
    {
      kind: "base",
      occurrence: ref("occ-base", "occurrence", "adsk::fusion::Occurrence"),
      component: ref("comp-base", "component", "adsk::fusion::Component"),
      body: ref("body-base", "body", "adsk::fusion::BRepBody"),
    },
    {
      kind: "revolute",
      occurrence: ref("occ-revolute", "occurrence", "adsk::fusion::Occurrence"),
      component: ref("comp-revolute", "component", "adsk::fusion::Component"),
      body: ref("body-revolute", "body", "adsk::fusion::BRepBody"),
      joint: { token: "joint-revolute" },
    },
    {
      kind: "slider",
      occurrence: ref("occ-slider", "occurrence", "adsk::fusion::Occurrence"),
      component: ref("comp-slider", "component", "adsk::fusion::Component"),
      body: ref("body-slider", "body", "adsk::fusion::BRepBody"),
      joint: { token: "joint-slider" },
    },
    {
      kind: "cylindrical",
      occurrence: ref(
        "occ-cylindrical",
        "occurrence",
        "adsk::fusion::Occurrence",
      ),
      component: ref(
        "comp-cylindrical",
        "component",
        "adsk::fusion::Component",
      ),
      body: ref("body-cylindrical", "body", "adsk::fusion::BRepBody"),
      joint: { token: "joint-cylindrical" },
    },
  ];
  const data: Record<string, unknown> = {
    tracks: [
      {
        joint: fixture[2]!.joint,
        rotation: { from: "0 deg", to: "60 deg" },
      },
      {
        joint: fixture[3]!.joint,
        slide: { from: "0 mm", to: "10 mm" },
      },
      {
        joint: fixture[4]!.joint,
        rotation: { from: "0 deg", to: "60 deg" },
        slide: { from: "0 mm", to: "10 mm" },
      },
    ],
    frameCount: 5,
    confirm: true,
    restore: true,
    checks: [
      {
        id: "pose-volume",
        measurement: {
          operation: "measure.volume",
          data: { ref: fixture[4]!.occurrence, units: "mm3" },
        },
        expected: "96 mm^3",
        tolerance: "0.001 mm^3",
      },
    ],
    directory: "C:\\Temp",
    prefix: "FMCAD_MOTION_native_motion_directory",
    width: 320,
    height: 240,
  };
  const { prepareCadScript } = load(
      "./src/cad.js",
    ) as typeof import("../../src/composition/cad"),
    original = prepareCadScript("motion.sample", data, {
      doc: document.name,
      docId: document.creationId,
      component: "root",
    }),
    source = "DOC_NAME = None\n" + original.script,
    filename = path.join(directory, "motion-sample.py");
  fs.writeFileSync(filename, source);

  const { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact.js",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    { pythonUnitContexts } = load(
      "./packages/node-adapters/dist/python/context-binding.js",
    ) as typeof import("../../packages/node-adapters/src/python/context-binding"),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker.js",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    { createRunScriptAdapter } = load(
      "./packages/node-adapters/dist/python/run-script.js",
    ) as typeof import("../../packages/node-adapters/src/python/run-script"),
    adapter = createRunScriptAdapter({
      observeSource() {},
      verifySource() {},
    }),
    runArtifact = adapter.prepareRunScript(filename, [], false, document.name, {
      docId: document.creationId,
    }),
    runUnits = new Map(runArtifact.units.map((unit) => [unit.id, unit]));

  for (const unit of original.units.filter((entry) => entry.role === "runtime"))
    assert.deepEqual(
      runUnits.get(unit.id),
      unit,
      `fmcad run must preserve verified CAD source unit ${unit.id}`,
    );
  assert.ok(
    Buffer.byteLength(runUnits.get("user-script")?.source ?? "") < 100_000,
    "fmcad run must keep the CAD bundle out of the monolithic user script",
  );
  assert.ok(
    runArtifact.sourceMap.some((entry) => entry.unitId === "user-script"),
    "Residual user source must stay in the checked CAD module namespace",
  );
  const identityGuardIndex = runArtifact.units.findIndex(
      (unit) => unit.id === "run-identity-guard",
    ),
    userScriptIndex = runArtifact.units.findIndex(
      (unit) => unit.id === "user-script",
    );
  assert.ok(
    identityGuardIndex >= 0 && identityGuardIndex < userScriptIndex,
    "The document identity guard must execute before residual user source",
  );

  const typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    runResult = await checker.check({
      artifact: runArtifact,
      context: { kind: "run" },
      unitContexts: pythonUnitContexts(runArtifact),
    });
  assert.equal(runResult.status, "passed", JSON.stringify(runResult));
  assert.equal(runResult.provenance.checkerVersion, "1.40.2");
  assert.equal(
    runResult.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );

  const namespaceFilename = path.join(directory, "namespace-probe.py"),
    namespaceTail = [
      "__fmcad_namespace_values__ = (__name__, __file__)",
      "def run(_context: str) -> tuple[str, str]:",
      "    return __fmcad_namespace_values__",
      "",
    ].join("\n");
  fs.writeFileSync(namespaceFilename, source + "\n" + namespaceTail);
  const namespaceArtifact = adapter.prepareRunScript(
      namespaceFilename,
      [],
      false,
      document.name,
      { docId: document.creationId },
    ),
    namespaceUnit = namespaceArtifact.units.find(
      (unit) => unit.id === "run-user-namespace",
    ),
    namespaceUser = namespaceArtifact.units.find(
      (unit) => unit.id === "user-script",
    ),
    namespaceWrapper = namespaceArtifact.units.find(
      (unit) => unit.filename === "<fmcad-run-wrapper>",
    );
  assert.ok(
    namespaceArtifact.units.some((unit) => unit.id === "values"),
    "The namespace assertion must use the verified CAD manifest path",
  );
  assert.ok(namespaceUnit, "Manifest run must establish its user namespace");
  assert.ok(namespaceUser, "Manifest run must retain residual user source");
  assert.ok(namespaceWrapper, "Manifest run must retain its generated wrapper");
  const namespaceSources = Buffer.from(
      JSON.stringify([
        namespaceUnit.source,
        namespaceUser.source,
        namespaceWrapper.source,
      ]),
    ).toString("base64"),
    namespaceCheck = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        [
          "import base64, json",
          "scope = {'__name__': '__main__'}",
          `for index, source in enumerate(json.loads(base64.b64decode(${JSON.stringify(namespaceSources)}))): exec(compile(source, f'<fmcad-run-unit-{index}>', 'exec'), scope)`,
          "print(json.dumps(scope['__fmcad_guarded_run']('context')))",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
  assert.equal(namespaceCheck.status, 0, namespaceCheck.stderr);
  assert.deepEqual(JSON.parse(namespaceCheck.stdout.trim()), [
    "__fmcad_script__",
    namespaceFilename,
  ]);

  const tamperedSource = source.replace(
    "Non-finite value cannot be serialized",
    "Non-finite value cannot be serialized!",
  );
  assert.notEqual(tamperedSource, source);
  const tamperedFilename = path.join(directory, "tampered-motion-sample.py");
  fs.writeFileSync(tamperedFilename, tamperedSource);
  const tamperedArtifact = adapter.prepareRunScript(
    tamperedFilename,
    [],
    false,
    document.name,
    { docId: document.creationId },
  );
  assert.equal(
    tamperedArtifact.units.some((unit) => unit.id === "values"),
    false,
    "A changed runtime prefix must not be treated as a verified CAD manifest",
  );
  assert.ok(
    tamperedArtifact.units.some((unit) =>
      unit.source.includes("Non-finite value cannot be serialized!"),
    ),
    "Unrecognized source must remain whole and unmodified for normal checking",
  );
  const rawArtifact = preparePythonArtifact(original.units, {
    context: original.context,
    request: original.request,
  });
  const rawResult = await checker.check({
    artifact: rawArtifact,
    context: { kind: "raw" },
    unitContexts: pythonUnitContexts(rawArtifact),
  });
  assert.equal(rawResult.status, "passed", JSON.stringify(rawResult));
});
