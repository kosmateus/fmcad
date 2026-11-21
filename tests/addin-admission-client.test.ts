import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createAddinAdmission } from "../packages/node-adapters/src/execution/addin-admission-client";
import { postAddinAdmission } from "../packages/node-adapters/src/execution/broker-physical";
import { BrokerMcpClient } from "../packages/node-adapters/src/fusion-transport/mcp";
import { createAdmissionRequest } from "../packages/node-adapters/src/execution/admission-http";
import { requestCurlBytes } from "../packages/node-adapters/src/fusion-transport/curl";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Spawn } from "../packages/node-adapters/src/fusion-transport/contracts";
import {
  provisionAddinMetadata,
  prepareMetadataWire,
} from "../src/queue-broker-modules";
import { createRequire } from "node:module";
import path from "node:path";

const identity = {
  owner: "owner",
  request: "request",
  instance: "instance",
  epoch: "epoch",
  source: "source",
  build: "build",
  document: '{"creationId":"doc","fileId":"file","version":3}',
};
const token = "fixture-token-".repeat(4);

test("both staged broker layouts resolve the private byte transport without workspace source modules", () => {
  const root = path.resolve(__dirname, "../..");
  const load = createRequire(path.join(root, "package.json"));
  for (const prefix of ["./src", "./dist/src"]) {
    const modules = load(
      `${prefix}/queue-broker-modules`,
    ) as typeof import("../src/queue-broker-modules");
    assert.equal(typeof modules.provisionAddinMetadata, "function");
    const adapter = load(
      `${prefix}/dist/node-adapters/execution/admission-http`,
    ) as typeof import("../packages/node-adapters/src/execution/admission-http");
    assert.equal(
      typeof adapter.createAdmissionRequest({ transport: "windows-curl" }),
      "function",
    );
  }
});

test("provisioning binds one private Windows handle after owner/document checks and physical send keeps its identity", async (t) => {
  let sends = 0;
  let preparations = 0;
  let fetches = 0;
  const localSpawn = spawn;
  const nativeChildProcess = createRequire(__filename)(
    "node:child_process",
  ) as typeof import("node:child_process");
  t.mock.method(nativeChildProcess, "spawn", ((_file, args, options) => {
    sends++;
    assert.equal(_file, "/mnt/c/Windows/System32/curl.exe");
    assert(!JSON.stringify({ args, options }).includes(token));
    return localSpawn("curl", args, options);
  }) satisfies Spawn);
  // Capture the original function before replacing the public property.
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    throw new Error("Linux namespace unavailable");
  });
  const outgoing = {
    jsonrpc: "2.0",
    id: "fmcad:request",
    method: "tools/call",
    params: {
      name: "get_open_document_metadata",
      arguments: { fileId: "file", version: 3 },
    },
  };
  const wire = prepareMetadataWire(outgoing).wire;
  const creationId = "doc";
  const observed = {
    pid: 123,
    birth: "birth",
    version: "v",
    documentState: {
      status: "complete",
      state: {
        identity: {
          creationId,
          fileId: "file",
          version: 3,
          isSaved: true,
        },
      },
    },
    documents: [
      { id: creationId, creationId, fileId: "file", version: 3, isSaved: true },
    ],
  };
  const endpoint = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.end(
      JSON.stringify({
        version: 1,
        binding: message.binding,
        record: {
          state: "terminal",
          result: { content: [{ type: "text", text: "metadata" }] },
        },
      }),
    );
  });
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  try {
    const address = endpoint.address();
    assert(address && typeof address !== "string");
    const provision = provisionAddinMetadata(
      {
        capability: "get_open_document_metadata",
        endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
        token,
        ...identity,
        pid: 123,
        birth: "birth",
      },
      "addin",
      (...args) => {
        preparations++;
        return createAddinAdmission(...args);
      },
      { transport: "windows-curl" },
    );
    assert(provision);
    assert.throws(() =>
      provision.bind(
        wire,
        observed,
        observed,
        "foreign",
        identity.request,
        1000,
      ),
    );
    assert.throws(() =>
      provision.bind(
        wire,
        { ...observed, birth: "foreign" },
        observed,
        identity.owner,
        identity.request,
        1000,
      ),
    );
    assert.equal(preparations, 0);
    const prepared = provision.bind(
      wire,
      observed,
      observed,
      identity.owner,
      identity.request,
      1000,
    );
    assert.equal(preparations, 1);
    assert.equal(sends, 0, "bind is local");
    await assert.rejects(
      postAddinAdmission(
        prepared.scope,
        {
          ...wire,
          id: "foreign",
        },
        1000,
        prepared,
      ),
      { code: "INPUT_CHANGED" },
    );
    assert.equal(sends, 0);
    const response = await postAddinAdmission(
      prepared.scope,
      wire,
      1000,
      prepared,
    );
    assert.equal(response.status, 200);
    assert.equal(preparations, 1);
    assert.equal(sends, 1);
    assert.equal(fetches, 0);
    assert(
      !JSON.stringify({ binding: prepared.binding, response }).includes(token),
    );
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

class AdmissionCurlChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    return true;
  }
}

test("Windows admission sends exact Unicode bytes with credentials only on stdin for all explicit operations", async () => {
  const outgoing = { text: 'zażółć 🧭 "\\\n\r\t', value: 42 };
  const payloadJson = JSON.stringify(outgoing);
  const bodies: Buffer[] = [];
  const port = createAdmissionRequest(
    { transport: "windows-curl" },
    {
      fetch: async () => {
        assert.fail("Windows must never use fetch");
      },
      spawn: (executable, args, options) => {
        assert.equal(executable, "/mnt/c/Windows/System32/curl.exe");
        assert.deepEqual(options, {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.equal(args[0], "--disable");
        assert.deepEqual(args.slice(-2), ["--config", "-"]);
        assert(!args.includes("--location"));
        assert(!JSON.stringify({ executable, args, options }).includes(token));
        // Only this test seam substitutes local curl for the trusted Windows path.
        const child = spawn("curl", args, options);
        return child;
      },
    },
  );
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    bodies.push(body);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers["mcp-session-id"], undefined);
    assert.equal(req.headers["mcp-protocol-version"], undefined);
    const message = JSON.parse(body.toString("utf8"));
    res.end(
      JSON.stringify({
        version: 1,
        binding: message.binding,
        record: {
          state: message.operation === "withdraw" ? "withdrawn" : "accepted",
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const handle = createAddinAdmission(
      {
        endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
        token,
      },
      identity,
      outgoing,
      port,
    );
    assert.equal(
      handle.binding.inputHash,
      "d83dd4b790375fbcabfc31c49a9c336aa2a3d36348e0f1f7c81d5e993269519d",
    );
    assert.equal(bodies.length, 0, "construction must not do I/O");
    await handle.admit();
    await handle.status();
    await handle.withdraw();
    for (const [index, operation] of [
      "admit",
      "status",
      "withdraw",
    ].entries()) {
      assert.deepEqual(
        bodies[index],
        Buffer.from(
          JSON.stringify({
            version: 1,
            operation,
            binding: handle.binding,
            ...(operation === "admit" ? { payloadJson } : {}),
          }),
        ),
      );
    }
    assert.equal(bodies.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Windows admission rejects redirects, corrupt UTF-8, foreign binding and disconnect without retry or token leaks", async () => {
  for (const mode of ["redirect", "utf8", "foreign", "disconnect"] as const) {
    let sends = 0;
    const port = createAdmissionRequest(
      { transport: "windows-curl" },
      {
        fetch: async () => {
          assert.fail("No fallback");
        },
        spawn: (_file, args, options) => {
          sends++;
          assert(!JSON.stringify({ args, options }).includes(token));
          const child = new AdmissionCurlChild();
          child.stdin.on("data", (bytes: Buffer) => {
            assert(
              bytes.includes(Buffer.from(token)),
              "token belongs only in stdin",
            );
          });
          child.stdin.on("finish", () => {
            queueMicrotask(() => {
              if (mode === "disconnect") {
                child.stderr.write(token);
                child.emit("error", new Error(token));
                return;
              }
              const body =
                mode === "utf8"
                  ? Buffer.from([0xc3, 0x28])
                  : Buffer.from(
                      JSON.stringify({
                        version: 1,
                        binding: { foreign: true },
                        record: { state: "accepted" },
                      }),
                    );
              child.stdout.write(
                Buffer.concat([
                  Buffer.from(
                    `HTTP/1.1 ${mode === "redirect" ? 302 : 200} Test\r\nLocation: http://127.0.0.1:9999/\r\nContent-Length: ${body.length}\r\n\r\n`,
                  ),
                  body,
                ]),
              );
              child.emit("close", 0, null);
            });
          });
          return child as unknown as ReturnType<Spawn>;
        },
      },
    );
    const handle = createAddinAdmission(
      {
        endpoint: "http://127.0.0.1:8765/admission/v1",
        token,
      },
      identity,
      { text: "test" },
      port,
    );
    await assert.rejects(handle.admit(), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(Reflect.get(error, "code"), "ADDIN_ADMISSION_UNCERTAIN");
      assert(!String(error.stack).includes(token));
      assert(!JSON.stringify(error).includes(token));
      return true;
    });
    assert.equal(sends, 1, mode);
  }
});

test("private byte transport preserves invalid UTF-8 instead of replacing it", async () => {
  const bytes = Buffer.from([0xc3, 0x28]);
  const result = await requestCurlBytes(
    {
      url: "http://127.0.0.1:8765/admission/v1",
      body: Buffer.from("{}"),
      headers: {},
      timeoutMs: 1000,
      maxBuffer: 1024,
    },
    () => {
      const child = new AdmissionCurlChild();
      child.stdin.on("finish", () => {
        child.stdout.write(
          Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), bytes]),
        );
        child.emit("close", 0, null);
      });
      return child as unknown as ReturnType<Spawn>;
    },
  );
  assert.deepEqual(result.body, bytes);
});

test("private byte health request is a single GET with no body or credentials", async () => {
  let sends = 0;
  const result = await requestCurlBytes(
    {
      method: "GET",
      url: "http://127.0.0.1:8765/health",
      headers: {},
      timeoutMs: 1000,
      maxBuffer: 1024,
    },
    (_file, args) => {
      sends++;
      assert.equal(args[args.indexOf("--request") + 1], "GET");
      const child = new AdmissionCurlChild();
      const config: Buffer[] = [];
      child.stdin.on("data", (bytes: Buffer) => config.push(bytes));
      child.stdin.on("finish", () => {
        const stdin = Buffer.concat(config).toString("utf8");
        assert.equal(stdin, 'url = "http://127.0.0.1:8765/health"\n');
        child.stdout.write('HTTP/1.1 200 OK\r\n\r\n{"status":"ok"}');
        child.emit("close", 0, null);
      });
      return child as unknown as ReturnType<Spawn>;
    },
  );
  assert.equal(result.status, 200);
  assert.equal(sends, 1);
});

test("untrusted executable, transport and unsupported endpoint fail before send", () => {
  for (const config of [
    { transport: "automatic" },
    { transport: "windows-curl", curlPath: "/tmp/untrusted" },
  ])
    assert.throws(() => createAdmissionRequest(config));
  assert.throws(() =>
    createAddinAdmission(
      {
        endpoint: "http://127.0.0.1:27182/admission/v1",
        token,
      },
      identity,
      {},
    ),
  );
});

test("admission uses the bound byte request port instead of another fetch namespace", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  let sends = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("fixture: Linux loopback refused");
  };
  try {
    const port = async (request: { body: Uint8Array }) => {
      sends++;
      const message = JSON.parse(Buffer.from(request.body).toString("utf8"));
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            version: 1,
            binding: message.binding,
            record: { state: "accepted" },
          }),
        ),
      };
    };
    const handle = Reflect.apply(createAddinAdmission, undefined, [
      { endpoint: "http://127.0.0.1:8765/admission/v1", token },
      identity,
      { text: "zażółć 🧭" },
      port,
    ]) as ReturnType<typeof createAddinAdmission>;
    assert.deepEqual(await handle.admit(), { state: "accepted" });
    assert.equal(sends, 1);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("physical admission rejects malformed results and retains binding after lost response", async () => {
  const outgoing = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "get_open_document_metadata",
      arguments: { fileId: "file", version: 1 },
    },
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(outgoing))
    .digest("hex");
  let requests = 0;
  let disconnect = false;
  let terminalResult: unknown = null;
  let raw = "";
  const server = createServer(async (req, res) => {
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (disconnect) {
      req.socket.destroy();
      return;
    }
    raw = JSON.stringify({
      version: 1,
      binding: message.binding,
      record: { state: "terminal", result: terminalResult },
    });
    res.end(raw);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const scope = {
      endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
      token,
      identity,
    };
    for (const lost of [false, true]) {
      disconnect = lost;
      await assert.rejects(
        postAddinAdmission(scope, outgoing, 1000),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(Reflect.get(error, "code"), "ADDIN_ADMISSION_UNCERTAIN");
          assert.deepEqual(Reflect.get(error, "admissionBinding"), {
            ...identity,
            version: 1,
            inputHash,
          });
          if (!lost) assert.equal(Reflect.get(error, "rawResponse"), raw);
          return true;
        },
      );
    }
    assert.equal(requests, 2);
    for (const content of [
      { type: "image", mimeType: "image/png", data: "not base64!" },
      { type: "audio", mimeType: "audio/wav", data: "AB==" },
      { type: "resource", resource: { uri: "file:///owned", blob: "bad!" } },
      {
        type: "resource",
        resource: { uri: "file:///owned", text: "ok", blob: "bad!" },
      },
    ]) {
      disconnect = false;
      terminalResult = { content: [content] };
      await assert.rejects(
        postAddinAdmission(scope, outgoing, 1000),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(Reflect.get(error, "code"), "ADDIN_ADMISSION_UNCERTAIN");
          assert.equal(Reflect.get(error, "rawResponse"), raw);
          assert.deepEqual(Reflect.get(error, "admissionBinding"), {
            ...identity,
            version: 1,
            inputHash,
          });
          return true;
        },
      );
    }
    for (const content of [
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "audio", mimeType: "audio/wav", data: "AAA=" },
      { type: "resource", resource: { uri: "file:///owned", blob: "AAAA" } },
    ]) {
      terminalResult = { content: [content] };
      const response = await postAddinAdmission(scope, outgoing, 1000);
      assert.equal(response.raw, raw);
      assert.deepEqual(response.toolResponse, {
        jsonrpc: "2.0",
        id: 2,
        result: terminalResult,
      });
    }
    assert.equal(requests, 9);
    for (const invalid of [
      { jsonrpc: "2.0", id: 2, method: "tools/call" },
      { ...outgoing, id: null },
      { ...outgoing, params: { name: "", arguments: {} } },
      { ...outgoing, params: { name: "tool", arguments: [] } },
    ])
      await assert.rejects(postAddinAdmission(scope, invalid, 1000));
    assert.equal(requests, 9);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("physical admission preserves original evidence and final transformed bytes", async () => {
  let requests = 0;
  let raw = "";
  let terminal = true;
  const outgoing = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: 'guard()\nuser_code()\nrun("")\n' },
    },
  };
  const server = createServer(async (req, res) => {
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    assert.deepEqual(JSON.parse(message.payloadJson), outgoing);
    assert.equal(
      message.binding.inputHash,
      createHash("sha256").update(message.payloadJson).digest("hex"),
    );
    raw = JSON.stringify(
      {
        version: 1,
        binding: message.binding,
        record: terminal
          ? {
              state: "terminal",
              result: { content: [{ type: "text", text: "result" }] },
            }
          : { state: "unknown" },
      },
      null,
      2,
    );
    res.end(raw);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const scope = {
      endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
      token,
      identity,
    };
    const result = await postAddinAdmission(scope, outgoing, 1000);
    assert.equal(result.raw, raw);
    assert.deepEqual(result.toolResponse, {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "result" }] },
    });
    class EvidenceTransport extends BrokerMcpClient {
      override async _openSession() {
        return undefined;
      }
      override async _post() {
        return result;
      }
    }
    const transport = new EvidenceTransport(
      { url: scope.endpoint, backend: "addin" },
      { version: "test", bridgeSource: () => "", requestTimeout: () => 1000 },
    );
    const tool = await transport.callTool(
      outgoing.params.arguments,
      outgoing.params.name,
    );
    assert.equal(tool.text, "result");
    assert.equal(Reflect.get(tool, "rawResponse"), raw);
    assert.equal(requests, 1);
    terminal = false;
    await assert.rejects(
      postAddinAdmission(scope, outgoing, 1000),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(Reflect.get(error, "code"), "ADDIN_ADMISSION_UNCERTAIN");
        assert.equal(Reflect.get(error, "rawResponse"), raw);
        return true;
      },
    );
    assert.equal(requests, 2);
    await assert.rejects(
      postAddinAdmission(scope, { method: "initialize" }, 1000),
    );
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("payload serialization cannot retarget the captured identity", () => {
  const mutableIdentity = { ...identity };
  const options = { endpoint: "http://127.0.0.1:8765/admission/v1", token };
  const payload = { nested: { value: "original" } };
  Object.defineProperty(payload.nested, "toJSON", {
    value: () => {
      mutableIdentity.document = "retargeted";
      options.token = "changed";
      return { value: "original" };
    },
  });
  assert.throws(
    () => createAddinAdmission(options, mutableIdentity, payload),
    /Executable/,
  );
  assert.equal(mutableIdentity.document, identity.document);
  assert.equal(options.token, token);
});

test("refuses partial HTTP, false withdrawal and unsafe integer evidence", async () => {
  for (const mode of [
    "partial",
    "withdraw-terminal",
    "unsafe-number",
    "underflow",
    "duplicate",
    "rounded-decimal",
    "invalid-utf8",
  ]) {
    let requests = 0;
    const server = createServer(async (req, res) => {
      requests++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      res.statusCode = mode === "partial" ? 206 : 200;
      if (mode === "partial") {
        res.end(
          JSON.stringify({
            version: 1,
            binding: message.binding,
            record: { state: "withdrawn" },
          }),
        );
        return;
      }
      if (mode === "invalid-utf8") {
        res.end(
          Buffer.concat([
            Buffer.from(
              `{"version":1,"binding":${JSON.stringify(message.binding)},"record":{"state":"terminal","result":"`,
            ),
            Buffer.from([0xff]),
            Buffer.from('"}}'),
          ]),
        );
        return;
      }
      res.end(
        `{"version":1,"binding":${JSON.stringify(message.binding)},` +
          `"record":{${mode === "duplicate" ? '"state":"unknown",' : ""}"state":"terminal","result":${mode === "unsafe-number" ? "9007199254740993" : mode === "underflow" ? "1e-400" : mode === "rounded-decimal" ? "1.00000000000000001" : "1"}}}`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const handle = createAddinAdmission(
        {
          endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
          token,
        },
        identity,
        {},
      );
      await assert.rejects(
        ["partial", "withdraw-terminal"].includes(mode)
          ? handle.withdraw()
          : handle.admit(),
        { code: "ADDIN_ADMISSION_UNCERTAIN" },
        mode,
      );
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("rejects lossy input serialization and nonlocal endpoints before dispatch", () => {
  const options = { endpoint: "http://127.0.0.1:8765/admission/v1", token };
  assert.throws(
    () => createAddinAdmission(options, identity, { number: Infinity }),
    /only JSON values/,
  );
  assert.throws(
    () =>
      createAddinAdmission(
        { ...options, endpoint: "http://example.com/admission/v1" },
        identity,
        {},
      ),
    /loopback/,
  );
});

test("rejects proxies without traps and refuses coerced transport options", () => {
  let traps = 0;
  const proxy = new Proxy(
    { value: "data" },
    {
      ownKeys() {
        traps++;
        return ["value"];
      },
    },
  );
  const options = { endpoint: "http://127.0.0.1:8765/admission/v1", token };
  assert.throws(
    () => createAddinAdmission(options, identity, { nested: proxy }),
    /Proxy/,
  );
  assert.equal(traps, 0);
  for (const key of ["token", "endpoint"] as const) {
    const invalid = { ...options };
    Object.defineProperty(invalid, key, {
      value: [options[key]],
      enumerable: true,
    });
    assert.throws(
      () => createAddinAdmission(invalid, identity, {}),
      /must be strings/,
    );
  }
});

test("binds exact Unicode and numeric input bytes and freezes input before send", async () => {
  let effects = 0;
  let terminal: unknown;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.operation === "admit") {
      assert.equal(
        message.binding.inputHash,
        createHash("sha256").update(message.payloadJson).digest("hex"),
      );
      assert.deepEqual(JSON.parse(message.payloadJson), {
        text: "żółw 🐢",
        number: 1e-7,
      });
      terminal ??= { state: "terminal", result: { effects: ++effects } };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: 1,
        binding: message.binding,
        record: terminal,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const payload = { text: "żółw 🐢", number: 1e-7 };
    const handle = createAddinAdmission(
      {
        endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
        token,
      },
      identity,
      payload,
    );
    payload.text = "mutated";
    assert.deepEqual(await handle.admit(), {
      state: "terminal",
      result: { effects: 1 },
    });
    assert.deepEqual(await handle.admit(), await handle.status());
    assert.equal(effects, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects mismatched receipt identity without retrying", async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    res.end(
      JSON.stringify({
        version: 1,
        binding: { ...message.binding, epoch: "other" },
        record: { state: "terminal", result: "wrong" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const handle = createAddinAdmission(
      {
        endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
        token,
      },
      identity,
      {},
    );
    await assert.rejects(handle.admit(), { code: "ADDIN_ADMISSION_UNCERTAIN" });
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("lost response is uncertain and performs no automatic retry", async () => {
  let requests = 0;
  const server = createServer((req) => {
    requests++;
    req.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const handle = createAddinAdmission(
      {
        endpoint: `http://127.0.0.1:${address.port}/admission/v1`,
        token,
      },
      identity,
      {},
    );
    await assert.rejects(handle.admit(), { code: "ADDIN_ADMISSION_UNCERTAIN" });
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
