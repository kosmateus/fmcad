"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const {
  createBrokerTransport,
} = require("../src/dist/fusion-transport/broker");
const {
  createPythonChecker,
  createPythonRpcAdmission,
  classifyPythonRpc,
} = require("../src/python");
const { createProductionQueueAdmission } = require("../src/queue-admission");
const { validateInvocation } = require("../src/catalog");
const { prepareCadScript } = require("../src/cad");
const documentStatusAdmission = require("./fixtures/document-status-admission-6bb.json");
const { prepareReceiptScript } = require("../src/queue-instance");

// Real private adapter, real receipt builder and real distributed checker.
// Only HTTP/SDK execution is synthetic; no input Python is ever executed here.
for (const backend of ["mcp", "addin"])
  test(`${backend}: final receipt checked before session, negative zero admission and positive exactly once`, async (t) => {
    const requests = [];
    const endpoint = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        requests.push(payload);
        if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          payload.method === "initialize"
            ? { protocolVersion: payload.params.protocolVersion }
            : backend === "addin"
              ? {
                  structuredContent: {
                    success: true,
                    stdout: "checked",
                    stderr: "",
                  },
                }
              : { content: [{ type: "text", text: "checked" }] };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      });
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    });
    const runtime = path.resolve("dist/runtime/python");
    const admission = createPythonRpcAdmission({
      runtime,
      checker: createPythonChecker({
        typingRoot: path.join(runtime, "typing"),
        definitionsRoot: path.join(runtime, "typing"),
        pythonPlatform: "Windows",
      }),
    });
    const client = createBrokerTransport(
      {
        backend,
        tool: "fusion_mcp_execute",
        url: `http://127.0.0.1:${endpoint.address().port}`,
        timeoutMs: 5000,
      },
      {
        version: "test",
        requestTimeout: (value) => value.timeoutMs,
        bridgeSource: () => {
          throw new Error("No bridge requested");
        },
      },
    );
    let admissions = 0,
      expected;
    const post = client._post.bind(client);
    client._post = (...args) => {
      admissions++;
      return post(...args);
    };
    client.preparePost = async (payload) => {
      const outgoing = structuredClone(payload);
      const classified = classifyPythonRpc(outgoing);
      assert.equal(classified.kind, "python");
      const artifact = prepareReceiptScript(
        classified.source,
        classified.official,
        "/offline/receipt.json",
        { jobId: "test" },
        { mapPath: (p) => p },
      );
      if (classified.official)
        outgoing.params.arguments.object.script = artifact.script;
      else outgoing.params.arguments.code = artifact.script;
      const certificate = await admission.check(outgoing, artifact);
      expected = outgoing;
      return {
        fence: () => certificate.fence(outgoing),
        send(sessionId) {
          certificate.fence(outgoing);
          return client._post(outgoing, sessionId);
        },
      };
    };
    const request = (script) => ({
      featureType: "script",
      object: { script, readOnly: true },
    });
    await assert.rejects(
      client.callTool(
        request('def run(context: object) -> None:\n    x: int = "bad"'),
      ),
      (error) =>
        error.code === "PYTHON_CHECK_REJECTED" &&
        error.pythonCheck.status === "failed",
    );
    assert.equal(admissions, 0);
    assert.deepEqual(requests, []);
    const prepared = await client.prepareCallTool(
      request(
        "def run(context: object) -> None:\n    import adsk.core\n    p = adsk.core.Point3D.create(0, 0, 0)\n    if p is not None:\n        print(p.x)",
      ),
    );
    assert.equal(admissions, 0);
    assert.deepEqual(requests, []);
    const result = await prepared();
    assert.equal(result.failed, false);
    assert.deepEqual(
      requests.map((p) => p.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    assert.deepEqual(requests[2], expected);
    await assert.rejects(prepared(), /already consumed/);
    assert.equal(admissions, 3);
  });

test("public document.status admits the exact prepared light artifact before one physical send", async (t) => {
  const requests = [];
  const endpoint = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      if (payload.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      const result = payload.method === "initialize"
        ? { protocolVersion: payload.params.protocolVersion }
        : { content: [{ type: "text", text: "checked" }] };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    endpoint.closeAllConnections();
    await new Promise((resolve) => endpoint.close(resolve));
  });

  const runtime = path.resolve("dist/runtime/python");
  const production = createProductionQueueAdmission(runtime);
  const client = createBrokerTransport({
    backend: "mcp",
    tool: "fusion_mcp_execute",
    url: `http://127.0.0.1:${endpoint.address().port}`,
    timeoutMs: 5000,
  }, {
    version: "test",
    requestTimeout: (value) => value.timeoutMs,
    bridgeSource: () => { throw new Error("No bridge requested"); },
  });
  let physicalCalls = 0;
  const post = client._post.bind(client);
  client._post = (payload, ...args) => {
    if (payload.method === "tools/call") physicalCalls++;
    return post(payload, ...args);
  };

  const invocation = validateInvocation({ version: 1, kind: "cad", operation: "document.status", data: {},
    doc: "Model", docId: "creation", docFileId: "file", purpose: "Inspect owned model" });
  const artifact = prepareCadScript(invocation.operation, invocation.data, {
    doc: invocation.doc, docId: invocation.docId, docFileId: invocation.docFileId,
    component: invocation.component, projectId: invocation.projectId, preview: invocation.preview === true,
  });
  assert.equal(artifact.artifactHash, documentStatusAdmission.artifact.artifactHash);
  assert.equal(artifact.sha256, documentStatusAdmission.artifact.wireHash);
  client.preparePost = async (payload) => {
    const outgoing = structuredClone(payload);
    assert.equal(outgoing.params.arguments.object.script, artifact.script);
    const certificate = await production.admission.check(outgoing, artifact);
    assert.equal(certificate.report.status, "passed");
    assert.equal(certificate.report.diagnostics.length, 0);
    return {
      fence: () => certificate.fence(outgoing),
      send: (sessionId) => {
        certificate.fence(outgoing);
        return client._post(outgoing, sessionId);
      },
    };
  };

  const prepared = await client.prepareCallTool({
    featureType: "script",
    object: { script: artifact.script, readOnly: true },
  });
  const result = await prepared();
  assert.equal(result.failed, false);
  assert.equal(physicalCalls, documentStatusAdmission.fences.physicalTransportToolsCallsPerValidArtifact);
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize", "notifications/initialized", "tools/call",
  ]);
  assert.equal(requests[2].params.arguments.object.script, artifact.script);
});
