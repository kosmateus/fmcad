const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  QueueScenarioBackend,
} = require("../dist/tests/scenarios/queue-backend.js");
const config = {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  protocolVersion: "2025-06-18",
  tool: "fusion_mcp_execute",
};

function project(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-payload-transport-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tests/helpers"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fmcad"}');
  fs.writeFileSync(
    path.join(root, "tests/helpers/qualified-live-runtime.js"),
    `module.exports = { resolveQualifiedLiveRuntime: () => ({
      dist: ${JSON.stringify(root)}, fingerprint: ${JSON.stringify("a".repeat(64))}
    }) };`,
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src/queue-client.js"),
    "module.exports = {};",
  );
  fs.writeFileSync(
    path.join(root, "tests/helpers/live-broker.js"),
    `exports.runQueueExec = async () => { throw new Error("OFFLINE_PUBLIC_QUEUE_SEAM"); };`,
  );
  return root;
}

for (const tool of ["execute_python", "fusion_mcp_execute"]) {
  test(`scenario driver admits the supported ADDIN public tool ${tool} without SDK`, async (t) => {
    const root = project(t);
    const backend = new QueueScenarioBackend(
      "fusion",
      "addin",
      new Set(),
      root,
      { ...config, tool },
      (file) => file,
    );
    await assert.rejects(
      backend.execute({
        source: 'print("offline only")',
        directory: root,
        requestId: "feature-payload-transport:0",
        owner: {
          clientId: "feature-payload-transport",
          scenarioId: "feature-payload-transport",
          runId: "feature-payload-transport",
        },
      }),
      /OFFLINE_PUBLIC_QUEUE_SEAM/,
    );
  });
}

for (const [label, overrides] of [
  ["unknown tool", { tool: "unapproved_tool" }],
  ["non-string tool", { tool: { toString: () => "execute_python" } }],
  ["foreign protocol", { protocolVersion: "2024-11-05" }],
  ["foreign backend", { backend: "mcp" }],
  ["excluded port", { url: "http://127.0.0.1:27182/mcp" }],
  ["foreign endpoint", { url: "http://127.0.0.1:8765/foreign" }],
]) {
  test(`scenario driver still refuses ${label} before the public queue`, async (t) => {
    const root = project(t);
    const backend = new QueueScenarioBackend(
      "fusion",
      "addin",
      new Set(),
      root,
      { ...config, ...overrides },
      (file) => file,
    );
    await assert.rejects(
      backend.execute({ directory: root }),
      /Live scenario commands require the qualified ADDIN endpoint/,
    );
    assert.equal(fs.existsSync(path.join(root, "request-0.py")), false);
  });
}

test("the ADDIN transport translates the public script alias before dispatch", async () => {
  const module = process.env.FMCAD_FEATURE_FROZEN_RUNTIME
    ? path.join(
        process.env.FMCAD_FEATURE_FROZEN_RUNTIME,
        "src/dist/fusion-transport/broker.js",
      )
    : "../packages/node-adapters/dist/fusion-transport/broker.js";
  const { createBrokerTransport } = require(module);
  const client = createBrokerTransport(config, {
    version: "offline-feature-transport",
    bridgeSource: () => {
      throw new Error("Script alias must not require the generic bridge");
    },
    requestTimeout: () => 180000,
  });
  let captured;
  client.preparePost = async (payload) => {
    captured = payload;
    return {
      fence() {},
      send() {
        throw new Error("Offline regression must not dispatch");
      },
    };
  };
  client._post = () => {
    throw new Error("Offline regression must not open a physical session");
  };
  const prepared = await client.prepareCallTool(
    {
      featureType: "script",
      object: {
        script: 'def run(context: str) -> None:\n    print("offline")',
        readOnly: true,
      },
    },
    "fusion_mcp_execute",
  );
  assert.equal(prepared.dispatchBoundary, "broker-post");
  assert.equal(captured.method, "tools/call");
  assert.equal(captured.params.name, "execute_python");
  assert.equal(captured.params.arguments.persistent, false);
  assert.match(captured.params.arguments.code, /print\("offline"\)/);
});
