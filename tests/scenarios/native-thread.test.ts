import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  threadMajorRadiusMm,
  assertCosmeticCylinder,
  threadInfoBody,
  threadReadbackBody,
} from "./native-thread-programs";
import { program, emit } from "./programs";
import {
  nativeThreadCapability,
  nativeThreadScenarios,
} from "./native-thread-cases";
import { runScenarios } from "./runner";
import { fixture } from "./test-support";

const info = {
  threadType: "ISO Metric profile",
  designation: "M10x1.5",
  threadClass: "6g",
  nominalSize: "10.0",
  internal: false,
  tapered: false,
  rightHanded: true,
  majorDiameterMm: 9.85,
  minorDiameterMm: 8.141,
  pitchDiameterMm: 8.928,
  pitchMm: 1.5,
};
const volume = Math.PI * (9.85 / 2) ** 2 * 20;
const readback = {
  descriptor: info,
  computed: true,
  modeled: false,
  modeledIsBoolean: true,
  suppressed: false,
  solid: true,
  radiusMm: 4.925,
  heightMm: 20,
  faceCount: 3,
  edgeCount: 2,
  surfaceTypes: [
    "adsk::core::Cylinder",
    "adsk::core::Plane",
    "adsk::core::Plane",
  ],
  bodyVolumeMm3: volume,
  physicalVolumeMm3: volume,
};

test("native thread seed uses resolved tolerance diameter, not nominal size", () => {
  assert.equal(threadMajorRadiusMm(info), 4.925);
  assert.notEqual(threadMajorRadiusMm(info), Number(info.nominalSize) / 2);
  // The installed table can differ: the fixture must not hardcode 9.85.
  assert.equal(threadMajorRadiusMm({ ...info, majorDiameterMm: 9.9 }), 4.95);
  assert.doesNotThrow(() => assertCosmeticCylinder(readback, info));
});

test("native thread rejects wrong selector, gender, units and modeled geometry", () => {
  for (const wrong of [
    { designation: "M10" },
    { threadClass: "6H" },
    { internal: true },
    { majorDiameterMm: 0.985 },
    { pitchMm: 0.15 },
  ])
    assert.throws(() => threadMajorRadiusMm({ ...info, ...wrong }));
  for (const wrong of [
    { modeled: true },
    { modeled: "false" },
    { modeledIsBoolean: false },
    { radiusMm: 5 },
    { faceCount: 100 },
    { computed: false },
    { heightMm: 19.99 },
    { descriptor: { ...info, threadClass: "6H" } },
    { bodyVolumeMm3: volume - 0.0011 },
    { physicalVolumeMm3: volume - 0.0011 },
  ])
    assert.throws(() =>
      assertCosmeticCylinder({ ...readback, ...wrong }, info),
    );
});

test("both native thread drivers resolve the table before seeding and retain strict measured conservation", () => {
  const root = path.resolve(__dirname, "../../..");
  for (const file of [
    "tests/live-thread-method.js",
    "tests/scenarios/native-thread-cases.ts",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(
      source.indexOf("threadInfoBody(") >= 0 &&
        source.indexOf("threadInfoBody(") < source.indexOf("const cylinder ="),
      file,
    );
    for (const required of [
      "threadMajorRadiusMm(",
      "assertCosmeticCylinder(",
      "cosmetic thread preserves BRep volume",
      "nominal cylinder resizes to the native table diameter",
    ])
      assert.ok(source.includes(required), file + ": " + required);
  }
});

for (const protocol of ["mcp", "addin"] as const) {
  test(`native thread scenario reaches its descriptor observation via ${protocol}`, async (t) => {
    const { backend, directory } = await fixture(t, protocol);
    let descriptorDispatches = 0;
    const nativeBoundary = {
      ...backend,
      capabilities: new Set([...backend.capabilities, nativeThreadCapability]),
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.source.includes("adsk.fusion.ThreadInfo.create(")) {
          descriptorDispatches++;
          // Stop at the native table boundary; this test covers routing, not
          // simulated thread geometry or the installed Fusion thread table.
          return {
            requestId: request.requestId,
            state: "failed" as const,
            sdkSettled: true,
            mayHaveMutated: false,
            stdout: "",
            error: "Native descriptor boundary reached",
          };
        }
        return backend.execute(request);
      },
    };
    const [report] = await runScenarios(
      nativeBoundary,
      nativeThreadScenarios(1),
      directory,
      1,
    );
    assert.ok(report);
    assert.equal(descriptorDispatches, 1, report.error);
    assert.match(report.error ?? "", /Native descriptor boundary reached/u);
    const rejected = report.requests.find(
      (request) => request.phase === "cad-native-thread-designation-rejected",
    );
    assert.equal(rejected?.result?.state, "failed");
    assert.equal(rejected?.result?.sdkSettled, true);
    assert.ok(
      report.requests.some(
        (request) => request.phase === "observe-native-thread-descriptor",
      ),
    );
  });
}

test("native descriptor and physical readback programs pass the pinned strict Python checker", async () => {
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json"));
  const { createPythonChecker } = load(
    "./packages/node-adapters/dist/python/checker",
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const { preparePythonArtifact } = load(
    "./packages/node-adapters/dist/python/artifact",
  ) as typeof import("../../packages/node-adapters/src/python/artifact");
  const document = { name: "owned-thread", creationId: "owned-thread-id" };
  for (const body of [
    threadInfoBody(document),
    threadReadbackBody(document, "body-token", "feature-token"),
  ]) {
    const source = program(body + "\n" + emit("thread_result"));
    assert.ok(
      !source.includes(".activate("),
      "Readback must not change active documents",
    );
    const result = await createPythonChecker({
      typingRoot: path.join(root, "dist/runtime/python/typing"),
      definitionsRoot: path.join(root, "dist/runtime/python/typing"),
      pythonPlatform: "Windows",
    }).check({
      artifact: preparePythonArtifact([
        {
          id: "thread-probe",
          filename: "thread-probe.py",
          source,
          role: "user",
        },
      ]),
      context: { kind: "raw" },
    });
    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics));
  }
});
