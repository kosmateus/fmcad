import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { CliDependencies } from "../src/entrypoints/cli";
import type {
  FmcadConfiguration,
  FmcadServices,
  FmcadOptions,
  CadWorkerInvocation,
  ExecuteOptions,
} from "../src/api";
const load = createRequire(__filename),
  root = process.cwd();
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { commands, legacyCommands } = load(
  path.join(root, "src/commands"),
) as typeof import("../src/composition/library-commands");
const { loadConfig } = load(
  path.join(root, "src/config"),
) as typeof import("../src/composition/library-configuration");
const config: FmcadConfiguration = {
  backend: "mcp",
  routing: "queue",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 180000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
};

type Call =
  | ["config", Parameters<NonNullable<CliDependencies["loadConfig"]>>[0]]
  | ["queue", string[], FmcadConfiguration, unknown]
  | ["init", Record<string, unknown>]
  | ["factory"];
function partial<T extends object>(value: Partial<T>): T {
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected service access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as T;
}
function harness(overrides: Partial<CliDependencies> = {}) {
  const calls: Call[] = [];
  let stdout = "",
    stderr = "";
  const deps: CliDependencies = {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    setExitCode() {},
    loadConfig: (options) => {
      calls.push(["config", options]);
      const backend = options["backend"] ?? "mcp";
      assert(backend === "mcp" || backend === "addin");
      return { cfg: { ...config, backend } };
    },
    runQueued: async (argv, cfg, options) => {
      calls.push(["queue", argv, cfg, options]);
      return 0;
    },
    initConfig: (options) => {
      calls.push(["init", options]);
      return { path: "/mock/config", note: "mock" };
    },
    ...overrides,
  };
  return {
    calls,
    deps,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("legacy non-CAD families use only the existing broker application with selected backend/config", async (t) => {
  t.after(
    (
      load(
        path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void
    )(),
  );
  const previousWsl = process.env["WSL_DISTRO_NAME"];
  process.env["WSL_DISTRO_NAME"] = "LegacyTest";
  t.after(() => {
    if (previousWsl === undefined) delete process.env["WSL_DISTRO_NAME"];
    else process.env["WSL_DISTRO_NAME"] = previousWsl;
  });
  for (const backend of ["mcp", "addin"]) {
    for (const entry of legacyCommands.filter(
      (entry) => !["family", "help", "init", "run"].includes(entry.kind),
    )) {
      const args =
        entry.key === "plane_add"
          ? ["Plane", "offset", "XY", "10 mm"]
          : entry.kind === "call"
            ? ["custom_tool", '{"value":1}']
            : Array(entry.minArgs ?? 0).fill("arg");
      if (entry.requiresDoc) args.push("--doc", "Design");
      if (entry.exactlyOne) args.push(entry.exactlyOne[0]!);
      const h = harness();
      assert.equal(
        await main(
          [...entry.key.split(" "), ...args, "--backend", backend],
          h.deps,
        ),
        0,
        `${entry.key}: ${h.stderr}`,
      );
      const queue = h.calls.find((call) => call[0] === "queue");
      assert.ok(queue && queue[0] === "queue", entry.key);
      assert.equal(queue[2].backend, backend);
      assert.equal(queue[2].routing, "queue");
      assert.equal(queue[1][0], entry.key.split(" ")[0]);
      assert.equal(h.calls.filter((call) => call[0] === "queue").length, 1);
      assert.equal(
        h.calls.some((call) => call[0] === "factory"),
        false,
      );
    }
  }
});

test("global and every per-command backend help remain offline", async () => {
  for (const backend of ["mcp", "addin"]) {
    const routes = [
      [],
      ["help"],
      ["--help"],
      ["-h"],
      ...commands.flatMap((entry) => [
        ["help", ...entry.key.split(" ")],
        [...entry.key.split(" "), "--help"],
        [...entry.key.split(" "), "-h"],
      ]),
    ];
    for (const route of routes) {
      const h = harness({
        loadConfig() {
          throw Error("help loaded config");
        },
      });
      assert.equal(
        await main([...route, "--backend", backend], h.deps),
        0,
        route.join(" "),
      );
      assert.ok(h.stdout.trim(), route.join(" "));
      assert.deepEqual(h.calls, []);
    }
  }
});

test("init stays local and run delegates through the typed library service", async (t) => {
  const init = harness();
  assert.equal(
    await main(["init", "--from-opencode", "--force"], init.deps),
    0,
  );
  assert.equal(init.calls[0]?.[0], "init");
  assert.equal(
    init.calls.some((call) => call[0] === "queue"),
    false,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-cli-run-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "trusted.py");
  fs.writeFileSync(
    script,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  let admitted:
    | {
        options: FmcadOptions;
        payload: CadWorkerInvocation;
        execution: ExecuteOptions;
      }
    | undefined;
  const h = harness({
    createFmcad: (options) =>
      partial<FmcadServices>({
        async start() {},
        async dispose() {},
        async execute(payload, execution) {
          admitted = { options, payload, execution };
          return {
            version: 1,
            requestId: execution.requestId,
            jobId: null,
            state: "succeeded",
            result: { success: true },
            outcome: {
              version: 1,
              requestId: null,
              jobId: null,
              acceptance: "accepted",
              executionOutcome: "succeeded",
              mayHaveMutated: null,
              validation: {
                status: "not_checked",
                source: null,
                artifactId: null,
                measurements: {},
              },
              code: null,
            },
          };
        },
      }),
  });
  assert.equal(
    await main(
      ["run", script, "--doc", "Model", "--readonly", "--backend", "addin"],
      h.deps,
    ),
    0,
    h.stderr,
  );
  assert(admitted);
  assert(admitted.payload.kind === "run");
  assert.equal(admitted.options.config.backend, "addin");
  assert.equal(admitted.payload.kind, "run");
  assert.equal(admitted.payload.request.identity.readOnly, true);
  assert.equal(
    h.calls.some((call) => call[0] === "queue"),
    false,
  );
});

test("backend configuration precedence and secret isolation remain unchanged", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-cli-backend-"),
  );
  const file = path.join(directory, "config.json");
  const original = process.env["FMCAD_BACKEND"];
  t.after(() => {
    if (original === undefined) delete process.env["FMCAD_BACKEND"];
    else process.env["FMCAD_BACKEND"] = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      backend: "mcp",
      url: "http://native.invalid",
      headers: { Host: "native-host", Authorization: "native-secret" },
      backends: {
        mcp: { headers: { "X-Native": "secret" } },
        addin: { transport: "node" },
      },
    }),
  );
  for (const [env, override, expected] of [
    ["addin", {}, "addin"],
    ["mcp", { backend: "addin" }, "addin"],
    ["addin", { backend: "mcp" }, "mcp"],
  ] as const) {
    process.env["FMCAD_BACKEND"] = env;
    const resolved = loadConfig({
      config: file,
      headers: { "X-CLI": "explicit" },
      ...override,
    }).cfg;
    assert.equal(resolved.backend, expected);
    if (expected === "addin") {
      assert.equal(resolved.url, "http://127.0.0.1:8765/mcp");
      assert.deepEqual(resolved.headers, { "X-CLI": "explicit" });
    } else assert.equal(resolved.headers["Authorization"], "native-secret");
  }
  process.env["FMCAD_BACKEND"] = "unknown";
  assert.throws(() => loadConfig({ config: file }), /backend/);
});

test("direct routing fails before existing broker route; queue spelling does not fork execution", async () => {
  const direct = harness({
    loadConfig: () => ({
      cfg: { ...config, routing: "direct" } as unknown as FmcadConfiguration,
    }),
  });
  assert.equal(await main(["projects"], direct.deps), 1);
  assert.match(direct.stderr, /routing=direct/);
  assert.equal(
    direct.calls.some((call) => call[0] === "queue"),
    false,
  );
  const queue = harness();
  assert.equal(await main(["projects", "--routing", "queue"], queue.deps), 0);
  assert.equal(queue.calls.filter((call) => call[0] === "queue").length, 1);
});

test("invalid backend config rejects before constructing a service or queue client", async () => {
  const h = harness({
    loadConfig: () => {
      throw Error("Unknown backend: unknown");
    },
  });
  assert.equal(await main(["projects", "--backend", "unknown"], h.deps), 1);
  assert.match(h.stderr, /Unknown backend/);
  assert.equal(
    h.calls.some((call) => call[0] === "queue"),
    false,
  );
});
