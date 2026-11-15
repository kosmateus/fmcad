import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { cadCommand } from "./scenarios/cad-programs";

const load = createRequire(path.resolve("tests/python-source-codec.test.js"));
const { prepareRunScript } = load(
  "../src/run",
) as typeof import("../src/composition/run");
const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const python = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact") &
  typeof import("../packages/node-adapters/src/python/context-binding") &
  typeof import("../packages/node-adapters/src/python/checker") &
  typeof import("../packages/node-adapters/src/python/admission");
const { prepareWireArtifact, prepareEncodedWireArtifact } = load(
  "../packages/node-adapters/dist/python/source-units",
) as typeof import("../packages/node-adapters/src/python/source-units");
const runtime = path.resolve("dist/runtime/python");
const checker = () =>
  python.createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    definitionsRoot: path.join(runtime, "typing"),
    pythonPlatform: "Windows",
  });

test("imported CAD scenario retains its full runtime and fits the native wire with a real decoded check", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-codec-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "cad-profile.py");
  // The existing profile's imports intentionally require conservative selection.
  await fs.writeFile(
    filename,
    cadCommand({ creationId: "codec-doc", name: "CodecFixture" }, "shape.box", {
      name: "Box",
      width: "2 mm",
      depth: "3 mm",
      height: "4 mm",
    }),
  );
  const original = prepareRunScript(
    filename,
    [],
    false,
    "CodecFixture",
    { docId: "codec-doc" },
    "cad-v1",
    [],
  );
  assert.ok(original.units.some((unit) => unit.id === "cam"));
  assert.ok(original.units.some((unit) => unit.id === "optics"));
  const artifact = python.retainPythonOrigin(
    prepareReceiptScript(
      original.script,
      true,
      path.join(directory, "receipt.json"),
      { jobId: "codec-job" },
      { mapPath: (value) => value },
    ),
    python.pythonArtifactManifest(original),
  );
  const request = {
    jsonrpc: "2.0",
    id: "codec-rpc",
    method: "tools/call",
    params: {
      name: "fusion_mcp_execute",
      arguments: { featureType: "script", object: { script: artifact.script } },
    },
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(request)) <= 1_048_576,
    `final native body is ${Buffer.byteLength(JSON.stringify(request))} bytes`,
  );
  assert.ok(artifact.units.some((unit) => unit.source === original.script));
  const user = original.units.find((unit) => unit.id === "user-script")!;
  const retained = artifact.units.find(
    (unit) => unit.filename === user.filename && unit.sha256 === user.sha256,
  )!;
  assert.deepEqual(python.pythonUnitContexts(artifact)[retained.id], {
    kind: "cad-v1",
    deferredFacade: true,
    entrypoint: "run-if-present",
  });
  const admission = python.createPythonRpcAdmission({
    runtime,
    checker: checker(),
  });
  const certificate = await admission
    .check(request, artifact)
    .catch((error: unknown) => {
      t.diagnostic(JSON.stringify(error));
      throw error;
    });
  assert.equal(
    certificate.report?.status,
    "passed",
    JSON.stringify(certificate.report),
  );
  t.diagnostic(
    JSON.stringify({
      sourceUnits: original.units.length,
      sourceHash: original.sha256,
      bodyBytes: Buffer.byteLength(JSON.stringify(request)),
      wireHash: artifact.sha256,
      artifactHash: artifact.artifactHash,
      analysisHash: certificate.report?.provenance.analysisHash,
    }),
  );
  certificate.fence(request);
  assert.throws(
    () =>
      certificate.fence({
        ...request,
        params: {
          ...request.params,
          arguments: {
            ...request.params.arguments,
            object: { script: artifact.script + "\npass" },
          },
        },
      }),
    /changed|mismatch/i,
  );
});

test("generic wire extraction and non-native receipts never rewrite input", () => {
  const source =
    "def run(context: str) -> None:\n    pass\n" + "# padding\n".repeat(70000);
  assert.equal(prepareWireArtifact(runtime, source).script, source);
  const native = prepareReceiptScript(
    source,
    true,
    "/offline/codec.json",
    {},
    { mapPath: (value) => value },
  );
  const addin = prepareReceiptScript(
    source,
    false,
    "/offline/codec.json",
    {},
    { mapPath: (value) => value },
  );
  assert.ok(native.script.startsWith("# FMCAD native source envelope v1"));
  assert.ok(!addin.script.startsWith("# FMCAD native source envelope v1"));
  assert.ok(addin.script.includes("# padding"));
});

test("real checker finds poisoned decoded source without running its top-level failure", async () => {
  const source =
    "def run(context: str) -> None:\n    mistake: int = 'wrong'\nraise RuntimeError('must not execute offline')\n" +
    "# padding\n".repeat(70000);
  const artifact = prepareEncodedWireArtifact(runtime, source);
  assert.notEqual(artifact.script, source);
  assert.equal(
    artifact.units.find((unit) => unit.filename === "<fmcad-native-source>")
      ?.source,
    source,
  );
  const report = await checker().check({ artifact, context: { kind: "raw" } });
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.ok(
    report.diagnostics.some((item) => item.rule === "reportAssignmentType"),
    JSON.stringify(report),
  );
});

test("encoding does not turn arbitrary dynamic compile into checked literal source", async () => {
  const source =
    "def run(context: str) -> None:\n    exec(compile(context, '<dynamic>', 'exec'))\n" +
    "# padding\n".repeat(70000);
  const artifact = prepareEncodedWireArtifact(runtime, source);
  const report = await checker().check({ artifact, context: { kind: "raw" } });
  assert.equal(report.status, "incomplete", JSON.stringify(report));
});

test("encoded official entrypoints are checked against the real decoded function", async () => {
  for (const body of [
    "answer = 42\n",
    "def run(context: int) -> None:\n    pass\n",
  ]) {
    const artifact = prepareEncodedWireArtifact(
      runtime,
      body + "# padding\n".repeat(70000),
    );
    const report = await checker().check({
      artifact,
      context: { kind: "raw", entrypoint: "run" },
    });
    assert.equal(report.status, "failed", JSON.stringify(report));
    assert.ok(report.diagnostics.length > 0);
  }
});
