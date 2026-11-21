import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createAddinAdmission } from "../packages/node-adapters/src/execution/addin-admission-client";

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
