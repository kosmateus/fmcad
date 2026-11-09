import type {
  Dependencies,
  ObjectValue,
  Spawn,
} from "../packages/node-adapters/src/fusion-transport/contracts";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { at, record, text, number } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/fusion-transport.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const { createBrokerTransport } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const { postHttp } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/http",
) as typeof import("../packages/node-adapters/src/fusion-transport/http");
const { postCurl } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/curl",
) as typeof import("../packages/node-adapters/src/fusion-transport/curl");
const { parse } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/contracts",
) as typeof import("../packages/node-adapters/src/fusion-transport/contracts");

// The existing curl double owns its streams and signal observation. ChildProcess-only
// members are intentionally unavailable; the one cast stays at the spawn port.
class FakeCurlChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): void {
    this.killed = signal;
  }
}
const dependencies: Dependencies = {
  version: "test",
  requestTimeout: (server) => server.timeoutMs ?? 1000,
  bridgeSource: () => "_BRIDGE_REQUEST = {}\ndef run(context): pass",
};

async function endpoint(
  t: TestContext,
  handler: (
    payload: ObjectValue,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ordinal: number,
  ) => unknown,
) {
  const requests: {
    payload: ObjectValue;
    headers: http.IncomingHttpHeaders;
  }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      requests.push({ payload, headers: req.headers });
      handler(payload, req, res, requests.length);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${number(at(server.address(), "port"))}/isolated`,
    requests,
  };
}

function handshake(payload: ObjectValue, res: http.ServerResponse) {
  if (payload["method"] === "initialize") {
    res.setHeader("Mcp-Session-Id", "test-session");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload["id"],
        result: {
          protocolVersion: at(payload, "params", "protocolVersion"),
          serverInfo: { name: "fake", version: "1", secret: "hidden" },
        },
      }),
    );
    return true;
  }
  if (payload["method"] === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return true;
  }
  return false;
}

for (const sse of [false, true])
  test(`broker transport maps ${sse ? "SSE" : "JSON"} without changing native data`, async (t) => {
    const receipt = {
      success: true,
      stdout: "native stdout",
      stderr: "native stderr",
      receipt: { token: "native-receipt", ordinal: 9 },
    };
    const f = await endpoint(t, (payload, req, res) => {
      if (handshake(payload, res)) return;
      assert.equal(payload["method"], "tools/call");
      assert.equal(req.headers["mcp-session-id"], "test-session");
      assert.equal(req.headers["mcp-protocol-version"], "2024-11-05");
      const result = {
        jsonrpc: "2.0",
        id: 2,
        result: {
          structuredContent: receipt,
          content: [{ type: "text", text: "native text" }],
        },
      };
      res.end(
        sse
          ? `: keepalive\n\nevent: message\ndata: ${JSON.stringify(result)}\n\ndata: {"jsonrpc":"2.0","method":"notice"}\n\n`
          : JSON.stringify(result),
      );
    });
    const headers = { Authorization: "Bearer isolated-fake-auth" };
    const client = createBrokerTransport(
      { url: f.url, timeoutMs: 1000, headers },
      dependencies,
    );
    headers.Authorization = "changed-after-construction";
    const result = await client.callTool({ readOnly: false }, "native");
    assert.deepEqual(result, {
      text: "native text",
      failed: false,
      data: receipt,
    });
    assert.deepEqual(client.serverInfo, { name: "fake", version: "1" });
    assert.equal(f.requests.length, 3);
    assert.ok(
      f.requests.every(
        (request) =>
          request.headers.authorization === "Bearer isolated-fake-auth",
      ),
    );
  });

test("concurrent discovery headers are immutable and scoped per request", async (t) => {
  const f = await endpoint(t, (payload, req, res) => {
    setTimeout(() => res.end("{}"), payload["id"] === 1 ? 20 : 1);
  });
  const headers = {
    "MCP-Protocol-Version": "configured",
    Authorization: "Bearer isolated",
  };
  const client = createBrokerTransport(
    { url: f.url, timeoutMs: 1000, headers },
    dependencies,
  );
  const before = JSON.stringify(client.server);
  await Promise.all([
    client.controlPost(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      "one",
      "2025-03-26",
    ),
    client.controlPost(
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
      "two",
      "2025-11-25",
    ),
  ]);
  assert.equal(JSON.stringify(client.server), before);
  assert.deepEqual(headers, {
    "MCP-Protocol-Version": "configured",
    Authorization: "Bearer isolated",
  });
  assert.deepEqual(
    f.requests.map((value) => [
      value.headers["mcp-session-id"],
      value.headers["mcp-protocol-version"],
    ]),
    [
      ["one", "2025-03-26"],
      ["two", "2025-11-25"],
    ],
  );
});

test("broker async-local overrides isolate overlapping requests and restore nested scopes", async (t) => {
  const f = await endpoint(t, (payload, req, res) =>
    setTimeout(() => res.end("{}"), payload["id"] === 1 ? 15 : 1),
  );
  const client = createBrokerTransport(
    { url: f.url, timeoutMs: 1000, headers: { "X-Scope": "base" } },
    dependencies,
  );
  const before = JSON.stringify(client.server);
  const firstHeaders = { "X-Scope": "first" };
  const first = client.withRequest(
    { timeoutMs: 100, headers: firstHeaders },
    async () => {
      await client._post({ jsonrpc: "2.0", id: 1, method: "ping" });
      await client.withRequest({ headers: { "X-Scope": "nested" } }, () =>
        client._post({ jsonrpc: "2.0", id: 3, method: "ping" }),
      );
      await client._post({ jsonrpc: "2.0", id: 4, method: "ping" });
    },
  );
  firstHeaders["X-Scope"] = "changed";
  await Promise.all([
    first,
    client.withRequest({ headers: { "X-Scope": "second" } }, () =>
      client._post({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ),
  ]);
  await client._post({ jsonrpc: "2.0", id: 5, method: "ping" });
  assert.deepEqual(
    f.requests.map((value) => [value.payload["id"], value.headers["x-scope"]]),
    [
      [1, "first"],
      [2, "second"],
      [3, "nested"],
      [4, "first"],
      [5, "base"],
    ],
  );
  assert.equal(JSON.stringify(client.server), before);
});

test("raw request scope does not inherit another session protocol or widen an outer timeout", async (t) => {
  const f = await endpoint(t, (payload, req, res) => {
    if (payload["id"] === "slow") {
      res.writeHead(200);
      const timer = setInterval(() => res.write("stream"), 2);
      res.on("close", () => clearInterval(timer));
    } else res.end("{}");
  });
  const client = createBrokerTransport(
    {
      url: f.url,
      timeoutMs: 1000,
      headers: { "MCP-Protocol-Version": "configured-old" },
    },
    dependencies,
  );
  client.negotiatedProtocolVersion = "2025-06-18";
  await client.withRequest({ headers: {}, protocolVersion: undefined }, () =>
    client._post({ method: "ping", id: "raw" }),
  );
  assert.equal(
    present(f.requests[0]).headers["mcp-protocol-version"],
    undefined,
  );
  await assert.rejects(
    client.withRequest({ timeoutMs: 25 }, () =>
      client.withRequest({ timeoutMs: 1000 }, () =>
        client._post({ method: "ping", id: "slow" }),
      ),
    ),
    { code: "ETIMEDOUT" },
  );
});

test("public facades cannot post SDK/read/probe/UI/raw or discovery through physical transports", async (t) => {
  const f = await endpoint(t, () =>
    assert.fail("public SDK calls must not reach HTTP"),
  );
  const publicClient = runtimeRequire(
    "../src/client",
  ) as typeof import("../src/composition/library-client");
  const { AddinClient } = runtimeRequire(
    "../src/addin-client",
  ) as typeof import("../src/composition/library-addin-client");
  assert.equal(record(publicClient)["authorizeBrokerClient"], undefined);
  assert.equal(
    record(
      runtimeRequire("../packages/node-adapters/dist/fusion-transport/mcp"),
    )["CONTROL_METHODS"],
    undefined,
    "the discovery allowlist cannot be mutated by a consumer",
  );
  assert.equal(
    record(runtimeRequire("../src/curl-transport"))["postWithCurl"],
    undefined,
  );
  for (const Client of [publicClient.McpClient, AddinClient]) {
    const client = new Client({
      url: f.url,
      routing: "queue",
      timeoutMs: 1000,
    });
    assert.equal(record(client)["_transportPost"], undefined);
    for (const method of ["tools/call", "resources/read", "custom/raw"]) {
      await assert.rejects(client._post({ jsonrpc: "2.0", id: 1, method }), {
        code: "QUEUE_REQUIRED",
      });
      await assert.rejects(
        client.controlPost({ jsonrpc: "2.0", id: 1, method }),
        { code: "CONTROL_METHOD_DENIED" },
      );
    }
    await assert.rejects(
      client.callTool({ queryType: "document" }, "fusion_mcp_read"),
      { code: "QUEUE_REQUIRED" },
    );
    if ("executeUiGuardedScript" in client) {
      const invoke = client.executeUiGuardedScript as (
        script: string,
      ) => Promise<unknown>;
      await assert.rejects(invoke.call(client, "pass"), {
        code: "QUEUE_REQUIRED",
      });
    }
  }
  assert.equal(f.requests.length, 0);
});

test("worker job environment does not grant public physical transport capability", async (t) => {
  const f = await endpoint(t, (payload, req, res) => res.end("{}"));
  const { McpClient } = runtimeRequire(
    "../src/client",
  ) as typeof import("../src/composition/library-client");
  const previous = process.env["FMCAD_QUEUE_WORKER_JOB"];
  process.env["FMCAD_QUEUE_WORKER_JOB"] = "forged-job-without-capability";
  t.after(() => {
    if (previous === undefined) delete process.env["FMCAD_QUEUE_WORKER_JOB"];
    else process.env["FMCAD_QUEUE_WORKER_JOB"] = previous;
  });
  const client = new McpClient({
    url: f.url,
    timeoutMs: 1000,
    routing: "queue",
  });
  for (const method of [
    "initialize",
    "ping",
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "tools/call",
    "resources/read",
    "custom/raw",
  ]) {
    await assert.rejects(client._post({ jsonrpc: "2.0", id: 1, method }), {
      code: "QUEUE_REQUIRED",
    });
  }
  await assert.rejects(client.controlPost({ method: "ping", id: 2 }), {
    code: "QUEUE_REQUIRED",
  });
  await assert.rejects(client.listTools(), { code: "QUEUE_REQUIRED" });
  await client.close();
  assert.equal(f.requests.length, 0);
});

for (const scenario of [
  "disconnect",
  "native-error",
  "wrong-id",
  "wrong-session",
  "wrong-protocol",
  "wrong-protocol-header",
  "http-error",
]) {
  test(`uncertain ${scenario} never replays or falls back`, async (t) => {
    let mutations = 0,
      curlCalls = 0;
    const f = await endpoint(t, (payload, req, res) => {
      if (scenario === "wrong-protocol" && payload["method"] === "initialize") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "incompatible" },
          }),
        );
        return;
      }
      if (handshake(payload, res)) return;
      mutations++;
      if (scenario === "disconnect") {
        res.writeHead(200);
        res.write("{");
        res.destroy();
        return;
      }
      if (scenario === "http-error") {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      if (scenario === "wrong-session")
        res.setHeader("Mcp-Session-Id", "other-session");
      if (scenario === "wrong-protocol-header")
        res.setHeader("MCP-Protocol-Version", "incompatible");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: scenario === "wrong-id" ? 99 : 2,
          ...(scenario === "native-error"
            ? {
                error: {
                  code: -32000,
                  message: "native failure",
                  data: { receipt: "native" },
                },
              }
            : { result: {} }),
        }),
      );
    });
    const client = createBrokerTransport(
      { url: f.url, timeoutMs: 1000 },
      {
        ...dependencies,
        spawn: () => {
          curlCalls++;
          throw new Error("unexpected curl");
        },
      },
    );
    await assert.rejects(client.callTool({}, "mutate"), (error) => {
      assert.match(text(at(error, "message")), /unknown.*inspect before retry/);
      if (scenario === "native-error")
        assert.deepEqual(at(error, "nativeError"), {
          code: -32000,
          message: "native failure",
          data: { receipt: "native" },
        });
      return true;
    });
    assert.equal(mutations, scenario === "wrong-protocol" ? 0 : 1);
    assert.equal(curlCalls, 0);
  });
}

test("HTTP absolute timeout bounds continuous streaming; byte bound and abort clean sockets", async (t) => {
  const f = await endpoint(t, (payload, req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write("streaming"), 2);
    res.on("close", () => clearInterval(timer));
  });
  const payload = { jsonrpc: "2.0", id: 1, method: "ping" };
  await assert.rejects(postHttp({ url: f.url, timeoutMs: 35 }, payload, {}), {
    code: "ETIMEDOUT",
  });
  await assert.rejects(
    postHttp({ url: f.url, timeoutMs: 1000, maxBuffer: 128 }, payload, {}),
    { code: "ENOBUFS" },
  );
  const controller = new AbortController();
  const pending = postHttp({ url: f.url, timeoutMs: 1000 }, payload, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "ABORT_ERR" });
});

function fakeCurl(action: (child: FakeCurlChild) => unknown) {
  const calls: {
    file: string;
    args: readonly string[];
    options: Parameters<Spawn>[2];
    child: FakeCurlChild;
    config?: string;
  }[] = [];
  const spawn: Spawn = (file, args, options) => {
    const child = new FakeCurlChild();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.killed = signal;
    };
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk) => chunks.push(chunk));
    child.stdin.on("finish", () => {
      present(calls.at(-1)).config = Buffer.concat(chunks).toString();
      action(child);
    });
    calls.push({ file, args, options, child });
    return child as unknown as ReturnType<Spawn>;
  };
  return { calls, spawn };
}

test("curl bounded fake output, auth on stdin, no retry/redirect/proxy or fallback", async () => {
  const f = fakeCurl((child) => {
    child.stdout.write(
      "HTTP/1.1 200 OK\r\nMcp-Session-Id: sid\r\nContent-Length: 2\r\n\r\n{}",
    );
    child.emit("close", 0);
  });
  const server = {
    url: "http://127.0.0.1:1/fake?private=endpoint",
    timeoutMs: 1000,
    headers: { Authorization: "Bearer private-auth" },
  };
  assert.deepEqual(
    await postCurl(
      server,
      { code: "private-script" },
      { sessionId: "sid" },
      f.spawn,
    ),
    { status: 200, sessionId: "sid", raw: "{}" },
  );
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(
    present(f.calls[0]).args.join(" "),
    /private-|--retry|--location/,
  );
  assert.match(present(present(f.calls[0]).config), /private-auth/);
  assert.equal(present(f.calls[0]).options.shell, false);
  for (const stream of ["stdout", "stderr"] as const) {
    const overflow = fakeCurl((child) =>
      child[stream].write(Buffer.alloc(129)),
    );
    await assert.rejects(
      postCurl({ ...server, maxBuffer: 128 }, {}, {}, overflow.spawn),
      { code: "ENOBUFS" },
    );
    assert.equal(present(overflow.calls[0]).child.killed, "SIGKILL");
    assert.equal(overflow.calls.length, 1);
  }
});

test("curl exit/protocol/session errors stay unknown without retry or secret diagnostics", async () => {
  for (const action of [
    (child: FakeCurlChild) => child.emit("close", 28),
    (child: FakeCurlChild) => child.emit("error", new Error("private-auth")),
    (child: FakeCurlChild) => {
      child.stdout.write("HTTP/1.1 200 OK\r\nMcp-Session-Id: other\r\n\r\n{}");
      child.emit("close", 0);
    },
    (child: FakeCurlChild) => {
      child.stdout.write("broken private-auth");
      child.emit("close", 0);
    },
    (child: FakeCurlChild) => {
      child.stdout.write(
        "HTTP/1.1 200 OK\r\nMCP-Protocol-Version: incompatible\r\n\r\n{}",
      );
      child.emit("close", 0);
    },
  ]) {
    const f = fakeCurl(action);
    await assert.rejects(
      postCurl(
        { url: "http://localhost:1", timeoutMs: 100 },
        {},
        { sessionId: "sid", protocolVersion: "2025-03-26" },
        f.spawn,
      ),
      (error) => {
        assert.match(text(at(error, "message")), /outcome unknown.*inspect/);
        assert.doesNotMatch(text(at(error, "message")), /private-auth/);
        return true;
      },
    );
    assert.equal(f.calls.length, 1);
  }
});

test("SSE supports multiline JSON, ignores comments and trailing notifications", () => {
  assert.deepEqual(
    parse(
      ': heartbeat\n\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{}}\n\ndata: {"method":"notice"}\n\n',
    ),
    { jsonrpc: "2.0", id: 2, result: {} },
  );
});

test("malformed JSON/SSE diagnostics never include backend snippets", () => {
  for (const raw of [
    "private-credential-is-not-json",
    "data: private-credential-is-not-json\n\n",
  ]) {
    assert.throws(
      () => parse(raw),
      (error) => {
        assert.equal(at(error, "code"), "EPROTO");
        assert.doesNotMatch(text(at(error, "message")), /private-credential/);
        return true;
      },
    );
  }
});

test("unsupported addin capabilities reject before network and cannot trigger fallback", async () => {
  let calls = 0;
  const client = createBrokerTransport(
    { backend: "addin", url: "http://127.0.0.1:1", timeoutMs: 100 },
    dependencies,
  );
  client._post = () => {
    calls++;
    throw new Error("unexpected network");
  };
  for (const [tool, request] of [
    ["fusion_mcp_read", { queryType: "licensing" }],
    ["fusion_mcp_read", { queryType: "document", operation: "recent" }],
    ["fusion_mcp_update", { featureType: "undo" }],
    ["fusion_mcp_update", { featureType: "redo" }],
    ["fusion_mcp_electronics_read", {}],
  ] as const) {
    await assert.rejects(client.callTool(request, tool), /fallback/i);
  }
  assert.equal(calls, 0);
  assert.equal(at(client, "capabilities", "readOnlyEnforced"), false);
  assert.deepEqual(at(client, "capabilities", "unsupported"), [
    "licensing",
    "document recent",
    "undo",
    "redo",
    "electronics",
  ]);
});

test("failed addin initialization is cached rather than reconnecting on a later call", async () => {
  const client = createBrokerTransport(
    { backend: "addin", url: "http://127.0.0.1:1", timeoutMs: 100 },
    dependencies,
  );
  let calls = 0;
  client._post = async () => {
    calls++;
    throw new Error("initial connection lost; outcome unknown");
  };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      client.callTool({
        featureType: "script",
        object: { script: "def run(context): pass" },
      }),
      /unknown/,
    );
  assert.equal(calls, 1);
});

test("invalid bounded configuration fails before spawning curl or opening an HTTP socket", async () => {
  const f = fakeCurl(() => assert.fail("invalid configuration must not spawn"));
  for (const config of [
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxBuffer: 0 },
    { maxBuffer: 33554433 },
    { headers: { Authorization: "fake\r\nInjected: value" } },
  ]) {
    const server = { url: "http://127.0.0.1:1", timeoutMs: 100, ...config };
    await assert.rejects(postCurl(server, {}, {}, f.spawn));
    await assert.rejects(postHttp(server, {}, {}));
  }
  assert.equal(f.calls.length, 0);
});
