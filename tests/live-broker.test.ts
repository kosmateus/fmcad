import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve("tests/live-broker.test.js"));
interface Rpc {
  jsonrpc?: string;
  id?: number;
  method: string;
  params?: {
    name?: string;
    arguments?: { code?: string; persistent?: boolean };
  };
}
interface Submission {
  payload: Rpc;
  sessionId?: string;
  sequence?: unknown;
  timeoutMs: number;
}
interface LiveBrokerPort {
  context(env?: NodeJS.ProcessEnv): { clientId: string };
  commandFlags(env?: NodeJS.ProcessEnv): string[];
  rpcResponse(value: unknown, client: unknown): unknown;
  disposeBackend(client: { reqOpts?: { agent?: { destroy(): void } } }): void;
  commandScript(code: string): string;
  spawnSync: typeof import("node:child_process").spawnSync;
  createBackend(
    server: { backend: string; timeoutMs: number },
    dependencies: {
      queue: {
        submit(input: Submission): Promise<{ id: string }>;
        wait(): Promise<unknown>;
      };
      loadConfig(options: unknown): { cfg: { routing: string } };
      createBackend(server: unknown): {
        server: unknown;
        _post(...args: unknown[]): Promise<{ status: number }>;
      };
    },
  ): {
    _post(
      payload: Rpc,
      sessionId?: string,
      controlPlane?: boolean,
    ): Promise<unknown>;
  };
}
interface RunPort {
  suites: string[];
  scopedSuites: string[];
  parseOptions(argv: string[]): {
    suite: string;
    args: string[];
    routing: string;
    concurrency: number;
  };
  run(
    argv: string[],
    settings?: {
      launch(argv: string[], env: NodeJS.ProcessEnv): Promise<number>;
      protocol?: "mcp" | "addin";
    },
  ): Promise<number>;
  runBatch(
    names: string[],
    routing: string,
    launch: (name: string) => Promise<number>,
    concurrency?: number,
  ): Promise<{ suite: string; exitCode: number }[]>;
  testSourceHash(root?: string): string;
}
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
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

const { context, commandFlags, createBackend, rpcResponse } = load(
  "./helpers/live-broker",
) as LiveBrokerPort;
const { run, suites, scopedSuites, parseOptions, runBatch, testSourceHash } =
  load("./run-live") as RunPort;

test("live SDK tests fail closed outside a broker suite and reject direct mode", () => {
  assert.throws(() => context({}), /no direct fallback/);
  assert.throws(
    () => context({ FMCAD_LIVE_ROUTING: "direct", FMCAD_LIVE_CLIENT: "suite" }),
    /routing=direct/,
  );
  const env = { FMCAD_LIVE_CLIENT: "suite", FMCAD_LIVE_SEQUENCE_ID: "lease" };
  assert.deepEqual(commandFlags(env), [
    "--routing",
    "queue",
    "--client",
    "suite",
  ]);
});

test("backend adapter sends SDK calls through the broker, preserves session and never retries unknown outcomes", async () => {
  const before = { ...process.env };
  process.env["FMCAD_LIVE_CLIENT"] = "suite";
  process.env["FMCAD_LIVE_SEQUENCE_ID"] = "lease";
  delete process.env["FMCAD_LIVE_ROUTING"];
  const submitted: Submission[] = [],
    physicalPosts: unknown[][] = [];
  let state = "succeeded";
  const queue = {
    async submit(input: Submission) {
      submitted.push(input);
      return { id: "job" };
    },
    async wait() {
      const input = present(submitted.at(-1));
      return {
        job: { id: "job", state },
        ...(state === "succeeded"
          ? {
              rpc: {
                status: 200,
                raw: JSON.stringify({
                  jsonrpc: "2.0",
                  id: input.payload.id,
                  result: { protocolVersion: "2025-06-18" },
                }),
              },
            }
          : {}),
      };
    },
  };
  try {
    const client = createBackend(
      { backend: "addin", timeoutMs: 1234 },
      {
        queue,
        loadConfig: (options) => {
          assert.deepEqual(
            options,
            { routing: "queue" },
            "broker suite must explicitly request queue routing",
          );
          return { cfg: { routing: "queue" } };
        },
        createBackend: (server) => ({
          server,
          _post: async (...args) => {
            physicalPosts.push(args);
            return { status: 200 };
          },
        }),
      },
    );
    await client._post({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(physicalPosts.length, 0);
    assert.equal(present(submitted[0]).payload.method, "initialize");
    const payload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_python", arguments: { code: "pass" } },
    };
    await client._post(payload, "session");
    assert.equal(physicalPosts.length, 0);
    assert.equal(
      present(submitted[1]).sequence,
      undefined,
      "local work between SDK calls must not hold a lease",
    );
    assert.equal(present(submitted[1]).payload.method, payload.method);
    assert.ok(
      present(
        present(present(submitted[1]).payload.params).arguments,
      ).code!.endsWith("pass"),
    );
    assert.equal(present(submitted[1]).sessionId, "session");
    assert.equal(present(submitted[1]).timeoutMs, 1234);
    state = "needs_reconciliation";
    await assert.rejects(
      client._post(payload, "session"),
      /inspect, never replay/,
    );
    assert.equal(submitted.length, 3);
    await assert.rejects(
      client._post(payload, "session", true),
      /cannot bypass/,
    );
    assert.equal(submitted.length, 3);
  } finally {
    for (const key of [
      "FMCAD_LIVE_CLIENT",
      "FMCAD_LIVE_SEQUENCE_ID",
      "FMCAD_LIVE_ROUTING",
    ]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("missing and nonterminal RPC results never become a success", () => {
  for (const state of [
    "running",
    "needs_reconciliation",
    "failed",
    "cancelled",
  ]) {
    assert.throws(
      () => rpcResponse({ job: { id: "job", state } }, {}),
      /inspect, never replay/,
    );
  }
});

test("broker backend cleanup tolerates clients without a local HTTP agent", () => {
  const { disposeBackend } = load("./helpers/live-broker") as LiveBrokerPort;
  assert.doesNotThrow(() => disposeBackend({}));
  let destroyed = false;
  disposeBackend({
    reqOpts: {
      agent: {
        destroy() {
          destroyed = true;
        },
      },
    },
  });
  assert.equal(destroyed, true);
});

test("live runner lists only the supported generic suites", async () => {
  assert.equal(suites.length, 12);
  assert.deepEqual(scopedSuites, ["gm12-spring", "data-import-fixed"]);
  assert.equal(suites.includes("data-import"), true);
  assert.equal(suites.includes("keychain"), false);
  assert.equal(
    suites.includes("gm12-spring"),
    false,
    "owner-bound fixed scope must not run from the generic all matrix",
  );
  await assert.rejects(run(["not-a-suite"]), /Choose a live suite/);
  await assert.rejects(run(["keychain"]), /Choose a live suite/);
  const scopedEnv = [
    "FMCAD_LIVE_CLIENT",
    "FMCAD_LIVE_RUNTIME_ROOT",
    "FMCAD_LIVE_DOC_NAME",
    "FMCAD_LIVE_DOC_ID",
    "FMCAD_LIVE_FUSION_VERSION",
  ];
  const before = Object.fromEntries(
    scopedEnv.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of scopedEnv) delete process.env[name];
    await assert.rejects(
      run(["gm12-spring", "--run"]),
      /requires FMCAD_LIVE_CLIENT/,
    );
    await assert.rejects(
      run(["data-import-fixed", "--run"]),
      /requires FMCAD_LIVE_CLIENT/,
    );
  } finally {
    for (const name of scopedEnv) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
  const pkg = record(load("../package.json"));
  for (const [name, command] of Object.entries(record(pkg["scripts"]))) {
    if (name.startsWith("test:live:"))
      assert.match(text(command), /^node tests\/run-live\.js /, name);
  }
  assert.equal(
    Object.hasOwn(record(pkg["scripts"]), "test:live:keychain"),
    false,
  );
  assert.match(
    text(record(pkg["scripts"])["test:live:gm12-spring"]),
    /^node tests\/run-live\.js gm12-spring --run$/,
  );
  assert.match(
    text(record(pkg["scripts"])["test:live:data-import"]),
    /^node tests\/run-live\.js data-import --run$/,
  );
});

test("runner accepts only broker routing", () => {
  assert.deepEqual(parseOptions(["all", "--routing", "queue"]), {
    suite: "all",
    args: [],
    routing: "queue",
    concurrency: 10,
  });
  assert.throws(() => parseOptions(["--routing", "direct"]), /routing=direct/);
  assert.throws(() => parseOptions(["--routing", "invalid"]), /routing=direct/);
  assert.throws(
    () => parseOptions(["--routing", "queue", "--routing", "queue"]),
    /Duplicate/,
  );
  assert.equal(parseOptions(["all", "--concurrency", "2"]).concurrency, 2);
  for (const value of [
    "0",
    "-1",
    "1.5",
    "Infinity",
    "10e3",
    "9007199254740992",
  ])
    assert.throws(
      () => parseOptions(["all", "--concurrency", value]),
      /concurrency|requires a value/,
    );
  assert.throws(
    () => parseOptions(["--concurrency", "2", "--concurrency", "3"]),
    /Duplicate/,
  );
});

test("migrated import suites launch compiled TypeScript with the original opt-in and owner context", async () => {
  const path = load("node:path") as typeof import("node:path");
  const required = [
    "FMCAD_LIVE_CLIENT",
    "FMCAD_LIVE_RUNTIME_ROOT",
    "FMCAD_LIVE_DOC_NAME",
    "FMCAD_LIVE_DOC_ID",
    "FMCAD_LIVE_FUSION_VERSION",
  ];
  const before = Object.fromEntries(
    required.map((name) => [name, process.env[name]]),
  );
  const launches: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  try {
    for (const name of required)
      process.env[name] = "fixture-only-no-native-execution";
    const launch = async (argv: string[], env: NodeJS.ProcessEnv) => {
      launches.push({ argv, env });
      return 0;
    };
    assert.equal(
      await run(["data-import", "--run"], { launch, protocol: "addin" }),
      0,
    );
    assert.equal(await run(["data-import-fixed", "--run"], { launch }), 0);
    assert.deepEqual(
      launches.map((value) => value.argv),
      [
        [
          path.join("dist", "tests", "scenarios", "cli.js"),
          "--backend",
          "fusion",
          "--profile",
          "broker",
          "--suite",
          "native-import",
          "--protocol",
          "addin",
          "--concurrency",
          "10",
          "--owners",
          "10",
          "--run",
        ],
        [path.join("dist", "tests", "live-data-import-fixed.js"), "--run"],
      ],
    );
    assert.match(
      present(present(launches[0]).env["FMCAD_LIVE_CLIENT"]),
      /^live:data-import:/,
    );
    assert.equal(
      present(launches[1]).env["FMCAD_LIVE_CLIENT"],
      process.env["FMCAD_LIVE_CLIENT"],
    );
    for (const value of launches)
      assert.equal(value.env["FMCAD_LIVE_ROUTING"], "queue");
  } finally {
    for (const name of required) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

test("legacy matrix respects the configured limit and records one failed suite without abandoning others", async () => {
  let active = 0,
    peak = 0;
  const results = await runBatch(
    ["a", "b", "c", "d"],
    "queue",
    async (name) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (name === "b") throw new Error("intentional failure");
        return 0;
      } finally {
        active--;
      }
    },
    2,
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((result) => result.exitCode),
    [0, 1, 0, 0],
  );
});

test("matrix source integrity includes live helpers/cases, not mutable reports", () => {
  const fs = load("node:fs") as typeof import("node:fs"),
    os = load("node:os") as typeof import("node:os"),
    path = load("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-source-integrity-"));
  fs.mkdirSync(path.join(root, "helpers"));
  const files = [
    "run-live.js",
    "live-example.js",
    "live-example-report.json",
    "helpers/live-broker.js",
    "helpers/live-cli.js",
    "helpers/live-scope.js",
  ];
  try {
    for (const file of files) fs.writeFileSync(path.join(root, file), "{}");
    const before = testSourceHash(root);
    fs.writeFileSync(
      path.join(root, "live-example-report.json"),
      '{"running":true}',
    );
    assert.equal(testSourceHash(root), before);
    fs.writeFileSync(
      path.join(root, "helpers/live-scope.js"),
      "// changed helper lifecycle",
    );
    assert.notEqual(testSourceHash(root), before);
    const helperVersion = testSourceHash(root);
    fs.writeFileSync(path.join(root, "live-example.js"), "// changed case");
    assert.notEqual(testSourceHash(root), helperVersion);
  } finally {
    for (const file of files) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(path.join(root, "helpers"));
    fs.rmdirSync(root);
  }
});

test("broker mode starts suites concurrently within the default budget", async () => {
  const started: string[] = [],
    finish = new Map<string, (value: number) => void>();
  const promise = runBatch(["a", "b", "c"], "queue", (name) => {
    started.push(name);
    return new Promise<number>((resolve) => finish.set(name, resolve));
  });
  assert.deepEqual(started, ["a", "b", "c"]);
  for (const name of ["a", "b", "c"]) {
    present(finish.get(name))(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(
    await promise,
    ["a", "b", "c"].map((suite) => ({ suite, exitCode: 0 })),
  );
  await assert.rejects(
    runBatch(["a"], "direct", async () => 0),
    /routing=direct/,
  );
});

test("CLI test subprocesses receive broker identity and sequence, unrelated subprocesses do not", () => {
  const fs = load("node:fs") as typeof import("node:fs"),
    os = load("node:os") as typeof import("node:os"),
    path = load("node:path") as typeof import("node:path");
  const { spawnSync } = load("./helpers/live-broker") as LiveBrokerPort;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-cli-routing-"));
  const before = { ...process.env };
  process.env["FMCAD_LIVE_CLIENT"] = "cli-suite";
  process.env["FMCAD_LIVE_SEQUENCE_ID"] = "cli-lease";
  delete process.env["FMCAD_LIVE_ROUTING"];
  try {
    const file = path.join(directory, "fmcad.js");
    fs.writeFileSync(
      file,
      "console.log(JSON.stringify(process.argv.slice(2)))",
    );
    const result = spawnSync(
      process.execPath,
      [file, "audit", "--doc", "fixture"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      ...commandFlags(),
      "audit",
      "--doc",
      "fixture",
    ]);
    assert.equal(
      spawnSync(process.execPath, ["-e", 'process.stdout.write("local")'], {
        encoding: "utf8",
      }).stdout,
      "local",
    );
  } finally {
    fs.unlinkSync(path.join(directory, "fmcad.js"));
    fs.rmdirSync(directory);
    for (const key of [
      "FMCAD_LIVE_CLIENT",
      "FMCAD_LIVE_SEQUENCE_ID",
      "FMCAD_LIVE_ROUTING",
    ]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("file-backed SDK adapter preserves stdout, stderr and settled failures without running source twice", () => {
  const { commandScript } = load("./helpers/live-broker") as LiveBrokerPort;
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  for (const [code, success, stdout] of [
    ['def run(context):\n    print("once")\nrun("")', true, "once\n"],
    [
      'import sys\nprint("before")\nprint("diagnostic", file=sys.stderr)\nraise ValueError("expected")',
      false,
      "before\n",
    ],
  ] as const) {
    const result = spawnSync(
      "python3",
      ["-c", commandScript(code) + '\nrun("")'],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = record(JSON.parse(result.stdout));
    assert.equal(payload["success"], success);
    assert.equal(payload["stdout"], stdout);
    if (!success) {
      assert.equal(payload["stderr"], "diagnostic\n");
      assert.match(text(payload["traceback"]), /ValueError: expected/);
    }
  }
});

test("file-backed adapter exposes pending native workflow metadata instead of hiding it in stdout", () => {
  const { commandScript } = load("./helpers/live-broker") as LiveBrokerPort;
  const { workflowOutputNonterminal } = load("../src/queue-instance") as {
    workflowOutputNonterminal(value: { text: string }): boolean;
  };
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  for (const marker of ["FMCAD_RESULT "]) {
    const line =
      marker +
      JSON.stringify({
        success: true,
        result: { completed: false, status: "submitted", outcome: "unknown" },
      });
    const result = spawnSync(
      "python3",
      [
        "-c",
        commandScript("print(" + JSON.stringify(line) + ")") + '\nrun("")',
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = record(JSON.parse(result.stdout));
    assert.equal(payload["stdout"], line + "\n");
    assert.equal(payload["executionOutcome"], "unknown");
    assert.equal(workflowOutputNonterminal({ text: result.stdout }), true);
  }
});

test("file-backed adapter preserves accepted cloud processing without inventing unknown native work", () => {
  const { commandScript } = load("./helpers/live-broker") as LiveBrokerPort;
  const { workflowOutputNonterminal } = load("../src/queue-instance") as {
    workflowOutputNonterminal(value: { text: string }): boolean;
  };
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  const line =
    "FMCAD_RESULT " +
    JSON.stringify({
      success: true,
      operation: "document.save_as",
      result: {
        accepted: true,
        pending: true,
        status: "pending",
        targetObserved: true,
        current: {
          creationId: "saved-doc",
          saved: true,
          modified: false,
          isComplete: false,
          fileId: "transitional-id",
          fileName: "owned-name",
          projectId: "project",
          folderId: "folder",
        },
        target: {
          name: "owned-name",
          projectId: "project",
          folderId: "folder",
        },
      },
    });
  const result = spawnSync(
    "python3",
    ["-c", commandScript("print(" + JSON.stringify(line) + ")") + '\nrun("")'],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = record(JSON.parse(result.stdout));
  assert.equal(payload["stdout"], line + "\n");
  assert.equal(payload["executionOutcome"], undefined);
  assert.equal(workflowOutputNonterminal({ text: result.stdout }), false);
});

test("parallel fixture scope keeps baseline/owned documents visible and activates only a verified owned ID in the same turn", () => {
  const fs = load("node:fs") as typeof import("node:fs"),
    path = load("node:path") as typeof import("node:path"),
    os = load("node:os") as typeof import("node:os");
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  const scope = load("./helpers/live-scope") as {
    fixture(name: string | null, id?: string): void;
    source(code: string): string;
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-scope-"));
  const file = path.join(directory, "baseline.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      documents: [{ creationId: "original" }],
      activeCreationId: "original",
    }),
  );
  const old = process.env["FMCAD_LIVE_BASELINE_FILE"];
  process.env["FMCAD_LIVE_BASELINE_FILE"] = file;
  const setup = `import sys, types, json
app = types.SimpleNamespace(userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
class Document:
    def __init__(self, name, key):
        self.name, self.creationId, self.isSaved = name, key, False
    def activate(self):
        app.activeDocument = self
        return True
app.documents = [Document('user model','original'),Document('fixture','owned'),Document('other test','other')]
app.activeDocument = app.documents[2]
adsk=types.ModuleType('adsk'); core=types.ModuleType('adsk.core')
core.Application=types.SimpleNamespace(get=lambda: app); adsk.core=core
sys.modules.update({'adsk':adsk,'adsk.core':core})
`;
  try {
    scope.fixture("fixture", "owned");
    const result = spawnSync(
      "python3",
      [
        "-c",
        setup +
          scope.source(
            "print(json.dumps(dict(active=app.activeDocument.creationId,visible=[d.creationId for d in app.documents if _fmcad_live_visible(d)])))",
          ),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      active: "owned",
      visible: ["original", "owned"],
    });
    const rejected = spawnSync(
      "python3",
      [
        "-c",
        setup +
          "app.documents[1].name='replacement'\n" +
          scope.source('print("must not execute")'),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Owned live fixture identity changed/);
    assert.equal(rejected.stdout, "");
    const missing = spawnSync(
      "python3",
      [
        "-c",
        setup +
          "app.documents.pop(1)\n" +
          scope.source('print("must not execute")'),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Owned live fixture disappeared/);
    assert.equal(missing.stdout, "");
    scope.fixture(null);
    const observer = spawnSync(
      "python3",
      [
        "-c",
        setup +
          scope.source(
            "print(json.dumps(dict(active=app.activeDocument.creationId,visible=[d.creationId for d in app.documents if _fmcad_live_visible(d)])))",
          ),
      ],
      { encoding: "utf8" },
    );
    assert.equal(observer.status, 0, observer.stderr);
    assert.deepEqual(JSON.parse(observer.stdout), {
      active: "original",
      visible: ["original"],
    });
  } finally {
    scope.fixture(null);
    if (old === undefined) delete process.env["FMCAD_LIVE_BASELINE_FILE"];
    else process.env["FMCAD_LIVE_BASELINE_FILE"] = old;
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
