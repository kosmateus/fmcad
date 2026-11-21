import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createAddinAdmission } from "../packages/node-adapters/src/execution/addin-admission-client";
import { postAddinAdmission } from "../packages/node-adapters/src/execution/broker-physical";
import { BrokerMcpClient } from "../packages/node-adapters/src/fusion-transport/mcp";

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
    const tool = await transport.callTool({}, "get_open_document_metadata");
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
