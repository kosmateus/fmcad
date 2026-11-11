import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
function address(server: http.Server): AddressInfo {
  const result = server.address();
  assert.ok(result && typeof result === "object");
  return result;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

test("only the broker bootstrap imports the private physical transport", () => {
  const publicFiles = [
    "src/client.js",
    "src/addin-client.js",
    "src/backends.js",
    "src/mcp-stdio.js",
    "src/composition/library.ts",
    "src/composition/opencode.ts",
    "src/entrypoints/cli.ts",
  ];
  for (const name of publicFiles) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(
      source,
      /createBrokerTransport|BrokerMcpClient|BrokerAddinClient|fusion-transport\/(broker|http|curl)/,
      name,
    );
  }
  const broker = fs.readFileSync(
    path.join(root, "src/queue-broker.js"),
    "utf8",
  );
  assert.equal((broker.match(/createBrokerTransport/g) || []).length, 1);
  assert.equal(
    record(load("./src/queue-client"))["assertDirectAccess"],
    undefined,
  );

  const manifest = record(load("./package.json"));
  assert.doesNotMatch(
    JSON.stringify(manifest["exports"]),
    /fusion-transport|queue-broker|src\/client/,
  );
});

test("legacy direct factory/config and worker environment grant no physical access", async (t) => {
  let physicalRequests = 0;
  const server = http.createServer((request, response) => {
    physicalRequests++;
    request.resume();
    request.on("end", () => response.end("{}"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const constructors = {
    McpClient: class {
      constructor() {
        assert.fail("direct factory must reject before construction");
      }
    },
  };
  assert.throws(
    () =>
      (
        load(
          "./src/backends",
        ) as typeof import("../src/composition/library-backends")
      ).createBackend({ routing: "direct" }, constructors),
    {
      code: "UNSUPPORTED_ROUTING",
    },
  );
  assert.throws(
    () =>
      (
        load(
          "./src/config",
        ) as typeof import("../src/composition/library-configuration")
      ).loadConfig({ routing: "direct" }),
    (error) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "UNSUPPORTED_ROUTING");
      assert.match(
        error.message,
        /routing=direct is no longer supported.*shared fmcad broker/,
      );
      return true;
    },
  );
  await assert.rejects(
    (
      load("./src/queue-broker") as {
        serve(
          config: { routing: string },
          options: { confirmOwnership: true; createBackend(): never },
        ): Promise<unknown>;
      }
    ).serve(
      { routing: "direct" },
      {
        confirmOwnership: true,
        createBackend() {
          assert.fail(
            "direct broker config must reject before transport construction",
          );
        },
      },
    ),
    { code: "UNSUPPORTED_ROUTING" },
  );

  const { McpClient } = load(
    "./src/client",
  ) as typeof import("../src/composition/library-client");
  const previous = process.env["FMCAD_QUEUE_WORKER_JOB"];
  process.env["FMCAD_QUEUE_WORKER_JOB"] = "forged-without-broker-capability";
  t.after(() => {
    if (previous === undefined) delete process.env["FMCAD_QUEUE_WORKER_JOB"];
    else process.env["FMCAD_QUEUE_WORKER_JOB"] = previous;
  });
  const client = new McpClient({
    url: `http://127.0.0.1:${address(server).port}/mcp`,
    routing: "queue",
  });
  for (const method of [
    "initialize",
    "ping",
    "tools/list",
    "resources/list",
    "tools/call",
    "resources/read",
  ]) {
    await assert.rejects(client._post({ jsonrpc: "2.0", id: 1, method }), {
      code: "QUEUE_REQUIRED",
    });
  }
  assert.equal(physicalRequests, 0);
  assert.equal(
    record(load("./src/queue-client"))["assertDirectAccess"],
    undefined,
  );
});

test(
  "CLI, MCP and library fail closed with a missing broker and reset marker",
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-broker-only-"));
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    let physicalRequests = 0;
    const server = http.createServer((request, response) => {
      physicalRequests++;
      request.resume();
      request.on("end", () => response.end("{}"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const configPath = path.join(home, "config.json");
    const config = {
      backend: "mcp",
      routing: "queue",
      url: `http://127.0.0.1:${address(server).port}/mcp`,
      headers: {},
      timeoutMs: 1000,
      tool: "fusion_mcp_execute",
      transport: "node",
      protocolVersion: "2025-06-18",
      queue: { autoStart: false, autoRecover: false },
      controlCenter: { port: 4748 },
    } as const;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const envKeys = [
      "XDG_STATE_HOME",
      "FMCAD_CONFIG",
      "FMCAD_ROUTING",
      "FMCAD_CLIENT",
    ];
    const before = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    process.env["XDG_STATE_HOME"] = home;
    process.env["FMCAD_CONFIG"] = configPath;
    process.env["FMCAD_ROUTING"] = "queue";
    process.env["FMCAD_CLIENT"] = "offline-broker-only-test";
    t.after(async () => {
      for (const key of envKeys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(home, { recursive: true, force: true });
    });

    const cli = load("./src/cli") as typeof import("../src/entrypoints/cli");
    let cliError = "";
    assert.equal(
      await cli.main(["projects", "--config", configPath], {
        stdout: { write() {} },
        stderr: {
          write(value) {
            cliError += value;
          },
        },
        setExitCode() {},
      }),
      1,
    );
    assert.match(
      cliError,
      /no direct fallback|QUEUE_NOT_RUNNING|ECONNREFUSED|ENOENT/i,
    );

    const stdin = new PassThrough();
    let stdout = "";
    const mcp = (
      load("./src/mcp-stdio") as typeof import("../src/entrypoints/mcp-stdio")
    ).startStdio(["--project-directory", project], {
      stdin,
      stdout: {
        write(value) {
          stdout += value;
        },
      },
      stderr: { write() {} },
      loadConfig: () => ({ cfg: config }),
    });
    stdin.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }) +
        "\n",
    );
    assert.ok(mcp);
    await mcp.closed;
    const mcpReply = record(JSON.parse(stdout.trim()));
    assert.equal(mcpReply["id"], 1);
    assert.ok(mcpReply["error"]);
    assert.match(
      String(record(mcpReply["error"])["message"]),
      /no direct fallback|QUEUE_NOT_RUNNING|ECONNREFUSED|ENOENT/i,
    );

    const { createFmcad } = load(
      "fmcad/api",
    ) as typeof import("../src/api/index");
    const api = createFmcad({
      version: 1,
      config,
      context: {
        clientId: "offline-library",
        instanceId: "offline-instance",
        source: "system",
        projectDirectory: project,
      },
    });
    await assert.rejects(api.start());
    await api.dispose();
    assert.equal(
      physicalRequests,
      0,
      "missing broker never falls back to the configured physical endpoint",
    );

    const state = path.join(home, "fmcad", "queue");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, "fusion-reset.lock"),
      JSON.stringify({ protocol: 1, nonce: "fixture-reset" }),
    );
    let resetError = "";
    assert.equal(
      await cli.main(["projects", "--config", configPath], {
        stdout: { write() {} },
        stderr: {
          write(value) {
            resetError += value;
          },
        },
        setExitCode() {},
      }),
      1,
    );
    assert.match(
      resetError,
      /no direct fallback|QUEUE_NOT_RUNNING|ECONNREFUSED|ENOENT/i,
    );
    assert.equal(
      physicalRequests,
      0,
      "a reset marker does not authorize direct dispatch",
    );
  },
);
