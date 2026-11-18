import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installChildCliRuntime } from "./child-cli-runtime";
import { QueueScenarioBackend } from "./queue-backend";

interface RuntimeLoader {
  resolveQualifiedLiveRuntime(env: NodeJS.ProcessEnv): {
    readonly root: string;
    readonly fingerprint: string;
  };
}

interface LiveBroker {
  spawnSync(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
    },
  ): unknown;
}

interface ScenarioSummary {
  readonly suite: string;
  readonly status: string;
  readonly qualification: string;
  readonly childRuntime: {
    readonly root: string;
    readonly fingerprint: string;
  };
  readonly reports: Array<{
    readonly id: string;
    readonly status: string;
    readonly cleanup: string;
    readonly report: string;
  }>;
}

interface ScenarioReport {
  readonly owner: { readonly runId: string; readonly clientId: string };
  readonly directory: string;
  readonly status: string;
  readonly cleanup: string;
  readonly backendIdentity: string;
  readonly requests: Array<{
    readonly requestId: string;
    readonly phase: string;
    readonly result: {
      readonly state: string;
      readonly sdkSettled: boolean;
      readonly brokerReceipt?: {
        readonly requestId: string;
        readonly clientId: string;
        readonly jobId: string;
        readonly state: string;
      };
    };
  }>;
}

const projectRoot = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(projectRoot, "package.json"));

function fixtureRoot(t: TestContext): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-child-cli-unqualified-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeFixture(root: string, name: string): string {
  const runtime = path.join(root, name),
    dist = path.join(runtime, "dist"),
    source = path.join(dist, "src");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "package.json"),
    JSON.stringify({ name, version: "0.1.0", fmcadRuntimeLayout: 1 }),
  );
  fs.writeFileSync(
    path.join(source, "queue-instance.js"),
    `module.exports = { buildHash: () => ${JSON.stringify("a".repeat(64))} };\n`,
  );
  fs.writeFileSync(
    path.join(source, "queue-client.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, name + "-queue-client-loaded"))}, "loaded"); module.exports = {};\n`,
  );
  return runtime;
}

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as T;
}

test("child CLI runtime installs the prepared package and removes only its private prefix", () => {
  const runtime = installChildCliRuntime(projectRoot),
    prefix = path.resolve(runtime.root, "../../.."),
    loader = load("./tests/helpers/qualified-live-runtime") as RuntimeLoader;
  try {
    assert.notEqual(runtime.root, projectRoot);
    assert.equal(fs.lstatSync(runtime.root).isSymbolicLink(), false);
    const binding = loader.resolveQualifiedLiveRuntime({
      FMCAD_LIVE_RUNTIME_ROOT: runtime.root,
    });
    assert.equal(binding.root, runtime.root);
    assert.equal(binding.fingerprint, runtime.fingerprint);
    assert.equal(
      runtime.fingerprint,
      readJson<{ fingerprint: string }>(
        path.join(projectRoot, "dist/runtime-build.json"),
      ).fingerprint,
    );
  } finally {
    runtime.close();
  }
  assert.equal(fs.existsSync(prefix), false);
});

test("child CLI suite uses the installed runtime for the real simulator queue and cleans its fixture", () => {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  env["FMCAD_LIVE_RUNTIME_ROOT"] = path.join(
    os.tmpdir(),
    "fmcad-child-cli-unqualified-" + randomUUID(),
  );
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "dist/tests/scenarios/cli.js"),
      "--backend",
      "simulator",
      "--profile",
      "broker",
      "--protocol",
      "mcp",
      "--suite",
      "child-cli",
      "--concurrency",
      "1",
      "--owners",
      "1",
    ],
    {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `child-cli scenario failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  const summary = JSON.parse(result.stdout) as ScenarioSummary;
  assert.equal(summary.suite, "child-cli");
  assert.equal(summary.qualification, "broker");
  assert.equal(summary.status, "passed");
  assert.equal(fs.existsSync(summary.childRuntime.root), false);
  assert.equal(
    summary.childRuntime.fingerprint,
    readJson<{ fingerprint: string }>(
      path.join(projectRoot, "dist/runtime-build.json"),
    ).fingerprint,
  );
  assert.equal(summary.reports.length, 1);
  assert.equal(summary.reports[0]?.status, "passed");
  assert.equal(summary.reports[0]?.cleanup, "complete");

  const report = readJson<ScenarioReport>(summary.reports[0]!.report),
    directory = report.directory,
    legacyOutput = fs.readFileSync(
      path.join(directory, "legacy/stdout.log"),
      "utf8",
    ),
    lease = readJson<{ owner: { clientId: string } }>(
      path.join(directory, "legacy/lease.json"),
    ),
    receiptsDirectory = path.join(directory, "legacy/queue-receipts"),
    receipts = fs.readdirSync(receiptsDirectory).map((filename) =>
      readJson<{
        owner: { clientId: string };
        requestId: string;
        jobId: string;
      }>(path.join(receiptsDirectory, filename)),
    ),
    saveObservations = report.requests.filter(
      (request) => request.phase === "save-observe",
    ),
    cleanupObservations = report.requests.filter(
      (request) => request.phase === "cleanup-observe",
    );
  assert.match(legacyOutput, /# pass 1/u);
  assert.doesNotMatch(legacyOutput, /not ok/u);
  assert.equal(lease.owner.clientId, report.owner.clientId);
  assert.ok(
    report.backendIdentity.startsWith(
      `simulator:mcp:${summary.childRuntime.fingerprint}:http://127.0.0.1:`,
    ),
  );
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    assert.equal(receipt.owner.clientId, report.owner.clientId);
    assert.ok(receipt.jobId);
  }
  assert.ok(saveObservations.length > 0);
  assert.ok(cleanupObservations.length > 0);
  for (const observation of [...saveObservations, ...cleanupObservations]) {
    assert.equal(observation.result.state, "succeeded");
    assert.equal(observation.result.sdkSettled, true);
    assert.equal(
      observation.result.brokerReceipt?.clientId,
      report.owner.clientId,
    );
    assert.equal(
      observation.result.brokerReceipt?.requestId,
      observation.requestId,
    );
  }
});

test("Fusion rejects a simulator-only installed runtime binding before loading it", () => {
  assert.throws(
    () =>
      new QueueScenarioBackend(
        "fusion",
        "addin",
        new Set(),
        projectRoot,
        {},
        (file) => file,
        { root: "/unqualified", fingerprint: "a".repeat(64) },
      ),
    /Simulator runtime binding cannot be used for Fusion/u,
  );
});

test("missing, foreign, and unqualified child runtimes reject before SDK load or queue dispatch", (t) => {
  const root = fixtureRoot(t),
    mismatchRoot = path.join(root, "mismatch"),
    mismatch = runtimeFixture(mismatchRoot, "fmcad"),
    liveBroker = load("./tests/helpers/live-broker") as LiveBroker,
    childProcessModule = load("node:child_process") as {
      spawnSync: (...args: unknown[]) => unknown;
    },
    originalSpawnSync = childProcessModule.spawnSync,
    cliPath = path.join(projectRoot, "bin/fmcad.js");
  fs.writeFileSync(
    path.join(mismatch, "dist/runtime-build.json"),
    JSON.stringify({
      version: 1,
      algorithm: "sha256",
      fingerprint: "b".repeat(64),
      entrypoints: {
        "queue-worker": "src/queue-worker.js",
        "queue-autostart-worker": "src/queue-autostart-worker.js",
        "queue-broker": "src/queue-broker.js",
      },
    }),
  );
  let dispatches = 0;
  childProcessModule.spawnSync = (...args: unknown[]) => {
    dispatches++;
    return originalSpawnSync(...args);
  };
  try {
    const cases = [
      {
        env: { FMCAD_LIVE_CLIENT: "scenario:missing-runtime" },
        error:
          /FMCAD_LIVE_RUNTIME_ROOT must name the qualified installed runtime/u,
        marker: path.join(root, "missing-queue-client-loaded"),
      },
      {
        env: {
          FMCAD_LIVE_CLIENT: "scenario:foreign-runtime",
          FMCAD_LIVE_RUNTIME_ROOT: runtimeFixture(root, "foreign"),
        },
        error: /does not identify an installed fmcad runtime/u,
        marker: path.join(root, "foreign-queue-client-loaded"),
      },
      {
        env: {
          FMCAD_LIVE_CLIENT: "scenario:unqualified-runtime",
          FMCAD_LIVE_RUNTIME_ROOT: runtimeFixture(root, "fmcad"),
        },
        error: /Runtime build manifest is missing or unreadable/u,
        marker: path.join(root, "fmcad-queue-client-loaded"),
      },
      {
        env: {
          FMCAD_LIVE_CLIENT: "scenario:mismatched-runtime",
          FMCAD_LIVE_RUNTIME_ROOT: mismatch,
        },
        error: /Installed runtime bytes do not match/u,
        marker: path.join(mismatchRoot, "fmcad-queue-client-loaded"),
      },
    ];
    for (const value of cases) {
      assert.throws(
        () =>
          liveBroker.spawnSync(
            process.execPath,
            [cliPath, "document", "status", "--doc", "fixture"],
            { cwd: projectRoot, env: value.env, encoding: "utf8" },
          ),
        value.error,
      );
      assert.equal(fs.existsSync(value.marker), false);
    }
  } finally {
    childProcessModule.spawnSync = originalSpawnSync;
  }
  assert.equal(dispatches, 0);
});
