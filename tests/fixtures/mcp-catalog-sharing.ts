import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import { createRequire } from "node:module";
import type { CatalogServices, CatalogMcpTool } from "../../src/api";
const load = createRequire(__filename);
const Module = load("node:module") as typeof import("node:module") & {
  _load(
    request: string,
    parent: NodeModule | null,
    ...args: unknown[]
  ): unknown;
};
const root = process.argv[2],
  directory = process.argv[3];
assert(root && directory);
const entry = path.join(root, "src/dist/entrypoints/mcp-stdio.js");
const queue = path.join(directory, "queue");
let factories = 0,
  toolsReads = 0,
  contractReads = 0;
let configured:
  | {
      value: CatalogServices;
      tools: readonly CatalogMcpTool[];
      contracts: ReturnType<CatalogServices["list"]>;
    }
  | undefined;
const catalog = new Proxy<Partial<CatalogServices>>(
  {
    tools() {
      toolsReads++;
      return [];
    },
    list() {
      contractReads++;
      return [];
    },
    fromMcp() {
      throw new Error("not used by tools/list");
    },
    isLocal() {
      return true;
    },
  },
  {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected catalog access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  },
) as CatalogServices;
const original = Module._load;
Module._load = function (request, parent, ...args) {
  const loaded = original.call(this, request, parent, ...args);
  if (request === "../api" && parent?.filename === entry)
    return {
      ...(loaded as typeof import("../../src/api")),
      createCatalogServices() {
        factories++;
        return catalog;
      },
    };
  if (request === "../../queue-connection.js" && parent?.filename === entry)
    return { queueDirectory: () => queue };
  if (request === "../../mcp-stdio-compat.js" && parent?.filename === entry) {
    const compatibility =
      loaded as typeof import("../../src/composition/library-mcp-compat");
    return {
      ...compatibility,
      configureCatalogServices(
        value: CatalogServices,
        tools: readonly CatalogMcpTool[],
        contracts: ReturnType<CatalogServices["list"]>,
      ) {
        configured = { value, tools, contracts };
        return compatibility.configureCatalogServices(value, tools, contracts);
      },
    };
  }
  return loaded;
};
const stdin = new PassThrough();
let output = "";
const { startStdio } = load(
  entry,
) as typeof import("../../src/entrypoints/mcp-stdio");
assert.equal(factories, 0, "import must not construct an MCP catalog");
assert.equal(
  startStdio(["--help"], {
    stdout: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  }),
  undefined,
);
assert.equal(factories, 0, "help must not construct an MCP catalog");
const running = startStdio([], {
  stdin,
  stdout: new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  }),
  stderr: new Writable({
    write(chunk: Buffer) {
      throw new Error("unexpected diagnostic: " + chunk.toString());
    },
  }),
});
assert(running);
stdin.end(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) +
    "\n",
);
void running.closed
  .then(() => {
    assert.equal(factories, 1);
    assert.equal(toolsReads, 1);
    assert.equal(contractReads, 1);
    assert(configured);
    assert.equal(configured.value, catalog);
    assert.deepEqual(configured.tools, []);
    assert.deepEqual(configured.contracts, []);
    const response: unknown = JSON.parse(output);
    assert(response !== null && typeof response === "object");
    const record = response as Record<string, unknown>;
    assert.equal(record["id"], 1);
    const result = record["result"];
    assert(result !== null && typeof result === "object");
    assert(Array.isArray((result as Record<string, unknown>)["tools"]));
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
