import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { ObjectValue } from "../packages/node-adapters/src/fusion-transport/contracts";
import type { FmcadConfiguration } from "../src/api";
import { list, record, text } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
const { createBrokerTransport } = load(
  path.join(root, "src/dist/fusion-transport/broker"),
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const { McpClient } = load(
  path.join(root, "src/client"),
) as typeof import("../src/composition/library-client");
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const dependencies = {
  version: "test",
  requestTimeout: () => 1000,
  bridgeSource: () =>
    assert.fail("Metadata discovery must not prepare add-in Python"),
};
function clientFor(backend = "mcp") {
  return createBrokerTransport({ ...cfg, backend }, dependencies);
}

const cfg: FmcadConfiguration = {
  backend: "mcp",
  routing: "queue",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
  transport: "node",
  protocolVersion: "2024-11-05",
  url: "https://host/mcp",
  tool: "execute",
  timeoutMs: 1000,
  headers: { Authorization: "Bearer private-token" },
};
const metadata = {
  serverInfo: {
    name: "fixture-backend",
    version: "fixture-version",
    sessionId: "private-session",
    credentials: "private-token",
  },
  protocolVersion: "2025-06-18",
};

function fakePost(
  client: ReturnType<typeof clientFor>,
  result: ObjectValue,
  sse = false,
) {
  const calls: [unknown, string | undefined][] = [];
  client._post = async (payload, sessionId) => {
    calls.push([payload["method"], sessionId]);
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: payload["id"],
      result:
        payload["method"] === "initialize"
          ? { protocolVersion: "2024-11-05", ...result }
          : { tools: [{ name: "fixture-tool" }] },
    });
    return {
      status: 200,
      sessionId: "private-session",
      raw: sse ? `event: message\ndata: ${raw}\n\n` : raw,
    };
  };
  return calls;
}

// The public compatibility clients intentionally reject SDK/discovery execution.
// Exercise the current private transport selected by broker composition.
for (const backend of ["mcp", "addin"])
  test(`${backend} broker transport parses initialize metadata without extra requests`, async () => {
    const client = clientFor(backend);
    const calls = fakePost(client, metadata, backend === "addin");
    assert.deepEqual(await client.listTools(), [{ name: "fixture-tool" }]);
    assert.deepEqual(client.serverInfo, {
      name: "fixture-backend",
      version: "fixture-version",
    });
    assert.equal(client.negotiatedProtocolVersion, "2025-06-18");
    assert.deepEqual(calls, [
      ["initialize", undefined],
      ["notifications/initialized", "private-session"],
      ["tools/list", "private-session"],
    ]);
  });

test("initialization clears previous metadata and retains only nonempty strings", async () => {
  const client = clientFor();
  for (const result of [
    metadata,
    {},
    { serverInfo: { name: 123, version: " " } },
    { serverInfo: { name: "partial", version: null } },
  ]) {
    fakePost(client, result);
    await client._openSession();
    assert.deepEqual(
      client.serverInfo,
      result === metadata
        ? { name: "fixture-backend", version: "fixture-version" }
        : record(record(result)["serverInfo"] ?? {})["name"] === "partial"
          ? { name: "partial" }
          : undefined,
    );
    assert.equal(
      client.negotiatedProtocolVersion,
      result === metadata ? "2025-06-18" : "2024-11-05",
    );
  }
});

for (const failure of ["http", "rpc", "parse", "transport"])
  test(`failed ${failure} initialization clears metadata before request`, async () => {
    const client = clientFor();
    fakePost(client, metadata);
    await client._openSession();
    client._post = async () => {
      assert.equal(client.serverInfo, undefined);
      assert.equal(client.negotiatedProtocolVersion, undefined);
      if (failure === "transport") throw new Error("offline");
      return {
        status: failure === "http" ? 500 : 200,
        raw:
          failure === "parse"
            ? "{"
            : JSON.stringify({
                error: { message: "failed" },
                result: metadata,
              }),
      };
    };
    await assert.rejects(client._openSession());
    assert.equal(client.serverInfo, undefined);
    assert.equal(client.negotiatedProtocolVersion, undefined);
  });

for (const result of [
  metadata,
  {},
  { serverInfo: { name: "Bearer private-token", version: 42 } },
]) {
  test(`doctor renders reported metadata only: ${JSON.stringify(result)}`, async () => {
    let stdout = "";
    let configReads = 0;
    let routes = 0;
    let calls: unknown[] = [];
    const code = await main(["doctor"], {
      loadConfig: () => {
        configReads++;
        return { cfg };
      },
      // The CLI delegates once through its broker seam. Run the real retained
      // worker formatter with the private transport in an isolated process;
      // no public direct client or invented metadata formatter is substituted.
      runQueued: async (argv, server) => {
        routes++;
        assert.deepEqual(argv, ["doctor"]);
        const source = `
          const assert=require('node:assert/strict');
          const {createBrokerTransport}=require(${JSON.stringify(path.join(root, "src/dist/fusion-transport/broker"))});
          const client=createBrokerTransport(${JSON.stringify(server)},{version:'test',requestTimeout:()=>1000,bridgeSource:()=>assert.fail('no bridge')});
          const metadata=${JSON.stringify(result)}, calls=[];
          client._post=async(payload,sessionId)=>{
            calls.push([payload.method,sessionId]);
            return {status:200,sessionId:'private-session',raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:payload.method==='initialize'?{protocolVersion:'2024-11-05',...metadata}:{tools:[{name:'fixture-tool'}]}})};
          };
          const {execute}=require(${JSON.stringify(path.join(root, "src/composition/legacy-worker"))});
          execute({payload:{entry:{kind:'doctor'},flags:{},args:[],rawArgs:[],options:{}}},client,()=>assert.fail('doctor has no modeling outcome'))
            .then(code=>{assert.equal(code,0);process.stdout.write('CALLS '+JSON.stringify(calls)+'\\n');})
            .catch(error=>{console.error(error);process.exitCode=1});
        `;
        const output = execFileSync(process.execPath, ["-e", source], {
          encoding: "utf8",
          timeout: 10000,
        });
        const lines = output.trimEnd().split("\n");
        const marker = lines.pop();
        assert(marker);
        assert(marker.startsWith("CALLS "));
        calls = list(JSON.parse(marker.slice(6)));
        stdout += lines.join("\n") + "\n";
        return 0;
      },
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
      stderr: { write: (value) => assert.fail(String(value)) },
      setExitCode: () => {},
    });
    assert.equal(routes, 1);
    assert.equal(code, 0);
    assert.equal(configReads, 1);
    assert.deepEqual(
      calls.map((call) => list(call)[0]),
      ["initialize", "notifications/initialized", "tools/list"],
    );
    const lines = stdout.trim().split("\n");
    assert.match(text(lines[0]), /^CONFIG /);
    assert.match(text(lines[1]), /^BACKEND /);
    assert.match(text(lines[2]), /^SERVER /);
    assert.equal(lines[3], "MCP_OK tools=1 (fixture-tool)");
    assert.deepEqual(
      JSON.parse(text(lines[2]).slice(7)),
      result === metadata
        ? {
            name: "fixture-backend",
            version: "fixture-version",
            protocolVersion: "2025-06-18",
          }
        : {
            name: record(result)["serverInfo"] ? "[REDACTED]" : "not reported",
            version: "not reported",
            protocolVersion: "2024-11-05",
          },
    );
    for (const secret of [
      "private-token",
      "private-session",
      "credentials",
      "sessionId",
    ])
      assert.ok(!stdout.includes(secret), stdout);
  });
}

test("public compatibility client retains direct-execution denial", async () => {
  const client = new McpClient({ ...cfg });
  await assert.rejects(client.listTools(), { code: "QUEUE_REQUIRED" });
  await assert.rejects(client._openSession(), { code: "QUEUE_REQUIRED" });
});
