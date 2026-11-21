import type {
  Server,
  ObjectValue,
  Spawn,
} from "../packages/node-adapters/src/fusion-transport/contracts";
import { createRequire } from "node:module";
import { at, record, text, number } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/curl-transport.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import http from "node:http";
const { postCurl, parseCurlResponse } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/curl",
) as typeof import("../packages/node-adapters/src/fusion-transport/curl");
const postWithCurl = (
  server: Server,
  payload: unknown,
  sessionId?: string | null,
  spawn?: Spawn,
) =>
  postCurl(
    server,
    payload as ObjectValue,
    { sessionId: sessionId as string | undefined },
    spawn,
  );
const { BrokerMcpClient } = runtimeRequire(
  "../packages/node-adapters/dist/fusion-transport/mcp",
) as typeof import("../packages/node-adapters/src/fusion-transport/mcp");
class McpClient extends BrokerMcpClient {
  constructor(server: Server) {
    super(server, {
      version: "test",
      requestTimeout: (server) => present(server.timeoutMs),
      bridgeSource: () => "",
    });
  }
}

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
const server = { url: "http://localhost:9000/mcp?mode=test", timeoutMs: 1000 };
const warning = /outcome unknown; inspect before retry/;

test(
  "real local curl independently verifies config quoting and exact HTTP bytes",
  {},
  async (t) => {
    const probe = spawnSync("curl", ["--disable", "--version"]);
    assert.notEqual(
      probe.error ? record(probe.error)["code"] : undefined,
      "ENOENT",
      "curl is required for actual transport qualification",
    );
    assert.equal(probe.status, 0);
    const requests: {
      url: string | undefined;
      method: string | undefined;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }[] = [];
    const endpoint = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        res.writeHead(200, { "Content-Length": "2" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => new Promise((resolve) => endpoint.close(resolve)));
    const header = 'Bearer synthetic-"quote"\\backslash żółć 🚀 # = @-';
    const urlPath =
      '/mcp?token=synthetic-url&quoted="yes"&glob=[a]&escaped=%5C';
    for (const payload of [
      {
        text: 'żółć 🚀 " \\ \r\n\t\u0000 #\nconfig = "external"',
        secret: "@synthetic-file",
      },
      "@synthetic-file",
    ]) {
      const response = await postWithCurl(
        {
          url: `http://127.0.0.1:${number(at(endpoint.address(), "port"))}${urlPath}`,
          curlPath: "curl",
          timeoutMs: 2000,
          headers: { Authorization: header },
        },
        payload,
        "synthetic-session",
        (file, args, options) => {
          assert.doesNotMatch(
            args.join(" "),
            /synthetic|127\.0\.0\.1|żółć|external/,
          );
          return spawn(file, args, options);
        },
      );
      assert.equal(response.raw, "{}");
      const received = present(requests.at(-1));
      assert.equal(received.method, "POST");
      assert.equal(received.url, urlPath);
      assert.equal(
        Buffer.from(present(received.headers.authorization), "latin1").toString(
          "utf8",
        ),
        header,
      );
      assert.equal(received.headers["mcp-session-id"], "synthetic-session");
      assert.deepEqual(received.body, Buffer.from(JSON.stringify(payload)));
      assert.equal(
        received.headers["content-length"],
        String(received.body.length),
      );
    }
    assert.equal(requests.length, 2);
  },
);

function fakeCurl(
  reply:
    string | ((child: FakeCurlChild) => void) = "HTTP/1.1 200 OK\r\n\r\n{}",
  exitCode = 0,
) {
  const calls: {
    file: string;
    args: readonly string[];
    options: Parameters<Spawn>[2];
    child: FakeCurlChild;
    input?: Buffer;
  }[] = [];
  const implementation: Spawn = (file, args, options) => {
    const child = new FakeCurlChild();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.killed = signal;
    };
    const chunks: Buffer[] = [];
    const call: (typeof calls)[number] = { file, args, options, child };
    calls.push(call);
    child.stdin.on("data", (chunk) => chunks.push(chunk));
    child.stdin.on("finish", () => {
      call.input = Buffer.concat(chunks);
      if (typeof reply === "function") reply(child);
      else {
        const bytes = Buffer.from(reply);
        // Deliberately split headers and multibyte text across arbitrary chunks.
        for (let i = 0; i < bytes.length; i += 3)
          child.stdout.write(bytes.subarray(i, i + 3));
        child.emit("close", exitCode, null);
      }
    });
    return child as unknown as ReturnType<Spawn>;
  };
  return { calls, implementation };
}

test("curl sends generated config only on stdin and keeps all request secrets out of argv", async () => {
  const raw = JSON.stringify({
    message: "\u017c\u00f3\u0142\u0107 \ud83d\ude80",
  });
  const fake = fakeCurl(
    `HTTP/1.1 200 OK\r\nMcP-SeSsIoN-Id: session:value\r\nContent-Length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`,
  );
  const payload = {
    secret: "unique-body-secret",
    text: "\u017c\u00f3\u0142\u0107 \ud83d\ude80",
  };
  const result = await postWithCurl(
    {
      ...server,
      headers: {
        Authorization: "Bearer auth-secret",
        "X-Test": "one:two",
        Accept: "application/json",
      },
    },
    payload,
    "session:value",
    fake.implementation,
  );
  assert.deepEqual(result, { status: 200, sessionId: "session:value", raw });
  assert.equal(fake.calls.length, 1);
  const { file, args, options, input } = present(fake.calls[0]);
  assert.equal(file, "/mnt/c/Windows/System32/curl.exe");
  assert.equal(args[0], "--disable");
  assert.ok(args.includes("--globoff"));
  assert.deepEqual(options, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(args[args.indexOf("--config") + 1], "-");
  assert.equal(args[args.indexOf("--max-time") + 1], "1");
  assert.equal(args[args.indexOf("--noproxy") + 1], "*");
  const lines = present(input).toString("utf8").trimEnd().split("\n");
  assert.ok(lines.includes(`url = "${server.url}"`));
  assert.ok(lines.includes('header = "x-test: one:two"'));
  assert.ok(lines.includes('header = "mcp-session-id: session:value"'));
  assert.ok(
    lines.includes(
      `header = "content-length: ${Buffer.byteLength(JSON.stringify(payload))}"`,
    ),
  );
  assert.equal(
    lines.filter((line) => line.startsWith('header = "accept:')).length,
    1,
  );
  assert.doesNotMatch(
    args.join(" "),
    /unique-body-secret|auth-secret|session:value|one:two|localhost|--retry|--location|--fail|--url|--header|--data/,
  );
  assert.equal(
    JSON.parse(present(lines.at(-1)).slice("data-binary = ".length)),
    JSON.stringify(payload),
  );
});

test("parser skips informational responses, keeps final status/session and SSE unchanged", () => {
  const raw = 'event: message\r\ndata: {"result":{}}\r\n\r\n';
  const response = parseCurlResponse(
    "HTTP/1.1 100 Continue\r\nMcp-Session-Id: old\r\n\r\n" +
      "HTTP/1.1 103 Early Hints\r\n\r\nHTTP/2 503 Unavailable\r\nMCP-Session-ID: final\r\n\r\n" +
      raw,
  );
  assert.deepEqual(response, { status: 503, sessionId: "final", raw });
  assert.deepEqual(new McpClient(server)._parse(response.raw), { result: {} });
  assert.equal(
    parseCurlResponse("HTTP/1.1 200 OK\n\nHTTP/1.1 500 body text\n\n").raw,
    "HTTP/1.1 500 body text\n\n",
  );
  assert.deepEqual(
    parseCurlResponse("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"),
    { status: 204, sessionId: undefined, raw: "" },
  );
  assert.equal(
    parseCurlResponse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}")
      .raw,
    "{}",
  );
});

test("parser rejects incomplete/malformed headers and incorrect byte lengths", () => {
  for (const raw of [
    "",
    "{}",
    "HTTP/1.1 200 OK\r\n",
    "HTTP/1.1 100 Continue\r\n\r\n",
    "HTTP/1.1 200 OK\r\nbad header\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: nonsense\r\n\r\n",
  ]) {
    assert.throws(() => parseCurlResponse(raw));
  }
});

test("non-2xx responses resolve for common client status handling without retry", async () => {
  for (const status of [301, 400, 401, 500]) {
    const fake = fakeCurl(`HTTP/1.1 ${status} Error\r\n\r\nerror body`);
    const response = await postWithCurl(
      { ...server, curlPath: "/custom/curl" },
      {},
      null,
      fake.implementation,
    );
    assert.equal(response.status, status);
    assert.equal(response.raw, "error body");
    assert.equal(present(fake.calls[0]).file, "/custom/curl");
    assert.equal(fake.calls.length, 1);
    const client = new McpClient(server);
    client._openSession = async () => undefined;
    client._post = async () => response;
    await assert.rejects(
      client.callTool({}, "test"),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("exit failures, malformed responses, spawn and stdin errors are uncertain and never retried", async () => {
  const cases: [ReturnType<typeof fakeCurl>, string, RegExp][] = [
    [fakeCurl("", 28), "ETIMEDOUT", /exit 28/],
    [fakeCurl("", 7), "ECHILD", /exit 7/],
    [fakeCurl("invalid"), "EPROTO", /invalid/],
    [
      fakeCurl((child) =>
        child.emit(
          "error",
          Object.assign(new Error("missing"), { code: "ENOENT" }),
        ),
      ),
      "ECHILD",
      /process/,
    ],
    [
      fakeCurl((child) =>
        child.stdin.emit(
          "error",
          Object.assign(new Error("pipe"), { code: "EPIPE" }),
        ),
      ),
      "EPIPE",
      /stdin/,
    ],
  ];
  for (const [fake, code, message] of cases) {
    await assert.rejects(
      postWithCurl(server, {}, null, fake.implementation),
      (error) => {
        assert.equal(at(error, "code"), code);
        assert.match(text(at(error, "message")), warning);
        assert.match(text(at(error, "message")), message);
        return true;
      },
    );
    assert.equal(fake.calls.length, 1);
  }
  await assert.rejects(
    postWithCurl(server, {}, null, () => {
      throw new Error("spawn");
    }),
    warning,
  );
  await assert.rejects(
    postWithCurl(
      { ...server, curlPath: "/nonexistent-fmcad-curl/curl.exe" },
      {},
    ),
    (error) =>
      at(error, "code") === "ECHILD" &&
      warning.test(text(at(error, "message"))),
  );
});

test("curl retains safe failure codes and local phases without claiming remote settlement", async () => {
  for (const [causeCode, phase] of [
    ["ENOENT", "spawn"],
    ["EACCES", "process"],
    ["EPIPE", "stdin"],
    ["EIO", "output"],
  ] as const) {
    const native = Object.assign(new Error("synthetic-secret-message"), {
      code: causeCode,
    });
    const fake = fakeCurl((child) => {
      if (phase === "process") child.emit("error", native);
      if (phase === "stdin") child.stdin.emit("error", native);
      if (phase === "output") child.stdout.emit("error", native);
    });
    let attempts = 0;
    await assert.rejects(
      postWithCurl(server, {}, null, (...args) => {
        attempts++;
        if (phase === "spawn") throw native;
        return fake.implementation(...args);
      }),
      (error) => {
        assert.equal(at(error, "causeCode"), causeCode);
        assert.equal(at(error, "transportPhase"), phase);
        assert.equal(
          at(error, "code"),
          phase === "spawn" || phase === "process" ? "ECHILD" : causeCode,
        );
        assert.match(text(at(error, "message")), warning);
        assert.doesNotMatch(JSON.stringify(error), /synthetic-secret-message/);
        assert.equal(at(error, "notStarted"), undefined);
        return true;
      },
    );
    assert.equal(attempts, 1);
    assert.equal(fake.calls.length, phase === "spawn" ? 0 : 1);
  }
});

test("curl never reads native code getters or retains unrecognized secret-like codes", async () => {
  let getterCalls = 0;
  const getter = Object.defineProperty(new Error("secret"), "code", {
    get() {
      getterCalls++;
      throw new Error("must not read native getter");
    },
  });
  for (const native of [getter, { code: "Bearer synthetic-secret-code" }]) {
    await assert.rejects(
      postWithCurl(server, {}, null, () => {
        throw native;
      }),
      (error) => {
        assert.equal(at(error, "transportPhase"), "spawn");
        assert.equal(at(error, "causeCode"), undefined);
        assert.doesNotMatch(JSON.stringify(error), /secret|Bearer/);
        return true;
      },
    );
  }
  assert.equal(getterCalls, 0);
});

test("fake MCP response loss remains unknown after one submission; preflight sends nothing", async () => {
  const fake = fakeCurl("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}");
  await assert.rejects(
    postWithCurl(
      server,
      { jsonrpc: "2.0", id: "sol-mcp-rpc-fault", method: "tools/call" },
      null,
      fake.implementation,
    ),
    (error) => {
      assert.equal(at(error, "code"), "EPROTO");
      assert.equal(at(error, "transportPhase"), "response");
      assert.match(text(at(error, "message")), warning);
      assert.equal(at(error, "notStarted"), undefined);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1);
  assert.match(present(fake.calls[0]?.input).toString(), /sol-mcp-rpc-fault/);
  const preflight = fakeCurl();
  await assert.rejects(
    postWithCurl(
      { ...server, headers: { "bad:name": "invalid" } },
      {},
      null,
      preflight.implementation,
    ),
  );
  assert.equal(preflight.calls.length, 0);
});

test("fake MCP distinguishes initialization failure from response loss after tools/call without replay", async () => {
  for (const failAt of ["initialize", "tools/call"]) {
    const methods: unknown[] = [];
    const fake = fakeCurl((child) => {
      const config = present(fake.calls.at(-1)?.input).toString();
      const data = present(
        config.split("\n").find((line) => line.startsWith("data-binary = ")),
      );
      const payload: unknown = JSON.parse(
        JSON.parse(data.slice("data-binary = ".length)),
      );
      const method = at(payload, "method");
      methods.push(method);
      if (method === failAt) {
        child.stdout.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}");
      } else {
        const raw =
          method === "initialize"
            ? JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { protocolVersion: "2024-11-05" },
              })
            : "";
        child.stdout.write(
          `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`,
        );
      }
      child.emit("close", 0);
    });
    const client = new BrokerMcpClient(
      { ...server, transport: "windows-curl" },
      {
        version: "sol-mcp-rpc-fake",
        requestTimeout: () => 1000,
        bridgeSource: () => "",
        spawn: fake.implementation as typeof spawn,
      },
    );
    const prepared = await client.prepareCallTool(
      { requestId: "sol-mcp-rpc-owned-fault" },
      "fake-owned-tool",
    );
    assert.equal(fake.calls.length, 0);
    await assert.rejects(prepared(), (error) => {
      assert.equal(at(error, "transportPhase"), "response");
      assert.equal(at(error, "code"), "EPROTO");
      assert.match(text(at(error, "message")), warning);
      return true;
    });
    assert.deepEqual(
      methods,
      failAt === "initialize"
        ? ["initialize"]
        : ["initialize", "notifications/initialized", "tools/call"],
    );
    await assert.rejects(prepared(), /already consumed/);
    assert.equal(fake.calls.length, failAt === "initialize" ? 1 : 3);
  }
});

test("process deadline kills a real hung subprocess without requiring Windows", async () => {
  let child: ReturnType<typeof spawn> | undefined;
  let calls = 0;
  await assert.rejects(
    postWithCurl({ ...server, timeoutMs: 50 }, {}, null, () => {
      calls++;
      child = spawn(
        process.execPath,
        ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
        { shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      return child as unknown as ReturnType<Spawn>;
    }),
    (error) =>
      at(error, "code") === "ETIMEDOUT" &&
      warning.test(text(at(error, "message"))),
  );
  assert.equal(calls, 1);
  assert.equal(present(child).killed, true);
  await new Promise((resolve) => present(child).once("close", resolve));
});

test("bounded output counts stdout and stderr; default accommodates screenshot-sized responses", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const fake = fakeCurl((child) => child[stream].write(Buffer.alloc(101)));
    await assert.rejects(
      postWithCurl(
        { ...server, maxBuffer: 100 },
        {},
        null,
        fake.implementation,
      ),
      (error) =>
        at(error, "code") === "ENOBUFS" &&
        warning.test(text(at(error, "message"))),
    );
    assert.equal(present(fake.calls[0]).child.killed, "SIGKILL");
    assert.equal(fake.calls.length, 1);
  }
  const raw = "x".repeat(22 * 1024 * 1024);
  const fake = fakeCurl((child) => {
    child.stdout.write(
      `HTTP/1.1 200 OK\r\nContent-Length: ${raw.length}\r\n\r\n`,
    );
    child.stdout.write(raw);
    child.emit("close", 0);
  });
  assert.equal(
    (await postWithCurl(server, {}, null, fake.implementation)).raw,
    raw,
  );
});

test("only HTTP(S) loopback URLs are allowed and validation happens before spawn", async () => {
  const fake = fakeCurl();
  for (const url of [
    "http://example.com",
    "http://192.168.1.2",
    "http://localhost.evil",
    "file:///tmp/test",
  ]) {
    await assert.rejects(
      postWithCurl({ ...server, url }, {}, null, fake.implementation),
      /loopback/,
    );
  }
  assert.equal(fake.calls.length, 0);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    await postWithCurl(
      { ...server, url: `https://${host}:9000/mcp` },
      {},
      null,
      fake.implementation,
    );
  }
  for (const config of [
    { maxBuffer: 0 },
    { timeoutMs: -1 },
    { maxBuffer: Infinity },
    { headers: { "X-Test": "value\r\nInjected: true" } },
    { headers: { "X-Test": "value\tcontrol" } },
    { headers: { "bad:name": "value" } },
    { url: server.url + '\nheader = "Injected: true"' },
  ]) {
    await assert.rejects(
      postWithCurl({ ...server, ...config }, {}, null, fake.implementation),
    );
  }
  assert.equal(fake.calls.length, 3);
  await assert.rejects(
    postWithCurl(server, {}, "session\x7f", fake.implementation),
    /header/,
  );
  await assert.rejects(
    postWithCurl({ ...server, timeoutMs: 0 }, {}, null, fake.implementation),
    /bounded positive/,
  );
});

test("McpClient selects curl explicitly and keeps the protocol default/override without session reuse", async () => {
  const client = new McpClient({
    ...server,
    transport: "windows-curl",
    url: "http://example.com",
  });
  await assert.rejects(
    client.controlPost({ jsonrpc: "2.0", id: 1, method: "ping" }),
    /loopback/,
  );
  for (const protocolVersion of [undefined, "2025-03-26"]) {
    const instance = new McpClient({ ...server, protocolVersion } as Server);
    const requests: { payload: ObjectValue; sessionId: string | undefined }[] =
      [];
    instance._post = async (payload, sessionId) => {
      requests.push({ payload, sessionId });
      return {
        status: 200,
        sessionId: "sid",
        raw:
          payload["method"] === "initialize"
            ? JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: at(payload, "params", "protocolVersion"),
                },
              })
            : "",
      };
    };
    assert.equal(await instance._openSession(), "sid");
    await instance._openSession();
    assert.equal(requests.length, 4);
    assert.equal(
      at(requests, 0, "payload", "params", "protocolVersion"),
      protocolVersion || "2024-11-05",
    );
    assert.equal(at(requests, 1, "sessionId"), "sid");
  }
});
