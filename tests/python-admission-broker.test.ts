import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const load = createRequire(path.resolve("package.json"));
// This rejection fixture stops during startup admission. It deliberately supplies
// the real MCP transport, whose later add-in-only UI methods are absent.
type Config = import("../src/queue-broker-ports").Config;
type StartupFixtureOptions = Omit<
  import("../src/queue-broker-ports").Options,
  "createBackend"
> & {
  createBackend: (config: Config) => ReturnType<typeof createBrokerTransport>;
};
const { serve } = load("./src/queue-broker") as {
  serve: (
    config: Config,
    options: StartupFixtureOptions,
  ) => ReturnType<typeof import("../src/queue-broker").serve>;
};
const { createBrokerTransport } = load(
  "./src/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
test("production transport refuses corrupted startup Python before any admission, including session initialization", async (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-broker-");
  const methods: string[] = [];
  let scripts = 0;
  const endpoint = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = record(JSON.parse(body));
      methods.push(text(payload["method"]));
      if (payload["method"] === "initialize") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: {
              protocolVersion: record(payload["params"])["protocolVersion"],
            },
          }),
        );
        return;
      }
      if (payload["method"] === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      scripts++;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { content: [] },
        }),
      );
    });
  });
  t.after(async () => {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) =>
    endpoint.listen(0, "127.0.0.1", resolve),
  );
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  const cfg = {
    backend: "mcp",
    url: `http://127.0.0.1:${address.port}`,
    timeoutMs: 5000,
    tool: "fusion_mcp_execute",
  };
  await assert.rejects(
    serve(cfg, {
      dir: directory,
      confirmOwnership: true,
      // The endpoint only records bytes; receipts belong to this local fixture.
      nativePath: (value) => value,
      createBackend: (server) => {
        const client = createBrokerTransport(
          { ...server, url: text(server["url"]) },
          {
            version: "test",
            requestTimeout: (s) => {
              assert.ok(typeof s.timeoutMs === "number");
              return s.timeoutMs;
            },
            bridgeSource: () => assert.fail("MCP has no bridge"),
          },
        );
        const prepare = client.prepareCallTool.bind(client);
        client.prepareCallTool = (args, name) =>
          prepare(
            {
              ...args,
              object: {
                ...record(args["object"]),
                script:
                  text(record(args["object"])["script"]) +
                  '\ninvalid_startup: int = "bad"\n',
              },
            },
            name,
          );
        return client;
      },
    }),
    (error) => {
      const failure = record(error);
      assert.equal(failure["code"], "PYTHON_CHECK_REJECTED");
      assert.equal(failure["probeNotSubmitted"], true);
      assert.notEqual(record(failure["pythonCheck"])["status"], "passed");
      return true;
    },
  );
  assert.equal(scripts, 0);
  assert.deepEqual(
    methods,
    [],
    "Rejected final Python must not initialize a session",
  );
  assert.ok(
    fs.existsSync(path.join(directory, "broker.lock")),
    "Lifecycle owner must handle local rejection evidence; this test never steals/removes shared ownership",
  );
});
