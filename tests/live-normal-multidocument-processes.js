"use strict";

// Runs independent real runner processes against the already-running shared
// broker. It never starts, reloads, pauses, or replaces the broker/runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const runtime = path.resolve(
  process.env.FMCAD_LIVE_RUNTIME || path.join(__dirname, ".."),
);
const runtimeRequire = createRequire(path.join(runtime, "src/queue-client.js"));
const clientModule = runtimeRequire("./queue-client");
const { loadConfig } = runtimeRequire("./config");
const { buildHash, processBirth, fusionPath } =
  runtimeRequire("./queue-instance");
const { QueueClient, inputFiles } = clientModule;
const sourceRoot = path.resolve(__dirname, "..");
const runnerScript = path.join(
  sourceRoot,
  "dist/tests/live-normal-multidocument.js",
);

function parseOptions(argv) {
  let protocol,
    processes = 2,
    concurrency = 2;
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--run") {
      if (seen.has(flag)) throw new Error("Duplicate runner option: " + flag);
      seen.add(flag);
      continue;
    }
    if (!["--protocol", "--processes", "--concurrency"].includes(flag))
      throw new Error("Unknown multi-runner option: " + flag);
    if (seen.has(flag)) throw new Error("Duplicate runner option: " + flag);
    seen.add(flag);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(flag + " requires a value");
    if (flag === "--protocol") {
      if (!["mcp", "addin"].includes(value))
        throw new Error("--protocol must be mcp or addin");
      protocol = value;
    } else {
      if (!/^[1-9][0-9]*$/.test(value))
        throw new Error(flag + " must be a positive safe integer");
      const number = Number(value);
      if (!Number.isSafeInteger(number))
        throw new Error(flag + " must be a positive safe integer");
      if (flag === "--processes") processes = number;
      else concurrency = number;
    }
  }
  if (!seen.has("--run")) throw new Error("Explicit --run required");
  if (processes < 2 || processes > 10)
    throw new Error("--processes must be between 2 and 10");
  if (![1, 2, 10].includes(concurrency))
    throw new Error("--concurrency must be one of 1, 2, or 10");
  return { protocol, processes, concurrency };
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value;
}

function state(value) {
  const data = object(value, "Expected native document inventory");
  assert.ok(data.active === null || typeof data.active === "string");
  assert.ok(Array.isArray(data.documents));
  const documents = data.documents.map((item) => {
    const row = object(item, "Expected document row");
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.name, "string");
    assert.equal(typeof row.saved, "boolean");
    assert.equal(typeof row.modified, "boolean");
    return {
      id: row.id,
      name: row.name,
      saved: row.saved,
      modified: row.modified,
    };
  });
  return {
    active: data.active,
    documents: documents.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function exactState(before, after) {
  assert.deepEqual(state(after), state(before));
}

function groupManifest(
  id,
  protocol,
  fingerprint,
  concurrency,
  baseline,
  count,
) {
  const runners = Array.from({ length: count }, () => {
    const runnerId = randomUUID();
    return {
      id: runnerId,
      documentNames: Array.from(
        { length: concurrency },
        (_, index) =>
          "FMCAD_MULTI_" + runnerId.replaceAll("-", "_") + "_" + index,
      ),
    };
  });
  return {
    version: 1,
    id,
    protocol,
    buildHash: fingerprint,
    ownerCount: concurrency,
    baseline: state(baseline),
    runners,
  };
}

function globalConcurrency(reports) {
  const intervals = reports.flatMap((report) => report.sdkIntervals || []);
  const events = intervals
    .flatMap((interval) => [
      { time: interval.started, delta: 1 },
      { time: interval.finished, delta: -1 },
    ])
    .sort((left, right) => left.time - right.time || left.delta - right.delta);
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    current += event.delta;
    maximum = Math.max(maximum, current);
  }
  assert.equal(current, 0);
  return { maximum, intervals: intervals.length };
}

function verifyRunnerReports(manifest, reports, identities) {
  assert.equal(reports.length, manifest.runners.length);
  assert.equal(
    new Set(identities.map((identity) => identity.pid)).size,
    identities.length,
    "Runner PIDs must be distinct",
  );
  assert.equal(
    new Set(identities.map((identity) => identity.pid + ":" + identity.birth))
      .size,
    identities.length,
    "Runner PID/birth identities must be distinct",
  );
  assert.ok(
    identities.every(
      (identity) =>
        typeof identity.birth === "string" && identity.birth.length > 0,
    ),
    "Runner births must be recorded, but clock ticks need not be unique across PIDs",
  );
  for (let index = 0; index < reports.length; index++) {
    const report = object(reports[index], "Missing runner report");
    const runner = manifest.runners[index];
    assert.equal(report.runId, runner.id);
    assert.equal(report.status, "passed", report.error || "Runner failed");
    assert.equal(report.buildHash, manifest.buildHash);
    assert.deepEqual(report.processIdentity, identities[index]);
    assert.equal(report.processGroup?.id, manifest.id);
    assert.equal(report.processGroup?.runnerId, runner.id);
    assert.equal(report.documents.length, manifest.ownerCount);
    assert.deepEqual(
      report.documents.map((document) => document.name).sort(),
      [...runner.documentNames].sort(),
    );
    assert.equal(report.cleanup?.length, manifest.ownerCount);
    for (let owner = 0; owner < manifest.ownerCount; owner++) {
      const document = report.documents[owner];
      const receipt = object(report.cleanup[owner], "Missing close receipt");
      assert.equal(receipt.closed, true);
      assert.equal(receipt.creationId, document.creationId);
      assert.equal(receipt.active, manifest.baseline.active);
    }
    assert.ok(
      report.receipts.every(
        (receipt) =>
          receipt.job &&
          receipt.result?.job?.id === receipt.job.id &&
          receipt.result?.job?.requestId === receipt.requestId &&
          receipt.result?.job?.clientId === receipt.clientId &&
          receipt.result?.execution?.sdkSettled === true,
      ),
      "Every original request must retain its owner-bound terminal receipt",
    );
  }
}

function persist(file, value) {
  const temporary = file + ".new";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}

function readMarker(stdout) {
  assert.equal(typeof stdout, "string");
  const markers = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  assert.equal(markers.length, 1, "Expected one read-only snapshot result");
  return state(JSON.parse(markers[0].slice("FMCAD_RESULT ".length)));
}

async function capture(queue, cfg, directory, requestId, fingerprint) {
  const filename = path.join(directory, requestId + ".py");
  fs.writeFileSync(
    filename,
    "import adsk.core, json\n" +
      "def run(context: str):\n" +
      "    a=adsk.core.Application.get()\n" +
      "    print('FMCAD_RESULT '+json.dumps(dict(active=a.activeDocument.creationId if a.activeDocument else None, documents=sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],key=lambda d:d['id']))))\n",
    { flag: "wx", mode: 0o600 },
  );
  const argv = ["run", filename, "--readonly"];
  const job = await queue.submit({
    requestId,
    kind: "command",
    argv,
    cwd: directory,
    timeoutMs: 180000,
    backend: cfg.backend,
    buildHash: fingerprint,
    inputFiles: inputFiles(argv, directory),
    description: "Read-only independent-runner document inventory",
  });
  const result = await queue.wait(job.id);
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.requestId, requestId);
  assert.equal(result.job.clientId, queue.auth.clientId);
  assert.equal(result.execution.sdkSettled, true);
  assert.equal(result.job.state, "succeeded", JSON.stringify(result));
  return { state: readMarker(result.stdout), receipt: { job, result } };
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code: code ?? 1, signal: signal || null }),
    );
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminalStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "needs_reconciliation",
]);

function readReport(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      return null;
    return object(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // The runner publishes by rename; a transient read during its first write
    // is just not-yet-ready evidence.
    return null;
  }
}

async function waitForGroupReadJobs(children, readOriginal) {
  for (;;) {
    let ready = true;
    const observations = [];
    for (const entry of children) {
      if (entry.child.exitCode !== null)
        throw new Error("A runner exited before submitting its baseline read");
      const report = readReport(path.join(entry.directory, "report.json"));
      const receipt = report?.receipts?.find(
        (row) => row.phase === "group-before",
      );
      if (!receipt?.job) {
        ready = false;
        continue;
      }
      const job = await readOriginal(receipt);
      const rpcCount = Number(job.dispatch?.rpcCount || 0);
      if (
        ["preparing", "processing"].includes(String(job.state)) &&
        rpcCount === 0
      ) {
        ready = false;
        continue;
      }
      assert.equal(
        job.state,
        "queued",
        "Runner read must wait behind the hold",
      );
      assert.equal(job.clientId, receipt.clientId);
      assert.equal(job.requestId, receipt.requestId);
      assert.equal(rpcCount, 0);
      observations.push({
        runnerId: entry.runner.id,
        pid: entry.child.pid,
        clientId: receipt.clientId,
        requestId: receipt.requestId,
        jobId: job.id,
        state: job.state,
        sdkRequestsSent: rpcCount,
      });
    }
    if (ready) return observations;
    await delay(25);
  }
}

function readOnlyProgram(directory, requestId, body) {
  const filename = path.join(directory, requestId + ".py");
  const source =
    "import adsk.core, json, time\n" +
    "DOC_NAME = None\n" +
    "def run(context: str):\n" +
    body
      .split("\n")
      .map((line) => "    " + line)
      .join("\n") +
    "\n";
  fs.writeFileSync(filename, source, { flag: "wx", mode: 0o600 });
  return { filename, argv: ["run", filename, "--readonly"] };
}

async function submitWithResponseRecovery(queue, input) {
  try {
    return await queue.submit(input);
  } catch (error) {
    assert.equal(error?.code, "QUEUE_IPC_RESPONSE_LOST");
    const original = object(
      await queue.call("find-request", { requestId: input.requestId }),
    );
    const job = object(original.job);
    assert.equal(job.requestId, input.requestId);
    assert.equal(job.clientId, queue.auth.clientId);
    return job;
  }
}

async function submitReadOnly(
  queue,
  cfg,
  directory,
  requestId,
  body,
  fingerprint,
) {
  const { argv } = readOnlyProgram(directory, requestId, body);
  return queue.submit({
    requestId,
    kind: "command",
    argv,
    cwd: directory,
    timeoutMs: 180000,
    backend: cfg.backend,
    buildHash: fingerprint,
    inputFiles: inputFiles(argv, directory),
    description: "Read-only independent-client recovery probe: " + requestId,
  });
}

async function observeJob(queue, jobId, accept) {
  for (;;) {
    const value = object(await queue.call("result", { jobId }));
    const job = object(value.job);
    if (accept(job, value)) return { job, value };
    if (terminalStates.has(String(job.state)))
      throw new Error(
        "Original probe job reached an unexpected terminal state: " +
          JSON.stringify(job),
      );
    await delay(25);
  }
}

async function waitWithResponseRecovery(queue, jobId, requestId) {
  try {
    return await queue.wait(jobId);
  } catch (error) {
    assert.equal(error?.code, "QUEUE_IPC_RESPONSE_LOST");
    const original = await queue.findRequest(requestId);
    assert.equal(original?.job?.id, jobId);
    assert.equal(original.job.requestId, requestId);
    assert.equal(original.job.clientId, queue.auth.clientId);
    return queue.wait(jobId);
  }
}

async function runFaultProbe({
  cfg,
  directory,
  groupId,
  fingerprint,
  processes,
  releaseRunners,
  abortRunners,
  summary,
  save,
}) {
  const clients = ["hold", "cancel", "lost", "continuation"].map(
    (role) =>
      new QueueClient("live:multidoc-fault:" + groupId + ":" + role, {
        cfg: { ...cfg, queue: { ...cfg.queue, autoStart: false } },
      }),
  );
  const [holdQueue, cancelQueue, lostQueue, continuationQueue] = clients;
  assert.ok(holdQueue && cancelQueue && lostQueue && continuationQueue);
  await Promise.all(
    clients.map((client) => client.register({ autoStart: false })),
  );
  const ids = {
    hold: groupId + ":fault-hold",
    cancel: groupId + ":fault-cancel",
    lost: groupId + ":fault-lost-client-response",
    continuation: groupId + ":fault-continuation",
  };
  summary.faultProbe = {
    status: "running",
    clientIds: clients.map((client) => client.auth.clientId),
    requestIds: ids,
    responseDrops: [],
  };
  save();
  let runnersReleased = false;
  const readers = new Map();
  const holdRelease = path.join(directory, "fault-hold-release.json");
  const releaseHold = () => {
    if (!fs.existsSync(holdRelease))
      persist(holdRelease, { groupId, state: "released" });
  };
  try {
    const holdJob = await submitReadOnly(
      holdQueue,
      cfg,
      directory,
      ids.hold,
      `import os
deadline=time.monotonic()+150
while not os.path.exists(${JSON.stringify(fusionPath(holdRelease))}):
    if time.monotonic()>deadline: raise RuntimeError('Original hold was not released before its bounded deadline')
    time.sleep(0.05)
print("FMCAD_MULTI_PROCESS_HOLD_SETTLED")`,
      fingerprint,
    );
    summary.faultProbe.holdJob = holdJob;
    save();
    const started = await observeJob(
      holdQueue,
      holdJob.id,
      (job) =>
        ["running", "sending"].includes(String(job.state)) &&
        Number(job.dispatch?.rpcCount || 0) > 0,
    );
    summary.faultProbe.holdStarted = started.job;
    releaseRunners();
    runnersReleased = true;
    summary.faultProbe.queuedRunnerProcesses = await waitForGroupReadJobs(
      processes,
      async (receipt) => {
        let reader = readers.get(receipt.clientId);
        if (!reader) {
          reader = new QueueClient(receipt.clientId, {
            cfg: { ...cfg, queue: { ...cfg.queue, autoStart: false } },
            existingCredentialsOnly: true,
          });
          readers.set(receipt.clientId, reader);
        }
        const current = await reader.call("result", { jobId: receipt.job.id });
        return current.job;
      },
    );

    await assert.rejects(
      cancelQueue.call("cancel", { jobId: holdJob.id }),
      (error) => error && error.code === "NOT_OWNER",
      "A foreign client must not cancel the live owner’s read-only turn",
    );
    summary.faultProbe.foreignCancel = {
      rejected: true,
      code: "NOT_OWNER",
      targetJobId: holdJob.id,
      targetClientId: holdQueue.auth.clientId,
      callerClientId: cancelQueue.auth.clientId,
    };
    const cancelJob = await submitReadOnly(
      cancelQueue,
      cfg,
      directory,
      ids.cancel,
      'print("FMCAD_CANCEL_MUST_NOT_DISPATCH")',
      fingerprint,
    );
    const queuedCancel = await observeJob(
      cancelQueue,
      cancelJob.id,
      (job) =>
        job.state === "queued" && Number(job.dispatch?.rpcCount || 0) === 0,
    );
    const cancelled = object(
      await cancelQueue.call("cancel", { jobId: cancelJob.id }),
    );
    assert.equal(cancelled.id, cancelJob.id);
    assert.equal(cancelled.clientId, cancelQueue.auth.clientId);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.dispatch?.rpcCount || 0, 0);
    summary.faultProbe.cancelled = {
      job: cancelled,
      beforeCancel: queuedCancel.job,
      executionNotSent: true,
    };
    save();

    const rawCall = lostQueue.call.bind(lostQueue);
    let dropSubmit = true;
    let dropResult = true;
    let originalLostJobId;
    lostQueue.call = async (action, values = {}) => {
      const value = await rawCall(action, values);
      if (
        action === "submit" &&
        values.request?.requestId === ids.lost &&
        dropSubmit
      ) {
        dropSubmit = false;
        originalLostJobId = value.id;
        summary.faultProbe.responseDrops.push("submit");
        save();
        throw Object.assign(new Error("Injected lost submit acknowledgement"), {
          code: "QUEUE_IPC_RESPONSE_LOST",
        });
      }
      if (
        action === "result" &&
        values.jobId === originalLostJobId &&
        dropResult
      ) {
        dropResult = false;
        summary.faultProbe.responseDrops.push("result");
        save();
        throw Object.assign(new Error("Injected lost result response"), {
          code: "QUEUE_IPC_RESPONSE_LOST",
        });
      }
      return value;
    };
    const recoveredAdmission = await submitWithResponseRecovery(lostQueue, {
      requestId: ids.lost,
      ...(() => {
        const { argv } = readOnlyProgram(
          directory,
          ids.lost,
          'print("FMCAD_LOST_RESPONSE_ORIGINAL_JOB")',
        );
        return {
          kind: "command",
          argv,
          cwd: directory,
          timeoutMs: 180000,
          backend: cfg.backend,
          buildHash: fingerprint,
          inputFiles: inputFiles(argv, directory),
          description:
            "Observe one original job after a dropped client response",
        };
      })(),
    });
    assert.equal(recoveredAdmission.id, originalLostJobId);
    const followerJob = await submitReadOnly(
      continuationQueue,
      cfg,
      directory,
      ids.continuation,
      'print("FMCAD_SECOND_OWNER_CONTINUED")',
      fingerprint,
    );
    releaseHold();
    const [holdResult, lostResult, followerResult, cancelledResult] =
      await Promise.all([
        holdQueue.wait(holdJob.id),
        waitWithResponseRecovery(lostQueue, recoveredAdmission.id, ids.lost),
        continuationQueue.wait(followerJob.id),
        cancelQueue.wait(cancelJob.id),
      ]);
    assert.equal(holdResult.job.state, "succeeded");
    assert.equal(holdResult.execution.sdkSettled, true);
    assert.equal(lostResult.job.id, originalLostJobId);
    assert.equal(lostResult.job.requestId, ids.lost);
    assert.equal(lostResult.job.clientId, lostQueue.auth.clientId);
    assert.equal(lostResult.job.state, "succeeded");
    assert.equal(lostResult.job.dispatch?.rpcCount, 1);
    assert.equal(lostResult.execution.sdkSettled, true);
    assert.equal(followerResult.job.clientId, continuationQueue.auth.clientId);
    assert.equal(followerResult.job.state, "succeeded");
    assert.equal(followerResult.execution.sdkSettled, true);
    assert.equal(cancelledResult.job.state, "cancelled");
    assert.deepEqual(summary.faultProbe.responseDrops, ["submit", "result"]);
    summary.faultProbe.receipts = {
      hold: holdResult.job,
      cancelled: cancelledResult.job,
      lostResponseRecovered: lostResult.job,
      secondOwnerContinuation: followerResult.job,
    };
    summary.faultProbe.status = "passed";
    save();
    return summary.faultProbe;
  } catch (error) {
    summary.faultProbe.status = "failed";
    summary.faultProbe.error =
      error instanceof Error ? error.message : String(error);
    if (!runnersReleased) abortRunners();
    save();
    throw error;
  } finally {
    releaseHold();
    readers.forEach((reader) => reader.dispose());
    clients.forEach((client) => client.dispose());
  }
}

async function waitForRunnerReadiness(children) {
  for (;;) {
    if (children.some((entry) => entry.child.exitCode !== null))
      throw new Error("An independent runner exited before readiness");
    const ready = children.every((entry) => {
      const value = readReport(entry.readyFile);
      return (
        value &&
        value.runId === entry.runner.id &&
        value.pid === entry.child.pid &&
        typeof value.buildHash === "string"
      );
    });
    if (ready) return;
    await delay(25);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const { cfg } = loadConfig({ routing: "queue" });
  const protocol = options.protocol || cfg.backend;
  assert.ok(["mcp", "addin"].includes(protocol));
  assert.equal(
    cfg.backend,
    protocol,
    "The requested protocol must match configuration; no broker start or switch is attempted",
  );
  assert.ok(fs.statSync(runnerScript).isFile(), "Build live runner first");

  const id = randomUUID();
  const root = path.join("/tmp/opencode/fmcad-multidocument-processes", id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const runnerRoot = path.join(root, "runners");
  fs.mkdirSync(runnerRoot, { mode: 0o700 });
  const queue = new QueueClient("live:multidoc-orchestrator:" + id, {
    cfg: { ...cfg, queue: { ...cfg.queue, autoStart: false } },
  });
  const summary = {
    id,
    protocol,
    concurrency: options.concurrency,
    processes: options.processes,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
    runtimeRoot: runtime,
    orchestratorIdentity: { pid: process.pid, birth: processBirth() },
    buildHash: buildHash(),
    status: "running",
    runners: [],
  };
  const summaryFile = path.join(root, "summary.json");
  const save = () => persist(summaryFile, summary);
  let children = [];
  try {
    await queue.register({ autoStart: false });
    const status = object(await queue.call("status"), "Missing broker status");
    assert.equal(status.buildHash, summary.buildHash);
    assert.equal(status.blocked ?? null, null, "Broker is blocked");
    assert.equal(status.held ?? null, null, "Broker retains unresolved work");
    summary.historicalUnknownJobCount = status.historicalUnknownJobCount;
    const brokerStatus = object(
      await queue.call("queue-summary"),
      "Missing broker summary",
    );
    assert.equal(brokerStatus.buildHash, summary.buildHash);
    assert.equal(brokerStatus.admissionScope, "normal-multidocument");

    const baselineCapture = await capture(
      queue,
      cfg,
      root,
      id + ":baseline",
      summary.buildHash,
    );
    summary.baseline = baselineCapture.state;
    summary.baselineReceipt = baselineCapture.receipt;
    const manifest = groupManifest(
      id,
      protocol,
      summary.buildHash,
      options.concurrency,
      baselineCapture.state,
      options.processes,
    );
    const manifestFile = path.join(root, "group.json");
    persist(manifestFile, manifest);
    summary.manifest = manifestFile;
    const startFile = path.join(root, "runners-start.json");
    const abortFile = path.join(root, "runners-abort.json");
    const releaseRunners = () =>
      persist(startFile, { groupId: id, state: "released" });
    const abortRunners = () => {
      if (!fs.existsSync(startFile) && !fs.existsSync(abortFile))
        persist(abortFile, { groupId: id, state: "aborted-before-sdk" });
    };
    summary.startGate = { startFile, abortFile };
    save();

    children = manifest.runners.map((runner) => {
      const directory = path.join(runnerRoot, runner.id);
      fs.mkdirSync(directory, { mode: 0o700 });
      const readyFile = path.join(root, "runner-ready-" + runner.id + ".json");
      const stdout = fs.openSync(
        path.join(directory, "stdout.log"),
        "wx",
        0o600,
      );
      const stderr = fs.openSync(
        path.join(directory, "stderr.log"),
        "wx",
        0o600,
      );
      const child = spawn(process.execPath, [runnerScript, "--run"], {
        cwd: sourceRoot,
        env: {
          ...process.env,
          FMCAD_MULTIDOC_GROUP_FILE: manifestFile,
          FMCAD_MULTIDOC_RUN_ID: runner.id,
          FMCAD_MULTIDOC_RUN_ROOT: directory,
          FMCAD_MULTIDOC_OWNER_COUNT: String(options.concurrency),
          FMCAD_MULTIDOC_READY_FILE: readyFile,
          FMCAD_MULTIDOC_START_FILE: startFile,
          FMCAD_MULTIDOC_ABORT_FILE: abortFile,
        },
        stdio: ["ignore", stdout, stderr],
      });
      const childId = { runnerId: runner.id, pid: child.pid, directory };
      const processIdentity = {
        pid: child.pid,
        birth: processBirth(child.pid),
      };
      summary.runners.push(childId);
      child.once("close", () => {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      });
      save();
      return {
        runner,
        directory,
        readyFile,
        child,
        processIdentity,
        done: waitForChild(child),
      };
    });
    await waitForRunnerReadiness(children);
    await runFaultProbe({
      cfg,
      directory: root,
      groupId: id,
      fingerprint: summary.buildHash,
      processes: children,
      releaseRunners,
      abortRunners,
      summary,
      save,
    });
    const results = await Promise.all(children.map((entry) => entry.done));
    summary.childResults = results.map((result, index) => ({
      runnerId: children[index].runner.id,
      ...result,
    }));
    const reports = children.map((entry, index) => {
      assert.equal(
        results[index].code,
        0,
        "Runner process failed; inspect its report and logs: " +
          entry.directory,
      );
      const reportFile = path.join(entry.directory, "report.json");
      const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      return report;
    });
    verifyRunnerReports(
      manifest,
      reports,
      children.map((entry) => entry.processIdentity),
    );
    summary.runners = reports.map((report) => ({
      runnerId: report.runId,
      processIdentity: report.processIdentity,
      clientIds: report.receipts.map((receipt) => receipt.clientId),
      report: path.join(runnerRoot, report.runId, "report.json"),
    }));
    summary.globalSdkConcurrency = globalConcurrency(reports);
    assert.equal(
      summary.globalSdkConcurrency.maximum,
      1,
      "Independent processes overlapped SDK work outside the single broker queue",
    );
    const afterCapture = await capture(
      queue,
      cfg,
      root,
      id + ":after",
      summary.buildHash,
    );
    summary.after = afterCapture.state;
    summary.afterReceipt = afterCapture.receipt;
    exactState(summary.baseline, afterCapture.state);
    const finalStatus = object(await queue.call("status"));
    assert.equal(finalStatus.blocked ?? null, null, "Broker left blocked work");
    assert.equal(
      finalStatus.held ?? null,
      null,
      "Broker retained unresolved work",
    );
    assert.equal(finalStatus.nonterminalJobCount, 0);
    assert.equal(
      finalStatus.historicalUnknownJobCount,
      summary.historicalUnknownJobCount,
      "The multi-runner test must not alter quarantined historical outcomes",
    );
    summary.status = "passed";
    save();
    console.log("MULTIDOCUMENT_PROCESS_REPORT " + summaryFile);
    return 0;
  } catch (error) {
    summary.status = "failed";
    summary.error = error instanceof Error ? error.stack : String(error);
    summary.finishedAt = new Date().toISOString();
    save();
    console.error("MULTIDOCUMENT_PROCESS_REPORT " + summaryFile);
    throw error;
  } finally {
    if (children.length) {
      // A startup error before the shared gate must not leave runner children blocked.
      const gate = summary.startGate;
      if (
        gate &&
        !fs.existsSync(gate.startFile) &&
        !fs.existsSync(gate.abortFile)
      )
        persist(gate.abortFile, { groupId: id, state: "aborted-before-sdk" });
      await Promise.allSettled(children.map((entry) => entry.done));
    }
    queue.dispose();
  }
}

if (require.main === module)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });

module.exports = {
  waitForGroupReadJobs,
  capture,
  exactState,
  globalConcurrency,
  groupManifest,
  parseOptions,
  submitWithResponseRecovery,
  verifyRunnerReports,
  waitWithResponseRecovery,
};
