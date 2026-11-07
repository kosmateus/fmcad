"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const fixture = require("./fixtures/python-admission-broker.cjs");
const packageRoot =
  process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE || path.resolve(__dirname, "..");
const { runQueued, QueueClient, inputFiles } = require(
  path.join(packageRoot, "dist/src/queue-client"),
);
const { startStdio } = require(path.join(packageRoot, "dist/src/mcp-stdio"));
const { createFmcad } = require("node:module").createRequire(
  path.join(packageRoot, "package.json"),
)("fmcad/api");

async function cli(f, source, id, client = "owner") {
  let stdout = "",
    stderr = "";
  const code = await runQueued(
    ["run", source],
    f.cfg,
    { client, "request-id": id },
    {
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          stderr += s;
        },
      },
    },
  );
  const marker = (prefix) =>
    stderr
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
  return {
    code,
    stdout,
    stderr,
    job: marker("FMCAD_QUEUE_JOB ")[0],
    reports: marker("FMCAD_PYTHON_CHECK "),
  };
}
async function mcpResult(f, jobId, owner = "owner") {
  const stdin = new PassThrough();
  let output = "";
  const clients = [];
  const server = startStdio(["--routing", "queue", "--client", owner], {
    stdin,
    stdout: {
      write: (s) => {
        output += s;
      },
    },
    stderr: { write() {} },
    loadConfig: () => ({ cfg: f.cfg }),
    QueueClient: class extends QueueClient {
      constructor(...args) {
        super(...args);
        clients.push(this);
      }
    },
    McpClient: class {
      close() {}
      controlPost() {
        assert.fail("Owned report observation must not contact SDK");
      }
    },
  });
  stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "observe",
      method: "tools/call",
      params: { name: "fmcad_queue_result", arguments: { jobId } },
    }) + "\n",
  );
  // Broker-only queue-result reads do not open a physical MCP client. Await
  // the actual stdio server lifecycle rather than an obsolete client close.
  await server.closed;
  clients.forEach((client) => client.dispose());
  return JSON.parse(output.trim()).result.structuredContent;
}

test("real CLI/worker, MCP and public API preserve the same owner report; rejected inputs have zero new physical admission", async (t) => {
  const f = await fixture(t),
    owner = await f.client("owner"),
    other = await f.client("other");
  const api = createFmcad({
    version: 1,
    config: f.cfg,
    context: {
      clientId: "owner",
      instanceId: "report-parity",
      source: "system",
      projectDirectory: f.home,
    },
  });
  const foreignApi = createFmcad({
    version: 1,
    config: f.cfg,
    context: {
      clientId: "other",
      instanceId: "foreign-report-parity",
      source: "system",
      projectDirectory: f.home,
    },
  });
  t.after(async () => {
    await api.dispose();
    await foreignApi.dispose();
  });
  await api.start();
  await foreignApi.start();
  const good = f.script(
    "good.py",
    'def run(context: str) -> None:\n    print("typed")\n',
  );
  const accepted = await cli(f, good, "good");
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(f.products(), 1);
  const result = await owner.call("result", { jobId: accepted.job.jobId });
  assert.deepEqual(accepted.reports, result.pythonChecks);
  assert.equal(result.pythonChecks.length, 1);
  const report = result.pythonChecks[0];
  assert.equal(report.status, "passed");
  assert.equal(report.provenance.checker, "basedpyright");
  const wireHash = (source) =>
    require("node:crypto").createHash("sha256").update(source).digest("hex");
  assert.ok(
    f.calls.some((payload) => {
      const script =
        payload.params?.arguments?.object?.script ??
        payload.params?.arguments?.code;
      return typeof script === "string" &&
        wireHash(script) === report.provenance.wireHash;
    }),
    "The real checker report must bind the exact Python bytes at the physical sender",
  );
  const beforeObservation = f.calls.length;
  assert.deepEqual(
    (await mcpResult(f, accepted.job.jobId)).pythonChecks,
    result.pythonChecks,
  );
  const apiResult = await api.query.result(accepted.job.jobId);
  assert.deepEqual(apiResult.pythonChecks, result.pythonChecks);
  assert.equal(apiResult.outcome.validation.status, "not_checked");
  assert.equal(f.calls.length, beforeObservation);
  await assert.rejects(other.call("result", { jobId: accepted.job.jobId }), {
    code: "NOT_OWNER",
  });
  await assert.rejects(foreignApi.query.result(accepted.job.jobId), {
    code: "NOT_OWNER",
  });
  assert.equal(await foreignApi.query.request("good"), null);
  assert.ok(
    !JSON.stringify(await other.call("status")).includes(
      report.provenance.artifactHash,
    ),
    "Private diagnostics are absent from global status",
  );
  const invocation = (name) => ({
    version: 1,
    kind: "run",
    request: {
      name,
      args: null,
      hasArgs: false,
      identity: { readOnly: true },
      readOnlyOperations: [],
    },
  });
  const apiAccepted = await api.execute(invocation(good), {
    requestId: "api-good",
  });
  assert.ok(apiAccepted.jobId);
  const apiExecuted = await owner.wait(apiAccepted.jobId);
  assert.equal(
    apiExecuted.job.state,
    "succeeded",
    JSON.stringify(apiExecuted.execution),
  );
  assert.deepEqual(
    (await api.query.result(apiAccepted.jobId)).pythonChecks,
    apiExecuted.pythonChecks,
  );
  assert.deepEqual(
    (await mcpResult(f, apiAccepted.jobId)).pythonChecks,
    apiExecuted.pythonChecks,
  );
  assert.equal(f.products(), 2);
  const bad = f.script(
    "bad.py",
    'def run(context: str) -> None:\n    value: int = "bad"\n',
  );
  const before = f.calls.length,
    rejected = await cli(f, bad, "bad");
  assert.equal(rejected.code, 1);
  assert.equal(f.calls.length, before);
  const refused = await owner.call("result", { jobId: rejected.job.jobId });
  assert.equal(refused.job.operationResult.executionOutcome, "not_started");
  assert.deepEqual(rejected.reports, refused.pythonChecks);
  assert.ok(
    !fs
      .readFileSync(path.join(f.dir, "queue-state.json"), "utf8")
      .includes(refused.pythonChecks[0].provenance.artifactHash),
    "Full diagnostics stay in the owner result instead of inflating retained queue state",
  );
  assert.ok(
    refused.pythonChecks[0].diagnostics.some(
      (d) => d.filename === bad && d.rule === "reportAssignmentType",
    ),
  );
  assert.deepEqual(
    (await mcpResult(f, rejected.job.jobId)).pythonChecks,
    refused.pythonChecks,
  );
  const apiRefused = await api.query.result(rejected.job.jobId);
  assert.deepEqual(apiRefused.pythonChecks, refused.pythonChecks);
  assert.equal(apiRefused.outcome.executionOutcome, "not_started");
  const apiBad = await api.execute(invocation(bad), { requestId: "api-bad" });
  const apiBadResult = await owner.wait(apiBad.jobId);
  assert.equal(apiBadResult.job.state, "failed");
  assert.equal(f.calls.length, before);
  assert.deepEqual(
    (await api.query.result(apiBad.jobId)).pythonChecks,
    apiBadResult.pythonChecks,
  );
  for (const name of ["execute_python", "fusion_mcp_execute"]) {
    const arguments_ =
      name === "execute_python"
        ? { code: 'value: int = "bad"', persistent: false }
        : {
            featureType: "script",
            object: {
              script: 'def run(context: str) -> None:\n    value: int = "bad"',
            },
          };
    await assert.rejects(
      owner.submit({
        kind: "rpc",
        requestId: name,
        timeoutMs: 120000,
        backend: "mcp",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        },
      }),
      (error) =>
        error.code === "PYTHON_CHECK_REJECTED" &&
        error.pythonCheck.status === "failed",
    );
    assert.equal(f.calls.length, before);
  }
  // The typed worker matrix mutates the pinned source after the real checker
  // awaits and proves the synchronous final source fence refuses physical send.
  assert.equal(f.maximum(), 1);
});

test("actual prepared typed service keeps input/reset/document drift fences and a single SDK owner across clients", async (t) => {
  const f = await fixture(t, { typedService: true }),
    a = await f.client("a"),
    b = await f.client("b");
  const source = f.script(
    "typed.py",
    'def run(context: str) -> None:\n    print("TYPED_SERVICE")\n',
  );
  async function submit(client, id, extra = {}) {
    const argv = ["run", source, "--doc", "A"];
    return client.submit({
      kind: "command",
      requestId: id,
      argv,
      cwd: f.home,
      backend: "mcp",
      timeoutMs: 120000,
      inputFiles: inputFiles(argv, f.home),
      ...extra,
    });
  }
  let started, finish, checkedPeer, firstResult;
  const activeSdk = new Promise((resolve) => {
      started = resolve;
    }),
    finishSdk = new Promise((resolve) => {
      finish = resolve;
    });
  const peerChecked = new Promise((resolve) => {
    checkedPeer = resolve;
  });
  f.observeProduct(async () => {
    started();
    await finishSdk;
  });
  const first = await submit(a, "first", {
      sequence: { action: "begin", mode: "automatic" },
    }),
    firstTerminal = a.wait(first.id);
  try {
    await Promise.race([
      activeSdk,
      firstTerminal.then((result) => {
        throw Error(
          "First fixture ended before SDK: " +
            result.job.state +
            "/" +
            result.job.code,
        );
      }),
    ]);
    f.observe(async (prepared) => {
      if (prepared.pythonArtifact) {
        assert.notEqual(
          prepared.record.binding.jobId,
          first.id,
          "Parallel local preparation must not borrow the active client identity",
        );
        assert.equal(prepared.pythonCertificate.report.status, "passed");
        checkedPeer();
      }
    });
    const peer = await submit(b, "peer"),
      peerTerminal = b.wait(peer.id);
    await Promise.race([
      peerChecked,
      peerTerminal.then((result) => {
        throw Error(
          "Peer ended before real checker completed: " +
            result.job.state +
            "/" +
            result.job.code,
        );
      }),
    ]);
    assert.equal(
      f.products(),
      1,
      "Second client checks locally while the first owns SDK, without dispatching its turn",
    );
    assert.equal(f.maximum(), 1);
    finish();
    firstResult = await firstTerminal;
    assert.equal(
      firstResult.job.state,
      "succeeded",
      JSON.stringify(firstResult.execution),
    );
    assert.equal((await peerTerminal).job.state, "succeeded");
  } finally {
    finish();
    f.observe(async () => {});
    f.observeProduct(async () => {});
  }
  const products = f.products();
  f.fingerprint("A-2");
  const changed = await submit(a, "changed", {
    sequence: {
      action: "continue",
      id: firstResult.job.sequenceId,
      mode: "automatic",
    },
  });
  const observed = await a.wait(changed.id);
  assert.equal(observed.job.state, "failed");
  assert.equal(observed.job.code, "DOCUMENT_CHANGED");
  assert.equal(f.products(), products);
  assert.equal(JSON.parse(observed.stdout).currentState.fingerprint, "A-2");
  for (const cause of ["input", "reset", "pause"]) {
    let reached, release;
    const ready = new Promise((resolve) => {
        reached = resolve;
      }),
      proceed = new Promise((resolve) => {
        release = resolve;
      });
    f.observe(async (prepared) => {
      if (prepared.pythonArtifact?.script.includes("TYPED_SERVICE")) {
        reached();
        await proceed;
      }
    });
    try {
      const job = await submit(b, cause),
        terminal = b.wait(job.id);
      await Promise.race([
        ready,
        terminal.then((result) => {
          throw Error(
            "Fixture completed before the checker observer: " +
              result.job.state +
              "/" +
              result.job.code,
          );
        }),
      ]);
      const before = f.calls.length,
        productsBefore = f.products();
      if (cause === "input")
        fs.appendFileSync(source, "# changed after checking\n");
      else if (cause === "reset")
        fs.writeFileSync(
          path.join(f.dir, "fusion-reset.lock"),
          JSON.stringify({ nonce: "test-owned-reset" }),
        );
      else {
        const control = await b.call("control-status");
        await b.call("pause", {
          control: {
            requestId: "pause-typed-fixture",
            instanceId: control.instanceId,
            expectedGeneration: control.generation,
          },
        });
        f.fingerprint("A-3");
      }
      release();
      if (cause === "pause") {
        const control = await b.call("control-status");
        await b.call("resume", {
          control: {
            requestId: "resume-typed-fixture",
            instanceId: control.instanceId,
            expectedGeneration: control.generation,
          },
        });
      }
      const result = await terminal;
      assert.equal(result.job.state, "failed");
      assert.equal(
        result.job.code,
        cause === "input"
          ? "INPUT_CHANGED"
          : cause === "reset"
            ? "FUSION_RESET_IN_PROGRESS"
            : "DOCUMENT_CHANGED",
      );
      assert.equal(result.job.operationResult.executionOutcome, "not_started");
      assert.equal(f.products(), productsBefore);
      if (cause === "pause")
        assert.equal(JSON.parse(result.stdout).currentState.fingerprint, "A-3");
      else assert.equal(f.calls.length, before);
    } finally {
      release();
      f.observe(async () => {});
      fs.rmSync(path.join(f.dir, "fusion-reset.lock"), { force: true });
    }
  }
  assert.equal(f.maximum(), 1);
});

test("offline raw preparation cannot publish accepted work after broker ownership is released", async (t) => {
  const f = await fixture(t),
    owner = await f.client("raw-stop");
  let reached, release;
  const ready = new Promise((resolve) => {
      reached = resolve;
    }),
    proceed = new Promise((resolve) => {
      release = resolve;
    });
  f.observe(async (prepared) => {
    if (prepared.pythonArtifact?.script.includes("RAW_STOP_GUARD")) {
      reached();
      await proceed;
    }
  });
  const before = f.calls.length;
  const submission = owner
    .submit({
      kind: "rpc",
      requestId: "pending-raw",
      timeoutMs: 120000,
      backend: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: {
              script:
                'def run(context: str) -> None:\n    print("RAW_STOP_GUARD")',
            },
          },
        },
      },
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await Promise.race([
      ready,
      submission.then(() => {
        throw Error("Raw request finished before the preparation observer");
      }),
    ]);
    const status = await owner.call("status");
    await assert.rejects(
      owner.call("stop", {
        onlyIfQuiescent: true,
        expectedBuildHash: status.buildHash,
        expectedRevision: status.revision,
      }),
      { code: "QUEUE_BUSY" },
    );
    await owner.call("stop");
    assert.ok(
      fs.existsSync(path.join(f.dir, "broker.lock")),
      "A stopping broker still owns its in-flight local preparation",
    );
    release();
    const result = await submission;
    assert.equal(result.error?.code, "BROKER_STOPPING");
    assert.equal(result.error.notStarted, true);
    await f.close();
    assert.equal(f.calls.length, before);
    assert.ok(!fs.existsSync(path.join(f.dir, "broker.lock")));
    const state = JSON.parse(
      fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8"),
    );
    assert.ok(
      !Object.values(state.jobs).some((job) => job.requestId === "pending-raw"),
    );
  } finally {
    release();
    f.observe(async () => {});
  }
});
