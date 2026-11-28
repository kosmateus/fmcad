import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import { createRequire } from "node:module";
import type { FmcadConfiguration } from "../src/api";
import type { McpStdioDependencies } from "../src/entrypoints/mcp-stdio";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
} from "../src/composition/library-mcp-protocol";
const runtime = createRequire(__filename)(
  path.join(process.cwd(), "src/mcp-stdio"),
) as typeof import("../src/entrypoints/mcp-stdio");
const { responseMessages, createForwarder } = runtime;
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((v, k) => object(v)[k], value);
}
function config(value: Partial<FmcadConfiguration>): FmcadConfiguration {
  return {
    backend: "addin",
    routing: "queue",
    url: "http://host",
    headers: {},
    timeoutMs: 5000,
    tool: "execute_python",
    transport: "node",
    protocolVersion: "2025-06-18",
    queue: { autoStart: false },
    controlCenter: { port: 4748 },
    ...value,
  };
}
function startStdio(
  args: string[],
  deps: Omit<McpStdioDependencies, "stderr" | "stdout"> & {
    stderr?: { write(text: string): unknown };
    stdout?: { write(text: string): unknown };
  },
) {
  const { stderr, stdout, ...rest } = deps;
  return runtime.startStdio(args, {
    ...rest,
    ...(stdout
      ? {
          stdout:
            stdout instanceof Writable
              ? stdout
              : new Writable({
                  write(chunk: Buffer, _encoding, done) {
                    stdout.write(chunk.toString());
                    done();
                  },
                }),
        }
      : {}),
    ...(stderr
      ? {
          stderr: new Writable({
            write(chunk: Buffer, _encoding, done) {
              stderr.write(chunk.toString());
              done();
            },
          }),
        }
      : {}),
  });
}
function launch(...args: Parameters<typeof startStdio>) {
  const running = startStdio(...args);
  assert(running);
  return running;
}

test("stdio help and invalid arguments do not load config or start a client", () => {
  let output = "";
  const deps = {
    loadConfig: () => assert.fail("must not load config"),
    createTelemetry: () => assert.fail("must not start telemetry"),
    createFmcad: () =>
      assert.fail("local metadata must not construct an application session"),
    stdout: {
      write: (text: string) => {
        output += text;
      },
    },
  };
  startStdio(["--help"], deps);
  assert.match(output, /Usage: fmcad-mcp/);
  assert.match(output, /default: addin/);
  for (const args of [
    ["--backend"],
    ["--backend", "auto"],
    ["--unknown"],
    ["mcp"],
    ["--backend", ""],
    ["--help", "--backend", "invalid"],
  ]) {
    assert.throws(() => startStdio(args, deps));
  }
});

test("stdio initialize and tools/list identify the local fmcad application without contacting Fusion", async () => {
  const stdin = new PassThrough();
  let output = "",
    stderr = "";
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "local-smoke", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const { closed } = launch([], {
    stdin,
    stdout: {
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    loadConfig: () =>
      assert.fail("local discovery must not load Fusion config"),
    QueueClient: class {
      constructor() {
        assert.fail("local discovery must not create a broker client");
      }
    },
  });

  stdin.end(
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
  );
  await closed;

  assert.equal(stderr, "");
  const replies: unknown[] = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  assert.equal(replies.length, 2);
  assert.equal(field(replies[0], "result", "serverInfo", "name"), "fmcad");
  assert.equal(field(replies[0], "result", "protocolVersion"), "2025-11-25");
  assert.ok(
    (field(replies[1], "result", "tools") as unknown[]).some(
      (tool) => field(tool, "name") === "fmcad_execute",
    ),
  );
  assert.ok(
    (field(replies[1], "result", "tools") as unknown[]).some(
      (tool) => field(tool, "name") === "execute_python",
    ),
  );
});

test("telemetry composition failure is diagnostic-only for local MCP ping", async () => {
  const stdin = new PassThrough();
  let output = "",
    stderr = "";
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };
  const { closed } = launch([], {
    stdin,
    stdout: {
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    createTelemetry() {
      throw new Error("/private/history/store.sqlite");
    },
  });

  stdin.end(JSON.stringify(request) + "\n");
  await closed;

  assert.deepEqual(JSON.parse(output), { jsonrpc: "2.0", id: 1, result: {} });
  assert.match(stderr, /passive telemetry unavailable; MCP remains available/);
  assert.doesNotMatch(stderr, /private\/history\/store\.sqlite/);
});

test("stdio ping stays local regardless of the selected physical backend", async () => {
  for (const [args, backend] of [
    [[], "addin"],
    [["--backend", "addin"], "addin"],
    [["--backend", "mcp"], "mcp"],
  ] as [string[], "addin" | "mcp"][]) {
    const stdin = new PassThrough();
    const cfg: Partial<FmcadConfiguration> = {
      backend,
      url: `http://127.0.0.1:${backend === "mcp" ? 27182 : 8765}/mcp`,
      transport: "windows-curl",
      curlPath: "/mnt/c/Windows/System32/curl.exe",
      headers: { Host: "127.0.0.1:27182" },
    };
    const request = { jsonrpc: "2.0", id: 1, method: "ping" };
    const reply = { jsonrpc: "2.0", id: 1, result: {} };
    let output = "",
      calls = 0;
    const configReads: unknown[] = [];
    const { closed } = launch(args, {
      stdin,
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: { write: (text) => assert.fail(text) },
      loadConfig: (opts) => {
        configReads.push(opts);
        return { cfg: config(cfg) };
      },
      createFmcad: () => {
        calls++;
        assert.fail("local ping must not construct an application session");
      },
    });
    stdin.end(JSON.stringify(request) + "\n");
    await closed;
    assert.equal(calls, 0);
    assert.deepEqual(
      configReads,
      [],
      "metadata must not discover configuration",
    );
    assert.deepEqual(JSON.parse(output), reply);
  }
});

test("stdio size diagnostics report only bounded metadata and preserve exact response frames", async () => {
  let output = "",
    stderr = "";
  const smallRequest = { jsonrpc: "2.0", id: 1, method: "resources/list" };
  const smallReply = { jsonrpc: "2.0", id: 1, result: { resources: [] } };
  const largeRequest = {
    jsonrpc: "2.0",
    id: "large-request-id",
    method: "tools/call",
    params: {
      name: "fusion_big_result",
      arguments: {
        prompt: "ARG_SECRET_SENTINEL",
        token: "TOKEN_SECRET_SENTINEL",
      },
    },
  };
  const largeReply = {
    jsonrpc: "2.0",
    id: "large-request-id",
    result: {
      content: [
        {
          type: "text",
          text: "RESULT_SECRET_SENTINEL" + "x".repeat(8 * 1024 * 1024),
        },
      ],
    },
  };
  const smallRaw = JSON.stringify(smallReply);
  const largeRaw = JSON.stringify(largeReply);
  const cfg = { backend: "addin", routing: "queue", headers: {} };

  const forward = createForwarder(
    async (request) => ({
      status: 200,
      raw: request.method === "resources/list" ? smallRaw : largeRaw,
    }),
    (message, frame) => {
      output += frame;
    },
    (line) => {
      stderr += line + "\n";
    },
    cfg,
  );
  await forward(JSON.stringify(smallRequest));
  await forward(JSON.stringify(largeRequest));

  const smallFrame = smallRaw + "\n";
  const largeFrame = largeRaw + "\n";
  assert.equal(
    output,
    smallFrame + largeFrame,
    "stdout frames remain byte-for-byte unchanged",
  );
  const lines = stderr.trim().split("\n");
  assert.equal(
    lines.length,
    1,
    "the below-threshold resource response is not logged",
  );
  assert.ok(lines[0]!.startsWith("[fmcad-mcp-size] "));
  const event = JSON.parse(lines[0]!.slice("[fmcad-mcp-size] ".length));
  assert.equal(event.event, "mcp_response_size");
  assert.equal(event.pid, process.pid);
  assert.match(event.clientInstanceId, /^[0-9a-f-]{36}$/);
  assert.equal(
    event.serverAlias,
    null,
    "shared local aliases cannot be distinguished safely",
  );
  assert.equal(event.backend, "addin");
  assert.equal(event.routing, "queue");
  assert.match(event.requestIdHash, /^[0-9a-f]{24}$/);
  assert.equal(event.method, "tools/call");
  assert.equal(event.toolName, "fusion_big_result");
  assert.equal(
    event.upstreamResponseBytes,
    Buffer.byteLength(largeRaw, "utf8"),
  );
  assert.equal(event.stdoutFrameBytes, Buffer.byteLength(largeFrame, "utf8"));
  assert.equal(event.thresholdBytes, 8 * 1024 * 1024);
  assert.ok(
    Buffer.byteLength(lines[0]!, "utf8") < 2048,
    "diagnostic record remains bounded",
  );
  assert.doesNotMatch(
    stderr,
    /ARG_SECRET_SENTINEL|TOKEN_SECRET_SENTINEL|RESULT_SECRET_SENTINEL|large-request-id|"arguments"|"content"/,
  );
});

test("stdio size diagnostics are capped at 20 events per forwarder", async () => {
  const threshold = 8 * 1024 * 1024;
  const request = { jsonrpc: "2.0", id: "same-id", method: "tools/list" };
  const reply = { jsonrpc: "2.0", id: "same-id", result: { tools: [] } };
  const baseRaw = JSON.stringify(reply);
  const raw =
    baseRaw + " ".repeat(threshold - Buffer.byteLength(baseRaw, "utf8"));
  assert.equal(Buffer.byteLength(raw, "utf8"), threshold);
  const logs: string[] = [];
  let sends = 0;
  const forward = createForwarder(
    async () => ({ status: 200, raw }),
    (message, frame) => {
      sends++;
      assert.equal(frame, JSON.stringify(message) + "\n");
    },
    (message) => logs.push(message),
    { backend: "mcp", routing: "queue" },
  );

  for (let i = 0; i < 25; i++) await forward(JSON.stringify(request));
  assert.equal(sends, 25);
  assert.equal(logs.length, 20);
  for (const line of logs) {
    const event = JSON.parse(line.slice("[fmcad-mcp-size] ".length));
    assert.equal(event.upstreamResponseBytes, threshold);
    assert.equal(
      event.stdoutFrameBytes,
      Buffer.byteLength(JSON.stringify(reply) + "\n", "utf8"),
    );
  }
});

test("broker compatibility strips normalized purpose metadata before physical admission", async () => {
  const stdin = new PassThrough();
  let seen = false;
  const { closed } = launch(
    ["--backend", "addin", "--project-directory", process.cwd()],
    {
      stdin,
      stdout: { write() {} },
      stderr: { write: (text) => assert.fail(text) },
      loadConfig: () => ({
        cfg: config({ backend: "addin", routing: "queue", headers: {} }),
      }),
      createFmcad: () =>
        assert.fail("local metadata must not construct an application session"),
      QueueClient: class {
        async register() {}
        async submit(input: unknown) {
          const payload = field(input, "payload");
          seen = true;
          assert.deepEqual(field(payload, "params", "_meta"), {
            other: "retained",
          });
          assert.equal(field(input, "description"), "Sprawdź dokument");
          return { id: "purpose-job" };
        }
        async wait() {
          return {
            job: { id: "purpose-job", state: "succeeded" },
            rpc: {
              status: 200,
              raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
            },
          };
        }
      },
    },
  );
  stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_viewport",
        arguments: {},
        _meta: {
          other: "retained",
          fmcad: { description: "  Sprawdź dokument  " },
        },
      },
    }) + "\n",
  );
  await closed;
  assert.equal(seen, true);
});

test("queued stdio returns an accepted receipt for running/paused work instead of outliving host deadlines", async () => {
  const stdin = new PassThrough();
  let output = "";
  let submitted: unknown;
  const job = {
    id: "job-paused",
    state: "running",
    clientId: "a",
    requestId: "request",
  };
  const { closed } = launch(
    ["--routing", "queue", "--project-directory", process.cwd()],
    {
      stdin,
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: { write: (text) => assert.fail(text) },
      loadConfig: () => ({
        cfg: config({ routing: "queue", backend: "addin", timeoutMs: 5000 }),
      }),
      createFmcad: () =>
        assert.fail("local metadata must not construct an application session"),
      QueueClient: class {
        async register() {}
        async submit(input: unknown) {
          submitted = input;
          return job;
        }
        async call(action: string) {
          assert.equal(action, "result");
          return { job };
        }
        wait(_id: string, { signal }: { signal: AbortSignal }) {
          return new Promise((resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("Wait stopped; job retained")),
              { once: true },
            ),
          );
        }
      },
    },
  );
  stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_viewport",
        arguments: {},
        _meta: { fmcad: { description: "Odczytaj widok" } },
      },
    }) + "\n",
  );
  await closed;
  const reply = JSON.parse(output);
  assert.equal(reply.result.structuredContent.status, "ACCEPTED");
  assert.equal(reply.result.structuredContent.jobId, job.id);
  assert.equal(field(submitted, "description"), "Odczytaj widok");
  assert.equal(field(submitted, "payload", "params", "_meta"), undefined);
  assert.equal(job.state, "running");
});

test("stdout EPIPE closes input and drains pending requests without an unhandled error", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let writes = 0;
  stdout.write = () => {
    writes++;
    queueMicrotask(() => {
      const error = Object.assign(new Error("broken output pipe"), {
        code: "EPIPE",
      });
      stdout.emit("error", error);
    });
    return false;
  };
  const cfg: Partial<FmcadConfiguration> = {
    backend: "mcp",
    routing: "queue",
    url: "http://127.0.0.1:1/mcp",
    headers: {},
  };
  const { closed } = launch([], {
    stdin,
    stdout,
    stderr: { write() {} },
    loadConfig: () => ({ cfg: config(cfg) }),
    createFmcad: () =>
      assert.fail("local metadata must not construct an application session"),
  });

  stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await closed;
  assert.equal(writes, 1);
});

test("plain JSON and SSE framing preserve data, images and event: strings", () => {
  const message = {
    jsonrpc: "2.0",
    id: 3,
    result: { text: "event: unchanged", image: "opaque" },
  };
  assert.deepEqual(responseMessages(JSON.stringify(message)), [message]);
  assert.deepEqual(
    responseMessages(
      "event: message\r\ndata: " + JSON.stringify(message) + "\r\n\r\n",
    ),
    [message],
  );
  assert.deepEqual(responseMessages(""), []);
});

test("client initialization, session, protocol and tool schemas are forwarded unchanged", async () => {
  const sent: JsonRpcMessage[] = [],
    calls: {
      request: JsonRpcRequest;
      session: string | undefined;
      version: string | undefined;
    }[] = [];
  const forward = createForwarder(
    async (request, session, version) => {
      calls.push({ request, session, version });
      if (!Object.hasOwn(request, "id")) return { status: 202, raw: "" };
      return {
        status: 200,
        sessionId: "test-session",
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "initialize"
              ? { protocolVersion: "2025-11-25" }
              : {
                  tools: [
                    { name: "execute_python", inputSchema: { type: "object" } },
                  ],
                },
        }),
      };
    },
    (message) => sent.push(message),
  );
  await forward(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    }),
  );
  await forward(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  await forward(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.session, "test-session");
  assert.equal(calls[2]?.version, "2025-11-25");
  assert.equal(sent.length, 2);
  assert.equal(
    field((field(sent[1], "result", "tools") as unknown[])[0], "name"),
    "execute_python",
  );
});

test("tool code is not wrapped, rewritten, or retried on timeout", async () => {
  let count = 0;
  const sent: JsonRpcMessage[] = [];
  const request = {
    jsonrpc: "2.0",
    id: "opaque-id",
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: 'print("hello")', persistent: false },
    },
  };
  const forward = createForwarder(
    async (payload) => {
      count++;
      assert.deepEqual(payload, request);
      throw new Error("timeout");
    },
    (message) => sent.push(message),
  );
  await forward(JSON.stringify(request));
  assert.equal(count, 1);
  assert.equal(field(sent[0], "id"), request.id);
  assert.equal(field(sent[0], "error", "code"), -32000);
  assert.match(String(field(sent[0], "error", "message")), /may have run/);
});

test("malformed input stays local; empty upstream reply is not success", async () => {
  let calls = 0;
  const sent: JsonRpcMessage[] = [];
  const forward = createForwarder(
    async () => {
      calls++;
      return { status: 200, raw: "" };
    },
    (message) => sent.push(message),
  );
  await forward("not-json");
  await forward("[]");
  assert.equal(calls, 0);
  await forward(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  );
  assert.equal(field(sent[0], "error", "code"), -32700);
  assert.equal(field(sent[1], "error", "code"), -32600);
  assert.equal(field(sent[2], "error", "code"), -32000);
});

test("invalid upstream JSON omits opaque snippets for requests and notifications", async () => {
  for (const hasId of [true, false]) {
    for (const raw of [
      '{"value":opaque-unlabeled-fragment}',
      "data: opaque-unlabeled-fragment\n\n",
      '{"value":"opaque-\\"tail"oops}',
      '{\n"value": 1\n"other": 2}',
    ]) {
      const sent: JsonRpcMessage[] = [],
        logs: string[] = [];
      let calls = 0;
      const request = {
        jsonrpc: "2.0",
        method: "tools/list",
        ...(hasId ? { id: 9 } : {}),
      };
      const forward = createForwarder(
        async (payload) => {
          calls++;
          assert.deepEqual(payload, request);
          return { status: 200, raw };
        },
        (message) => sent.push(message),
        (message) => logs.push(message),
      );
      await forward(JSON.stringify(request));
      assert.equal(calls, 1);
      assert.equal(sent.length, hasId ? 1 : 0);
      assert.equal(logs.length, hasId ? 0 : 1);
      if (hasId) {
        assert.equal(field(sent[0], "id"), 9);
        assert.equal(field(sent[0], "error", "code"), -32000);
      }
      const message = hasId ? field(sent[0], "error", "message") : logs[0];
      assert(typeof message === "string");
      assert.match(
        message,
        /^Fusion MCP connection error; no retry was performed\. An operation may have run: Invalid JSON(?: at position \d+)?(?: \(line \d+ column \d+\))?$/,
      );
      assert.doesNotMatch(message, /opaque|unlabeled|tail|value|other/);
    }
  }
});

test("thrown forwarder diagnostics preserve genuine errors and redact already loaded credentials", async () => {
  const cfg = {
    url: "https://host/private-path?custom=opaque-query",
    headers: { "X-Custom-Auth": "opaque-credential" },
  };
  for (const hasId of [true, false]) {
    for (const ErrorType of [Error, SyntaxError]) {
      const sent: JsonRpcMessage[] = [],
        logs: string[] = [];
      const forward = createForwarder(
        async () => {
          throw new ErrorType(
            `SDK execution failed for CAD-entity ${cfg.url} opaque-credential Authorization: Bearer unknown-secret`,
          );
        },
        (message) => sent.push(message),
        (message) => logs.push(message),
        cfg,
      );
      await forward(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          ...(hasId ? { id: 4 } : {}),
        }),
      );
      assert.equal(sent.length, hasId ? 1 : 0);
      assert.equal(logs.length, hasId ? 0 : 1);
      const message = hasId ? field(sent[0], "error", "message") : logs[0];
      assert(typeof message === "string");
      assert.match(message, /SDK execution failed for CAD-entity/);
      assert(typeof message === "string");
      assert.match(message, /\[REDACTED/);
      assert.doesNotMatch(
        message,
        /opaque|private-path|unknown-secret|Invalid JSON/,
      );
    }
  }
});

test("parsed upstream results and RPC errors remain unchanged even when they contain known credentials", async () => {
  const cfg = { headers: { Authorization: "Bearer opaque-credential" } };
  for (const payload of [
    {
      result: {
        text: "Authorization: Bearer opaque-credential",
        entityToken: "opaque-credential",
      },
    },
    {
      error: {
        code: -32001,
        message: "Authorization: Bearer opaque-credential",
        data: { secret: "opaque-credential" },
      },
    },
  ]) {
    const sent: JsonRpcMessage[] = [];
    const message = { jsonrpc: "2.0", id: 5, ...payload };
    const forward = createForwarder(
      async () => ({ status: 200, raw: JSON.stringify(message) }),
      (value) => sent.push(value),
      (text) => assert.fail(text),
      cfg,
    );
    await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call" }),
    );
    assert.deepEqual(sent, [message]);
  }
});
