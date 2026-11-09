import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { FmcadConfiguration } from "../packages/core/dist/domain/config.js";

const load = createRequire(__filename);
const { startStdio } = load(
  path.join(process.cwd(), "dist/src/dist/entrypoints/mcp-stdio.js"),
) as typeof import("../dist/library-build/src/entrypoints/mcp-stdio.js");
const config: FmcadConfiguration = {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 1000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-11-25",
  routing: "queue",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
};

test(
  "MCP starts its companion once without waiting for console readiness",
  { timeout: 2000 },
  async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = "";
    let diagnostics = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    let rejectStartup!: (reason: Error) => void;
    let calls = 0;
    const runtime = startStdio([], {
      stdin,
      stdout,
      stderr,
      loadConfig: () => ({ cfg: config }),
      ensureWeb: (cfg) => {
        calls++;
        assert.equal(cfg.controlCenter.port, 4748);
        return new Promise<void>((_resolve, reject) => {
          rejectStartup = reject;
        });
      },
      QueueClient: class {
        constructor() {
          assert.fail("Local ping must not create a broker client");
        }
      },
    });
    assert.ok(runtime);
    stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    await runtime.closed;
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(output), { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(diagnostics, "");
    rejectStartup(new Error("private history path and service details"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      diagnostics,
      "fmcad: Control Center unavailable; MCP remains available.\n",
    );
  },
);

test("MCP help never starts the console or reads user configuration", () => {
  const stdout = new PassThrough();
  const result = startStdio(["--help"], {
    stdout,
    loadConfig: () => assert.fail("Help must not read configuration"),
    ensureWeb: () => assert.fail("Help must not start a service"),
  });
  assert.equal(result, undefined);
});

test("invalid application configuration does not break offline MCP discovery", async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  let output = "",
    diagnostics = "",
    reads = 0;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const runtime = startStdio([], {
    stdin,
    stdout,
    stderr,
    loadConfig: () => {
      reads++;
      throw new Error("Invalid application configuration fixture");
    },
    ensureWeb: () =>
      assert.fail("Invalid configuration cannot start the companion"),
    QueueClient: class {
      constructor() {
        assert.fail("Invalid configuration cannot create a broker client");
      }
    },
  });
  assert.ok(runtime);
  stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fmcad_queue_status", arguments: {} },
      },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  await runtime.closed;
  const messages = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.find((value) => value.id === 1),
    { jsonrpc: "2.0", id: 1, result: {} },
  );
  assert.deepEqual(
    messages.find((value) => value.id === 3),
    { jsonrpc: "2.0", id: 3, result: {} },
  );
  assert.match(
    messages.find((value) => value.id === 2).error.message,
    /Invalid application configuration fixture/,
  );
  assert.equal(reads, 2);
  assert.equal(diagnostics, "");
});
