import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const {
  createDebugTraceContext,
  createDebugTraceWriter,
  createDiagnosticLog,
  debugTraceEnabled,
  readDebugTrace,
  summarizeDebugTraceRaw,
  validDebugTraceContext,
} = load(
  "./packages/node-adapters/dist/telemetry/diagnostic-log",
) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");
const { createQueuePost } = load(
  "./src/dist/composition/library-mcp-queue",
) as typeof import("../src/composition/library-mcp-queue");
const { createForwarder } = load(
  "./src/dist/composition/library-mcp-forwarder",
) as typeof import("../src/composition/library-mcp-forwarder");
const { debugTraceCommand } = load(
  "./dist/src/dist/entrypoints/queue-cli",
) as typeof import("../src/entrypoints/queue-cli");
const { QueueClient, runQueued } = load(
  "./dist/src/queue-client",
) as typeof import("../src/queue-client");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, "diagnostics") };
}

test("diagnostics bound queued input, rotate by bytes, redact and close", async (t) => {
  const { directory } = fixture(t);
  const log = createDiagnosticLog("test", {
    directory,
    maxBytes: 256,
    maxFiles: 2,
    maxPending: 2,
  });
  assert.equal(log.write("Authorization: Bearer private-secret"), true);
  assert.equal(log.write("second"), true);
  assert.equal(log.write("overflow"), false);
  await log.flush();
  assert.doesNotMatch(
    fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
      .join(""),
    /private-secret/,
  );
  for (let index = 0; index < 10; index++) {
    log.write("x".repeat(512));
    await log.flush();
  }
  assert.equal(fs.readdirSync(directory).length, 2);
  for (const name of fs.readdirSync(directory))
    assert.ok(fs.statSync(path.join(directory, name)).size <= 256);
  await log.close();
  assert.equal(log.write("after close"), false);
  assert.deepEqual(log.stats(), { pending: 0, dropped: 2, errors: 0 });
});

test("cleanup removes only inactive owned diagnostics and preserves recovery evidence", async (t) => {
  const { root, directory } = fixture(t);
  fs.mkdirSync(directory);
  const uuid = "11111111-1111-4111-8111-111111111111";
  const file = (at: number, pid: number) =>
    path.join(directory, `test-${at}-${pid}-${uuid}.log`);
  fs.writeFileSync(file(1, 101), "expired");
  fs.writeFileSync(file(2, 102), "live");
  const receipt = path.join(root, "unresolved-receipt.json");
  fs.writeFileSync(receipt, "original unresolved evidence");
  fs.linkSync(receipt, file(3, 103));
  fs.symlinkSync(receipt, file(4, 104));
  fs.writeFileSync(path.join(directory, "foreign.log"), "foreign");
  const log = createDiagnosticLog("test", {
    directory,
    now: () => 1000,
    maxAgeMs: 100,
    isAlive: (pid) => pid === 102,
  });
  log.write("new");
  await log.close();
  assert.equal(fs.existsSync(file(1, 101)), false);
  assert.equal(fs.readFileSync(file(2, 102), "utf8"), "live");
  assert.equal(
    fs.readFileSync(receipt, "utf8"),
    "original unresolved evidence",
  );
  assert.equal(fs.lstatSync(file(3, 103)).nlink, 2);
  assert.equal(fs.lstatSync(file(4, 104)).isSymbolicLink(), true);
  assert.equal(
    fs.readFileSync(path.join(directory, "foreign.log"), "utf8"),
    "foreign",
  );
});

test("diagnostic disk full is reported separately and writing recovers", async (t) => {
  const { root, directory } = fixture(t);
  const durable = path.join(root, "history.sqlite");
  fs.writeFileSync(durable, "durable");
  let full = true;
  const io = {
    ...fs,
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      if (full) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.writeFileSync(...args);
    },
  };
  const log = createDiagnosticLog("test", { directory, io });
  log.write("lost auxiliary record");
  await log.flush();
  assert.equal(log.stats().errors, 1);
  full = false;
  log.write("recovered");
  await log.close();
  assert.match(
    fs
      .readdirSync(directory)
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
      .join(""),
    /recovered/,
  );
  assert.equal(fs.readFileSync(durable, "utf8"), "durable");
});

test("deleting temporary diagnostics does not prevent subsequent writes", async (t) => {
  const { directory } = fixture(t);
  const log = createDiagnosticLog("test", {
    directory,
    maxBytes: 128,
    maxFiles: 1,
  });
  log.write("first");
  await log.flush();
  fs.rmSync(directory, { recursive: true });
  log.write("after cleanup");
  await log.close();
  assert.equal(log.stats().errors, 0);
  assert.equal(fs.readdirSync(directory).length, 1);
});

test("unsafe diagnostic directory cannot redirect writes", async (t) => {
  const { root, directory } = fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, directory);
  const log = createDiagnosticLog("test", { directory });
  log.write("must not appear");
  await log.close();
  assert.equal(log.stats().errors, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("debug trace identity is opt-in, stable, and request-bound", () => {
  assert.equal(debugTraceEnabled({}), false);
  assert.equal(debugTraceEnabled({ FMCAD_DEBUG_TRACE: "true" }), false);
  assert.equal(debugTraceEnabled({ FMCAD_DEBUG_TRACE: "1" }), true);
  assert.equal(
    createDebugTraceContext("request-1", "client-1", "cli", false),
    undefined,
  );
  const first = createDebugTraceContext("request-1", "client-1", "cli", true);
  const retry = createDebugTraceContext("request-1", "client-1", "cli", true);
  assert.ok(first);
  assert.deepEqual(first, retry);
  assert.equal(
    validDebugTraceContext(first, {
      requestId: "request-1",
      clientId: "client-1",
    }),
    true,
  );
  assert.equal(
    validDebugTraceContext(first, {
      requestId: "request-2",
      clientId: "client-1",
    }),
    false,
  );
  assert.doesNotThrow(() =>
    createDebugTraceContext("custom request:id", "client/one", "mcp", true),
  );
});

test("trace writer keeps only bounded safe metadata and explicit stdout observations", () => {
  const context = createDebugTraceContext(
    "request with secret-marker",
    "client-1",
    "mcp",
    true,
  );
  assert.ok(context);
  const records: string[] = [];
  let span = 0;
  const writer = createDebugTraceWriter({
    sink: { write: (text) => (records.push(text), true) },
    now: () => 1_800_000_000_000,
    pid: 123,
    newSpanId: () => (++span).toString(16).padStart(16, "0"),
  });
  writer.write(context, {
    stage: "raw-received",
    status: "passed",
    jobId: "job-1",
    rpcId: "11111111-1111-4111-8111-111111111111",
    artifactRef: "received-response-11111111-1111-4111-8111-111111111111.json",
    rawBytes: 4,
    rawSha256: "a".repeat(64),
    responseKeys: ["jsonrpc", "result", "private-secret-marker"],
    stdoutObservation: "observed_empty",
  });
  writer.write(context, {
    stage: "parsed",
    status: "passed",
    stdoutObservation: "not_observed",
  });
  writer.write(context, {
    stage: "parsed",
    status: "passed",
    stdoutObservation: "not_observed",
    ...({ payload: "private-secret-marker" } as object),
  });
  assert.equal(records.length, 2);
  const [raw, parsed] = records.map((line) => JSON.parse(line));
  assert.equal(raw.requestIdHashed, true);
  assert.doesNotMatch(JSON.stringify(raw), /secret-marker/);
  assert.deepEqual(raw.responseKeys, ["jsonrpc", "result"]);
  assert.equal(
    raw.artifactRef,
    "received-response-11111111-1111-4111-8111-111111111111.json",
  );
  assert.equal(raw.stdoutObservation, "observed_empty");
  assert.equal(parsed.stdoutObservation, "not_observed");
  assert.equal(raw.parentSpanId, context.rootSpanId);
  assert.notEqual(raw.spanId, parsed.spanId);
});

test("a trace can be read as one correlated stream across independent processes", async (t) => {
  const { directory } = fixture(t);
  const requestId = "cross-process-request";
  const clientId = "cross-process-client";
  const context = createDebugTraceContext(requestId, clientId, "cli", true);
  assert.ok(context);
  const parentLog = createDiagnosticLog("fmcad-debug-trace", {
    directory,
    maxFiles: 8,
  });
  createDebugTraceWriter({ sink: parentLog }).write(context, {
    stage: "request-accepted",
    status: "passed",
    jobId: "job-cross-process",
    stdoutObservation: "not_observed",
  });
  await parentLog.flush();

  const modulePath = load.resolve(
    "./packages/node-adapters/dist/telemetry/diagnostic-log",
  );
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const d=require(${JSON.stringify(modulePath)});const l=d.createDiagnosticLog("fmcad-debug-trace",{directory:process.env.TRACE_DIR,maxFiles:8});const c=d.createDebugTraceContext(process.env.TRACE_REQUEST,process.env.TRACE_CLIENT,"cli",true);d.createDebugTraceWriter({sink:l}).write(c,{stage:"preflight",status:"passed",jobId:"job-cross-process",stdoutObservation:"not_observed"});l.flush().then(()=>l.close());`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TRACE_DIR: directory,
        TRACE_REQUEST: requestId,
        TRACE_CLIENT: clientId,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  await parentLog.close();
  const events = readDebugTrace(context.traceId, { directory });
  assert.deepEqual(events.map((event) => event["stage"]).sort(), [
    "preflight",
    "request-accepted",
  ]);
  assert.equal(new Set(events.map((event) => event["traceId"])).size, 1);
  assert.equal(new Set(events.map((event) => event["pid"])).size, 2);
});

test("raw trace summary records empty and nonempty stdout without copying values", () => {
  const empty = summarizeDebugTraceRaw(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "request",
      result: {
        structuredContent: { stdout: "", stderr: "private-payload-marker" },
        content: [{ type: "text", text: JSON.stringify({ stdout: "" }) }],
      },
    }),
  );
  const nonempty = summarizeDebugTraceRaw(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "request",
      result: {
        content: [{ type: "text", text: JSON.stringify({ stdout: "hello" }) }],
      },
    }),
  );
  assert.equal(empty.stdoutObservation, "observed_empty");
  assert.equal(empty.stdoutBytes, 0);
  assert.equal(nonempty.stdoutObservation, "observed_nonempty");
  assert.equal(nonempty.stdoutBytes, 5);
  assert.doesNotMatch(JSON.stringify(empty), /private-payload-marker/);
});

test("public MCP queue tracing reaches caller framing without changing wire output", async () => {
  const previous = process.env["FMCAD_DEBUG_TRACE"];
  process.env["FMCAD_DEBUG_TRACE"] = "1";
  try {
    let submitted: Record<string, unknown> | undefined;
    const clientId = "mcp-trace-client";
    const requestId = randomUUID();
    const request = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "tools/call",
      params: {
        name: "unregistered_tool",
        arguments: {},
        _meta: { fmcad: { requestId } },
      },
    };
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        structuredContent: { stdout: "observed output" },
        content: [{ type: "text", text: "safe response" }],
      },
    });
    const job = {
      id: "trace-job",
      requestId,
      clientId,
      state: "succeeded",
    };
    const post = createQueuePost(
      {
        dir: "/unused",
        auth: { clientId },
        register: async () => undefined,
        call: async () => undefined,
        submit: async (input) => {
          submitted = input;
          return job;
        },
        findRequest: async () => null,
        wait: async () => ({ job, rpc: { status: 200, raw } }),
      },
      { backend: "mcp", timeoutMs: 1000 },
      undefined,
      { clientId, projectDirectory: "/tmp" },
      {
        catalog: () => ({
          tools: [],
          contracts: {},
          fromMcp: () => {
            throw new Error("unregistered tool must not map to a catalog call");
          },
          isLocal: () => false,
        }),
        resolveProjectDirectory: (selection) => ({
          projectDirectory: selection.projectDirectory ?? null,
          source: "test",
        }),
        buildHash: () => "a".repeat(64),
        readOwnedResult: () => Buffer.from(""),
        responseMessages: (value) => JSON.parse(value),
      },
    );
    const logs: string[] = [];
    let output = "";
    const forward = createForwarder(
      post,
      (_message, frame) => {
        output += frame;
      },
      (line) => logs.push(line),
      { backend: "mcp", routing: "queue" },
    );
    await forward(JSON.stringify(request));
    const metadata = submitted?.["debugTrace"] as
      | import("../packages/node-adapters/src/telemetry/diagnostic-log").DebugTraceContext
      | undefined;
    assert.ok(metadata);
    assert.equal(metadata.requestId, requestId);
    assert.ok(output.includes('"fmcad"'));
    assert.doesNotMatch(output, /debugTrace|FMCAD_DEBUG_TRACE_ID/);
    assert.deepEqual(logs, [`FMCAD_DEBUG_TRACE_ID ${metadata.traceId}`]);

    const loggerDirectory = path.join(
      os.tmpdir(),
      `fmcad-diagnostics-${process.getuid?.() ?? "user"}`,
    );
    const runtime = load(
      "./dist/src/dist/node-adapters/telemetry/diagnostic-log",
    ) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");
    await runtime.flushDebugTrace();
    const events = runtime.readDebugTrace(metadata.traceId, {
      directory: loggerDirectory,
    });
    assert.deepEqual(
      events.map((event) => event["stage"]),
      ["caller-received", "parsed", "stdout-written"],
    );
    assert.equal(events.at(-1)?.["stdoutObservation"], "observed_nonempty");
    assert.equal(events.at(-1)?.["stdoutBytes"], 15);
    let traceOutput = "",
      traceError = "";
    const traceExit = await debugTraceCommand([metadata.traceId], {
      stdout: { write: (text) => (traceOutput += text) },
      stderr: { write: (text) => (traceError += text) },
    });
    assert.equal(traceExit, 0, traceError);
    assert.deepEqual(
      traceOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).stage),
      events.map((event) => event["stage"]),
    );
    assert.equal(
      await debugTraceCommand(["invalid"], {
        stdout: { write() {} },
        stderr: { write() {} },
      }),
      2,
    );
  } finally {
    if (previous === undefined) delete process.env["FMCAD_DEBUG_TRACE"];
    else process.env["FMCAD_DEBUG_TRACE"] = previous;
  }
});

test("public CLI queue tracing retains caller output observations without its text", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-trace-state-"));
  const previousState = process.env["XDG_STATE_HOME"];
  const previousTrace = process.env["FMCAD_DEBUG_TRACE"];
  const requestId = randomUUID();
  const original = {
    register: QueueClient.prototype.register,
    submit: QueueClient.prototype.submit,
    wait: QueueClient.prototype.wait,
    dispose: QueueClient.prototype.dispose,
  };
  let submitted: Record<string, unknown> | undefined;
  let stdout = "";
  let stderr = "";
  let cliOutput = "private-cli-output-marker";
  process.env["XDG_STATE_HOME"] = directory;
  process.env["FMCAD_DEBUG_TRACE"] = "1";
  try {
    QueueClient.prototype.register = async function () {
      return this;
    };
    QueueClient.prototype.submit = async function (input) {
      submitted = input as unknown as Record<string, unknown>;
      return {
        id: "cli-trace-job",
      } as Awaited<ReturnType<typeof QueueClient.prototype.submit>>;
    };
    QueueClient.prototype.wait = async function (jobId) {
      return {
        job: {
          id: jobId,
          requestId: String(submitted?.["requestId"] ?? requestId),
          clientId: this.auth.clientId,
          state: "succeeded",
        },
        stdout: cliOutput,
        stderr: "",
      } as Awaited<ReturnType<typeof QueueClient.prototype.wait>>;
    };
    QueueClient.prototype.dispose = function () {};

    const exitCode = await runQueued(
      ["doctor"],
      {
        backend: "addin",
        routing: "queue",
        timeoutMs: 1000,
        queue: { autoStart: false },
      },
      { client: "cli-trace-client", "request-id": requestId },
      {
        stdout: { write: (text) => (stdout += text) },
        stderr: { write: (text) => (stderr += text) },
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "private-cli-output-marker");
    const trace = submitted?.["debugTrace"] as
      | import("../packages/node-adapters/src/telemetry/diagnostic-log").DebugTraceContext
      | undefined;
    assert.ok(trace);
    assert.match(stderr, new RegExp(`FMCAD_DEBUG_TRACE_ID ${trace.traceId}`));

    const runtime = load(
      "./dist/src/dist/node-adapters/telemetry/diagnostic-log",
    ) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");
    await runtime.flushDebugTrace();
    const events = runtime.readDebugTrace(trace.traceId);
    assert.deepEqual(
      events.map((event) => event["stage"]),
      ["caller-received", "stdout-written"],
    );
    assert.equal(events[0]?.["stdoutObservation"], "observed_nonempty");
    assert.equal(events[0]?.["stdoutBytes"], 25);
    assert.doesNotMatch(JSON.stringify(events), /private-cli-output-marker/);

    const emptyRequestId = randomUUID();
    cliOutput = "";
    stdout = "";
    stderr = "";
    const emptyExitCode = await runQueued(
      ["doctor"],
      {
        backend: "addin",
        routing: "queue",
        timeoutMs: 1000,
        queue: { autoStart: false },
      },
      { client: "cli-trace-client", "request-id": emptyRequestId },
      {
        stdout: { write: (text) => (stdout += text) },
        stderr: { write: (text) => (stderr += text) },
      },
    );
    assert.equal(emptyExitCode, 0);
    assert.equal(stdout, "");
    const emptyTraceId = /^FMCAD_DEBUG_TRACE_ID ([a-f0-9]{32})$/m.exec(
      stderr,
    )?.[1];
    assert.ok(emptyTraceId);
    await runtime.flushDebugTrace();
    const emptyEvents = runtime.readDebugTrace(emptyTraceId);
    assert.equal(emptyEvents.at(-1)?.["status"], "passed");
    assert.equal(emptyEvents.at(-1)?.["stdoutObservation"], "observed_empty");
    assert.equal(emptyEvents.at(-1)?.["stdoutBytes"], 0);

    const failedRequestId = randomUUID();
    cliOutput = "private-cli-output-marker";
    stderr = "";
    await assert.rejects(
      runQueued(
        ["doctor"],
        {
          backend: "addin",
          routing: "queue",
          timeoutMs: 1000,
          queue: { autoStart: false },
        },
        { client: "cli-trace-client", "request-id": failedRequestId },
        {
          stdout: {
            write: () => {
              throw Object.assign(new Error("broken output pipe"), {
                code: "EPIPE",
              });
            },
          },
          stderr: { write: (text) => (stderr += text) },
        },
      ),
      { code: "EPIPE" },
    );
    const failedTraceId = /^FMCAD_DEBUG_TRACE_ID ([a-f0-9]{32})$/m.exec(
      stderr,
    )?.[1];
    assert.ok(failedTraceId);
    await runtime.flushDebugTrace();
    const failedEvents = runtime.readDebugTrace(failedTraceId);
    assert.deepEqual(
      failedEvents.map((event) => event["stage"]),
      ["caller-received", "stdout-written"],
    );
    assert.equal(failedEvents.at(-1)?.["status"], "failed");
    assert.equal(failedEvents.at(-1)?.["code"], "EPIPE");
    assert.doesNotMatch(
      JSON.stringify(failedEvents),
      /private-cli-output-marker/,
    );
  } finally {
    QueueClient.prototype.register = original.register;
    QueueClient.prototype.submit = original.submit;
    QueueClient.prototype.wait = original.wait;
    QueueClient.prototype.dispose = original.dispose;
    if (previousState === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previousState;
    if (previousTrace === undefined) delete process.env["FMCAD_DEBUG_TRACE"];
    else process.env["FMCAD_DEBUG_TRACE"] = previousTrace;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
