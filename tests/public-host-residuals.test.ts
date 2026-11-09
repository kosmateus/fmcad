import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
type Modules = {
  "addin-bridge": typeof import("../src/composition/library-addin-bridge");
  backends: typeof import("../src/composition/library-backends");
  "cad-input": typeof import("../src/composition/library-cad-input");
  "addin-client": typeof import("../src/composition/library-addin-client");
};
const root = process.cwd(),
  load = createRequire(__filename);
const Module = load("node:module") as typeof import("node:module") & {
  _load(name: string, ...args: unknown[]): unknown;
};
function historical<K extends keyof Modules>(name: K): Modules[K] {
  const directory = path.join(root, "tests/fixtures/public-host-baseline");
  const source = fs.readFileSync(
    path.join(directory, name + ".js.txt"),
    "utf8",
  );
  const hashes = JSON.parse(
    fs.readFileSync(path.join(directory, "provenance.json"), "utf8"),
  ) as Record<string, { sha256: string }>;
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    hashes[`src/${name}.js`]?.sha256,
  );
  const filename = path.join(root, "src", name + ".js");
  const isolated = new Module(filename, module) as InstanceType<
    typeof Module
  > & { _compile(source: string, filename: string): void };
  isolated.filename = filename;
  isolated.paths = createRequire(filename).resolve.paths("fixture") ?? [];
  isolated._compile(source, filename);
  return isolated.exports as Modules[K];
}
test("typed CAD input retains exact file bytes, worker verification and decoder failures", () => {
  const before = historical("cad-input"),
    after = load(path.join(root, "src/cad-input")) as Modules["cad-input"];
  const original = Module._load,
    worker = process.env["FMCAD_QUEUE_WORKER_JOB"];
  try {
    for (const activeWorker of [false, true])
      for (const deny of [false, true]) {
        const observe = (api: Modules["cad-input"], args: string[]) => {
          const calls: unknown[] = [];
          if (activeWorker) process.env["FMCAD_QUEUE_WORKER_JOB"] = "owned-job";
          else delete process.env["FMCAD_QUEUE_WORKER_JOB"];
          Module._load = function (name, ...rest) {
            if (name.endsWith("/queue-client"))
              return {
                verifyInputBytes(file: string, bytes: Buffer) {
                  calls.push(["verify", file, bytes.toString("hex")]);
                  if (deny) throw Error("pinned input changed");
                },
              };
            return original.call(this, name, ...rest);
          };
          try {
            return {
              value: api.parseCadInput(args, { note: "text" }, {}, (file) => {
                const bytes = Buffer.from('{"note":"Żółć"}');
                calls.push(["read", file, bytes.toString("hex")]);
                return bytes;
              }),
              calls,
            };
          } catch (error) {
            assert(error instanceof Error);
            return { error: error.message, calls };
          }
        };
        for (const args of [
          [],
          ["--file", "/input.json"],
          ["--data", '{"note":"inline"}'],
          ["--file", "/input.json", "--data", "{}"],
          ["--data", "[]"],
          ["--doc-id", "no-doc"],
          ["--file"],
        ])
          assert.deepEqual(observe(after, args), observe(before, args));
      }
  } finally {
    Module._load = original;
    if (worker === undefined) delete process.env["FMCAD_QUEUE_WORKER_JOB"];
    else process.env["FMCAD_QUEUE_WORKER_JOB"] = worker;
  }
});
test("typed public add-in adapter preserves protocol metadata and refuses direct SDK access", async () => {
  const before = historical("addin-client"),
    after = load(
      path.join(root, "src/addin-client"),
    ) as Modules["addin-client"];
  for (const protocolVersion of [undefined, null, "", "2025-11-25"]) {
    const server = {
      protocolVersion,
      clientId: "fixture-owner",
      headers: { "X-Test": "exact" },
    };
    const oldClient = new before.AddinClient(server),
      client = new after.AddinClient(server);
    assert.deepEqual(client.server, oldClient.server);
    assert.deepEqual(client.capabilities, oldClient.capabilities);
    assert.equal(client.capabilities, after.ADDIN_CAPABILITIES);
    for (const current of [oldClient, client]) {
      await assert.rejects(current.executeUiGuardedScript(), {
        code: "QUEUE_REQUIRED",
        message: "SDK access requires a broker turn",
      });
      await assert.rejects(current._post({ method: "tools/call" }), {
        code: "QUEUE_REQUIRED",
      });
    }
  }
});

test("typed compatibility factory preserves selection and direct-routing denial before construction", () => {
  const before = historical("backends"),
    after = load(path.join(root, "src/backends")) as Modules["backends"];
  function observe(api: Modules["backends"], server: Record<string, unknown>) {
    const calls: unknown[] = [];
    class Mcp {
      constructor(value: unknown) {
        calls.push(["mcp", value]);
      }
    }
    class Addin {
      constructor(value: unknown) {
        calls.push(["addin", value]);
      }
    }
    try {
      const value = api.createBackend(server, {
        McpClient: Mcp,
        AddinClient: Addin,
      });
      return { kind: value.constructor.name, calls };
    } catch (error) {
      assert(error instanceof Error);
      return {
        name: error.name,
        error: error.message,
        code: "code" in error ? error.code : undefined,
        calls,
      };
    }
  }
  for (const backend of [
    undefined,
    "",
    "mcp",
    "addin",
    "unknown",
    5,
    Symbol("invalid"),
  ])
    for (const routing of [undefined, "queue", "direct"])
      assert.deepEqual(
        observe(after, { backend, routing }),
        observe(before, { backend, routing }),
      );
});

test("typed bridge asset boundary retains checked program bytes and unsupported-operation errors", () => {
  const before = historical("addin-bridge"),
    after = load(
      path.join(root, "src/addin-bridge"),
    ) as Modules["addin-bridge"];
  function observe(
    api: Modules["addin-bridge"],
    tool: string,
    request: Record<string, unknown>,
  ) {
    try {
      return { script: api.buildBridgeScript(tool, request) };
    } catch (error) {
      assert(error instanceof Error);
      return { name: error.name, message: error.message };
    }
  }
  const cases: [string, Record<string, unknown>][] = [
    ["fusion_mcp_read", { queryType: "document", operation: "open" }],
    [
      "fusion_mcp_read",
      { queryType: "document", operation: "search", query: "Żółć" },
    ],
    ["fusion_mcp_read", { queryType: "activeCommand" }],
    ["fusion_mcp_read", { queryType: "projects" }],
    ["fusion_mcp_read", { queryType: "unsupported" }],
    [
      "fusion_mcp_update",
      { featureType: "script", object: { script: "print('unchanged')" } },
    ],
    ["unsupported", {}],
  ];
  for (const [tool, request] of cases)
    assert.deepEqual(
      observe(after, tool, request),
      observe(before, tool, request),
    );
});
