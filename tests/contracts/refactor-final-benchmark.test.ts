const data =
  require("../../scripts/refactor-benchmark-data.ts") as typeof import("../../scripts/refactor-benchmark-data");
const test = require("node:test") as typeof import("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync, readFileSync } =
  require("node:fs") as typeof import("node:fs");
const { resolve, join } = require("node:path") as typeof import("node:path");
const { tmpdir } = require("node:os") as typeof import("node:os");
const { command } =
  require("../../scripts/refactor-baseline.ts") as import("../../scripts/refactor-baseline").Harness;
const { isCompleteFinalRuntime, isWithin, summarizeSamples } =
  require("../../scripts/refactor-baseline-benchmark.ts") as import("../../scripts/refactor-baseline-benchmark").FinalBenchmarkHarness;

const root = resolve(__dirname, "../..");
const fixtureInput = data.record(
  data.json(
    readFileSync(
      resolve(root, "tests/fixtures/refactor-final-benchmark.json"),
      "utf8",
    ),
  ),
);
const fixture = {
  nodeEnv: data.text(fixtureInput["nodeEnv"]),
  samples: data.number(fixtureInput["samples"]),
  warmIterations: data.number(fixtureInput["warmIterations"]),
  clients: data.number(fixtureInput["clients"]),
  config: data.record(fixtureInput["config"]),
  operations: data.array(fixtureInput["operations"]).map(data.text),
  excluded: data.array(fixtureInput["excluded"]).map(data.text),
};

test("final fixture is bounded, offline, and excludes geometric claims", () => {
  assert.equal(fixture.samples, 5);
  assert.equal(fixture.warmIterations, 5);
  assert.equal(fixture.clients, 4);
  assert.equal(fixture.config["routing"], "queue");
  assert.ok(fixture.operations.includes("public-api-import"));
  assert.ok(fixture.operations.includes("mcp-tools-list"));
  assert.ok(fixture.excluded.includes("physical geometry"));
  assert.ok(fixture.excluded.includes("global broker and IPC"));
});

test("sample summary reports median, p95, and spread without removing outliers", () => {
  assert.deepEqual(summarizeSamples([9, 1, 5, 3, 7]), {
    count: 5,
    min: 1,
    median: 5,
    p95: 9,
    max: 9,
    spread: 8,
  });
  assert.equal(summarizeSamples([4, 1, 3, 2])?.median, 2.5);
  assert.equal(summarizeSamples([1, Number.NaN]), null);
  assert.equal(summarizeSamples([]), null);
});

test("final runtime qualification rejects a timeout or a missing fake queue call", () => {
  const ordinary = (name: string, phase: "cold" | "warm") => ({
    status: "pass",
    processCount: 1,
    data: {
      processCount: 1,
      childProcessLaunchCalls: 0,
      first:
        name === "api-import"
          ? {
              processLaunchCalls: 0,
              newActiveResources: [],
              newActiveHandles: [],
            }
          : undefined,
      warmSamples: Array.from(
        { length: phase === "warm" ? fixture.warmIterations : 0 },
        () => ({ operationMs: 1 }),
      ),
    },
  });
  const multi = (phase: "cold" | "warm") => {
    const statusCalls = phase === "cold" ? 1 : fixture.warmIterations + 1;
    const clients = Array.from({ length: fixture.clients }, (_, index) => ({
      status: "pass",
      data: {
        processCount: 1,
        childProcessLaunchCalls: 0,
        first: {
          clientId: `fixture-client-${index + 1}`,
          fakeQueue: { registerCalls: 1, queueSummaryCalls: statusCalls },
        },
        warmSamples: Array.from(
          { length: phase === "warm" ? fixture.warmIterations : 0 },
          () => ({ operationMs: 1, fakeRpcOperationMs: 1 }),
        ),
      },
    }));
    return {
      status: "pass",
      processCount: 1,
      data: {
        status: "pass",
        processCount: fixture.clients,
        clients,
        fakeQueue: {
          registerCalls: fixture.clients,
          queueSummaryCalls: fixture.clients * statusCalls,
        },
      },
    };
  };
  const runtime: import("../../scripts/refactor-benchmark-data").FinalRuntime =
    {
      version: 1,
      fixtureSha256: "fixture-only-sha256",
      isolation: {
        rootUnderOsTemp: true,
        uniqueOwnedSubdirectories: true,
        xdgRootsPerClient: true,
        noGlobalBrokerOrSdk: true,
      },
      workloads: Object.fromEntries(
        [
          "api-import",
          "help",
          "mcp",
          "catalog",
          "prepare-bundle",
          "multi-client",
        ].map((name) => [
          name,
          {
            coldRuns: Array.from({ length: fixture.samples }, () =>
              name === "multi-client" ? multi("cold") : ordinary(name, "cold"),
            ),
            warmRuns: Array.from({ length: fixture.samples }, () =>
              name === "multi-client" ? multi("warm") : ordinary(name, "warm"),
            ),
          },
        ]),
      ),
    };
  assert.equal(isCompleteFinalRuntime(runtime), true);
  const multiClient = runtime.workloads["multi-client"];
  assert.ok(multiClient);
  const firstRun = multiClient.coldRuns[0];
  assert.ok(firstRun?.data?.fakeQueue);
  assert.ok(typeof firstRun.data.fakeQueue.queueSummaryCalls === "number");
  firstRun.data.fakeQueue.queueSummaryCalls--;
  assert.equal(isCompleteFinalRuntime(runtime), false);
  firstRun.status = "timeout";
  assert.equal(isCompleteFinalRuntime(runtime), false);
});

test("multi-client MCP status uses only isolated injected QueueClient wrappers", () => {
  const directory = mkdtempSync(join(tmpdir(), "fmcad-final-bench-test-"));
  try {
    const project = join(directory, "project");
    const temp = join(directory, "tmp");
    mkdirSync(project);
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: join(directory, "home"),
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      NODE_ENV: fixture.nodeEnv,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
    };
    for (const path of [
      env.HOME,
      env.TMPDIR,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_DATA_HOME,
      env.XDG_STATE_HOME,
    ])
      mkdirSync(path);
    assert.equal(isWithin(tmpdir(), directory), true);
    const result = command(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(root, "scripts/refactor-baseline-benchmark.ts"),
        "--final-worker",
        root,
        "multi-client",
        "cold",
        project,
        "fixture-contract-client",
        "0",
      ],
      root,
      30000,
      undefined,
      env,
    );
    assert.equal(result.status, "pass", result.stderr);
    const measured = JSON.parse(result.stdout);
    assert.equal(measured.processCount, 1);
    assert.equal(measured.childProcessLaunchCalls, 0);
    assert.equal(measured.first.configReads, 1);
    assert.equal(
      measured.first.fakeQueue.mode,
      "injected QueueClient; no broker process or IPC",
    );
    assert.equal(measured.first.fakeQueue.registerCalls, 1);
    assert.equal(measured.first.fakeQueue.queueSummaryCalls, 1);
    assert.equal(measured.first.fakeQueue.wrapperCalls, 2);
    assert.ok(measured.first.fakeQueue.requestBytes > 0);
    assert.ok(measured.first.fakeQueue.responseBytes > 0);

    const multi = command(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(root, "scripts/refactor-baseline-benchmark.ts"),
        "--multi-worker",
        root,
        directory,
        project,
        "cold",
      ],
      root,
      60000,
      undefined,
      env,
    );
    assert.equal(multi.status, "pass", multi.stderr);
    const clients = data.workerData(data.json(multi.stdout));
    assert.equal(clients.status, "pass");
    assert.equal(clients.processCount, fixture.clients);
    assert.ok(
      clients.clients?.every(
        (client) =>
          client.data?.processCount === 1 &&
          client.data?.childProcessLaunchCalls === 0,
      ),
    );
    assert.equal(clients.processCount, fixture.clients);
    assert.equal(clients.fakeQueue?.registerCalls, fixture.clients);
    assert.equal(clients.fakeQueue?.queueSummaryCalls, fixture.clients);

    const apiImport = command(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(root, "scripts/refactor-baseline-benchmark.ts"),
        "--final-worker",
        root,
        "api-import",
        "cold",
        project,
        "fixture-contract-client",
        "0",
      ],
      root,
      30000,
      undefined,
      env,
    );
    assert.equal(apiImport.status, "pass", apiImport.stderr);
    const imported = JSON.parse(apiImport.stdout).first;
    assert.equal(imported.processLaunchCalls, 0);
    assert.equal(JSON.parse(apiImport.stdout).childProcessLaunchCalls, 0);
    assert.deepEqual(imported.newActiveResources, []);
    assert.deepEqual(imported.newActiveHandles, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed benchmark report fields never become successful measurements", () => {
  for (const value of [
    null,
    [],
    { workloads: { help: { coldRuns: "not-an-array" } } },
    {
      version: 1,
      workloads: {
        help: { coldRuns: [{ data: { processCount: "1" } }], warmRuns: [] },
      },
    },
  ])
    assert.equal(isCompleteFinalRuntime(value), false);
  assert.throws(
    () =>
      data.report({ measurements: { package: { data: [{ size: "1024" }] } } }),
    /finite benchmark/,
  );
  assert.throws(
    () => data.workerData({ first: { fakeQueue: { registerCalls: "1" } } }),
    /finite benchmark/,
  );
  assert.throws(
    () => data.workerData({ rssBytes: Number.NaN }),
    /finite benchmark/,
  );
  const missing = data.workerData({ processCount: 1 });
  assert.equal(missing.rssBytes, undefined);
  assert.equal(missing.first, undefined);
  assert.equal(missing.clients, undefined);
});
