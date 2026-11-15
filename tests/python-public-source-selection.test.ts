import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PreparedPythonArtifact } from "@fmcad/core";

const load = createRequire(
  path.resolve("tests/python-public-source-selection.test.js"),
);
const { prepareCadScript } = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");
const { prepareRunScript } = load(
  "../src/run",
) as typeof import("../src/composition/run.js");
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

const runtime = path.resolve("dist/runtime/python");

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

const dynamicFallback = prepareRunScript(
  path.resolve("tests/fixtures/minimal-native-payload-dynamic.py"),
  [],
  false,
  "PublicSelectionFallback",
  { docId: "public-source-selection-fallback" },
  "cad-v1",
  [],
);
const dynamicFallbackWire = prepareWire(
  dynamicFallback,
  "public-source-selection-fallback",
);
const dynamicFallbackSourceBytes = Buffer.byteLength(
  dynamicFallback.script,
  "utf8",
);
const dynamicFallbackEncodedBytes = Buffer.byteLength(
  dynamicFallbackWire.artifact.script,
  "utf8",
);

const operations = [
  {
    operation: "shape.box",
    data: { name: "Block 😀", width: "40 mm", depth: "20 mm", height: "10 mm" },
    dependencies: ["geometry-shapes-application"],
  },
  {
    operation: "shape.helix",
    data: {
      schemaVersion: 1,
      frame: "component",
      radius: "4 mm",
      pitch: "5.75 mm",
      turns: 8,
      hand: "right",
      startPhase: "0 deg",
      tolerance: "0.01 mm",
    },
    dependencies: [
      "geometry-shapes-application",
      "shapes",
      "spring-domain",
      "spring-fusion",
    ],
    sourceOrder: [
      "runtime/python/fmcad/application/geometry_shapes.py",
      "assets/cad/shapes.py",
      "runtime/python/fmcad/domain/spring.py",
      "runtime/python/fmcad/adapters/fusion/spring.py",
    ],
  },
  {
    operation: "model.thread",
    data: {
      faces: [{ token: "cylinder-face-token" }],
      internal: false,
      threadType: "ISO Metric profile",
      designation: "M10x1.5",
      class: "6g",
      modeled: true,
    },
    dependencies: [
      "geometry-model-application",
      "model",
      "thread-domain",
      "thread-fusion",
    ],
    sourceOrder: [
      "runtime/python/fmcad/application/geometry_model.py",
      "assets/cad/model.py",
      "runtime/python/fmcad/domain/thread.py",
      "runtime/python/fmcad/adapters/fusion/thread.py",
    ],
  },
  {
    operation: "frame.context_audit",
    data: {
      ref: { kind: "body", name: "Housing" },
      sourceId: "housing-definition-v3",
      instance: ["Root:1", "Housing:2"],
      datumToRoot: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1],
      datumSource: { kind: "fixture-analytic-placement", version: 1 },
    },
    dependencies: ["semantic-model-state-application"],
  },
] as const;

for (const { operation, data, dependencies, ...selection } of operations) {
  test(`public CAD ${operation} selects its helper dependencies and passes the real checker`, async () => {
    const original = prepareCadScript(operation, data, {
      doc: "PublicSelectionFixture",
      docId: `public-source-selection-${operation}`,
    });
    const wire = prepareWire(original, `public-${operation}`);
    const rawSourceBytes = Buffer.byteLength(original.script, "utf8");
    const encodedScriptBytes = Buffer.byteLength(wire.artifact.script, "utf8");
    const ids = new Set(original.units.map((unit) => unit.id));
    const measurements =
      `units=${original.units.length}/${dynamicFallback.units.length}, ` +
      `raw=${rawSourceBytes}/${dynamicFallbackSourceBytes} B, ` +
      `encoded=${encodedScriptBytes}/${dynamicFallbackEncodedBytes} B, ` +
      `finalJSON=${wire.jsonBytes}/${dynamicFallbackWire.jsonBytes} B`;

    assert.ok(
      original.units.length < dynamicFallback.units.length / 2,
      `${operation} did not reduce public source units against dynamic fallback: ${measurements}`,
    );
    assert.ok(
      rawSourceBytes < dynamicFallbackSourceBytes / 2,
      `${operation} raw source was not reduced: ${measurements}`,
    );
    for (const dependency of dependencies)
      assert.ok(ids.has(dependency), `${operation} omitted ${dependency}`);
    if ("sourceOrder" in selection) {
      const positions = selection.sourceOrder.map((filename) =>
        original.units.findIndex((unit) => unit.filename.endsWith(filename)),
      );
      assert.ok(
        positions.every((position) => position >= 0),
        operation,
      );
      assert.ok(
        positions.every(
          (position, index) => index === 0 || position > positions[index - 1]!,
        ),
        `${operation} changed predecessor/override registration order`,
      );
    }
    for (const unrelated of ["cam", "optics", "sheetmetal"])
      assert.ok(
        !ids.has(unrelated),
        `${operation} retained unrelated ${unrelated}`,
      );
    assert.ok(
      original.script.includes(JSON.stringify(operation)),
      `${operation} was not preserved in the prepared source`,
    );
    if (operation === "shape.box")
      assert.ok(
        original.script.includes(String.raw`Block \U0001f600`) &&
          wire.artifact.units.some((unit) =>
            unit.source.includes(original.script),
          ),
        "Unicode CAD input was not preserved through receipt wrapping",
      );

    const manifest = python.pythonArtifactManifest(original);
    assert.deepEqual(manifest.units, original.units);
    const origin = object(wire.artifact.context)
      ? wire.artifact.context["origin"]
      : undefined;
    assert.ok(object(origin), `${operation} lost original source provenance`);
    assert.equal(origin["artifactHash"], original.artifactHash);
    assert.equal(origin["sha256"], original.sha256);
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
      `${operation} lost the exact embedded-source mapping`,
    );

    assert.ok(
      encodedScriptBytes < dynamicFallbackEncodedBytes / 2,
      `${operation} encoded script was not reduced: ${measurements}`,
    );
    assert.ok(
      wire.jsonBytes < dynamicFallbackWire.jsonBytes / 2,
      `${operation} final JSON was not reduced: ${measurements}`,
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
    assert.equal(certificate.artifact?.script, wire.artifact.script);
    certificate.fence(wire.request);

    const tampered = structuredClone(wire.request);
    tampered.params.arguments.object.script += "\n# changed after admission";
    assert.throws(() => certificate.fence(tampered));
  });
}

test("public measure.baseline.capture preserves BRepBody through the real Fusion checker", async () => {
  const original = prepareCadScript(
    "measure.baseline.capture",
    {
      bodies: [
        {
          role: "housing",
          body: { kind: "body", token: "body-token-a", name: "Housing" },
        },
      ],
      frame: "assembly",
      scope: "durable",
      workBudgetMs: 30000,
    },
    {
      doc: "PublicBrepBaseline",
      docId: "public-brep-baseline-capture",
      docFileId: "public-brep-baseline-capture-file",
    },
  );
  const wire = prepareWire(original, "public-brep-baseline-capture");
  const admission = python.createPythonRpcAdmission({
    runtime,
    checker: createChecker(),
  });

  const certificate = await admission
    .check(wire.request, wire.artifact)
    .catch((error: unknown) => {
      const report =
        error !== null && typeof error === "object" && "pythonCheck" in error
          ? error.pythonCheck
          : error;
      assert.fail(JSON.stringify(report));
    });

  assert.equal(certificate.kind, "python");
  assert.equal(
    certificate.report?.status,
    "passed",
    JSON.stringify(certificate.report?.diagnostics),
  );
  assert.deepEqual(certificate.report?.diagnostics, []);
});

test("public run selection keeps dynamic, initializer, and registry escape sources conservative", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-public-source-selection-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const fallbackSources = [
    [
      "dynamic dispatch",
      'DOC_NAME = ""\nraise RuntimeError("selection must not execute user code")\ndef run(context):\n    operation = context\n    FMCAD.call(operation, {})\n',
    ],
    [
      "reflection import",
      'DOC_NAME = ""\nraise RuntimeError("selection must not execute user code")\nimport inspect\ndef run(context):\n    FMCAD.call("shape.box", {})\n',
    ],
    [
      "module initializer",
      'DOC_NAME = ""\nraise RuntimeError("selection must not execute user code")\nexec("CAD_HANDLERS[\'shape.box\'] = lambda ctx, data: data")\ndef run(context):\n    FMCAD.call("shape.box", {})\n',
    ],
    [
      "registry alias",
      'DOC_NAME = ""\nraise RuntimeError("selection must not execute user code")\ndef replacement(ctx, data):\n    return data\nregistry = CAD_HANDLERS\nregistry.update({"shape.box": replacement})\ndef run(context):\n    FMCAD.call("shape.box", {})\n',
    ],
    [
      "registry overwrite",
      'DOC_NAME = ""\nraise RuntimeError("selection must not execute user code")\nCAD_HANDLERS["shape.box"] = lambda ctx, data: data\ndef run(context):\n    FMCAD.call("shape.box", {})\n',
    ],
  ] as const;

  for (const [index, [name, source]] of fallbackSources.entries()) {
    const filename = path.join(directory, `${index}.py`);
    fs.writeFileSync(filename, source);
    const artifact = prepareRunScript(
      filename,
      [],
      false,
      "PublicSelectionFallback",
      { docId: `public-source-selection-${index}` },
      "cad-v1",
      [],
    );
    assert.deepEqual(
      runtimeUnits(artifact),
      runtimeUnits(dynamicFallback),
      `${name} must preserve the conservative runtime closure`,
    );
    assert.ok(
      artifact.units.some(
        (unit) =>
          unit.role === "user" &&
          unit.source.includes("selection must not execute user code"),
      ),
      `${name} source was not preserved as data`,
    );
    for (const id of ["cam", "optics", "sheetmetal"])
      assert.ok(runtimeUnitIds(artifact).includes(id), `${name} dropped ${id}`);
  }
});

test("CLI worker and MCP typed invocation prepare the same public CAD source", async () => {
  const operation = operations.find(
    (entry) => entry.operation === "model.thread",
  )!;
  const context = {
    doc: "PublicSelectionParity",
    docId: "public-source-selection-parity",
  };
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
    operation: operation.operation,
    data: operation.data,
    context,
    json: true,
  });
  const code = await executeWorker(command, backend, () => {}, {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });
  const result = await executeInvocation(
    {
      version: 1,
      kind: "cad",
      operation: operation.operation,
      data: operation.data,
      ...context,
    },
    backend,
  );

  assert.equal(code, 0, stderr.join(""));
  assert.deepEqual(JSON.parse(stdout.join("")), result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[1], "fusion_mcp_execute");
  assert.equal(calls[1]?.[1], "fusion_mcp_execute");
  assert.deepEqual(calls[0]?.[0], calls[1]?.[0]);
  assert.deepEqual(calls[0]?.[2], calls[1]?.[2]);
  assert.ok(calls[0]?.[0].object.script.includes("model.thread"));
  assert.ok(calls[0]?.[2]?.units.some((unit) => unit.id === "thread-domain"));
  assert.ok(calls[0]?.[2]?.units.some((unit) => unit.id === "thread-fusion"));
});
