import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { createRequire } from "node:module";
import os from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { FmcadConfiguration } from "../src/api";
import type { McpStdioDependencies } from "../src/entrypoints/mcp-stdio";
import type {
  JsonRpcRequest,
  McpResponse,
} from "../src/composition/library-mcp-protocol";
import type { Client } from "../src/queue-broker-ports";
const load = createRequire(__filename),
  root = process.cwd();
const { McpClient } = load(
  path.join(root, "src/client"),
) as typeof import("../src/composition/library-client");
const { serve } = load(
  path.join(root, "src/queue-broker"),
) as typeof import("../src/queue-broker");
const { request: brokerRequest } = load(
  path.join(root, "src/queue-connection"),
) as typeof import("../src/entrypoints/queue-connection");
const { startStdio } = load(
  path.join(root, "src/mcp-stdio"),
) as typeof import("../src/entrypoints/mcp-stdio");
const config: FmcadConfiguration = {
  backend: "addin",
  routing: "queue",
  url: "http://host",
  timeoutMs: 1000,
  headers: {},
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
};
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((v, k) => object(v)[k], value);
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function port(server: http.Server): number {
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}
function partial<T extends object>(value: {
  [K in keyof T]?: T[K] | undefined;
}): T {
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected fixture access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as T;
}

async function fixtureServer(
  t: import("node:test").TestContext,
  handler: (
    message: unknown,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
) {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      handler(requests.at(-1), req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { url: `http://127.0.0.1:${port(server)}/mcp`, requests };
}

function startHarness({
  QueueClient,
}: {
  QueueClient: NonNullable<McpStdioDependencies["QueueClient"]>;
  controlPost?: (request: JsonRpcRequest) => Promise<McpResponse>;
}) {
  const stdin = new PassThrough();
  let output = "",
    diagnostics = "";
  let controlPosts = 0;
  const running = startStdio(
    ["--routing", "queue", "--project-directory", process.cwd()],
    {
      stdin,
      stdout: new Writable({
        write(chunk: Buffer, _encoding, done) {
          output += chunk.toString();
          done();
        },
      }),
      stderr: new Writable({
        write(chunk: Buffer, _encoding, done) {
          diagnostics += chunk.toString();
          done();
        },
      }),
      loadConfig: () => ({ cfg: config }),
      createFmcad() {
        controlPosts++;
        assert.fail(
          "metadata compatibility must not create a physical application session",
        );
      },
      QueueClient,
    },
  );
  assert(running);
  return {
    stdin,
    closed: running!.closed,
    output: () =>
      output.trim()
        ? output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown)
        : [],
    diagnostics: () => diagnostics,
    controlPosts: () => controlPosts,
  };
}

for (const method of ["resources/list", "resources/templates/list"]) {
  test(`queue-mode ${method} is admitted exactly once through the shared broker`, async () => {
    const catalog =
      method === "resources/list" ? "resources" : "resourceTemplates";
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "offline-test", version: "1" },
      },
    };
    const list = {
      jsonrpc: "2.0",
      id: "list-id",
      method,
      params: { cursor: "next-page" },
    };
    const submissions: unknown[] = [];
    const harness = startHarness({
      QueueClient: class {
        async register() {}
        async submit(input: unknown) {
          submissions.push(input);
          return { id: "resource-job" };
        }
        async wait(jobId: string) {
          assert.equal(jobId, "resource-job");
          return {
            job: { id: jobId, state: "succeeded" },
            rpc: {
              status: 200,
              raw: JSON.stringify({
                jsonrpc: "2.0",
                id: "list-id",
                result: { [catalog]: [], nextCursor: "next-page" },
              }),
            },
          };
        }
        dispose() {}
      },
    });
    harness.stdin.write(JSON.stringify(initialize) + "\n");
    harness.stdin.end(JSON.stringify(list) + "\n");
    await harness.closed;

    assert.equal(harness.controlPosts(), 0);
    assert.equal(submissions.length, 1);
    assert.equal(field(submissions[0], "kind"), "rpc");
    assert.deepEqual(field(submissions[0], "payload"), list);
    assert.equal(field(submissions[0], "cwd"), process.cwd());
    const replies = harness.output();
    assert.equal(replies.length, 2);
    assert.equal(field(replies[0], "result", "protocolVersion"), "2025-11-25");
    assert.deepEqual(field(replies[1], "result", catalog), []);
    assert.equal(field(replies[1], "result", "nextCursor"), "next-page");
    assert.equal(
      field(replies[1], "result", "_meta", "fmcad", "jobId"),
      "resource-job",
    );
  });
}

test("resources/templates/list normalizes only a matching JSON-RPC method-not-found response", async () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  };
  const list = {
    jsonrpc: "2.0",
    id: "templates-id",
    method: "resources/templates/list",
  };
  let submits = 0;
  const harness = startHarness({
    QueueClient: class {
      async register() {}
      async submit(input: unknown) {
        submits++;
        assert.deepEqual(field(input, "payload"), list);
        return { id: "templates-job" };
      }
      async wait() {
        return {
          job: { id: "templates-job", state: "succeeded" },
          rpc: {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: list.id,
              error: {
                code: -32601,
                message: "Method not found: resources/templates/list",
              },
            }),
          },
        };
      }
      dispose() {}
    },
  });
  harness.stdin.write(JSON.stringify(initialize) + "\n");
  harness.stdin.end(JSON.stringify(list) + "\n");
  await harness.closed;

  const replies = harness.output();
  assert.equal(field(replies[0], "result", "protocolVersion"), "2025-11-25");
  assert.deepEqual(field(replies[1], "result", "resourceTemplates"), []);
  assert.equal(
    field(replies[1], "result", "_meta", "fmcad", "jobId"),
    "templates-job",
  );
  assert.equal(
    submits,
    1,
    "the upstream request is admitted once, without retry or fallback",
  );
});

for (const scenario of [
  {
    name: "non-method-not-found error",
    method: "resources/templates/list",
    reply: (id: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "authorization failed" },
    }),
  },
  {
    name: "mismatched response id",
    method: "resources/templates/list",
    reply: () => ({
      jsonrpc: "2.0",
      id: "wrong-id",
      error: { code: -32601, message: "Method not found" },
    }),
  },
  {
    name: "resources/list method-not-found",
    method: "resources/list",
    reply: (id: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    }),
  },
]) {
  test(`${scenario.name} is not normalized`, async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    };
    const list = { jsonrpc: "2.0", id: "catalog-id", method: scenario.method };
    let submits = 0;
    const harness = startHarness({
      QueueClient: class {
        async register() {}
        async submit(input: unknown) {
          submits++;
          assert.equal(field(input, "payload", "method"), scenario.method);
          return { id: "catalog-job" };
        }
        async wait() {
          return {
            job: { id: "catalog-job", state: "succeeded" },
            rpc: {
              status: 200,
              raw: JSON.stringify(scenario.reply("catalog-id")),
            },
          };
        }
        dispose() {}
      },
    });
    harness.stdin.write(JSON.stringify(initialize) + "\n");
    harness.stdin.end(JSON.stringify(list) + "\n");
    await harness.closed;
    const replies = harness.output();
    assert.equal(replies.length, 2);
    assert.equal(field(replies[1], "id"), "catalog-id");
    assert.equal(field(replies[1], "result"), undefined);
    assert.ok(
      field(replies[1], "error"),
      "upstream failure must remain a failure",
    );
    assert.equal(submits, 1);
  });
}

for (const method of ["resources/list", "resources/templates/list"]) {
  test(`public McpClient cannot dispatch ${method} without a broker turn`, async (t) => {
    const f = await fixtureServer(t, () =>
      assert.fail("public compatibility client must not reach HTTP"),
    );
    const client = new McpClient({
      url: f.url,
      routing: "queue",
      timeoutMs: 1000,
      headers: { "X-Offline": "fixture" },
    });
    const payload = {
      jsonrpc: "2.0",
      id: "catalog",
      method,
      params: { cursor: "next" },
    };
    await assert.rejects(client._post(payload), { code: "QUEUE_REQUIRED" });
    await assert.rejects(client.controlPost(payload), {
      code: "QUEUE_REQUIRED",
    });
    assert.equal(Reflect.get(client, "_transportPost"), undefined);
    assert.equal(f.requests.length, 0);
  });
}

test("actual McpClient denies resources/read without transport or header changes", async () => {
  const headers = { "MCP-Protocol-Version": "old" };
  const client = new McpClient({
    url: "http://127.0.0.1:1/mcp",
    routing: "queue",
    headers,
  });
  await assert.rejects(
    client.controlPost(
      { jsonrpc: "2.0", id: 42, method: "resources/read" },
      "offline-session",
      "2025-11-25",
    ),
    { code: "CONTROL_METHOD_DENIED" },
  );
  assert.deepEqual(client.server.headers, headers);
  assert.equal(Reflect.get(client, "_transportPost"), undefined);
});

test("queue-mode resources/read fails locally before admission or physical dispatch", async (t) => {
  t.after(
    (
      load(
        path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void
    )(),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-broker-"));
  let physicalCalls = 0;
  let startupProbes = 0;
  const broker = await serve(
    { backend: "addin", timeoutMs: 1000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () =>
        partial<Client>({
          // Match the deliberately minimal predecessor fixture. Optional
          // preparation hooks are absent; other unexpected reads still fail.
          prepareCallTool: undefined,
          prepareUiGuardedScript: undefined,
          prepareListTools: undefined,
          executeUiGuardedScript: undefined,
          withRequest: undefined,
          reqOpts: undefined,
          negotiatedProtocolVersion: undefined,
          serverInfo: undefined,
          capabilities: {},
          server: { timeoutMs: 1000 },
          _parse: JSON.parse,
          async _post() {
            physicalCalls++;
            assert.fail(
              "unsupported resource reads must never reach physical transport",
            );
          },
          async callTool() {
            startupProbes++;
            assert.equal(
              startupProbes,
              1,
              "only the isolated broker startup may probe the fake backend",
            );
            return {
              failed: false,
              text:
                "FMCAD_QUEUE_INSTANCE " +
                JSON.stringify({
                  pid: 999,
                  birth: "offline:999",
                  version: "fixture",
                  activeCommand: "SelectCommand",
                  documents: [],
                }),
            };
          },
        }),
    },
  );
  t.after(async () => {
    await broker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const auth = {
    clientId: "offline-resource-read",
    clientToken: "offline-token",
  };
  const request = {
    jsonrpc: "2.0",
    id: 42,
    method: "resources/read",
    params: { uri: "fusion://document/item" },
  };
  const submissions: unknown[] = [];
  let rejected = 0;
  const harness = startHarness({
    controlPost: async () =>
      assert.fail("resources/read must not use the metadata/control transport"),
    QueueClient: class {
      async register() {
        await brokerRequest(dir, { action: "register", ...auth });
      }
      async submit(input: unknown) {
        submissions.push(input);
        try {
          return await brokerRequest(dir, {
            action: "submit",
            auth,
            request: input,
          });
        } catch (error) {
          assert.equal(field(error, "code"), "unsupported_queue_route");
          rejected++;
          throw error;
        }
      }
      async wait() {
        assert.fail("a rejected request has no admitted job to wait for");
      }
    },
  });
  harness.stdin.end(JSON.stringify(request) + "\n");
  await harness.closed;

  assert.equal(harness.controlPosts(), 0);
  assert.equal(submissions.length, 0);
  assert.equal(rejected, 0);
  assert.equal(physicalCalls, 0);
  assert.equal(
    startupProbes,
    1,
    "resource-read rejection must not trigger any additional backend probe",
  );
  assert.equal(broker.status()["active"], null);
  assert.deepEqual(
    broker.status()["jobs"],
    {},
    "validation rejection must not create an admitted job",
  );
  assert.equal(harness.output().length, 1);
  const [reply] = harness.output();
  assert.equal(field(reply, "id"), request.id);
  assert.equal(field(reply, "error", "code"), -32601);
  assert.match(text(field(reply, "error", "message")), /Method not found/);
  assert.equal(
    field(reply, "result"),
    undefined,
    "rejection must not fabricate contents or a successful receipt",
  );
});

test("unsupported resources/subscribe request and notification fail closed; a later ping works in the same process", async () => {
  let submissions = 0;
  const harness = startHarness({
    controlPost: async (request) => {
      assert.equal(request.method, "ping");
      return {
        status: 200,
        raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }),
      };
    },
    QueueClient: class {
      async register() {}
      async submit() {
        submissions++;
        throw Object.assign(new Error("route is not supported"), {
          code: "unsupported_queue_route",
        });
      }
    },
  });
  harness.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "unsupported",
      method: "resources/subscribe",
    }) + "\n",
  );
  harness.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "resources/subscribe" }) + "\n",
  );
  harness.stdin.end(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n",
  );
  await harness.closed;

  const replies = harness.output();
  assert.equal(replies.length, 2, "notification has no JSON-RPC response");
  assert.equal(field(replies[0], "id"), "unsupported");
  assert.equal(field(replies[0], "error", "code"), -32601);
  assert.match(text(field(replies[0], "error", "message")), /Method not found/);
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(harness.diagnostics(), "");
  assert.equal(submissions, 0, "unsupported methods never reach SDK admission");
  assert.equal(harness.controlPosts(), 0, "the valid ping is local");
});

test(
  "CLI child reports stopped broker without direct fallback and handles local requests",
  { timeout: 10000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-child-"));
    const seen: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const message = JSON.parse(body);
        seen.push({
          method: message.method,
          session: req.headers["mcp-session-id"],
          version: req.headers["mcp-protocol-version"],
        });
        res.setHeader("Content-Type", "application/json");
        if (message.method === "initialize") {
          res.setHeader("Mcp-Session-Id", "child-session");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { resources: {} },
              },
            }),
          );
        } else if (message.method === "resources/list") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "offline catalog unavailable" },
            }),
          );
        } else {
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }),
          );
        }
      });
    });
    // Cleanup is registered before async server startup can fail.
    // eslint-disable-next-line prefer-const
    let child: ChildProcessWithoutNullStreams | undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "close");
        child.kill();
        await stopped;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const fixtureConfig = path.join(dir, "config.json");
    fs.writeFileSync(
      fixtureConfig,
      JSON.stringify({
        backend: "mcp",
        routing: "queue",
        url: `http://127.0.0.1:${port(server)}/mcp`,
        transport: "node",
        timeoutMs: 1000,
        queue: { autoStart: false, autoRecover: false },
      }),
    );
    // This scenario owns broker admission, not the process-global companion port.
    // Observe the actual default startup hook without racing other test processes
    // for port 4748 or leaving a detached web service after this child's EOF.
    const companionTrace = path.join(dir, "companion.jsonl");
    const companionPreload = path.join(dir, "companion.cjs");
    fs.writeFileSync(
      companionPreload,
      `
    const fs = require('node:fs'), Module = require('node:module'), original = Module._load;
    Module._load = function(name, ...args) {
      if (name === '../composition/control-center.js') return {
        async ensureControlCenter(port) { fs.appendFileSync(${JSON.stringify(companionTrace)}, JSON.stringify({ port }) + '\\n'); }
      };
      return original.call(this, name, ...args);
    };
  `,
    );
    child = spawn(
      process.execPath,
      [
        "--require",
        companionPreload,
        path.join(root, "bin/fmcad-mcp.js"),
        "--project-directory",
        dir,
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env["PATH"],
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          FMCAD_CONFIG: fixtureConfig,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const lines = readline
      .createInterface({ input: child.stdout })
      [Symbol.asyncIterator]();
    async function exchange(message: unknown) {
      assert(child);
      child.stdin.write(JSON.stringify(message) + "\n");
      const line = await lines.next();
      assert.equal(line.done, false, diagnostics);
      return JSON.parse(line.value);
    }
    const initialized = await exchange({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "offline-child", version: "1" },
      },
    });
    assert.deepEqual(field(initialized, "result", "capabilities"), {
      tools: {},
    });
    const resourceReply = await exchange({
      jsonrpc: "2.0",
      id: "catalog-error",
      method: "resources/list",
    });
    assert.equal(field(resourceReply, "id"), "catalog-error");
    assert.equal(field(resourceReply, "error", "code"), -32000);
    assert.match(
      text(field(resourceReply, "error", "message")),
      /QUEUE_NOT_RUNNING|no direct fallback/i,
    );
    assert.deepEqual(
      await exchange({ jsonrpc: "2.0", id: 0, method: "ping" }),
      { jsonrpc: "2.0", id: 0, result: {} },
    );
    assert.equal(
      child.exitCode,
      null,
      "catalog error must not terminate the child before EOF",
    );
    assert.deepEqual(
      seen,
      [],
      "local metadata and failed broker admission never open a physical endpoint",
    );
    child.stdin.end();
    assert.deepEqual(await closed, [0, null], diagnostics);
    assert.equal(
      (await lines.next()).done,
      true,
      "no extra JSON-RPC replies on EOF",
    );
    assert.equal(diagnostics, "");
    assert.deepEqual(
      fs
        .readFileSync(companionTrace, "utf8")
        .trim()
        .split("\n")
        .map((value) => JSON.parse(value) as unknown),
      [{ port: 4748 }],
    );
  },
);
