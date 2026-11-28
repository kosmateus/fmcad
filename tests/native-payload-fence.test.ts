import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { createPythonRpcAdmission } = load(
  "./packages/node-adapters/dist/python/admission",
) as typeof import("../packages/node-adapters/src/python/admission");
const { preparePythonArtifact } = load(
  "./packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const limit = 1_048_576;

function fixture() {
  let checks = 0;
  const admission = createPythonRpcAdmission({
    runtime: path.join(root, "runtime/python"),
    resources: () => "test-resources",
    checker: {
      async check() {
        checks++;
        throw new Error("Checker reached");
      },
    },
  });
  return {
    admission,
    get checks() {
      return checks;
    },
  };
}

function documentRequest(bytes: number) {
  const request = {
    jsonrpc: "2.0",
    id: "native-size",
    method: "tools/call",
    params: {
      name: "fusion_mcp_execute",
      arguments: { featureType: "document", object: { name: "" } },
    },
  };
  const available = bytes - Buffer.byteLength(JSON.stringify(request));
  request.params.arguments.object.name =
    "🧪".repeat(Math.floor(available / 4)) + "x".repeat(available % 4);
  assert.equal(Buffer.byteLength(JSON.stringify(request)), bytes);
  assert.ok(JSON.stringify(request).length < bytes);
  return request;
}

test("native ingress fence accepts exactly 1 MiB of final UTF-8 JSON and rejects one more byte", async () => {
  const { admission } = fixture();
  const atLimit = documentRequest(limit);
  const certificate = await admission.check(atLimit);
  assert.equal(certificate.kind, "non-python");
  certificate.fence(atLimit);
  await assert.rejects(admission.check(documentRequest(limit + 1)), {
    code: "NATIVE_MCP_PAYLOAD_TOO_LARGE",
    requestBytes: limit + 1,
    maxRequestBytes: limit,
    notStarted: true,
    executionOutcome: "not_started",
    userScriptSubmitted: false,
    mayHaveMutated: false,
  });
  atLimit.params.arguments.object.name += "x";
  assert.throws(() => certificate.fence(atLimit), {
    code: "PYTHON_ADMISSION_CHANGED",
    notStarted: true,
  });
});

test("oversized native Python is rejected before checker work or a send certificate", async () => {
  const f = fixture();
  const request = {
    jsonrpc: "2.0",
    id: "native-python-size",
    method: "tools/call",
    params: {
      name: "fusion_mcp_execute",
      arguments: {
        featureType: "script",
        object: { script: "#" + "x".repeat(limit) },
      },
    },
  };
  await assert.rejects(f.admission.check(request), {
    code: "NATIVE_MCP_PAYLOAD_TOO_LARGE",
    notStarted: true,
    userScriptSubmitted: false,
    mayHaveMutated: false,
  });
  assert.equal(f.checks, 0);
});

test("native HTTP limit does not become a new limit for the separate add-in Python protocol", async () => {
  const f = fixture();
  const source = "#" + "x".repeat(limit);
  const artifact = preparePythonArtifact([
    { id: "wire", filename: "<wire>", source, role: "wrapper" },
  ]);
  await assert.rejects(
    f.admission.check(
      {
        jsonrpc: "2.0",
        id: "addin-size",
        method: "tools/call",
        params: { name: "execute_python", arguments: { code: source } },
      },
      artifact,
    ),
    { code: "PYTHON_CHECK_TOOL_ERROR" },
  );
  assert.equal(f.checks, 1);
});
