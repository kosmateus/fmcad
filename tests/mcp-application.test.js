"use strict";
const os = require('node:os');
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "..");

function processClient(
  t,
  entrypoint,
  directory,
  extra = {},
  executable = false,
) {
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: directory,
    FMCAD_CONFIG: path.join(directory, "config.json"),
    FMCAD_BACKEND: "addin",
    FMCAD_ROUTING: "queue",
    FMCAD_PROJECT_DIRECTORY: directory,
    ...extra,
  };
  const child = spawn(
    executable ? entrypoint : process.execPath,
    executable ? [] : [entrypoint],
    { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let diagnostics = "",
    output = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const lines = readline
    .createInterface({ input: child.stdout })
    [Symbol.asyncIterator]();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
  });
  return {
    child,
    diagnostics: () => diagnostics,
    output: () => output,
    notify(value) {
      child.stdin.write(JSON.stringify(value) + "\n");
    },
    async request(value) {
      child.stdin.write(
        typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n",
      );
      const line = await lines.next();
      assert.equal(line.done, false, diagnostics);
      return JSON.parse(line.value);
    },
    async close() {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], diagnostics);
      assert.equal((await lines.next()).done, true);
      assert.equal(diagnostics, "");
    },
    async kill(signal = "SIGKILL") {
      child.kill(signal);
      await closed;
    },
  };
}
const request = (id, method, params) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
const execute = (id, operation, data = {}, context = {}, meta) =>
  request(id, "tools/call", {
    name: "fmcad_execute",
    arguments: { operation, data, context },
    ...(meta ? { _meta: { fmcad: meta } } : {}),
  });
async function until(fn, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for " + message);
}

test("typed MCP adapter preserves pins, purpose and request identity across aliases without replay", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  let submissions = 0,
    starts = 0,
    observed;
  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("not a physical RPC");
    },
    services(local) {
      assert.equal(local, false);
      return {
        async start() {
          starts++;
        },
        async execute(payload, options) {
          submissions++;
          observed = { payload, options };
          return {
            version: 1,
            requestId: options.requestId,
            jobId: "owned-job",
            state: "running",
            result: null,
            outcome: { executionOutcome: "unknown" },
          };
        },
        query: {
          async result() {
            throw new Error(
              "Lost observation; remote execution may still be active",
            );
          },
        },
      };
    },
  });
  const response = JSON.parse(
    (
      await application(
        execute(
          0,
          "entity.list",
          {},
          {
            doc: "Model",
            docId: "creation",
            docFileId: "file",
            component: "root",
            projectId: "project",
          },
          { description: "Inspect part", requestId: "stable-owned-request" },
        ),
      )
    ).raw,
  );
  assert.equal(submissions, 1);
  assert.equal(starts, 1);
  assert.deepEqual(observed, {
    payload: {
      version: 1,
      kind: "cad",
      operation: "entity.list",
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      component: "root",
      projectId: "project",
      purpose: "Inspect part",
    },
    options: { requestId: "stable-owned-request" },
  });
  assert.equal(response.id, 0);
  assert.equal(response.error.data.fmcad.jobId, "owned-job");
  assert.equal(response.error.data.requestId, "stable-owned-request");
  assert.match(response.error.data.instruction, /do not resubmit/);
  const alias = request("alias", "tools/call", {
    name: "fmcad_cad_entity_list",
    arguments: {
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Inspect part",
    },
  });
  await application(alias);
  assert.equal(
    submissions,
    2,
    "each explicit call has one submit; observation failure never replays",
  );
  assert.equal(observed.payload.docId, "creation");
});

test("MCP rejects missing project scope before admission with typed required validation", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  let projectResolution;
  const application = createMcpApplication({
    queueTools: [],
    clientContext: {
      identity: {
        clientId: "owner-a",
        instanceId: "presence-a",
        sessionId: "session-a",
      },
      async resolveProject(selection) {
        projectResolution = selection;
        return { projectDirectory: null, source: "none" };
      },
    },
    services() {
      assert.fail("missing project must reject before constructing services");
    },
    compatibility() {
      assert.fail("native validation must not enter raw compatibility");
    },
  });
  const result = JSON.parse(
    (
      await application(
        execute(
          "no-project",
          "entity.list",
          {},
          { doc: "Model" },
          {
            requestId: "missing-project-request",
          },
        ),
      )
    ).raw,
  );
  assert.deepEqual(projectResolution, {});
  assert.equal(result.error.data.requestId, "missing-project-request");
  assert.equal(result.error.data.requestStatus, "rejected-before-admission");
  assert.equal(result.error.data.validation.status, "required");
  assert.equal(result.error.data.context.projectDirectory, null);
});

test("queue helper invalid input and unsupported methods fail before configuration or transport", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  const queueTools = [
    ["begin", []],
    ["end", ["sequenceId"]],
    ["result", ["jobId"]],
  ].map(([name, required]) => ({
    name: "fmcad_queue_" + name,
    inputSchema: { required },
  }));
  const application = createMcpApplication({
    queueTools,
    services() {
      assert.fail("no application effect");
    },
    compatibility() {
      assert.fail("no compatibility effect");
    },
  });
  for (const [name, args] of [
    ["fmcad_queue_result", { jobId: "" }],
    ["fmcad_queue_begin", { unknown: true }],
    ["fmcad_queue_end", {}],
    ["fusion_mcp_execute", { code: "wrong schema" }],
  ]) {
    const value = JSON.parse(
      (
        await application(
          request(name, "tools/call", { name, arguments: args }),
        )
      ).raw,
    );
    assert.equal(value.error.code, -32602);
  }
  for (const method of [
    "resources/read",
    "resources/subscribe",
    "prompts/list",
    "prompts/get",
    "not/a/method",
  ]) {
    assert.equal(
      JSON.parse((await application(request(method, method))).raw).error.code,
      -32601,
    );
  }
});

test("queue helper forwards a schema-declared optional outcome and rejects other values", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  const queueTools = [{
    name: "fmcad_queue_reconcile",
    inputSchema: {
      required: ["jobId"],
      properties: {
        jobId: { type: "string" },
        acceptedOutcome: { type: "string", enum: ["committed", "aborted"] },
      },
    },
  }];
  let forwarded;
  const application = createMcpApplication({
    queueTools,
    compatibility(request) {
      forwarded = request;
      return { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) };
    },
  });
  const valid = request("valid-outcome", "tools/call", {
    name: "fmcad_queue_reconcile",
    arguments: { jobId: "job-1", acceptedOutcome: "committed" },
  });
  assert.equal(JSON.parse((await application(valid)).raw).result !== undefined, true);
  assert.deepEqual(forwarded.params.arguments, valid.params.arguments);
  const invalid = request("invalid-outcome", "tools/call", {
    name: "fmcad_queue_reconcile",
    arguments: { jobId: "job-1", acceptedOutcome: "unknown" },
  });
  assert.equal(JSON.parse((await application(invalid)).raw).error.code, -32602);
});

test("MCP stops waiting for a slow observation without replay or terminal-success fabrication", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  let submissions = 0,
    state = "preparing";
  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("no raw proxy");
    },
    services() {
      return {
        async start() {},
        async execute(payload, options) {
          submissions++;
          return {
            version: 1,
            requestId: options.requestId,
            jobId: "bounded-job",
            state,
            result: null,
            outcome: {
              executionOutcome: state === "failed" ? "failed" : "not_started",
            },
          };
        },
        query: {
          result() {
            return new Promise(() => {});
          },
        },
      };
    },
  });
  const before = Date.now();
  const accepted = JSON.parse(
    (await application(execute(1, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert(
    Date.now() - before < 2000,
    "a stuck result read must not extend the synchronous acceptance window",
  );
  assert.equal(accepted.result.structuredContent.status, "ACCEPTED");
  assert.equal(accepted.result.structuredContent.state, "preparing");
  assert.equal(submissions, 1);
  state = "failed";
  const failed = JSON.parse(
    (await application(execute(2, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.status, undefined);
  state = "succeeded";
  const missing = JSON.parse(
    (await application(execute(3, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert.match(missing.error.message, /QUEUE_RESULT_UNAVAILABLE/);
  assert.equal(missing.error.data.fmcad.jobId, "bounded-job");
  assert.equal(
    submissions,
    3,
    "each explicit test call submits once, never on observation failure",
  );
});

test("explicit raw compatibility adapters preserve wire arguments and never promote arbitrary backend tool names", async () => {
  const { createMcpApplication } = require("../src/dist/entrypoints/mcp");
  const seen = [];
  const application = createMcpApplication({
    queueTools: [],
    services() {
      assert.fail("not native CAD");
    },
    async compatibility(value) {
      seen.push(value);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: value.id,
          result: { content: [] },
        }),
      };
    },
  });
  const raw = request(4, "tools/call", {
    name: "fusion_mcp_execute",
    arguments: {
      featureType: "script",
      object: { script: 'print("unchanged")', readOnly: true },
    },
  });
  assert(JSON.parse((await application(raw)).raw).result);
  assert.deepEqual(seen, [raw]);
  const unknown = JSON.parse(
    (
      await application(
        request(5, "tools/call", {
          name: "arbitrary_upstream_sdk_schema",
          arguments: {},
        }),
      )
    ).raw,
  );
  assert.equal(unknown.error.code, -32602);
  assert.equal(seen.length, 1);
});

test(
  "process MCP and CLI share the production broker/typed worker and execute once per explicit request",
  { timeout: 30000 },
  async (t) => {
    const { resolveFmcadConfiguration } = require("../dist/src/dist/core");
    const { queueDirectory } = require("../dist/src/queue-connection");
    const { serve } = require("../dist/src/queue-broker");
    const { durable } = require("../dist/src/queue-instance");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-broker-'));
    const oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = directory;
    const dir = queueDirectory();
    const config = {
      ...resolveFmcadConfiguration({
        adapter: { backend: "mcp", url: "http://localhost:1", timeoutMs: 5000 },
        environment: {},
        file: {},
        platformDefaults: {},
        acceptedService: null,
      }),
      queue: {
        autoStart: false,
        startupTimeoutMs: 45000,
        waitTimeoutMs: 35000,
        client: "typed-mcp",
      },
      controlCenter: { port: 5481 },
    };
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(config),
    );
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: {
        status: "complete",
        fingerprint: "unchanged",
        state: {
          identity: { creationId: "creation", fileId: "file" },
          references: [],
        },
      },
    };
    const expected = {
      success: true,
      operation: "document.status",
      result: {
        name: "Model",
        creationId: "creation",
        saved: true,
        modified: false,
        fileId: "file",
        fileName: "Model.f3d",
        version: 1,
        versionId: "version-1",
        isComplete: true,
        folderId: "folder",
        projectId: "project",
      },
    };
    let calls = 0;
    function settle(script) {
      const binding = script.match(
        /_qr_binding = _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
      );
      const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (!binding || !file) return;
      const record = JSON.parse(JSON.parse(binding[1]));
      const target = JSON.parse(file[1])
        .replace(/^\\\\wsl\$\\[^\\]+/, "")
        .replaceAll("\\", "/");
      durable(target, {
        ...record,
        terminal: true,
        outcome: "succeeded",
        instance,
      });
    }
    const physical = {
      server: { timeoutMs: 5000 },
      _parse: JSON.parse,
      async _post(payload) {
        calls++;
        settle(payload.params.arguments.object.script);
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(expected),
                },
              ],
            },
          }),
        };
      },
      async callTool(value) {
        const script = value.object?.script || "";
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          settle(script);
          return {
            failed: false,
            text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
          };
        }
        const response = await this._post({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name: "fusion_mcp_execute", arguments: value },
        });
        return {
          failed: false,
          text: JSON.parse(response.raw).result.content[0].text,
        };
      },
    };
    const broker = await serve(config, {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      pollMs: 5,
    });
    t.after(async () => {
      await broker.close();
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const env = { FMCAD_BACKEND: "mcp" };
    const client = processClient(
      t,
      path.join(root, "dist/bin/fmcad-mcp.js"),
      directory,
      env,
    );
    async function completed(response) {
      if (!response.result?.structuredContent?.jobId)
        return response.result?.structuredContent;
      const jobId = response.result.structuredContent.jobId;
      for (let i = 0; i < 1000; i++) {
        const value = await client.request(
          request(`poll-${i}`, "tools/call", {
            name: "fmcad_queue_result",
            arguments: { jobId },
          }),
        );
        const result = value.result?.structuredContent;
        if (["succeeded", "failed"].includes(result?.job?.state)) {
          assert.equal(result.job.state, "succeeded", JSON.stringify(result));
          return JSON.parse(result.stdout);
        }
        assert(!value.error, JSON.stringify(value));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("The existing owned job did not settle");
    }
    const native = await client.request(
      execute(
        1,
        "document.status",
        {},
        {
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect part",
        },
        { requestId: "mcp-stable" },
      ),
    );
    const nativeOutput = await completed(native);
    assert.deepEqual(nativeOutput, expected, JSON.stringify(native));
    assert.equal(calls, 1);
    const jobs = Object.values(broker.status().jobs);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].requestId, "mcp-stable");
    assert(
      !Object.hasOwn(jobs[0], "request"),
      "public broker status must not leak the worker envelope",
    );
    const repeated = await client.request(
      execute(
        2,
        "document.status",
        {},
        {
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect part",
        },
        { requestId: "mcp-stable" },
      ),
    );
    assert.deepEqual(
      await completed(repeated),
      expected,
      JSON.stringify(repeated),
    );
    assert.equal(
      calls,
      1,
      "same explicit request identity is deduplicated by the broker, never replayed",
    );
    const cliChild = spawn(
      process.execPath,
      [
        path.join(root, "dist/bin/fmcad.js"),
        "document",
        "status",
        "--doc",
        "Model",
        "--doc-id",
        "creation",
        "--doc-file-id",
        "file",
        "--json",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          FMCAD_CONFIG: path.join(directory, "config.json"),
          FMCAD_BACKEND: "mcp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    cliChild.stdout.on("data", (chunk) => {
      output += chunk;
    });
    cliChild.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    assert.deepEqual(await once(cliChild, "close"), [0, null], errors);
    assert.deepEqual(JSON.parse(output), nativeOutput);
    assert.equal(
      calls,
      2,
      "one MCP operation and one distinct CLI operation each get one SDK turn",
    );
    await client.close();
  },
);

test(
  "MCP process identities preserve project-scoped jobs across pause, lost acknowledgement and owner restart",
  { timeout: 30000 },
  async (t) => {
    const { resolveFmcadConfiguration } = require("../dist/src/dist/core");
    const { queueDirectory } = require("../src/queue-connection");
    const { serve } = require("../dist/src/queue-broker");
    const { durable } = require("../dist/src/queue-instance");
    const { QueueClient } = require("../src/queue-client");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-context-process-'));
    const projectA = path.join(directory, "project-a");
    const projectB = path.join(directory, "project-b");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    const oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = directory;
    const clients = [];
    const dir = queueDirectory();
    const config = resolveFmcadConfiguration({
      adapter: {
        backend: "mcp",
        url: "http://localhost:1/mcp",
        timeoutMs: 5000,
      },
      environment: {},
      file: {},
      platformDefaults: {},
      acceptedService: null,
    });
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(config),
    );
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: {
        status: "complete",
        fingerprint: "unchanged",
        state: {
          identity: { creationId: "creation", fileId: "file" },
          references: [],
        },
      },
    };
    const expected = {
      success: true,
      operation: "entity.list",
      result: { entities: [], observed: true },
    };
    let userCalls = 0;
    let releaseFirstCall;
    let markFirstCall;
    const firstCallStarted = new Promise((resolve) => {
      markFirstCall = resolve;
    });
    const firstCallGate = new Promise((resolve) => {
      releaseFirstCall = resolve;
    });
    function settle(script) {
      const binding = script.match(
        /_qr_binding = _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
      );
      const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (!binding || !file) return;
      const record = JSON.parse(JSON.parse(binding[1]));
      const target = JSON.parse(file[1])
        .replace(/^\\\\wsl\$\\[^\\]+/, "")
        .replaceAll("\\", "/");
      durable(target, {
        ...record,
        terminal: true,
        outcome: "succeeded",
        instance,
      });
    }
    const physical = {
      server: { timeoutMs: 5000 },
      _parse: JSON.parse,
      async _post(payload) {
        userCalls++;
        if (userCalls === 1) {
          markFirstCall();
          await firstCallGate;
        }
        settle(payload.params.arguments.object.script);
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(expected),
                },
              ],
            },
          }),
        };
      },
      async callTool(value) {
        const script = value.object?.script || "";
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          settle(script);
          return {
            failed: false,
            text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
          };
        }
        const response = await this._post({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name: "fusion_mcp_execute", arguments: value },
        });
        return {
          failed: false,
          text: JSON.parse(response.raw).result.content[0].text,
        };
      },
    };
    const broker = await serve(config, {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      pollMs: 5,
    });
    const owner = new QueueClient("owner-a", { cfg: config });
    t.after(async () => {
      releaseFirstCall();
      for (const client of clients) {
        if (client.child.exitCode === null && client.child.signalCode === null)
          await client.kill();
      }
      try {
        let state = await owner.call("control-status");
        const deadline = Date.now() + 10000;
        while (state.phase === "PAUSING" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          state = await owner.call("control-status");
        }
        if (state.phase === "PAUSED") {
          await owner.call("resume", {
            control: {
              requestId: "mcp-context-cleanup-resume",
              instanceId: state.instanceId,
              expectedGeneration: state.generation,
            },
          });
        }
      } catch {
        /* Preserve the original process-test failure during cleanup. */
      }
      owner.dispose();
      await broker.close();
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await owner.register();
    const entrypoint = path.join(root, "dist/bin/fmcad-mcp.js");
    const ownerAEnv = {
      FMCAD_CLIENT: "owner-a",
      FMCAD_BACKEND: "mcp",
      FMCAD_PROJECT_DIRECTORY: projectA,
    };
    const first = processClient(t, entrypoint, directory, ownerAEnv);
    clients.push(first);
    await first.request(
      request("initialize-a", "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "label-is-not-owner", version: "1" },
      }),
    );
    first.notify(
      execute(
        "lost-ack",
        "entity.list",
        {},
        {
          projectDirectory: projectA,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect project A",
        },
        { requestId: "request-a" },
      ),
    );
    const jobA = await until(
      () =>
        Object.values(broker.status().jobs).find(
          (job) => job.requestId === "request-a",
        ),
      "owner A queued job",
    ).catch(async (error) => {
      await first.kill();
      throw new Error(
        `${error.message}; stdout=${first.output()}; stderr=${first.diagnostics()}`,
      );
    });
    await firstCallStarted;
    assert(
      ["running", "sending"].includes(broker.status().jobs[jobA.id].state),
    );
    const beforePause = await owner.call("control-status");
    const paused = await owner.call("pause", {
      control: {
        requestId: "mcp-context-pause",
        instanceId: beforePause.instanceId,
        expectedGeneration: beforePause.generation,
      },
    });
    assert.equal(
      paused.phase,
      "PAUSING",
      `pause waits for the active SDK turn; actual state: ${paused.phase}`,
    );
    await first.kill(); // The active SDK request remains; the MCP process never consumes its acknowledgement.

    const second = processClient(t, entrypoint, directory, {
      FMCAD_CLIENT: "owner-b",
      FMCAD_BACKEND: "mcp",
      FMCAD_PROJECT_DIRECTORY: projectB,
    });
    clients.push(second);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
    );
    const savedA = snapshot.jobs[jobA.id].request;
    assert.equal(savedA.cwd, fs.realpathSync(projectA));
    assert.deepEqual(savedA.clientContext, {
      clientId: "owner-a",
      requestId: "request-a",
      sessionId: savedA.clientContext.sessionId,
      projectDirectory: fs.realpathSync(projectA),
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Inspect project A",
    });

    const foreignResult = await second.request(
      request("foreign-result", "tools/call", {
        name: "fmcad_queue_result",
        arguments: { jobId: jobA.id },
      }),
    );
    assert(foreignResult.error);
    assert.match(foreignResult.error.message, /NOT_OWNER/);
    const hiddenRequest = await second.request(
      request("foreign-request", "tools/call", {
        name: "fmcad_queue_request",
        arguments: { requestId: "request-a" },
      }),
    );
    assert.equal(hiddenRequest.result.structuredContent.jobId, null);
    assert.equal(hiddenRequest.result.structuredContent.context, null);

    const restarted = processClient(t, entrypoint, directory, ownerAEnv);
    clients.push(restarted);
    const recovered = await restarted.request(
      request("recover-a", "tools/call", {
        name: "fmcad_queue_request",
        arguments: { requestId: "request-a" },
      }),
    );
    const recoveredContext = recovered.result.structuredContent.context;
    assert.equal(recovered.result.structuredContent.jobId, jobA.id);
    assert.equal(recovered.result.structuredContent.status, "running");
    assert.equal(recoveredContext.clientId, "owner-a");
    assert.equal(recoveredContext.projectDirectory, fs.realpathSync(projectA));
    assert.equal(recoveredContext.docId, "creation");
    assert.equal(recoveredContext.docFileId, "file");
    assert.equal(recoveredContext.projectId, undefined);
    assert.equal(recoveredContext.purpose, "Inspect project A");

    const duplicate = await restarted.request(
      execute(
        "duplicate-a",
        "entity.list",
        {},
        {
          projectDirectory: projectA,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect project A",
        },
        { requestId: "request-a" },
      ),
    );
    assert.equal(duplicate.result.structuredContent.jobId, jobA.id);
    assert.equal(
      Object.values(broker.status().jobs).filter(
        (job) => job.requestId === "request-a",
      ).length,
      1,
    );
    assert.equal(
      userCalls,
      1,
      "a duplicate request during a long SDK turn does not dispatch again",
    );

    releaseFirstCall();
    await until(
      async () => (await owner.call("control-status")).phase === "PAUSED",
      "pause to settle after active SDK turn",
    );
    const current = await owner.call("control-status");
    const resumed = await owner.call("resume", {
      control: {
        requestId: "mcp-context-resume",
        instanceId: current.instanceId,
        expectedGeneration: current.generation,
      },
    });
    assert(["RUNNING", "RESUMING"].includes(resumed.phase));
    const aFinished = await until(async () => {
      const value = await restarted.request(
        request("poll-a-" + randomUUID(), "tools/call", {
          name: "fmcad_queue_request",
          arguments: { requestId: "request-a" },
        }),
      );
      return value.result?.structuredContent.status === "succeeded"
        ? value.result.structuredContent
        : null;
    }, "recovered project A terminal result");
    const replyB = await second.request(
      execute(
        "project-b",
        "entity.list",
        {},
        {
          projectDirectory: projectB,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          projectId: "fusion-project-b",
          purpose: "Inspect project B",
        },
        { requestId: "request-b" },
      ),
    );
    const jobB = await until(
      () =>
        Object.values(broker.status().jobs).find(
          (job) => job.requestId === "request-b",
        ),
      "owner B project job",
    );
    assert.equal(
      replyB.result?._meta?.fmcad?.jobId,
      jobB.id,
      JSON.stringify(replyB),
    );
    const snapshotB = JSON.parse(
      fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
    );
    const savedB = snapshotB.jobs[jobB.id].request;
    assert.equal(savedB.cwd, fs.realpathSync(projectB));
    assert.equal(
      savedB.clientContext.projectDirectory,
      fs.realpathSync(projectB),
    );
    assert.equal(savedB.clientContext.docId, "creation");
    assert.equal(savedB.clientContext.docFileId, "file");
    assert.equal(savedB.clientContext.projectId, "fusion-project-b");
    const bFinished = await until(async () => {
      const value = await second.request(
        request("poll-b-" + randomUUID(), "tools/call", {
          name: "fmcad_queue_request",
          arguments: { requestId: "request-b" },
        }),
      );
      return value.result?.structuredContent.status === "succeeded"
        ? value.result.structuredContent
        : null;
    }, "project B terminal result");
    assert.equal(aFinished.context.projectDirectory, fs.realpathSync(projectA));
    assert.equal(bFinished.context.projectDirectory, fs.realpathSync(projectB));
    const foreignReconcile = await second.request(
      request("foreign-reconcile", "tools/call", {
        name: "fmcad_queue_reconcile",
        arguments: { jobId: jobA.id },
      }),
    );
    assert(foreignReconcile.error);
    assert.match(foreignReconcile.error.message, /NOT_OWNER/);
    assert.equal(
      userCalls,
      2,
      "each distinct request dispatches once after resume",
    );
    await restarted.close();
    await second.close();
  },
);
