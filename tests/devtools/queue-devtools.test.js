"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const benchmark = require("../../scripts/benchmark-queue-idle");
const drain = require("../../scripts/drain-idle-maintenance");
const exporter = require("../../scripts/export-queue-phases");
const installer = require("../../scripts/install-queue-phases");
const projectLog = require("../../scripts/migrate-project-log");
const responses = require("../../scripts/migrate-project-responses");
const recovery = require("../../scripts/recover-local-build-preflight");
const start = require("../../scripts/start-installed-queue-phases");
const verify = require("../../scripts/verify-queue-phases");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-devtools-"));
  const home = path.join(directory, "home");
  const state = path.join(directory, "state");
  const temporary = path.join(directory, "tmp");
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  fs.mkdirSync(temporary);
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = state;
  process.env.TMPDIR = temporary;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, home, state, temporary };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function archiveFixture(file, entries) {
  const records = [];
  for (const [name, raw] of entries) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write("0000644\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    records.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    zlib.gzipSync(Buffer.concat([...records, Buffer.alloc(1024)])),
  );
}

test("all nine CommonJS launchers are inert when imported", (t) => {
  const f = fixture(t);
  const cadStateBefore = fs.existsSync(path.join(root, ".cad"));
  const scripts = [
    "benchmark-queue-idle",
    "drain-idle-maintenance",
    "export-queue-phases",
    "install-queue-phases",
    "migrate-project-log",
    "migrate-project-responses",
    "recover-local-build-preflight",
    "start-installed-queue-phases",
    "verify-queue-phases",
  ];
  const statements = scripts.map(
    (name) =>
      `require(${JSON.stringify(path.join(root, "scripts", name + ".js"))})`,
  );
  const result = require("node:child_process").spawnSync(
    process.execPath,
    ["-e", statements.join(";")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.home,
        XDG_STATE_HOME: f.state,
        TMPDIR: f.temporary,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(fs.readdirSync(f.state), []);
  assert.equal(fs.existsSync(path.join(root, ".cad")), cadStateBefore);
});

test("invalid local CLI input exits before creating state or evidence", (t) => {
  const f = fixture(t);
  const cases = [
    [
      "install-queue-phases.js",
      [],
      '{"state":"not_installed","code":"INVALID_ARGUMENT","message":"--stage and --archive are required"}',
    ],
    [
      "migrate-project-log.js",
      [],
      "Usage: node scripts/migrate-project-log.js PROJECT_DIRECTORY",
    ],
    ["migrate-project-responses.js", [], "--project is required"],
    ["export-queue-phases.js", ["--help"]],
    ["recover-local-build-preflight.js", []],
    ["start-installed-queue-phases.js", []],
    ["verify-queue-phases.js", ["--help"]],
  ];
  for (const [script, args, expectedStderr] of cases) {
    const result = require("node:child_process").spawnSync(
      process.execPath,
      [path.join(root, "scripts", script), ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: f.home,
          XDG_STATE_HOME: f.state,
          TMPDIR: f.temporary,
        },
      },
    );
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.equal(result.stdout, "", script);
    assert.notEqual(result.stderr, "", script);
    if (expectedStderr) assert.equal(result.stderr.trim(), expectedStderr);
  }
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test("idle benchmark uses the same fixed history and reports stable counters", (t) => {
  const f = fixture(t);
  // Stable counters match the b03f153 CommonJS baseline; only timing fields vary.
  const result = benchmark.benchmarkQueueIdle(f.directory);
  assert.deepEqual(
    {
      historyJobs: result.historyJobs,
      snapshotBytes: result.snapshotBytes,
      iterations: result.iterations,
      transactions: result.transactions,
    },
    {
      historyJobs: 3500,
      snapshotBytes: 15058576,
      iterations: 30,
      transactions: 0,
    },
  );
  assert.equal(Number.isFinite(result.elapsedMs), true);
  assert.equal(Number.isFinite(result.cpuMs), true);
  assert.equal(result.meanCheckMs, result.elapsedMs / result.iterations);
  const cli = require("node:child_process").spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/benchmark-queue-idle.js"),
      "--ignored-legacy-argument",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.home,
        XDG_STATE_HOME: f.state,
        TMPDIR: f.temporary,
      },
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const cliOutput = JSON.parse(cli.stdout);
  assert.deepEqual(
    {
      historyJobs: cliOutput.historyJobs,
      snapshotBytes: cliOutput.snapshotBytes,
      iterations: cliOutput.iterations,
      transactions: cliOutput.transactions,
    },
    {
      historyJobs: 3500,
      snapshotBytes: 15058576,
      iterations: 30,
      transactions: 0,
    },
  );
  assert.equal(cli.stderr, "");
});

test("idle maintenance workflow uses a fake broker and writes only into its fixture directory", async (t) => {
  const f = fixture(t);
  const directory = path.join(f.directory, "queue");
  fs.mkdirSync(directory);
  writeJson(path.join(directory, "queue-state.json"), {
    ...JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures/idle-queue-state.json"),
        "utf8",
      ),
    ),
    controlRequests: { prior: { paused: false } },
  });
  writeJson(path.join(directory, "broker.lock"), { pid: 1001 });
  const calls = [];
  let paused = false;
  const client = {
    async register() {
      calls.push(["register"]);
    },
    async call(action, values) {
      calls.push([action, values]);
      if (action === "status")
        return {
          active: null,
          blocked: null,
          lease: null,
          held: null,
          jobs: {},
          paused,
          buildHash: "fixture-build",
        };
      if (action === "control-status")
        return {
          activeOperations: 0,
          instanceId: "fixture-instance",
          generation: 4,
        };
      if (action === "pause") {
        paused = true;
        return { paused: true };
      }
      if (action === "stop") {
        fs.unlinkSync(path.join(directory, "broker.lock"));
        return { stopping: true };
      }
      throw new Error(`Unexpected fake broker command: ${action}`);
    },
  };
  const result = await drain.drainIdleMaintenance({
    client,
    directory,
    createId: (() => {
      const values = ["pause-id", "report-id"];
      return () => values.shift();
    })(),
    now: () => new Date("2026-10-30T12:00:00.000Z"),
    wait: async () => {},
  });
  assert.equal(
    result.reportFile,
    path.join(directory, "idle-maintenance-report-id.json"),
  );
  assert.equal(result.operatorPauseId, "pause-id");
  assert.equal(result.previousBuildHash, "fixture-build");
  assert.deepEqual(result.originalControlRequestIds, ["prior"]);
  assert.deepEqual(
    calls.map(([action]) => action),
    ["register", "status", "control-status", "pause", "status", "stop"],
  );
  assert.equal(fs.existsSync(path.join(directory, "broker.lock")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(result.reportFile, "utf8")).nativeCalls,
    0,
  );
});

test("installer preserves unknown-work and reconciliation fences", async () => {
  assert.throws(
    () =>
      installer.assertQuiescent({
        jobs: { unknown: { state: "needs_reconciliation" } },
      }),
    {
      code: "QUEUE_NOT_QUIESCENT",
    },
  );
  assert.throws(() => installer.assertQuiescent({ jobs: { unknown: null } }), {
    code: "QUEUE_NOT_QUIESCENT",
  });
  assert.throws(() => installer.assertQuiescent({ jobs: "unparseable" }), {
    code: "QUEUE_NOT_QUIESCENT",
  });
  assert.throws(
    () => installer.assertQuiescent({ active: "foreign-job", jobs: {} }),
    { code: "QUEUE_NOT_QUIESCENT" },
  );
  assert.doesNotThrow(() =>
    installer.assertQuiescent({
      active: null,
      blocked: null,
      lease: null,
      jobs: {},
    }),
  );
});

test("export creates a candidate only under a supplied offline destination", (t) => {
  const f = fixture(t);
  const projectRoot = path.join(f.directory, "source");
  const runtime = path.join(f.directory, "runtime");
  const destinationRoot = path.join(f.directory, "output");
  fs.mkdirSync(path.join(projectRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "src"), { recursive: true });
  for (const [relative, content] of [
    ["scripts/install-queue-phases.js", "fixture installer"],
    ["scripts/verify-queue-phases.js", "fixture verifier"],
    ["scripts/verify-queue-phases-python.py", "fixture python verifier"],
    ["docs/QUEUE_PHASES_20261020.md", "fixture docs"],
    ["src/fixture.js", "verified bytes"],
  ]) {
    const base = relative.startsWith("src/") ? runtime : projectRoot;
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const archive = path.join(f.directory, "baseline.tgz");
  archiveFixture(archive, [["src/fixture.js", "baseline"]]);
  const verification = path.join(f.directory, "verification.json");
  const report = {
    verified: true,
    testExitCode: 0,
    counts: { fail: 0, pass: 3 },
    runtime,
    afterBuildHash: "fixture-build",
    runtimeFiles: [{ path: "src/fixture.js", sha256: sha("verified bytes") }],
    testFiles: [],
    validationScope: "offline fixture",
  };
  writeJson(verification, report);
  const manifest = exporter.exportQueuePhases(
    { verification, archive },
    {
      projectRoot,
      destinationRoot,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      createId: () => "fixed-id",
      buildHash: () => "fixture-build",
    },
  );
  assert.equal(manifest.state, "verified_candidate_not_installed");
  assert.equal(manifest.fusionCalls, 0);
  assert.equal(manifest.passedTests, 3);
  assert.equal(
    fs.readFileSync(path.join(manifest.path, "files/src/fixture.js"), "utf8"),
    "verified bytes",
  );
  assert.equal(
    fs.readFileSync(
      path.join(manifest.path, "scripts/install-queue-phases.js"),
      "utf8",
    ),
    "fixture installer",
  );
  assert.deepEqual(
    exporter.parseArguments([
      "--verification",
      verification,
      "--archive",
      archive,
    ]),
    { verification, archive },
  );
});

test("legacy project log migration is byte-preserving and confined to an explicit fixture", (t) => {
  const f = fixture(t);
  const project = path.join(f.directory, "project");
  fs.mkdirSync(project);
  fs.copyFileSync(
    path.join(__dirname, "fixtures/project-log.txt"),
    path.join(project, "fmcad.log"),
  );
  const original = fs.readFileSync(path.join(project, "fmcad.log"), "utf8");
  const latestHour = original.slice(original.indexOf("2026-10-30T13:"));
  const manifest = projectLog.migrate(project);
  const logs = path.join(project, ".cad/logs");
  assert.equal(fs.existsSync(path.join(project, "fmcad.log")), false);
  assert.equal(
    fs.readFileSync(path.join(logs, "fmcad-2026-10-30_12.log"), "utf8"),
    original.split("2026-10-30T13:")[0],
  );
  assert.equal(
    fs.readFileSync(path.join(logs, "fmcad.log"), "utf8"),
    latestHour,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(logs, "migration.json"), "utf8"))
      .sha256,
    manifest.sha256,
  );
  assert.equal(manifest.lines, 2);
});

test("project response migration uses a private queue fixture for preview and apply", (t) => {
  const f = fixture(t);
  const project = path.join(f.directory, "project");
  const directory = path.join(f.directory, "queue");
  const jobId = "job_fixture_1";
  const jobDirectory = path.join(directory, "jobs", jobId);
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  fs.mkdirSync(jobDirectory, { recursive: true });
  fs.writeFileSync(path.join(jobDirectory, "stdout.txt"), "offline stdout");
  fs.writeFileSync(path.join(jobDirectory, "stderr.txt"), "offline stderr");
  writeJson(path.join(directory, "queue-state.json"), {
    jobs: {
      [jobId]: { id: jobId, state: "succeeded", request: { cwd: project } },
    },
  });
  const preview = responses.migrateResponses(
    ["--project", project, "--queue-dir", directory],
    directory,
  );
  assert.equal(preview.applied, false);
  assert.equal(preview.files, 2);
  assert.equal(fs.existsSync(path.join(jobDirectory, "stdout.txt")), true);
  const report = path.join(f.directory, "response-migration.json");
  const applied = responses.migrateResponses(
    [
      "--project",
      project,
      "--queue-dir",
      directory,
      "--report",
      report,
      "--apply",
    ],
    directory,
  );
  assert.equal(applied.applied, true);
  assert.equal(
    applied.bytes,
    "offline stdout".length + "offline stderr".length,
  );
  assert.equal(
    fs.readFileSync(
      path.join(project, ".cad/results", jobId, "stdout.txt"),
      "utf8",
    ),
    "offline stdout",
  );
  assert.equal(fs.existsSync(path.join(jobDirectory, "stdout.txt")), false);
  assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).files.length, 2);
});

test("preflight inspector accepts a matching synthetic build-change witness", (t) => {
  const f = fixture(t);
  const queue = path.join(f.directory, "queue");
  const sourceRoot = path.join(f.directory, "runtime");
  const expected = { ...recovery.EXPECTED };
  const instance = {
    pid: 202,
    birth: "fixture-birth",
    version: "Fusion fixture",
  };
  const coreFiles = recovery.CORE.map((file) => {
    const content =
      file === "src/queue-broker.js"
        ? "// synthetic baseline producer\nif (buildHash() !== codeHash) fail('BUILD_CHANGED', 'Pinned executable build changed');\nconst actual = await probe(client\nif (job) hold(job, error.code || 'BROKER_EXECUTION_FAILED')\n"
        : `fixture source for ${file}\n`;
    const target = path.join(sourceRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return [file, content];
  });
  const archive = path.join(f.directory, "baseline.tgz");
  archiveFixture(archive, coreFiles);
  const bindingId = "b4df0c45-64ce-47e8-8c6a-792e72af4711";
  const jobDirectory = path.join(queue, "jobs", expected.jobId);
  fs.mkdirSync(jobDirectory, { recursive: true });
  writeJson(path.join(queue, "broker.lock"), {
    pid: 101,
    birth: "fixture-broker-birth",
    nonce: expected.brokerNonce,
  });
  writeJson(path.join(queue, "instance.json"), {
    buildHash: expected.buildHash,
    instance,
  });
  writeJson(path.join(queue, "queue-state.json"), {
    active: expected.jobId,
    blocked: { id: expected.jobId, reason: "BUILD_CHANGED" },
    lease: { id: expected.sequenceId, clientId: expected.clientId },
    paused: true,
    controlRequests: { request: { paused: true } },
    jobs: {
      [expected.jobId]: {
        id: expected.jobId,
        requestId: expected.requestId,
        state: "needs_reconciliation",
        clientId: expected.clientId,
        sequenceId: expected.sequenceId,
        kind: "command",
        request: { argv: ["run"], buildHash: expected.buildHash },
        details: { reason: "BUILD_CHANGED" },
        dispatch: { dispatchCount: 0, rpcCount: 0, completedCount: 0 },
      },
    },
  });
  writeJson(path.join(jobDirectory, "preflight-start.json"), {
    version: 2,
    jobId: expected.jobId,
    buildHash: expected.buildHash,
    binding: {
      jobId: expected.jobId,
      buildHash: expected.buildHash,
      rpcId: bindingId,
      requestHash: sha(`preflight:${expected.jobId}:${bindingId}`),
    },
    receipt: path.join(jobDirectory, `preflight-${bindingId}.receipt.json`),
    instance,
  });
  const proof = recovery.inspect({
    dir: queue,
    root: sourceRoot,
    archive,
    status: {
      buildHash: expected.buildHash,
      held: "BUILD_CHANGED",
      active: expected.jobId,
      stopping: false,
      lease: { id: expected.sequenceId },
    },
    control: { instanceId: expected.brokerNonce, activeOperations: 0 },
    expected,
    alive: () => true,
    command: () => [path.join(sourceRoot, "src/queue-autostart-worker.js")],
    currentBuildHash: () => "fixture-current-build",
  });
  assert.equal(proof.classification, "not_started");
  assert.equal(proof.fusionCalls, 0);
  assert.equal(proof.currentBuildHash, "fixture-current-build");
  assert.equal(proof.jobId, expected.jobId);
});

test("installed readiness accepts fixture evidence with a fake paused broker", async (t) => {
  const f = fixture(t);
  const directory = path.join(f.directory, "queue");
  const instance = {
    pid: 77,
    birth: "fixture-instance-birth",
    version: "Fusion fixture",
  };
  fs.mkdirSync(directory);
  writeJson(path.join(directory, "instance.json"), { instance });
  const evidenceFile = path.join(f.directory, "handoff-evidence.json");
  writeJson(evidenceFile, { instance });
  const handoff = {
    evidenceFile,
    result: { code: "OPERATOR_LOCAL_PREFLIGHT_NOT_STARTED" },
    pendingRemoteRequests: 0,
    brokerStopped: true,
    originallyPaused: true,
  };
  const clientCalls = [];
  const client = {
    async register(options) {
      clientCalls.push(["register", options]);
    },
    async call(action) {
      clientCalls.push([action]);
      return {
        buildHash: "fixture-build",
        active: null,
        blocked: null,
        held: null,
        lease: null,
        paused: true,
        revision: 4,
      };
    },
  };
  const result = await start.startInstalledQueuePhases(
    {
      root: f.directory,
      directory,
      verificationFile: path.join(f.directory, "verification.json"),
      handoff,
      installation: {
        state: "installed",
        files: [],
        afterBuildHash: "fixture-build",
      },
      verification: {
        runtime: f.directory,
        installedRuntimeTested: true,
        verified: true,
        afterBuildHash: "fixture-build",
      },
    },
    {
      buildHash: () => "fixture-build",
      loadConfig: () => ({
        cfg: { routing: "queue" },
        path: path.join(f.directory, "config.json"),
      }),
      createClient: () => client,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      createId: () => "ready-id",
      spawn: () => {
        throw new Error(
          "Metadata command must not run for an originally paused queue",
        );
      },
    },
  );
  assert.equal(result.resumed, false);
  assert.equal(result.fusionRestarted, false);
  assert.deepEqual(
    clientCalls.map(([action]) => action),
    ["register", "status", "status"],
  );
  assert.equal(fs.existsSync(result.reportFile), true);
});

test("verification helpers hash only a fixture runtime and summarize controlled test output", (t) => {
  const f = fixture(t);
  const runtime = path.join(f.directory, "runtime");
  const installed = path.join(f.directory, "installed");
  const output = path.join(f.directory, "reports");
  const state = path.join(f.directory, "offline-state");
  fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "src"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "assets"), { recursive: true });
  fs.mkdirSync(path.join(installed, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), "{}");
  fs.writeFileSync(path.join(runtime, "bin/fake.js"), "fixture");
  fs.writeFileSync(path.join(runtime, "src/fake.js"), "fixture");
  fs.writeFileSync(path.join(runtime, "assets/fake.py"), "fixture");
  fs.writeFileSync(
    path.join(installed, "scripts/install-queue-phases.js"),
    "fixture installer",
  );
  fs.writeFileSync(path.join(installed, "package-lock.json"), "{}");
  for (const relative of [
    ...installer.RUNTIME_FILES,
    ...installer.TEST_FILES,
  ]) {
    const file = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture: ${relative}`);
  }
  const files = verify.executableFiles(runtime);
  assert.equal(
    files.length,
    4 +
      installer.RUNTIME_FILES.filter((file) => file.startsWith("src/")).length +
      installer.RUNTIME_FILES.filter((file) => file.startsWith("assets/"))
        .length,
  );
  assert.equal(
    files.some((file) => file.path === "package.json"),
    true,
  );
  assert.equal(
    files.some((file) => file.path === "src/fake.js"),
    true,
  );
  assert.deepEqual(
    verify.parseTestCounts(
      "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n",
    ),
    {
      tests: 2,
      pass: 2,
      fail: 0,
      cancelled: 0,
      skipped: 0,
    },
  );
  const report = verify.verifyQueuePhases(
    { runtime },
    {
      installedRoot: installed,
      outputDirectory: output,
      stateDirectory: state,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      buildHash: () => "fixture-build",
      spawn: (args, options) => {
        assert.equal(options.cwd, runtime);
        assert.equal(options.env.XDG_STATE_HOME, state);
        assert.equal(args[0], "--test");
        return {
          pid: 41,
          output: [],
          stdout: "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n",
          stderr: "",
          status: 0,
          signal: null,
          error: undefined,
        };
      },
    },
  );
  assert.equal(report.verified, true);
  assert.equal(report.installedRuntimeTested, false);
  assert.equal(report.output, output);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, "verification.json"), "utf8"))
      .fusionCalls,
    0,
  );
});
