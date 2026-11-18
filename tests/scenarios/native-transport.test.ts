import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { ScenarioBackend } from "./contracts";
import { record, text } from "./contracts";
import { ScenarioSession, runScenarios } from "./runner";
import { nativeBackendAdapterScenarios } from "./native-backend-adapter-cases";
import {
  nativeMcpStdioArguments,
  nativeMcpStdioClient,
  nativeMcpStdioEntry,
  nativeMcpStdioScenarios,
} from "./native-mcp-stdio-cases";
import {
  nativeRpcRecoveryScenarios,
  prepareNativeRpcRecoveryBroker,
} from "./native-rpc-recovery-cases";
import {
  diagnosticAddinClient,
  disposeDiagnosticClient,
  type DiagnosticQueue,
} from "./native-transport-support";
import type { Job, Result } from "../live-recovery-ports";
import type { ObjectValue } from "../../packages/node-adapters/src/fusion-transport/contracts";

const root = path.resolve(__dirname, "../../..");

function startMcpChild(
  args: string[],
  home: string,
  config: string,
  preload: string,
  t: import("node:test").TestContext,
) {
  const child = spawn(process.execPath, ["--require", preload, ...args], {
    cwd: home,
    env: {
      PATH: process.env["PATH"],
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: home,
      FMCAD_CONFIG: config,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
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
    async request(value: unknown): Promise<Record<string, unknown>> {
      child.stdin.write(JSON.stringify(value) + "\n");
      const line = await lines.next();
      assert.equal(line.done, false, diagnostics);
      return record(JSON.parse(line.value) as unknown);
    },
    notify(value: unknown): void {
      child.stdin.write(JSON.stringify(value) + "\n");
    },
    async close(checkOutput = true): Promise<void> {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], diagnostics);
      if (checkOutput) assert.equal((await lines.next()).done, true);
      assert.equal(diagnostics, "");
      lines.return?.();
    },
  };
}

const backend: ScenarioBackend = {
  identity: "native-transport-port-proof",
  mode: "simulator",
  qualification: "component",
  protocol: "addin",
  capabilities: new Set(["documents"]),
  fusionPath: (value) => value,
  async execute() {
    throw new Error(
      "No simulator SDK operation belongs to this transport port proof",
    );
  },
};
test("all native diagnostic factories are pure and reject unsupported ten-owner runs before SDK or child work", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-transport-plans-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const factory of [
    nativeBackendAdapterScenarios,
    nativeMcpStdioScenarios,
    nativeRpcRecoveryScenarios,
  ]) {
    const scenarios = factory();
    assert.equal(scenarios.length, 10);
    const reports = [];
    for (const scenario of scenarios)
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.equal(report.document, undefined);
      assert.equal(report.fixture, undefined);
      assert.deepEqual(report.requests, []);
    }
  }
});

test("native MCP stdio uses the qualified runtime entry and rejects a fingerprint mismatch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-mcp-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "tests/helpers");
  fs.mkdirSync(helper, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fmcad" }),
  );
  fs.writeFileSync(
    path.join(helper, "qualified-live-runtime.js"),
    `module.exports = { resolveQualifiedLiveRuntime: () => ({ dist: ${JSON.stringify(path.join(root, "qualified", "dist"))}, fingerprint: "qualified-build" }) };\n`,
  );

  assert.equal(
    nativeMcpStdioEntry({ root, buildHash: "qualified-build" }),
    path.join(root, "qualified/dist/bin/fmcad-mcp.js"),
  );
  assert.throws(
    () => nativeMcpStdioEntry({ root, buildHash: "different-build" }),
    assert.AssertionError,
  );
});

test("MCP discovery budget and explicit observation abort fail without resubmission", async (t) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const trace: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const client = nativeMcpStdioClient(
    child,
    (event) => trace.push(event),
    controller.signal,
    25,
  );
  t.after(async () => {
    client.dispose();
    child.kill();
    await closed;
  });
  await assert.rejects(client.request("tools/list", {}), /MCP smoke timeout/u);
  assert.equal(trace.at(-1)?.["stage"], "timeout");
  assert.equal(trace.at(-1)?.["timeoutMs"], 25);
  const pending = client.request("tools/call", { name: "execute_python" });
  const rejected = assert.rejects(pending, /interrupted.*never resubmit/u);
  controller.abort();
  await rejected;
  assert.equal(trace.filter((event) => event["stage"] === "write").length, 2);
  assert.equal(trace.at(-1)?.["timeoutMs"], null);
});

test("MCP child closure rejects an outstanding observation without replay or settlement", async (t) => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdin.once("data", () => process.exit(0))'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const trace: Record<string, unknown>[] = [];
  const client = nativeMcpStdioClient(child, (event) => trace.push(event));
  t.after(() => client.dispose());
  await assert.rejects(
    client.request("tools/call", { name: "execute_python" }),
    /closed.*never resubmit/u,
  );
  await closed;
  assert.equal(trace.filter((event) => event["stage"] === "write").length, 1);
  assert.equal(trace.at(-1)?.["stage"], "closed");
  assert.equal(trace.at(-1)?.["timeoutMs"], null);
});

test("public MCP child binds its validated project before admission and rejects missing or foreign projects", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-mcp-project-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  const foreign = path.join(home, "foreign-project");
  fs.mkdirSync(project);
  fs.mkdirSync(foreign);
  const trace = path.join(home, "submissions.jsonl");
  const preload = path.join(home, "queue-boundary.cjs");
  const config = path.join(home, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      backend: "addin",
      routing: "queue",
      url: "http://127.0.0.1:1/mcp",
      headers: {},
      timeoutMs: 1000,
      tool: "execute_python",
      transport: "node",
      protocolVersion: "2025-06-18",
      queue: { autoStart: false },
      controlCenter: { port: 4748 },
    }),
  );
  fs.writeFileSync(
    preload,
    `
      const fs = require("node:fs");
      const Module = require("node:module");
      const original = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === "../../queue-client.js" && parent?.filename.endsWith("/entrypoints/mcp-stdio.js")) {
          const loaded = original.call(this, request, parent, isMain);
          return {
            ...loaded,
            QueueClient: class {
              constructor(clientId) { this.dir = process.env.FMCAD_FAKE_QUEUE_DIR; this.auth = { clientId }; }
              async register() {}
              persistRequestContext() {}
              async submit(input) {
                await new Promise(resolve => setTimeout(resolve, 700));
                fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(input) + "\\n");
                this.submitted = input;
                return { id: "offline-job", requestId: input.requestId, clientId: this.auth.clientId, state: "succeeded" };
              }
              async wait(jobId) {
                const input = this.submitted;
                if (input.requestId === "offline-queued-admission")
                  return new Promise(() => {});
                return {
                  job: { id: jobId, requestId: input.requestId, clientId: this.auth.clientId, state: "succeeded" },
                  rpc: { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: input.payload.id, result: { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, stdout: "OFFLINE_BOUND_PROJECT" }) }] } }) },
                };
              }
              async call(action, args) {
                if (action !== "result" || args.jobId !== "offline-job") throw new Error("Unexpected offline queue action");
                const input = this.submitted;
                if (!this.polled) {
                  this.polled = true;
                  return { job: { id: args.jobId, requestId: input.requestId, clientId: this.auth.clientId, state: "queued" } };
                }
                return { job: { id: args.jobId, requestId: input.requestId, clientId: this.auth.clientId, state: "succeeded" }, rpc: { status: 200, raw: JSON.stringify({ jsonrpc: "2.0", id: input.payload.id, result: { isError: false, content: [] } }) } };
              }
              dispose() {}
            },
          };
        }
        if (request === "../composition/control-center.js" && parent?.filename.endsWith("/entrypoints/mcp-stdio.js"))
          return { async ensureControlCenter() {} };
        if (request === "../composition/control-center-telemetry.js" && parent?.filename.endsWith("/entrypoints/mcp-stdio.js"))
          return { createMcpStdioTelemetry: () => ({ publishOwnedResult() {}, async close() {} }) };
        return original.call(this, request, parent, isMain);
      };
    `,
  );
  const qualified = process.env["FMCAD_LIVE_RUNTIME_ROOT"]
    ? (
        createRequire(__filename)(
          path.join(root, "tests/helpers/qualified-live-runtime"),
        ) as {
          resolveQualifiedLiveRuntime(): { fingerprint: string };
        }
      ).resolveQualifiedLiveRuntime()
    : undefined;
  const entry = qualified
    ? nativeMcpStdioEntry({ root, buildHash: qualified.fingerprint })
    : path.join(root, "dist/bin/fmcad-mcp.js");
  const clientId = "offline-project-binding";
  const executeRequest = (id: string, meta?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: 'print("offline")', persistent: false },
      ...(meta ? { _meta: { fmcad: meta } } : {}),
    },
  });
  const initialize = {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

  const positive = startMcpChild(
    nativeMcpStdioArguments(entry, clientId, project),
    home,
    config,
    preload,
    t,
  );
  const timings: Record<string, unknown>[] = [];
  const observer = nativeMcpStdioClient(
    positive.child,
    (event) => timings.push(event),
    undefined,
    300,
  );
  t.after(() => observer.dispose());
  await observer.request("initialize", initialize.params);
  positive.notify(initialized);
  const success = await observer.request(
    "tools/call",
    executeRequest("positive", { requestId: "offline-delayed-admission" })
      .params,
  );
  assert.equal(success["isError"], false);
  const submission = record(
    JSON.parse(fs.readFileSync(trace, "utf8").trim()) as unknown,
  );
  assert.equal(submission["cwd"], fs.realpathSync(project));
  assert.equal(
    record(submission["clientContext"])["projectDirectory"],
    fs.realpathSync(project),
  );
  assert.equal(submission["requestId"], "offline-delayed-admission");
  assert.equal(
    timings.filter(
      (event) =>
        event["tool"] === "execute_python" && event["stage"] === "write",
    ).length,
    1,
  );
  assert.ok(
    Number(
      timings.find(
        (event) =>
          event["tool"] === "execute_python" && event["stage"] === "response",
      )?.["elapsedMs"],
    ) >= 700,
  );
  fs.rmSync(trace);
  const queued = await observer.request(
    "tools/call",
    executeRequest("queued", { requestId: "offline-queued-admission" }).params,
  );
  const accepted = record(queued["structuredContent"]);
  assert.equal(accepted["status"], "QUEUED");
  assert.equal(accepted["jobId"], "offline-job");
  const settled = await observer.request("tools/call", {
    name: "fmcad_queue_result",
    arguments: { jobId: accepted["jobId"] },
  });
  const terminal = record(record(settled["structuredContent"])["job"]);
  assert.equal(terminal["requestId"], "offline-queued-admission");
  assert.equal(terminal["clientId"], clientId);
  assert.equal(terminal["state"], "succeeded");
  assert.equal(
    fs.readFileSync(trace, "utf8").trim().split("\n").length,
    1,
    "queued work must be submitted once, never replayed",
  );
  await positive.close(false); // Responses are consumed by the production scenario waiter.

  fs.rmSync(trace, { force: true });
  const unbound = startMcpChild(
    [entry, "--routing", "queue", "--client", clientId],
    home,
    config,
    preload,
    t,
  );
  await unbound.request(initialize);
  unbound.notify(initialized);
  const missing = await unbound.request(executeRequest("missing"));
  assert.match(
    text(record(missing["error"])["message"]),
    /MCP_PROJECT_REQUIRED/u,
  );
  assert.equal(
    record(record(missing["error"])["data"])["acceptanceState"],
    "rejected-before-admission",
  );
  await unbound.close();
  assert.equal(
    fs.existsSync(trace),
    false,
    "missing project must not reach admission",
  );

  const foreignChild = startMcpChild(
    [entry, "--routing", "queue", "--client", clientId],
    home,
    config,
    preload,
    t,
  );
  await foreignChild.request(initialize);
  foreignChild.notify(initialized);
  const rejectedForeign = await foreignChild.request(
    executeRequest("foreign", {
      projectDirectory: foreign,
      roots: [{ uri: pathToFileURL(project).href, name: "validated project" }],
    }),
  );
  assert.match(
    text(record(rejectedForeign["error"])["message"]),
    /inside one of the validated MCP roots/u,
  );
  assert.equal(
    record(record(rejectedForeign["error"])["data"])["acceptanceState"],
    "rejected-before-admission",
  );
  await foreignChild.close();
  assert.equal(
    fs.existsSync(trace),
    false,
    "foreign project must not reach admission",
  );
});

test("native adapter timeout keeps retained positive integer bound before dispatch", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2147482648])
    assert.throws(
      () => nativeBackendAdapterScenarios(1, value),
      /positive integer at most 2147482647/u,
    );
  assert.equal(nativeBackendAdapterScenarios(1, 2147482647).length, 1);
});

for (const fault of [
  "none",
  "foreign-owner",
  "foreign-request",
  "missing-settlement",
  "lost-reply",
] as const) {
  test(`actual private addin adapter journals each original request before queue admission: ${fault}`, async (t) => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "native-adapter-receipt-"),
    );
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const owner = {
      runId: "diagnostic-run",
      scenarioId: "adapter",
      clientId: "diagnostic-owner",
    };
    const session = new ScenarioSession(
      backend,
      owner,
      path.join(parent, "adapter"),
    );
    session.report.lifecycle = "read-only";
    session.report.scope = "exclusive-instance";
    session.persist();
    const admitted = new Map<string, { job: Job; payload: ObjectValue }>();
    const methods: string[] = [];
    const queue: DiagnosticQueue = {
      dir: parent,
      auth: { clientId: owner.clientId },
      async register() {
        return undefined;
      },
      async call() {
        throw new Error("No observer RPC requested by this port proof");
      },
      async findRequest() {
        throw new Error(
          "No recovery replay or lookup requested by this port proof",
        );
      },
      async submit(input) {
        const stored = record(
          JSON.parse(
            fs.readFileSync(
              path.join(session.directory, "report.json"),
              "utf8",
            ),
          ) as unknown,
        );
        const requests = stored["requests"];
        assert.ok(Array.isArray(requests));
        const intent = record(requests.at(-1));
        assert.equal(intent["requestId"], input["requestId"]);
        assert.equal(record(stored["owner"])["clientId"], owner.clientId);
        assert.equal(record(intent["intent"])["readOnly"], true);
        assert.deepEqual(record(intent["intent"])["payload"], input["payload"]);
        const payload = record(input["payload"]);
        methods.push(text(payload["method"]));
        const job: Job = {
          id: "job-" + admitted.size,
          requestId: text(input["requestId"]),
          clientId: owner.clientId,
          state: "succeeded",
        };
        admitted.set(job.id, { job, payload });
        return job;
      },
      async wait(id): Promise<Result> {
        const item = admitted.get(id);
        assert.ok(item);
        const scripted = item.payload["method"] === "tools/call";
        if (scripted && fault === "lost-reply")
          throw new Error("lost original reply");
        const job = {
          ...item.job,
          ...(scripted && fault === "foreign-owner"
            ? { clientId: "foreign" }
            : {}),
          ...(scripted && fault === "foreign-request"
            ? { requestId: "foreign" }
            : {}),
        };
        const response =
          item.payload["method"] === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      stdout: "ADAPTER_PROBE_1\n",
                      stderr: "",
                    }),
                  },
                ],
              };
        const value = {
          job,
          stdout: "",
          execution: {
            sdkSettled: !(scripted && fault === "missing-settlement"),
            mayHaveMutated: true,
          },
          rpc: {
            status:
              item.payload["method"] === "notifications/initialized"
                ? 202
                : 200,
            sessionId: "stable-session",
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: item.payload["id"],
              result: response,
            }),
          },
        };
        return value;
      },
      dispose() {},
    };
    const client = diagnosticAddinClient(
      session,
      {
        root,
        config: {
          backend: "addin",
          url: "http://never.invalid",
          timeoutMs: 1000,
        },
        queue,
        buildHash: "test",
      },
      1000,
    );
    t.after(() => disposeDiagnosticClient(root, client));
    const call = () =>
      client.callTool({
        featureType: "script",
        object: {
          readOnly: true,
          script: 'def run(_context: str):\n print("ADAPTER_PROBE_1")',
        },
      });
    if (fault === "none") {
      const value = await call();
      assert.equal(value.failed, false);
      assert.equal(value.text, "ADAPTER_PROBE_1\n");
      assert.equal(value.readOnlyRequested, true);
      assert.equal(value.readOnlyEnforced, false);
      assert.equal(
        session.report.requests.at(-1)?.result?.mayHaveMutated,
        true,
        "Readonly intent must not manufacture no-mutation proof",
      );
    } else {
      await assert.rejects(
        call(),
        /Foreign original|Unsettled|lost original reply/u,
      );
      const before = admitted.size;
      await assert.rejects(call(), /Unsettled/u);
      assert.equal(
        admitted.size,
        before,
        "Uncertain original reply must never be submitted again",
      );
      await session.cleanup();
      assert.equal(session.report.cleanup, "deferred");
    }
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.equal(session.report.requests.length, 3);
  });
}

test("native RPC preparation refuses an existing user broker before constructing a physical adapter", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-existing-broker-"),
  );
  const previous = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = directory;
  t.after(() => {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const queue = path.join(directory, "fmcad", "queue");
  fs.mkdirSync(queue, { recursive: true });
  const filename = path.join(queue, "broker.lock"),
    sentinel = "owned-by-existing-user-broker";
  fs.writeFileSync(filename, sentinel);
  await assert.rejects(
    prepareNativeRpcRecoveryBroker(root, {
      backend: "addin",
      url: "http://never.invalid",
      timeoutMs: 1000,
    }),
    /Drain\/stop the idle broker/u,
  );
  assert.equal(fs.readFileSync(filename, "utf8"), sentinel);
});
