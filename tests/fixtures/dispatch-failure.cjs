/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS subprocess fixture. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { BrokerMcpClient } = require("../../packages/node-adapters/dist/fusion-transport/mcp.js");
const { decodeNativeProgram } = require("./native-source-envelope.cjs");
const { runBoundInstanceProbe } = require("./bound-instance-probe.cjs");

const sandbox = fs.mkdtempSync(
  path.join(
    process.env.FMCAD_DISPATCH_TEST_TMP || os.tmpdir(),
    "fmcad-dispatch-suite-",
  ),
);
for (const [name, directory] of Object.entries({
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
})) {
  process.env[name] = path.join(sandbox, directory);
  fs.mkdirSync(process.env[name], { recursive: true });
}
for (const protocol of ["node:http", "node:https"]) {
  const api = require(protocol);
  api.request = api.get = () => {
    throw new Error("Network forbidden in offline fixture");
  };
}
globalThis.fetch = () => {
  throw new Error("Network forbidden in offline fixture");
};
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

// Installed/isolated offline runtime only. No CLI, discovery, autostart or HTTP.
const runtime =
  process.env.FMCAD_DISPATCH_TEST_RUNTIME ||
  path.resolve(__dirname, "../../dist");
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const { dispatchPrepared } = load("./dist/core/application/execution");
const { serve } = load("./queue-broker");
const ipc = load("./queue-connection");
const { buildHash } = load("./queue-instance");
const secret = "Bearer-private-fixture-token";

test("dispatch errors retain the exact phase without a second send", async () => {
  for (const phase of [
    "prepare",
    "check",
    "admit",
    "fence",
    "send",
    "settle",
  ]) {
    const error = Object.assign(new Error(secret), { code: "ECONNRESET" });
    let sends = 0,
      observed;
    const ports = {
      prepare() {
        if (phase === "prepare") throw error;
        return { id: "prepared" };
      },
      check() {
        if (phase === "check") throw error;
      },
      admit(send) {
        if (phase === "admit") throw error;
        return send();
      },
      fence() {
        if (phase === "fence") throw error;
      },
      async send() {
        sends++;
        if (phase === "send") throw error;
        return {};
      },
      settle() {
        if (phase === "settle") throw error;
        return {};
      },
      unknown(cause, failure) {
        observed = { cause, failure, kind: "unknown" };
      },
      notSubmitted(cause, failure) {
        observed = { cause, failure, kind: "not_submitted" };
      },
    };
    await assert.rejects(dispatchPrepared(ports), (e) => e === error);
    assert.equal(observed.cause, error);
    assert.equal(observed.failure.phase, phase);
    assert.equal(
      observed.failure.submitted,
      ["send", "settle"].includes(phase),
    );
    assert.equal(sends, ["send", "settle"].includes(phase) ? 1 : 0);
    assert.equal(observed.kind, sends ? "unknown" : "not_submitted");
  }
});

async function scenario(t, fault, owner, metadata = "known") {
  const root = fs.mkdtempSync(path.join(sandbox, "fmcad-dispatch-failure-"));
  const queue = path.join(root, "queue");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const auth = { clientId: owner, clientToken: secret + owner };
  const instance = {
    pid: 99,
    birth: "synthetic:99",
    version: "offline",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  let sends = 0;
  const preparedProbes = new Map();
  const probeReceipts = [];
  const fake = new BrokerMcpClient(
    {
      backend: "mcp",
      url: "http://offline.invalid",
      tool: "fusion_mcp_execute",
      timeoutMs: 1000,
    },
    {
      version: "offline",
      bridgeSource: () => "",
      requestTimeout: () => 1000,
    },
  );
  const prepareCallTool = fake.prepareCallTool.bind(fake);
  fake.prepareCallTool = async (args, tool, manifest) => {
    const script = args?.object?.script;
    if (
      typeof script === "string" &&
      decodeNativeProgram(script).includes("_qr_path = ")
    ) {
      assert.ok(manifest, "probe sends must retain their checked source manifest");
      assert.equal(
        manifest.sha256,
        createHash("sha256").update(script, "utf8").digest("hex"),
        "the manifest must bind the exact probe source sent to the backend",
      );
      preparedProbes.set(script, manifest);
    }
    return prepareCallTool(args, tool, manifest);
  };
  fake._post = async (payload) => {
    if (payload.method === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "offline-fixture", version: "offline" },
          },
        }),
      };
    if (payload.method === "notifications/initialized")
      return { status: 200, raw: "" };
    const args = payload.params?.arguments;
    const script = args?.object?.script;
    if (
      payload.method === "tools/call" &&
      typeof script === "string" &&
      preparedProbes.has(script)
    ) {
      const manifest = preparedProbes.get(script);
      assert.ok(manifest, "MCP probes must pass through prepared admission");
      const source = decodeNativeProgram(script);
      assert.match(source, /FMCAD_QUEUE_INSTANCE /);
      let text;
      if (source.includes("_qr_path = ")) {
        const probe = runBoundInstanceProbe(script, instance);
        text = probe.text;
        probeReceipts.push({ manifest, script, receipt: probe.receipt });
      } else {
        text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance);
      }
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text }] },
        }),
      };
    }
    sends++;
    if (fault === "send") {
      const error = Object.assign(new Error(secret), {
        code: "ECONNRESET",
        stdout: secret,
        stderr: secret,
        headers: { Authorization: secret },
      });
      if (metadata === "getter") {
        Object.defineProperty(error, "causeCode", {
          get() {
            assert.fail("Diagnostic must not invoke getters");
          },
        });
        Object.defineProperty(error, "transportPhase", {
          get() {
            assert.fail("Diagnostic must not invoke getters");
          },
        });
      } else
        Object.assign(error, {
          causeCode: metadata === "known" ? "ENOENT" : secret,
          transportPhase: metadata === "known" ? "spawn" : secret,
        });
      throw error;
    }
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: fault === "settle" ? "foreign-wire-id" : payload.id,
        result: {},
      }),
    };
  };
  const broker = await serve(
    { backend: "mcp", timeoutMs: 1000 },
    {
      dir: queue,
      confirmOwnership: true,
      createBackend: () => fake,
      nativePath: (file) => file,
      pollMs: 5,
      spawnWorker: () => {
        throw new Error("Worker spawn forbidden in offline fixture");
      },
      testCheckPrepared:
        fault === "prepare"
          ? () => {
              throw Object.assign(new Error(secret), {
                code: "PYTHON_CHECK_REJECTED",
              });
            }
          : undefined,
    },
  );
  try {
    const startup = probeReceipts.find(
      ({ receipt }) => receipt.stage === "startup",
    );
    assert.ok(startup, "startup must execute and persist its bound probe");
    assert.equal(startup.receipt.stage, "startup");
    assert.deepEqual(
      startup.manifest.request,
      Object.fromEntries(
        Object.entries(startup.receipt).filter(
          ([key]) =>
            ![
              "terminal",
              "outcome",
              "instance",
              "probeObservation",
            ].includes(key),
        ),
      ),
      "the checked artifact must carry the exact binding persisted in its receipt",
    );
    assert.equal(
      startup.manifest.sha256,
      createHash("sha256").update(startup.script, "utf8").digest("hex"),
    );
    assert.match(startup.manifest.artifactHash, /^[a-f0-9]{64}$/);
    assert.equal(startup.receipt.buildHash, buildHash());
    assert.equal(startup.receipt.terminal, true);
    assert.equal(startup.receipt.outcome, "succeeded");
    assert.equal(startup.receipt.instance.pid, instance.pid);
    assert.equal(startup.receipt.instance.birth, instance.birth);
    assert.equal(startup.receipt.instance.version, instance.version);
    assert.deepEqual(startup.receipt.probeObservation, {
      schema: "fmcad-instance-probe-v1",
      identity: {
        pid: instance.pid,
        birth: instance.birth,
        version: instance.version,
        activeCommand: instance.activeCommand,
        documents: instance.documents,
      },
    });
    await ipc.request(queue, { action: "register", ...auth });
    if (fault === "prepare") {
      await assert.rejects(
        ipc.request(queue, {
          action: "submit",
          auth,
          request: {
            kind: "rpc",
            requestId: "original-" + owner,
            cwd: project,
            timeoutMs: 1000,
            payload: { jsonrpc: "2.0", id: 1, method: "ping" },
          },
        }),
        { code: "PYTHON_CHECK_REJECTED" },
      );
      assert.equal(sends, 0);
      return { jobId: owner, diagnostic: { clientId: owner } };
    }
    const job = await ipc.request(queue, {
      action: "submit",
      auth,
      request: {
        kind: "rpc",
        requestId: "original-" + owner,
        cwd: project,
        timeoutMs: 1000,
        payload: { jsonrpc: "2.0", id: 1, method: "ping" },
      },
    });
    let result;
    for (let attempt = 0; attempt < 200; attempt++) {
      result = await ipc.request(queue, {
        action: "result",
        auth,
        jobId: job.id,
      });
      if (["failed", "needs_reconciliation"].includes(result.job.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      result.job.state,
      fault === "prepare" ? "failed" : "needs_reconciliation",
    );
    const directory = path.join(queue, "jobs", job.id);
    const failures = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith("dispatch-failure-"));
    assert.equal(
      failures.length,
      1,
      "The original error needs durable diagnostic evidence",
    );
    const diagnostic = JSON.parse(
      fs.readFileSync(path.join(directory, failures[0]), "utf8"),
    );
    assert.equal(diagnostic.jobId, job.id);
    assert.equal(diagnostic.requestId, job.requestId);
    assert.equal(diagnostic.clientId, owner);
    assert.equal(diagnostic.phase, fault);
    assert.equal(diagnostic.submitted, fault !== "prepare");
    assert.equal(
      diagnostic.code,
      fault === "send"
        ? "ECONNRESET"
        : fault === "settle"
          ? "UNKNOWN_RPC"
          : "PYTHON_CHECK_REJECTED",
    );
    assert.equal(
      diagnostic.causeCode,
      fault === "send" && metadata === "known" ? "ENOENT" : null,
    );
    assert.equal(
      diagnostic.transportPhase,
      fault === "send" && metadata === "known" ? "spawn" : null,
    );
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
    assert.equal("execution" in diagnostic, false);
    if (fault !== "prepare") {
      const journal = JSON.parse(
        fs.readFileSync(
          path.join(directory, `rpc-${diagnostic.rpc.rpcId}.json`),
          "utf8",
        ),
      );
      assert.equal(diagnostic.rpc.requestHash, journal.binding.requestHash);
      assert.equal(diagnostic.rpc.buildHash, journal.binding.buildHash);
      assert.equal(journal.terminal, false);
      assert.equal(journal.binding.jobId, job.id);
      assert.equal(result.execution?.sdkSettled === true, false);
    }
    const before = fs.readFileSync(path.join(directory, failures[0]));
    await assert.rejects(
      ipc.request(queue, {
        action: "result",
        auth: { ...auth, clientToken: "tampered" },
        jobId: job.id,
      }),
      { code: "UNAUTHORIZED" },
    );
    const foreign = {
      clientId: "foreign-" + owner,
      clientToken: "foreign-token",
    };
    await ipc.request(queue, { action: "register", ...foreign });
    await assert.rejects(
      ipc.request(queue, { action: "result", auth: foreign, jobId: job.id }),
      { code: "NOT_OWNER" },
    );
    await ipc.request(queue, { action: "result", auth, jobId: job.id });
    assert.deepEqual(
      fs.readFileSync(path.join(directory, failures[0])),
      before,
    );
    assert.equal(
      sends,
      fault === "prepare" ? 0 : 1,
      "Observation must not replay dispatch",
    );
    return { jobId: job.id, diagnostic };
  } finally {
    // Only our synthetic broker and temp fixture; never a production endpoint.
    if (fault === "prepare") await broker.close();
    else
      await assert.rejects(broker.close(), { code: "RECONCILIATION_REQUIRED" });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const metadata of ["getter", "secret"]) {
  test(`broker excludes ${metadata} transport metadata without releasing unknown`, async (t) => {
    await scenario(t, "send", "owner-" + metadata, metadata);
  });
}

for (const fault of ["prepare", "send", "settle"]) {
  test(`real broker preserves ${fault} failure in isolated fake MCP profiles`, async (t) => {
    const results = await Promise.all([
      scenario(t, fault, "owner-a-" + fault),
      scenario(t, fault, "owner-b-" + fault),
    ]);
    assert.notEqual(results[0].jobId, results[1].jobId);
    assert.notEqual(
      results[0].diagnostic.clientId,
      results[1].diagnostic.clientId,
    );
  });
}
