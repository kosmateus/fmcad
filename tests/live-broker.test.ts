import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
const multiProcess = load("./live-normal-multidocument-processes") as {
  waitForGroupReadJobs(
    children: unknown[],
    readOriginal: (receipt: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown>;
  capture(
    queue: unknown,
    cfg: unknown,
    directory: string,
    requestId: string,
    fingerprint: string,
  ): Promise<unknown>;
  parseOptions(argv: string[]): {
    protocol?: string;
    processes: number;
    concurrency: number;
  };
  groupManifest(
    id: string,
    protocol: string,
    fingerprint: string,
    concurrency: number,
    baseline: {
      active: string | null;
      documents: {
        id: string;
        name: string;
        saved: boolean;
        modified: boolean;
      }[];
    },
    count: number,
  ): {
    id: string;
    buildHash: string;
    runners: { id: string; documentNames: string[] }[];
    ownerCount: number;
    baseline: {
      active: string | null;
      documents: {
        id: string;
        name: string;
        saved: boolean;
        modified: boolean;
      }[];
    };
  };
  globalConcurrency(
    reports: { sdkIntervals?: { started: number; finished: number }[] }[],
  ): { maximum: number; intervals: number };
  exactState(before: unknown, after: unknown): void;
  submitWithResponseRecovery(
    queue: {
      auth: { clientId: string };
      call(action: string, values: Record<string, unknown>): Promise<unknown>;
      submit(input: { requestId: string }): Promise<Record<string, unknown>>;
    },
    input: { requestId: string },
  ): Promise<Record<string, unknown>>;
  verifyRunnerReports(
    manifest: {
      id: string;
      buildHash: string;
      ownerCount: number;
      baseline: { active: string | null };
      runners: { id: string; documentNames: string[] }[];
    },
    reports: Record<string, unknown>[],
    identities: { pid: number; birth: string }[],
  ): void;
  waitWithResponseRecovery(
    queue: {
      auth: { clientId: string };
      findRequest(requestId: string): Promise<{
        job?: { id: string; requestId: string; clientId: string };
      } | null>;
      wait(jobId: string): Promise<Record<string, unknown>>;
    },
    jobId: string,
    requestId: string,
  ): Promise<Record<string, unknown>>;
};

test("independent runner inventory uses the typed run entrypoint and one original read-only request", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-capture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const job = {
    id: "capture-job",
    requestId: "capture-request",
    clientId: "capture-owner",
    state: "succeeded",
  };
  const snapshot = { active: null, documents: [] };
  let submitted = 0,
    waited = 0;
  const queue = {
    auth: { clientId: job.clientId },
    async submit(input: Record<string, unknown>) {
      submitted++;
      assert.equal(input["requestId"], job.requestId);
      assert.equal(input["buildHash"], "capture-build");
      const argv = input["argv"];
      assert.ok(Array.isArray(argv));
      assert.equal(argv[0], "run");
      assert.equal(argv[2], "--readonly");
      const source = fs.readFileSync(String(argv[1]), "utf8");
      assert.match(source, /^def run\(context: str\):$/m);
      assert.match(source, /^    a=adsk\.core\.Application\.get\(\)$/m);
      return job;
    },
    async wait(id: string) {
      waited++;
      assert.equal(id, job.id);
      return {
        job,
        execution: { sdkSettled: true },
        stdout: "FMCAD_RESULT " + JSON.stringify(snapshot),
      };
    },
  };
  await multiProcess.capture(
    queue,
    { backend: "addin" },
    directory,
    job.requestId,
    "capture-build",
  );
  assert.equal(submitted, 1);
  assert.equal(waited, 1);
});

test("independent runner readiness observes original job state instead of stale admission receipts", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-runner-state-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const job = {
    id: "original-job",
    clientId: "owner",
    requestId: "baseline",
    state: "preparing",
  };
  const receipt = {
    phase: "group-before",
    clientId: "owner",
    requestId: "baseline",
    job,
  };
  fs.writeFileSync(
    path.join(directory, "report.json"),
    JSON.stringify({ receipts: [receipt] }),
  );
  let observations = 0;
  const result = await multiProcess.waitForGroupReadJobs(
    [
      {
        directory,
        child: { exitCode: null, pid: 123 },
        runner: { id: "runner" },
      },
    ],
    async (original) => {
      observations++;
      assert.deepEqual(original, receipt);
      return { ...job, state: "queued", dispatch: { rpcCount: 0 } };
    },
  );
  assert.equal(observations, 1);
  assert.deepEqual(result, [
    {
      runnerId: "runner",
      pid: 123,
      clientId: "owner",
      requestId: "baseline",
      jobId: "original-job",
      state: "queued",
      sdkRequestsSent: 0,
    },
  ]);
  assert.equal(job.state, "preparing");
});

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

test("packaged stage dependencies resolve from both source-tree and installed runtime layouts", () => {
  const payload = { kind: "run", request: { helperVersion: "cad-v1" } };
  for (const modulePath of [
    "../dist/src/composition/stage-dependencies.js",
    "../dist/src/dist/composition/stage-dependencies.js",
  ]) {
    const { requiresPhysicalStageOwner } = load(modulePath) as {
      requiresPhysicalStageOwner(value: unknown): boolean;
    };
    assert.equal(requiresPhysicalStageOwner(payload), true, modulePath);
  }
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

test("independent live runners require the shared protocol and manifest owner grid", () => {
  assert.deepEqual(
    multiProcess.parseOptions([
      "--run",
      "--protocol",
      "mcp",
      "--processes",
      "3",
      "--concurrency",
      "10",
    ]),
    { protocol: "mcp", processes: 3, concurrency: 10 },
  );
  assert.deepEqual(multiProcess.parseOptions(["--run"]), {
    protocol: undefined,
    processes: 2,
    concurrency: 2,
  });
  for (const argv of [
    ["--protocol", "addin"],
    ["--run", "--protocol", "direct"],
    ["--run", "--processes", "1"],
    ["--run", "--concurrency", "3"],
  ])
    assert.throws(() => multiProcess.parseOptions(argv));

  const manifest = multiProcess.groupManifest(
    "10000000-0000-4000-8000-000000000000",
    "addin",
    "runtime-build",
    10,
    {
      active: "original-document",
      documents: [
        {
          id: "original-document",
          name: "User Design",
          saved: true,
          modified: false,
        },
      ],
    },
    3,
  );
  assert.equal(manifest.runners.length, 3);
  assert.equal(manifest.ownerCount, 10);
  assert.equal(new Set(manifest.runners.map((runner) => runner.id)).size, 3);
  const documentNames = manifest.runners.flatMap(
    (runner) => runner.documentNames,
  );
  assert.equal(documentNames.length, 30);
  assert.equal(new Set(documentNames).size, 30);
});

test("multi-runner SDK intervals prove one queue and final user state is exact", () => {
  assert.deepEqual(
    multiProcess.globalConcurrency([
      { sdkIntervals: [{ started: 1, finished: 2 }] },
      { sdkIntervals: [{ started: 2, finished: 3 }] },
    ]),
    { maximum: 1, intervals: 2 },
  );
  assert.equal(
    multiProcess.globalConcurrency([
      { sdkIntervals: [{ started: 1, finished: 3 }] },
      { sdkIntervals: [{ started: 2, finished: 4 }] },
    ]).maximum,
    2,
  );
  const baseline = {
    active: "original",
    documents: [
      { id: "original", name: "User Design", saved: true, modified: false },
    ],
  };
  assert.doesNotThrow(() => multiProcess.exactState(baseline, baseline));
  assert.throws(() =>
    multiProcess.exactState(baseline, {
      ...baseline,
      documents: [{ ...baseline.documents[0]!, modified: true }],
    }),
  );
});

test("multi-runner response recovery reads the same owner request without resubmitting", async () => {
  const requestId = "group:lost-response",
    job = { id: "original-job", requestId, clientId: "client-a" };
  let submitCalls = 0,
    findCalls = 0,
    waitCalls = 0,
    resultReads = 0;
  const recoveredResult = {
    job: { ...job, state: "succeeded" },
    stdout: "original output",
    execution: { sdkSettled: true },
  };
  const client = {
    auth: { clientId: job.clientId },
    async submit(input: { requestId: string }) {
      submitCalls++;
      assert.equal(input.requestId, requestId);
      throw Object.assign(new Error("dropped submit acknowledgement"), {
        code: "QUEUE_IPC_RESPONSE_LOST",
      });
    },
    async call(action: string, values: Record<string, unknown>) {
      assert.equal(action, "find-request");
      assert.deepEqual(values, { requestId });
      resultReads++;
      return { job };
    },
    async findRequest(id: string) {
      findCalls++;
      assert.equal(id, requestId);
      return { job };
    },
    async wait(jobId: string) {
      waitCalls++;
      assert.equal(jobId, job.id);
      if (waitCalls === 1)
        throw Object.assign(new Error("dropped result response"), {
          code: "QUEUE_IPC_RESPONSE_LOST",
        });
      return recoveredResult;
    },
  };
  const admission = await multiProcess.submitWithResponseRecovery(client, {
    requestId,
  });
  assert.equal(admission["id"], job.id);
  assert.equal(admission["requestId"], requestId);
  const result = await multiProcess.waitWithResponseRecovery(
    client,
    job.id,
    requestId,
  );
  assert.equal(record(result["job"])["id"], job.id);
  assert.equal(result["stdout"], recoveredResult.stdout);
  assert.equal(submitCalls, 1);
  assert.equal(resultReads, 1);
  assert.equal(findCalls, 1);
  assert.equal(waitCalls, 2);
});

test("multi-runner evidence requires distinct processes, clients, receipts and closed fixtures", () => {
  const manifest = multiProcess.groupManifest(
    "10000000-0000-4000-8000-000000000001",
    "addin",
    "runtime-build",
    1,
    {
      active: "original-document",
      documents: [
        {
          id: "original-document",
          name: "User Design",
          saved: true,
          modified: false,
        },
      ],
    },
    2,
  );
  const identities = [
    { pid: 100, birth: "process-a" },
    { pid: 101, birth: "process-b" },
  ];
  const reports = manifest.runners.map((runner, index) => {
    const owner = `live:${runner.id}:0`;
    const document = {
      name: runner.documentNames[0],
      creationId: `owned-${index}`,
    };
    const receipt = {
      requestId: owner + ":close",
      clientId: owner,
      job: { id: `job-${index}`, requestId: owner + ":close", clientId: owner },
      result: {
        job: {
          id: `job-${index}`,
          requestId: owner + ":close",
          clientId: owner,
        },
        execution: { sdkSettled: true },
      },
    };
    return {
      runId: runner.id,
      status: "passed",
      buildHash: manifest.buildHash,
      processIdentity: identities[index],
      processGroup: { id: manifest.id, runnerId: runner.id },
      documents: [document],
      cleanup: [
        {
          closed: true,
          creationId: document.creationId,
          active: "original-document",
        },
      ],
      receipts: [receipt],
    };
  });
  assert.doesNotThrow(() =>
    multiProcess.verifyRunnerReports(manifest, reports, identities),
  );
  assert.throws(() =>
    multiProcess.verifyRunnerReports(manifest, reports, [
      identities[0]!,
      identities[0]!,
    ]),
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
