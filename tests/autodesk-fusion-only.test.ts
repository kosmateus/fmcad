import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
const root = path.resolve(__dirname, "../..");
const load = createRequire(__filename);
const { createBackend } = load(
  path.join(root, "src/backends.js"),
) as typeof import("../src/composition/library-backends");
const { createBrokerTransport } = load(
  path.join(root, "packages/node-adapters/dist/fusion-transport/broker.js"),
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");

test("new physical clients reject native MCP before constructing any transport", () => {
  let constructed = 0;
  class ForbiddenClient {
    constructor() {
      constructed++;
    }
  }
  for (const server of [
    { backend: "mcp", url: "http://127.0.0.1:27182" },
    { backend: "mcp", url: "http://127.0.0.1:8765" },
    { backend: "addin", url: "http://127.0.0.1:27182" },
    { backend: "addin", url: "http://[::1]:27182/mcp" },
    { backend: "addin", url: "http://localhost:027182/mcp" },
    { url: "http://127.0.0.1:27182" },
  ]) {
    assert.throws(
      () =>
        createBackend(server, {
          McpClient: ForbiddenClient,
          AddinClient: ForbiddenClient,
        }),
      /autodesk-fusion-mcp|unsupported.*backend/i,
    );
    assert.throws(
      () =>
        createBrokerTransport(server, {
          version: "test",
          requestTimeout: () => 1000,
          bridgeSource: () => assert.fail("No bridge may be prepared"),
        }),
      /autodesk-fusion-mcp|unsupported.*backend/i,
    );
  }
  assert.equal(constructed, 0);
});

test("omitting the backend selects only autodesk-fusion-mcp", () => {
  class AutodeskClient {
    readonly backend = "addin";
  }
  for (const url of [
    "http://127.0.0.1:8765",
    "http://127.0.0.1:8765/path:27182?previous=:27182",
  ]) {
    const client = createBackend(
      { url },
      {
        McpClient: class {
          constructor() {
            assert.fail("Native MCP must never be selected");
          }
        },
        AddinClient: AutodeskClient,
      },
    );
    assert.ok(client instanceof AutodeskClient);
  }
});

test("broker refuses a retired physical endpoint before claiming a queue", async () => {
  const { serve } = load(path.join(root, "src/queue-broker.js")) as {
    serve(config: unknown, options: unknown): Promise<unknown>;
  };
  for (const config of [
    { backend: "mcp", url: "http://127.0.0.1:8765" },
    { backend: "addin", url: "http://127.0.0.1:27182/mcp" },
  ]) {
    const dir = path.join(os.tmpdir(), `fmcad-native-refused-${randomUUID()}`);
    await assert.rejects(
      serve(config, {
        dir,
        confirmOwnership: true,
        createBackend: () => assert.fail("No physical client may be created"),
      }),
      { code: "UNSUPPORTED_BACKEND" },
    );
    assert.equal(fs.existsSync(dir), false, "Refusal must precede queue claim");
  }
});
