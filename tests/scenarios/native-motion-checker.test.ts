import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import type { ScenarioSession } from "./runner";
import { motionProfiler } from "./native-motion-cases";
import { NativeProbe } from "./native-probe";

const ref = (token: string, kind: string, objectType: string) => ({
  token,
  kind,
  objectType,
});

test("motion profiler passes production Python checking with the CAD source manifest preserved", async (t) => {
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
  const tracks = [
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
  ];
  const data: Record<string, unknown> = {
    tracks,
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
  const guard = `motion_document_id = ${JSON.stringify(document.creationId)}
matches = [d for d in app.documents if d.creationId == motion_document_id]
assert len(matches) == 1, 'Owned creationId missing or ambiguous'
doc = matches[0]
assert doc.isValid and doc.name == ${JSON.stringify(document.name)} and not doc.isSaved and doc.dataFile is None, 'Owned unsaved identity guard'
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command: no mutation or cleanup'
`;
  let source: string | undefined;
  const session = {
    document,
    directory,
    report: { owner: { clientId: "offline-motion-checker" } },
    backend: { fusionPath: (value: string) => value },
    async verifyOwnedUnsaved() {},
    async execute(_phase: string, script: string) {
      source = script;
      return {
        error: null,
        errorType: null,
        results: [
          {
            operation: "motion.sample",
            document: document.name,
            result: { status: "captured-for-offline-check" },
          },
        ],
        observations: [],
      };
    },
  } as unknown as ScenarioSession;
  await new NativeProbe(
    session,
    "native-motion-checker",
    "MOTION_PROBE ",
  ).compiled("motion.sample", data, "root", (original) =>
    motionProfiler(original, fixture, guard, document.creationId),
  );
  assert.ok(source, "NativeProbe did not prepare the compiled motion request");

  const { prepareCadScript } = load(
      "./src/cad.js",
    ) as typeof import("../../src/composition/cad"),
    original = prepareCadScript("motion.sample", data, {
      doc: document.name,
      docId: document.creationId,
      component: "root",
    }),
    profiled = motionProfiler(
      original.script,
      fixture,
      guard,
      document.creationId,
    ),
    profiledPrefix = "DOC_NAME = None\n" + profiled;
  assert.ok(
    source.startsWith(profiledPrefix),
    "NativeProbe must use the production CAD bundle and motion profiler",
  );
  const renamedOriginal = original.script.replace(
      /^def run\(/m,
      "def _test_compiled_run(",
    ),
    profilerSource = profiled.slice(renamedOriginal.length),
    envelope = source.slice(profiledPrefix.length);
  assert.ok(
    profiled.startsWith(renamedOriginal),
    "Profiler must retain the production CAD bundle",
  );
  const { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact.js",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    { pythonUnitContexts } = load(
      "./packages/node-adapters/dist/python/context-binding.js",
    ) as typeof import("../../packages/node-adapters/src/python/context-binding"),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker.js",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    wrapper = original.units.find(
      (unit) => unit.filename === "<fmcad-wrapper>",
    );
  assert.ok(wrapper, "Production CAD bundle must retain its wrapper unit");
  const artifact = preparePythonArtifact(
    [
      ...original.units.map((unit, index) => ({
        id: unit.id,
        filename: unit.filename,
        source:
          index === 0
            ? "DOC_NAME = None\n" + unit.source
            : unit === wrapper
              ? unit.source.replace(/^def run\(/m, "def _test_compiled_run(")
              : unit.source,
        role: unit.role,
      })),
      {
        id: "native-motion-profiler",
        filename: "<native-motion-profiler>",
        source: profilerSource,
        role: "user" as const,
      },
      {
        id: "native-probe-envelope",
        filename: "<native-probe-envelope>",
        source: envelope,
        role: "user" as const,
      },
    ],
    { context: original.context, request: original.request },
  );
  const unitContexts = pythonUnitContexts(artifact),
    typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    result = await checker.check({
      artifact,
      context: { kind: "raw" },
      unitContexts,
    });
  console.log(
    JSON.stringify({
      sourceBytes: Buffer.byteLength(source),
      runArtifactBytes: Buffer.byteLength(original.script),
      checkerArtifactBytes: Buffer.byteLength(artifact.script),
      checkerUnits: artifact.units.length,
      status: result.status,
      diagnostics: result.diagnostics.length,
      reasons: result.reasons,
      provenance: result.provenance,
    }),
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.provenance.checkerVersion, "1.40.2");
  assert.equal(
    result.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
  const filename = path.join(directory, "motion-sample.py");
  fs.writeFileSync(filename, source);
  const { createRunScriptAdapter } = load(
      "./packages/node-adapters/dist/python/run-script.js",
    ) as typeof import("../../packages/node-adapters/src/python/run-script"),
    runArtifact = createRunScriptAdapter({
      observeSource() {},
      verifySource() {},
    }).prepareRunScript(filename, [], false, document.name, {
      docId: document.creationId,
    });
  const runUnits = new Map(runArtifact.units.map((unit) => [unit.id, unit]));
  for (const unit of original.units.filter((unit) => unit.role === "runtime")) {
    assert.deepEqual(
      runUnits.get(unit.id),
      unit,
      `fmcad run must preserve verified CAD source unit ${unit.id}`,
    );
  }
  assert.ok(
    Buffer.byteLength(runUnits.get("user-script")?.source ?? "") < 100_000,
    "fmcad run must keep the verified CAD bundle out of the monolithic user script",
  );
  assert.ok(
    runArtifact.sourceMap.some((entry) => entry.unitId === "user-script"),
    "The residual user source must remain a mapped executable unit",
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
  const runResult = await checker.check({
    artifact: runArtifact,
    context: { kind: "run" },
    unitContexts: pythonUnitContexts(runArtifact),
  });
  assert.equal(runResult.status, "passed", JSON.stringify(runResult));
  assert.equal(runResult.provenance.checkerVersion, "1.40.2");
  const tamperedSource = source.replace(
    "Non-finite value cannot be serialized",
    "Non-finite value cannot be serialized!",
  );
  assert.notEqual(tamperedSource, source);
  const tamperedFilename = path.join(directory, "tampered-motion-sample.py");
  fs.writeFileSync(tamperedFilename, tamperedSource);
  const tamperedArtifact = createRunScriptAdapter({
    observeSource() {},
    verifySource() {},
  }).prepareRunScript(tamperedFilename, [], false, document.name, {
    docId: document.creationId,
  });
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
  const evidenceDirectory = process.env["FMCAD_MOTION_REPRO_DIR"];
  if (evidenceDirectory) {
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, "source.py"), source);
    fs.writeFileSync(
      path.join(evidenceDirectory, "run-artifact.py"),
      runArtifact.script,
    );
    fs.writeFileSync(
      path.join(evidenceDirectory, "run-artifact.bin"),
      Buffer.from(runArtifact.bytes),
    );
    fs.writeFileSync(
      path.join(evidenceDirectory, "run-manifest.json"),
      JSON.stringify(
        {
          sourceBytes: Buffer.byteLength(source),
          runScriptBytes: Buffer.byteLength(runArtifact.script),
          artifactBytes: runArtifact.bytes.length,
          artifactHash: runArtifact.artifactHash,
          wireHash: runArtifact.sha256,
          context: runArtifact.context,
          request: runArtifact.request,
          units: runArtifact.units.map((unit) => ({
            id: unit.id,
            filename: unit.filename,
            role: unit.role,
            sourceBytes: Buffer.byteLength(unit.source),
            sha256: unit.sha256,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  }
  const rawRunResult = await checker.check({
    artifact: runArtifact,
    context: { kind: "run" },
    unitContexts: pythonUnitContexts(runArtifact),
  });
  if (evidenceDirectory)
    fs.writeFileSync(
      path.join(evidenceDirectory, "run-checker-report.json"),
      JSON.stringify(rawRunResult, null, 2) + "\n",
    );
  console.log(
    JSON.stringify({
      rawRunArtifactBytes: runArtifact.bytes.length,
      rawRunUnits: runArtifact.units.length,
      rawRunStatus: rawRunResult.status,
      rawRunDiagnostics: rawRunResult.diagnostics.length,
      rawRunReasons: rawRunResult.reasons,
      rawRunProvenance: rawRunResult.provenance,
    }),
  );
  assert.equal(rawRunResult.status, "passed", JSON.stringify(rawRunResult));
});
