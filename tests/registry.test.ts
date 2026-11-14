import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { CliDependencies } from "../src/entrypoints/cli";
import type { CliOptions } from "../src/entrypoints/cli/parser";
import type {
  FmcadConfiguration,
  FmcadOptions,
  FmcadServices,
  CadWorkerInvocation,
  ExecuteOptions,
} from "../src/api";
const root = process.cwd();
const load = createRequire(__filename);
const { commands, legacyCommands, findCommand, globalFlags } = load(
  path.join(root, "src/commands"),
) as typeof import("../src/composition/library-commands");
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { OPS } = load(path.join(root, "src/ops")) as {
  OPS: Record<string, unknown>;
};
type Call =
  | ["exit", number]
  | ["config", CliOptions]
  | ["queue", string[], FmcadConfiguration, CliOptions]
  | ["init", Record<string, unknown>];
function call<K extends Call[0]>(
  calls: Call[],
  kind: K,
): Extract<Call, [K, ...unknown[]]> {
  const found = calls.find(
    (entry): entry is Extract<Call, [K, ...unknown[]]> => entry[0] === kind,
  );
  assert(found, `Missing ${kind} call`);
  return found;
}
function services(
  value: Pick<FmcadServices, "start" | "dispose" | "execute">,
): FmcadServices {
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected service access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as FmcadServices;
}
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

function harness(overrides: CliDependencies = {}) {
  const calls: Call[] = [];
  let stdout = "",
    stderr = "";
  const dependencies: CliDependencies = {
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
    setExitCode: (code) => calls.push(["exit", code]),
    loadConfig: (opts) => {
      calls.push(["config", opts]);
      return { cfg: { ...config, ...opts } };
    },
    runQueued: async (argv, cfg, opts) => {
      calls.push(["queue", argv, cfg, opts]);
      return 0;
    },
    initConfig: (opts) => {
      calls.push(["init", opts]);
      return { path: "/config", note: "test" };
    },
    ...overrides,
  };
  return {
    calls,
    dependencies,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("registry inventories every shipped command and subcommand", () => {
  const expected = [
    ...Object.keys(OPS),
    "doc",
    "doc search",
    "doc open",
    "doc new",
    "doc list",
    "doc recent",
    "doc save",
    "doc close",
    "export",
    "export stl",
    "export step",
    "file_download",
    "shot",
    "undo",
    "redo",
    "active",
    "licensing",
    "doctor",
    "init",
    "tools",
    "call",
    "run",
    "help",
  ];
  assert.deepEqual(
    legacyCommands.map((command) => command.key).sort(),
    expected.sort(),
  );
  assert.equal(
    new Set(commands.map((command) => command.key)).size,
    commands.length,
  );
  for (const command of commands) {
    assert.ok(
      command.usage && command.description && command.example && command.kind,
      command.key,
    );
    assert.equal(findCommand(command.key.split(" ")), command);
  }
});

test("keychain is absent while queue and MCP help remain available offline", async () => {
  assert.equal(
    commands.some(
      (command) =>
        command.key === "keychain" || command.key.startsWith("keychain "),
    ),
    false,
  );
  assert.equal(findCommand(["keychain"]), undefined);
  assert.equal(findCommand(["queue", "status"])?.kind, "queue");
  const { globalHelp, detail } = load(
    path.join(root, "src/help"),
  ) as typeof import("../src/composition/library-help");
  assert.match(globalHelp(), /queue status/);
  assert.doesNotMatch(globalHelp(), /fmcad keychain/i);
  const removed = harness();
  assert.equal(await main(["keychain", "prepare"], removed.dependencies), 1);
  assert.match(removed.stderr, /unknown command: keychain/);
  assert.deepEqual(removed.calls, [["exit", 1]]);
  const { startStdio } = load(
    path.join(root, "src/mcp-stdio"),
  ) as typeof import("../src/entrypoints/mcp-stdio");
  let mcpHelp = "";
  startStdio(["--help"], {
    stdout: {
      write: (text) => {
        mcpHelp += text;
      },
    },
    loadConfig: () => assert.fail("MCP help must remain offline"),
  });
  assert.match(mcpHelp, /Usage: fmcad-mcp/);
  assert.doesNotMatch(mcpHelp, /keychain/i);
  assert.match(detail("keychain"), /No detailed help/);
});

test("every help route stays offline and uses registry usage", async () => {
  for (const entry of commands)
    for (const argv of [
      ["help", ...entry.key.split(" ")],
      [...entry.key.split(" "), "--help"],
      [...entry.key.split(" "), "-h"],
    ]) {
      const h = harness({
        loadConfig() {
          throw Error("unexpected config");
        },
      });
      assert.equal(await main(argv, h.dependencies), 0, argv.join(" "));
      assert.ok(h.stdout.includes(entry.usage), argv.join(" "));
      assert.deepEqual(h.calls, []);
    }
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    const h = harness({
      loadConfig() {
        throw Error("unexpected config");
      },
    });
    assert.equal(await main(argv, h.dependencies), 0);
    for (const entry of commands.filter((command) => command.kind !== "family"))
      assert.ok(h.stdout.includes(entry.usage));
    assert.deepEqual(h.calls, []);
  }
});

test("missing values, unknown options and invalid legacy invocations fail before configuration/admission", async () => {
  for (const entry of legacyCommands.filter(
    (command) => !["family", "help"].includes(command.kind),
  )) {
    for (const flag of [
      "--unknown",
      ...Object.entries(entry.flags ?? {})
        .filter(([, kind]) => kind === "value")
        .map(([flag]) => flag),
    ]) {
      const h = harness();
      assert.equal(
        await main([...entry.key.split(" "), flag], h.dependencies),
        1,
      );
      assert.match(h.stderr, /missing value|unknown option/);
      assert.equal(
        h.calls.some((call) => call[0] === "config" || call[0] === "queue"),
        false,
      );
    }
  }
  for (const flag of Object.keys(globalFlags))
    for (const suffix of [[], ["--help"]]) {
      const h = harness();
      assert.equal(
        await main(["projects", flag, ...suffix], h.dependencies),
        1,
      );
      assert.match(h.stderr, /missing value/);
      assert.equal(
        h.calls.some((call) => call[0] === "config" || call[0] === "queue"),
        false,
      );
    }
  for (const argv of [
    ["doc", "close"],
    ["doc", "close", "--save", "--discard"],
    ["doc", "missing"],
    ["export", "obj"],
    ["param_set", "width", "10 mm"],
    ["folder_create", "project"],
    ["call", "tool", "{invalid"],
  ]) {
    const h = harness();
    assert.equal(await main(argv, h.dependencies), 1, argv.join(" "));
    assert.equal(
      h.calls.some((call) => call[0] === "config" || call[0] === "queue"),
      false,
    );
  }
});

test("legacy non-CAD operation arguments pass once to the existing broker route", async () => {
  for (const entry of commands.filter((command) => command.kind === "op")) {
    const args =
      entry.key === "plane_add"
        ? ["Offset", "offset", "XY", "10 mm"]
        : Array.from(
            { length: entry.minArgs ?? 0 },
            (_, index) => `arg${index}`,
          );
    const h = harness();
    assert.equal(
      await main(
        [entry.key, ...args, ...(entry.requiresDoc ? ["--doc", "Design"] : [])],
        h.dependencies,
      ),
      0,
    );
    const routed = call(h.calls, "queue");
    assert.ok(routed, entry.key);
    assert.equal(routed[1][0], entry.key);
    assert.deepEqual(routed[1].slice(1, 1 + args.length), args);
    assert.equal(h.calls.filter((call) => call[0] === "queue").length, 1);
  }
});

test("docops, exports, calls and tools preserve argv instead of constructing a CLI transport", async (t) => {
  t.after(
    (
      load(
        path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void
    )(),
  );
  for (const entry of commands.filter((command) =>
    ["docops", "export", "upload", "call", "tools", "doctor"].includes(
      command.kind,
    ),
  )) {
    const args =
      entry.kind === "call"
        ? ["tool", '{"value":1}']
        : Array(entry.minArgs ?? 0).fill("argument");
    if (entry.requiresDoc) args.push("--doc", "Design");
    if (entry.exactlyOne) args.push(entry.exactlyOne[0]!);
    const h = harness();
    assert.equal(
      await main([...entry.key.split(" "), ...args], h.dependencies),
      0,
      `${entry.key}: ${h.stderr}`,
    );
    const routed = call(h.calls, "queue");
    assert.ok(routed, entry.key);
    assert.equal(routed[1][0], entry.key.split(" ")[0]);
    assert.equal(h.calls.filter((call) => call[0] === "queue").length, 1);
  }
});

test("run keeps JSON, document pins, readonly and listing as typed library/offline requests", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cli-run-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "box.py");
  fs.writeFileSync(
    script,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  const admitted: {
    options: FmcadOptions;
    payload: CadWorkerInvocation;
    execution: ExecuteOptions;
  }[] = [];
  const h = harness({
    createFmcad: (options) =>
      services({
        async start() {},
        async dispose() {},
        async execute(payload, execution) {
          assert(execution);
          admitted.push({ options, payload, execution });
          return {
            version: 1,
            requestId: execution.requestId ?? "",
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
      [
        "run",
        script,
        "--args",
        "[25]",
        "--doc",
        "Design",
        "--doc-id",
        "creation",
        "--doc-file-id",
        "file",
        "--readonly",
      ],
      h.dependencies,
    ),
    0,
    h.stderr,
  );
  assert(admitted[0]);
  assert.equal(admitted[0].payload.kind, "run");
  assert(admitted[0].payload.kind === "run");
  assert.deepEqual(admitted[0].payload.request.args, [25]);
  assert.deepEqual(admitted[0].payload.request.identity, {
    docId: "creation",
    docFileId: "file",
    readOnly: true,
  });
  for (const flag of ["--list", "-l"]) {
    const listing = harness({
      listScripts: () => [{ name: "box", dir: "scripts" }],
    });
    assert.equal(await main(["run", flag], listing.dependencies), 0);
    assert.equal(listing.stdout, "box (scripts)\n");
    assert.deepEqual(listing.calls, []);
  }
});

test("purpose/global options reach configuration; negative values and path arguments remain caller-owned", async () => {
  const h = harness();
  assert.equal(
    await main(
      [
        "--purpose",
        "Inspect model",
        "--config",
        "/config",
        "call",
        "tool",
        '{"value":1}',
        "--url",
        "http://localhost",
        "--header",
        "A:one",
        "--header",
        "B:two:three",
        "--timeout",
        "123",
      ],
      h.dependencies,
    ),
    0,
  );
  const configured = call(h.calls, "config");
  assert.equal(configured[1].description, "Inspect model");
  assert.equal(configured[1]["config"], "/config");
  assert.deepEqual(configured[1].headers, { A: "one", B: "two:three" });
  assert.equal(configured[1].timeoutMs, 123);
  const routed = call(h.calls, "queue");
  assert.ok(routed[1].includes("call"));
  assert.ok(routed[1].includes("http://localhost"));
  assert.ok(routed[1].includes("/config"));
  const negative = harness();
  assert.equal(
    await main(
      ["param_set", "width", "-10 mm", "--doc", "Design"],
      negative.dependencies,
    ),
    0,
  );
  assert.ok(call(negative.calls, "queue")[1].includes("-10 mm"));
});

test("upload input path is passed without shell mapping and init remains offline", async (t) => {
  t.after(
    (
      load(
        path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void
    )(),
  );
  const h = harness();
  assert.equal(
    await main(
      [
        "upload",
        "/mnt/c/notes.txt",
        "--project",
        "Project",
        "--folder",
        "Folder",
      ],
      h.dependencies,
    ),
    0,
  );
  assert.ok(call(h.calls, "queue")[1].includes("/mnt/c/notes.txt"));
  const init = harness();
  assert.equal(
    await main(
      ["init", "--from-opencode", "--force", "--config", "/config"],
      init.dependencies,
    ),
    0,
  );
  assert.deepEqual(init.calls[0], [
    "init",
    { fromOpencode: true, force: true, config: "/config" },
  ]);
  assert.equal(init.stdout, "WROTE /config (test)\n");
  assert.equal(
    init.calls.some((call) => call[0] === "config" || call[0] === "queue"),
    false,
  );
});

test("broker failure is returned without constructing an adapter fallback", async () => {
  const h = harness({
    runQueued: async () => {
      throw Error("broker unavailable; operation outcome unknown");
    },
  });
  assert.equal(await main(["projects"], h.dependencies), 1);
  assert.match(h.stderr, /broker unavailable; operation outcome unknown/);
  assert.equal(h.calls.filter((call) => call[0] === "queue").length, 0);
});

test("legacy help descriptor exports remain compatible", () => {
  const { SPECIAL, detail } = load(
    path.join(root, "src/help"),
  ) as typeof import("../src/composition/library-help");
  for (const key of Object.keys(SPECIAL))
    assert.equal(SPECIAL[key]!(), detail(key));
});
