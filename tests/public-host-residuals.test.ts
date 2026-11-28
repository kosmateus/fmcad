import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

test("typed compatibility factory selects ADDIN and rejects retired backends and direct routing before construction", () => {
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
    for (const routing of [undefined, "queue", "direct"]) {
      const server = { backend, routing };
      const current = observe(after, server);
      if (routing === "direct" || backend === "addin") {
        assert.deepEqual(current, observe(before, server));
        if (routing === "direct") {
          assert.equal(current.code, "UNSUPPORTED_ROUTING");
          assert.deepEqual(current.calls, []);
        } else {
          assert.deepEqual(current, {
            kind: "Addin",
            calls: [["addin", server]],
          });
        }
      } else if (backend === undefined) {
        // The public default changed deliberately; keep the historical oracle intact.
        assert.deepEqual(current, {
          kind: "Addin",
          calls: [["addin", server]],
        });
      } else {
        assert.deepEqual(current, {
          name: "Error",
          error:
            "Unsupported physical backend; use autodesk-fusion-mcp on port 8765 (backend=addin)",
          code: "UNSUPPORTED_BACKEND",
          calls: [],
        });
      }
    }
});

test("typed bridge retains canonical checked bytes, executable parity and unsupported-operation errors", () => {
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
      { queryType: "document", operation: "search", name: "Żółć $&" },
    ],
    [
      "fusion_mcp_read",
      { queryType: "document", operation: "search", query: "Żółć" },
    ],
    ["fusion_mcp_read", { queryType: "activeCommand" }],
    ["fusion_mcp_read", { queryType: "projects" }],
    ["fusion_mcp_read", { queryType: "unsupported" }],
    [
      "fusion_mcp_execute",
      { featureType: "script", object: { script: "print('unchanged')" } },
    ],
    [
      "fusion_mcp_execute",
      {
        featureType: "document",
        object: { operation: "open", fileId: "owned-file" },
      },
    ],
    [
      "fusion_mcp_execute",
      {
        featureType: "document",
        object: { operation: "close", userConfirmedCloseWithoutSave: true },
      },
    ],
    [
      "fusion_mcp_update",
      { featureType: "script", object: { script: "print('unchanged')" } },
    ],
    ["unsupported", {}],
  ];
  const paths = load(
    path.join(root, "src/dist/config-platform"),
  ) as typeof import("../packages/node-adapters/src/config-platform/runtime-paths");
  const bridge = load(
    path.join(root, "packages/node-adapters/dist/fusion-transport/bridge"),
  ) as typeof import("../packages/node-adapters/src/fusion-transport/bridge");
  const { assets, runtime } = paths.resolveRuntimePaths({
    anchor: path.join(root, "src/addin-bridge.js"),
  });
  const canonicalSource =
    fs.readFileSync(
      path.join(runtime, "fmcad/adapters/fusion/identity.py"),
      "utf8",
    ) +
    "\n" +
    fs.readFileSync(path.join(assets, "addin-bridge.py"), "utf8");
  assert.equal(after.addinBridgeSource(), canonicalSource);
  for (const [tool, request] of cases) {
    const current = observe(after, tool, request);
    const previous = observe(before, tool, request);
    if (!("script" in current) || !("script" in previous)) {
      assert.deepEqual(current, previous);
      continue;
    }
    // This boundary stays byte-exact even when static typing declarations grow.
    assert.equal(
      current.script,
      bridge.buildBridgeScript(tool, request, canonicalSource),
    );
    if (tool === "fusion_mcp_execute" && request["featureType"] === "script") {
      assert.deepEqual(current, previous);
      continue;
    }
    // The canonical identity's expanded Protocol members are intentional typing
    // input, not executable behavior. Keep the historical fixture/hash intact.
    const parity = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import ast, json, sys
def executable(source):
    tree = ast.parse(source)
    imports = tree.body[1]
    assert isinstance(imports, ast.ImportFrom) and imports.module == 'typing'
    assert any(item.name == 'TYPE_CHECKING' and item.asname == '_Identity_TYPE_CHECKING' for item in imports.names)
    guard = tree.body[2]
    assert isinstance(guard, ast.If) and isinstance(guard.test, ast.Name)
    assert guard.test.id == '_Identity_TYPE_CHECKING' and not guard.orelse
    assert all(isinstance(item, ast.ClassDef) for item in guard.body)
    del tree.body[2]
    return ast.dump(tree, include_attributes=False)
before, after = json.load(sys.stdin)
assert executable(before) == executable(after), 'Executable bridge program changed'
`,
      ],
      {
        input: JSON.stringify([previous.script, current.script]),
        encoding: "utf8",
      },
    );
    assert.equal(parity.status, 0, parity.stderr);
  }
});
