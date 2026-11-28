import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import type {
  DebugTraceContext,
  DebugTraceEvent,
} from "../packages/node-adapters/src/telemetry/diagnostic-log";

interface TraceRecord extends Record<string, unknown> {
  abortReason?: unknown;
  action?: unknown;
  at?: unknown;
  buildHash?: unknown;
  code?: unknown;
  deadlineMonotonicMs?: unknown;
  durationMs?: unknown;
  ipcStage?: unknown;
  jobId?: unknown;
  messageId?: unknown;
  monotonicEndMs?: unknown;
  monotonicStartMs?: unknown;
  pid?: unknown;
  requestId?: unknown;
  source?: unknown;
  stage?: unknown;
}

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.resolve(__dirname, "../../package.json"));

const {
  createDebugTraceContext,
  createDebugTraceWriter,
  createDiagnosticLog,
  flushDebugTrace,
  readDebugTrace,
  writeDebugTrace,
} = load(
  "./packages/node-adapters/dist/telemetry/diagnostic-log",
) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms`);
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("debug JSONL keeps correlated IPC timing and redacts credentials", async (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "queue-ipc-trace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = createDebugTraceContext(
    "queue-ipc-request",
    "queue-ipc-client",
    "cli",
    true,
  );
  assert.ok(context);
  const sink = createDiagnosticLog("fmcad-debug-trace", {
    directory,
    maxFiles: 8,
  });
  const writer = createDebugTraceWriter({
    sink,
    now: () => 1_800_000_000_000,
    pid: 4242,
    newSpanId: () => "1111111111111111",
  });
  const common = {
    stage: "ipc",
    action: "worker-status",
    messageId: "11111111-1111-4111-8111-111111111111",
    jobId: "queue-ipc-job",
    buildHash: "a".repeat(64),
    monotonicStartMs: 12.5,
    deadlineMonotonicMs: 30_012.5,
  } satisfies DebugTraceEvent;
  writer.write(context, {
    ...common,
    ipcStage: "request-written",
    status: "written",
  });
  writer.write(context, {
    ...common,
    ipcStage: "timeout",
    status: "failed",
    monotonicEndMs: 30_012.5,
    durationMs: 30_000,
    code: "QUEUE_IPC_TIMEOUT",
  });
  const abortEvent = {
    ...common,
    ipcStage: "abort",
    status: "failed",
    abortReason: "QUEUE_IPC_TIMEOUT",
    ...{
      workerToken: "must-not-be-written",
      payload: "must-not-be-written",
    },
  } satisfies DebugTraceEvent & {
    payload: string;
    workerToken: string;
  };
  writer.write(context, abortEvent);
  await sink.flush();

  const events = readDebugTrace(context.traceId, {
    directory,
  }) as TraceRecord[];
  assert.equal(events.length, 2);
  const firstEvent = events[0];
  const secondEvent = events[1];
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.equal(firstEvent.stage, "ipc");
  assert.equal(firstEvent.ipcStage, "request-written");
  assert.equal(firstEvent.action, "worker-status");
  assert.equal(firstEvent.messageId, common.messageId);
  assert.equal(firstEvent.jobId, common.jobId);
  assert.equal(firstEvent.requestId, context.requestId);
  assert.equal(firstEvent.source, "cli");
  assert.equal(firstEvent.pid, 4242);
  assert.equal(firstEvent.buildHash, common.buildHash);
  assert.equal(firstEvent.monotonicStartMs, 12.5);
  assert.equal(firstEvent.deadlineMonotonicMs, 30_012.5);
  assert.equal(secondEvent.ipcStage, "timeout");
  assert.equal(secondEvent.monotonicEndMs, 30_012.5);
  assert.equal(secondEvent.durationMs, 30_000);
  assert.equal(secondEvent.code, "QUEUE_IPC_TIMEOUT");
  const contents = fs
    .readdirSync(directory)
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("");
  assert.doesNotMatch(contents, /must-not-be-written/);
});

test("independent accepted workers trace one backend each and do not replay after heartbeat timeout", async (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "queue-ipc-repro-"));
  const socketPath = path.join(directory, "broker.sock");
  const workerFixture = path.join(
    root,
    "tests",
    "fixtures",
    "queue-ipc-debug-trace-client.cjs",
  );
  const diagnosticModule = path.join(
    root,
    "packages/node-adapters/dist/telemetry/diagnostic-log.js",
  );
  const contexts = new Map<string, DebugTraceContext>();
  const counts = new Map<string, number>();
  const sockets = new Map<string, net.Socket>();
  const heldBackend = new Map<string, (result: unknown) => void>();
  type ChildResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
    stderr: string;
  };
  type TracedChild = {
    process: ChildProcessByStdio<null, Readable, Readable>;
    readonly output: string;
    readonly stderrOutput: string;
    completion: Promise<ChildResult>;
  };
  const children = new Map<string, TracedChild>();
  const traceIds = new Map<string, string>();
  const buildHash = "b".repeat(64);
  const runId = randomUUID();
  const failureJob = `queue-ipc-timeout-${runId}`;
  const successJob = `queue-ipc-success-${runId}`;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline)) as {
        action: NonNullable<DebugTraceEvent["action"]>;
        jobId: string;
        debugTraceMessageId?: string;
      };
      const context = contexts.get(message.jobId);
      const messageId = message.debugTraceMessageId;
      const startedAt = performance.now();
      const trace = (
        ipcStage: NonNullable<DebugTraceEvent["ipcStage"]>,
        fields: Partial<DebugTraceEvent> = {},
      ) => {
        writeDebugTrace(context, {
          stage: "ipc",
          ipcStage,
          action: message.action,
          messageId,
          jobId: message.jobId,
          buildHash,
          monotonicAtMs: performance.now(),
          ...fields,
        });
      };
      const reply = (result: unknown) => {
        trace("reply-emitted", {
          status: "passed",
          monotonicStartMs: startedAt,
          monotonicEndMs: performance.now(),
          durationMs: performance.now() - startedAt,
        });
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      };

      if (!context || typeof messageId !== "string") {
        socket.end(
          JSON.stringify({ ok: false, error: { code: "INVALID" } }) + "\n",
        );
        return;
      }
      trace("handler-start", {
        status: "started",
        monotonicStartMs: startedAt,
      });
      trace("request-accepted", { status: "passed" });
      if (message.action === "backend") {
        counts.set(
          `backend:${message.jobId}`,
          (counts.get(`backend:${message.jobId}`) || 0) + 1,
        );
        heldBackend.set(message.jobId, reply);
        sockets.set(message.jobId, socket);
        return;
      }
      if (message.action === "worker-status") {
        const key = `worker-status:${message.jobId}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        if (message.jobId === failureJob) return;
        reply({ remainingMs: 1000, phase: "running" });
        return;
      }
      socket.end(
        JSON.stringify({ ok: false, error: { code: "INVALID_ACTION" } }) + "\n",
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const child of children.values()) child.process.kill();
    for (const socket of sockets.values()) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const [jobId, clientId] of [
    [failureJob, `ipc-failure-${runId}`] as const,
    [successJob, `ipc-success-${runId}`] as const,
  ]) {
    const context = createDebugTraceContext(jobId, clientId, "cli", true);
    assert.ok(context);
    contexts.set(jobId, context);
    traceIds.set(jobId, context.traceId);
    const child = spawn(process.execPath, [workerFixture], {
      env: {
        ...process.env,
        FMCAD_DEBUG_TRACE: "1",
        FMCAD_TEST_QUEUE_DIR: directory,
        FMCAD_TEST_JOB_ID: jobId,
        FMCAD_TEST_WORKER_TOKEN: `private-worker-token-${jobId}`,
        FMCAD_TEST_TRACE_CONTEXT: JSON.stringify(context),
        FMCAD_TEST_CONNECTION_MODULE: path.join(
          root,
          "src/queue-connection.js",
        ),
        FMCAD_TEST_DIAGNOSTIC_MODULE: diagnosticModule,
        FMCAD_TEST_BUILD_HASH: buildHash,
        FMCAD_TEST_HEARTBEAT_TIMEOUT_MS: "100",
        FMCAD_TEST_POLL_MS: "10",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stderrOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (stderrOutput += chunk));
    const completion = new Promise<ChildResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve({
          code,
          signal,
          output,
          stderr: stderrOutput,
        }),
      );
    });
    children.set(jobId, {
      process: child,
      get output() {
        return output;
      },
      get stderrOutput() {
        return stderrOutput;
      },
      completion,
    });
  }

  await waitFor(
    () =>
      (counts.get(`backend:${failureJob}`) === 1 &&
        counts.get(`backend:${successJob}`) === 1) ||
      [...children.values()].every((child) => child.process.exitCode !== null),
  );
  assert.equal(
    counts.get(`backend:${failureJob}`),
    1,
    [...children.values()]
      .map(
        (child) =>
          `${child.process.exitCode}: ${child.output} ${child.stderrOutput}`,
      )
      .join("\n"),
  );
  assert.equal(counts.get(`backend:${successJob}`), 1);
  const failureChild = children.get(failureJob);
  assert.ok(failureChild);
  const failureResult = await within(
    failureChild.completion,
    2500,
    "Heartbeat fault did not time out",
  );
  assert.equal(failureResult.code, 0, failureResult.stderr);
  const failureOutput = JSON.parse(failureResult.output) as {
    code?: unknown;
  };
  assert.equal(failureOutput.code, "QUEUE_IPC_TIMEOUT");
  await waitFor(() => (counts.get(`worker-status:${successJob}`) || 0) >= 2);
  const replyBackend = heldBackend.get(successJob);
  assert.ok(replyBackend);
  replyBackend({ value: "synthetic-success" });
  const successChild = children.get(successJob);
  assert.ok(successChild);
  const successResult = await within(
    successChild.completion,
    2500,
    "Accepted backend did not return",
  );
  assert.equal(successResult.code, 0, successResult.stderr);
  const successOutput = JSON.parse(successResult.output) as { ok?: unknown };
  assert.equal(successOutput.ok, true);
  assert.equal(counts.get(`backend:${failureJob}`), 1);
  assert.equal(counts.get(`backend:${successJob}`), 1);
  assert.equal(counts.get(`worker-status:${failureJob}`), 1);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await flushDebugTrace();
  const failureTraceId = traceIds.get(failureJob);
  const successTraceId = traceIds.get(successJob);
  assert.ok(failureTraceId);
  assert.ok(successTraceId);
  const failureTrace = readDebugTrace(failureTraceId) as TraceRecord[];
  const successTrace = readDebugTrace(successTraceId) as TraceRecord[];
  const allEvents = [...failureTrace, ...successTrace];
  const failureBackendId = failureTrace.find(
    (event) =>
      event.action === "backend" && event.ipcStage === "request-written",
  )?.messageId;
  const failureHeartbeatId = failureTrace.find(
    (event) =>
      event.action === "worker-status" && event.ipcStage === "request-written",
  )?.messageId;
  assert.equal(typeof failureBackendId, "string");
  assert.equal(typeof failureHeartbeatId, "string");
  assert.ok(typeof failureBackendId === "string");
  assert.ok(typeof failureHeartbeatId === "string");
  assert(
    failureTrace.some(
      (event) =>
        event.messageId === failureBackendId &&
        event.ipcStage === "request-written" &&
        typeof event.deadlineMonotonicMs === "number",
    ),
    "backend RPC budget deadline should be visible without timing out its accepted IPC",
  );
  for (const [trace, messageId, action] of [
    [failureTrace, failureBackendId, "backend"],
    [failureTrace, failureHeartbeatId, "worker-status"],
  ] as const) {
    const records = trace
      .filter((event) => event.messageId === messageId)
      .sort(
        (left, right) =>
          Date.parse(String(left.at)) - Date.parse(String(right.at)),
      );
    assert(
      records.some(
        (event) =>
          event.action === action && event.ipcStage === "handler-start",
      ),
    );
    assert(
      records.some(
        (event) =>
          event.action === action && event.ipcStage === "request-accepted",
      ),
    );
  }
  assert(
    failureTrace.some(
      (event) =>
        event.messageId === failureHeartbeatId &&
        event.ipcStage === "timeout" &&
        event.code === "QUEUE_IPC_TIMEOUT",
    ),
  );
  assert(
    failureTrace.some(
      (event) =>
        event.messageId === failureBackendId &&
        event.ipcStage === "abort" &&
        event.abortReason === "QUEUE_IPC_TIMEOUT",
    ),
  );
  assert(
    successTrace.some(
      (event) =>
        event.action === "backend" && event.ipcStage === "reply-received",
    ),
  );
  assert.equal(
    new Set(
      allEvents
        .filter((event) => event.ipcStage === "request-written")
        .map((event) => event.pid),
    ).size,
    2,
  );
  assert(allEvents.every((event) => event.buildHash === buildHash));
  assert.doesNotMatch(JSON.stringify(allEvents), /private-worker-token/);
});
