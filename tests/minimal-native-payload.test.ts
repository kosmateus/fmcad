import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { PreparedPythonArtifact, PythonCheckContext } from "@fmcad/core";

const load = createRequire(
  path.resolve("tests/minimal-native-payload.test.js"),
);
const { prepareRunScript } = load(
  "../src/run",
) as typeof import("../src/composition/run.js");
const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance.js").createQueueInstance
>;
const python = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact.js") &
  typeof import("../packages/node-adapters/src/python/context-binding.js") &
  typeof import("../packages/node-adapters/src/python/checker.js") &
  typeof import("../packages/node-adapters/src/python/admission.js");

const runtime = path.resolve("dist/runtime/python");
const nativeLimitBytes = 1_048_576;

function createChecker() {
  return python.createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    definitionsRoot: path.join(runtime, "typing"),
    pythonPlatform: "Windows",
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("cad-v1 shape.box keeps its dependency closure within the native MCP payload limit", async () => {
  const sourcePath = path.resolve("tests/fixtures/minimal-native-payload.py");
  const original = prepareRunScript(
    sourcePath,
    [],
    false,
    "PayloadFixture",
    { docId: "minimal-native-payload" },
    "cad-v1",
    [],
  );
  const receipt = prepareReceiptScript(
    original.script,
    true,
    "/offline/minimal-native-payload.json",
    { jobId: "minimal-native-payload" },
    { mapPath: (value) => value },
  );
  const artifact: PreparedPythonArtifact = python.retainPythonOrigin(
    receipt,
    python.pythonArtifactManifest(original),
  );
  const request = {
    jsonrpc: "2.0",
    id: "minimal-native-payload",
    method: "tools/call",
    params: {
      name: "fusion_mcp_execute",
      arguments: {
        featureType: "script",
        object: { script: artifact.script },
      },
    },
  };
  const body = Buffer.from(JSON.stringify(request), "utf8");
  const checker = createChecker();
  const admission = python.createPythonRpcAdmission({ runtime, checker });
  const certificate = await admission.check(request, artifact);

  assert.equal(certificate.kind, "python");
  assert.equal(certificate.report?.status, "passed");
  assert.deepEqual(certificate.report?.diagnostics, []);
  assert.equal(certificate.artifact?.script, artifact.script);
  certificate.fence(request);

  assert.deepEqual(Object.keys(request).sort(), [
    "id",
    "jsonrpc",
    "method",
    "params",
  ]);
  assert.deepEqual(Object.keys(request.params).sort(), ["arguments", "name"]);
  assert.deepEqual(Object.keys(request.params.arguments).sort(), [
    "featureType",
    "object",
  ]);
  assert.deepEqual(Object.keys(request.params.arguments.object).sort(), [
    "script",
  ]);
  assert.deepEqual(JSON.parse(body.toString("utf8")), request);

  const unitIds = original.units.map((unit) => unit.id);
  const userSource = original.units.find(
    (unit) => unit.role === "user",
  )?.source;
  assert.ok(userSource);
  assert.match(userSource, /FMCAD\.call\(\s*["']shape\.box["']/);
  assert.match(userSource, /FMCAD\.emit\(result\)/);
  const requiredUnits = [
    "helpers",
    "core",
    "identity",
    "geometry-shapes-domain",
    "geometry-shapes-fusion",
    "geometry-shapes-application",
    "geometry-model-domain",
    "geometry-model-fusion",
    "geometry-model-application",
    "geometry-sketch-domain",
    "geometry-sketch-fusion",
    "geometry-sketch-application",
  ];
  const missingUnits = requiredUnits.filter((id) => !unitIds.includes(id));
  const unusedHeavyUnits = ["cam", "optics"].filter((id) =>
    unitIds.includes(id),
  );
  const violations = [
    ...(missingUnits.length
      ? [`missing required units: ${missingUnits.join(", ")}`]
      : []),
    ...(unusedHeavyUnits.length
      ? [`unused units included: ${unusedHeavyUnits.join(", ")}`]
      : []),
    ...(body.byteLength > nativeLimitBytes
      ? [
          `final native JSON body is ${body.byteLength} B; limit is ${nativeLimitBytes} B`,
        ]
      : []),
  ];
  assert.deepEqual(
    violations,
    [],
    `minimal native payload contract failed; source units=${unitIds.length}, body=${body.byteLength} B`,
  );
});

test("dynamic cad-v1 helper calls retain the runtime and pass the real checker", async () => {
  const original = prepareRunScript(
    path.resolve("tests/fixtures/minimal-native-payload-dynamic.py"),
    [],
    false,
    "PayloadFixture",
    { docId: "minimal-native-payload-dynamic" },
    "cad-v1",
    [],
  );
  const userSource = original.units.find(
    (unit) => unit.role === "user",
  )?.source;
  assert.ok(userSource);
  assert.match(userSource, /FMCAD\.call\(\s*operation,\s*\{/);

  const unitIds = new Set(original.units.map((unit) => unit.id));
  for (const id of ["helpers", "core", "identity", "cam", "optics"])
    assert.ok(unitIds.has(id), `dynamic call must retain runtime unit ${id}`);

  const declared = original.context;
  assert.ok(object(declared));
  const unitContexts = declared["unitContexts"];
  assert.ok(object(unitContexts));
  const userContext = unitContexts["user-script"];
  assert.ok(object(userContext));
  assert.equal(userContext["kind"], "cad-v1");
  const report = await createChecker().check({
    artifact: original,
    context: { kind: "raw", entrypoint: "run" },
    unitContexts: unitContexts as unknown as Readonly<
      Record<string, PythonCheckContext>
    >,
  });
  assert.equal(
    report.status,
    "passed",
    JSON.stringify({
      reasons: report.reasons,
      diagnostics: report.diagnostics,
    }),
  );
  assert.deepEqual(report.diagnostics, []);
});
