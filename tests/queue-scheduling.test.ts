import type {
  QueueDomainOptions,
  QueueSnapshot,
  QueueRequest,
} from "../packages/core/src/domain/queue-model";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Auth = { clientId: string; clientToken: string };
type Job = {
  id: string;
  state: string;
  sequenceId: string;
  sequenceMode: string;
  sequenceState: string;
  code: string;
  finishedAt: number;
};
type TestQueue = Omit<
  InstanceType<typeof QueueDomain>,
  "status" | "submit" | "next"
> & {
  status(): { jobs: Record<string, Job> };
  status(id: string): Job;
  submit(input: QueueRequest): Job;
  next(): Job | null;
};
const load = createRequire(
  path.join(process.cwd(), "tests", "queue-scheduling.test.js"),
);
const { QueueDomain } = load(
  "../src/dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { serve } = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { request: wireRequest } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
const request = <T = unknown>(dir: string, message: Record<string, unknown>) =>
  wireRequest(dir, message) as Promise<T>;
const { invocationRouting, sequenceOptions } = load(
  "../src/queue-client",
) as typeof import("../src/queue-client");
const { mcpInvocation } = load("../src/catalog/index") as {
  mcpInvocation(
    name: string,
    options: Record<string, unknown>,
  ): {
    invocation: Record<string, unknown> & { purpose: string };
    argv: string[];
  };
};

function fixture(
  _t: test.TestContext,
  options: Partial<QueueDomainOptions> = {},
) {
  let time = 1000,
    id = 0;
  let saved: QueueSnapshot | undefined;
  const domainOptions = {
    now: () => time,
    newId: () => `id-${++id}`,
    hash: (text: string) => text,
    commit: (snapshot: QueueSnapshot) => {
      saved = structuredClone(snapshot);
    },
    ...options,
  };
  const state = new QueueDomain(domainOptions) as TestQueue;
  const submit = (clientId = "a", extra: Partial<QueueRequest> = {}) =>
    state.submit({
      requestId: `request-${++id}`,
      clientId,
      kind: "rpc",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
      timeoutMs: 1000,
      ...extra,
    });
  return {
    state,
    restore: () =>
      new QueueDomain({ ...domainOptions, snapshot: saved }) as TestQueue,
    submit,
    advance: (value: number) => {
      time += value;
    },
  };
}

function syntheticProbe(identity: Record<string, unknown>) {
  return {
    async callTool(args: { object: { script?: string } }) {
      const script = args.object.script;
      assert.equal(typeof script, "string");
      const { prepareWireArtifact } = load(
        "../src/dist/python/source-units",
      ) as {
        prepareWireArtifact(
          anchor: string,
          source: string,
        ): { units: Array<{ source: string }> };
      };
      const prepared = prepareWireArtifact(
        path.resolve(__dirname, "../runtime/python"),
        script!,
      );
      const code = prepared.units.map((unit) => unit.source).join("\n");
      const receiptPath = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
      const binding =
        /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
          code,
        );
      assert.ok(receiptPath && binding, "probe must use its bound receipt");
      const expected = JSON.parse(JSON.parse(binding[1]!)) as Record<
        string,
        unknown
      >;
      fs.writeFileSync(
        JSON.parse(receiptPath[1]!),
        JSON.stringify({
          ...expected,
          terminal: true,
          outcome: "succeeded",
          instance: identity,
          probeObservation: {
            schema: "fmcad-instance-probe-v1",
            identity,
          },
        }),
      );
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
      };
    },
  };
}

test("settled history causes no idle transactions; summary stays detached and omits history", (t) => {
  const { state, submit } = fixture(t);
  for (let i = 0; i < 50; i++) {
    submit();
    const job = state.next()!;
    state.finish(job.id);
  }
  const original = JSON.stringify(state.data);
  let commits = 0;
  const commit = state._commit.bind(state);
  state._commit = (change) => {
    commits++;
    return commit(change);
  };
  for (let i = 0; i < 1000; i++) assert.equal(state.next(), null);
  assert.equal(commits, 0);
  assert.equal(JSON.stringify(state.data), original);
  const summary = state.summary();
  assert.equal("jobs" in summary ? summary.jobs : undefined, undefined);
  assert.equal(summary.active, null);
  summary.paused = true;
  assert.equal(state.summary().paused, false);
  assert.equal(Object.keys(state.status().jobs).length, 50);
  state._fault = Error("synthetic uncertain storage");
  assert.throws(() => state.next(), { code: "STORAGE_UNAVAILABLE" });
  assert.throws(() => state.summary(), { code: "STORAGE_UNAVAILABLE" });
});

test("a settled sequence explicitly released before offline work admits another client immediately", (t) => {
  const { state, submit } = fixture(t);
  submit("a", {
    ownerToken: "private-a",
    sequence: { action: "begin", mode: "exclusive" },
  });
  const a = state.next()!;
  state.finish(a.id);
  const b = submit("b");
  assert.equal(state.next(), null);
  assert.throws(() => state.release(a.sequenceId, "b"), { code: "NOT_OWNER" });
  state.release(a.sequenceId, "a");
  assert.equal(
    state.next()!.id,
    b.id,
    "No clock advance or idle timeout needed",
  );
  state.finish(b.id);
  assert.throws(
    () =>
      submit("a", {
        ownerToken: "private-a",
        sequence: { action: "continue", id: a.sequenceId },
      }),
    { code: "SEQUENCE_MISMATCH" },
  );
  assert.throws(() => submit("a", { expectedRevision: 0 }), {
    code: "STALE_REVISION",
  });
  const fresh = submit("a", {
    expectedRevision: state.summary().revision,
    sequence: { action: "begin" },
  });
  const next = state.next()!;
  assert.equal(next.id, fresh.id);
  assert.notEqual(next.sequenceId, a.sequenceId);
});

test("dependent steps retain exclusivity and end releases it without truncating active work", (t) => {
  const { state, submit, advance } = fixture(t, { idleMs: 100, leaseMs: 1000 });
  submit("a", { sequence: { action: "begin", mode: "exclusive" } });
  const a = state.next()!,
    b = submit("b");
  advance(200);
  assert.equal(state.next(), null);
  assert.equal(state.summary().lease!.id, a.sequenceId);
  assert.throws(() => state.release(a.sequenceId, "a"), { code: "QUEUE_BUSY" });
  state.finish(a.id);
  const last = submit("a", { sequence: { action: "end", id: a.sequenceId } });
  assert.equal(state.next()!.id, last.id);
  state.finish(last.id);
  assert.equal(state.summary().lease, null);
  assert.equal(state.next()!.id, b.id);
});

test("idle lease and stale continuation expire on schedule; cached waiters update after commit", (t) => {
  const { state, submit, advance } = fixture(t, { idleMs: 100 });
  submit("a", { sequence: { action: "begin", mode: "exclusive" } });
  const a = state.next()!;
  state.finish(a.id);
  const continuation = submit("a", {
    sequence: { action: "continue", id: a.sequenceId },
  });
  const b = submit("b");
  advance(100);
  assert.equal(state.next()!.id, b.id);
  assert.equal(state.status(continuation.id).code, "SEQUENCE_EXPIRED");
  state.finish(b.id);
  assert.equal(state.next(), null);
});

test("administrative pause freezes queued deadlines without releasing unknown ownership", (t) => {
  const { state, submit, advance } = fixture(t, { idleMs: 50 });
  submit("a", { sequence: { action: "begin", mode: "exclusive" } });
  const a = state.next()!;
  state.block(a.id, "unknown remote outcome");
  const b = submit("b", { queueTimeoutMs: 100 });
  state.pause(true);
  advance(1000);
  assert.equal(state.next(), null);
  assert.equal(state.status(b.id).state, "queued");
  assert.equal(state.summary().blocked!.id, a.id);
  assert.equal(state.summary().lease!.id, a.sequenceId);
  assert.throws(() => state.release(a.sequenceId, "a"), { code: "QUEUE_BUSY" });
  state.resolve(a.id, { state: "failed", code: "RECONCILED" });
  const c = submit("b", { queueTimeoutMs: 100 });
  advance(100);
  assert.equal(state.next(), null);
  assert.equal(state.status(c.id).state, "queued");
  submit("b");
  assert.equal(state.next(), null);
  state.pause(false);
  assert.equal(state.next()!.id, b.id);
});

test("stale revisions and restored pending jobs still receive maintenance", (t) => {
  const { state, restore, submit } = fixture(t);
  const a = submit("a");
  const b = submit("b", { expectedRevision: 0 });
  assert.equal(state.next()!.id, a.id);
  state.finish(a.id);
  assert.equal(state.next(), null);
  assert.equal(state.status(b.id).code, "STALE_REVISION");
  const c = submit("c");
  const restored = restore();
  assert.equal(restored.next()!.id, c.id);
  const unresolved = restore();
  assert.equal(unresolved.summary().blocked!.id, c.id);
  assert.equal(unresolved.next(), null);
});

for (const mode of ["automatic", "exclusive"])
  test(`controlled broker IPC: ${mode} sequence and offline review`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qs-"));
    const identity = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: { status: "metadata-only" },
    };
    const physical = {
      server: { timeoutMs: 1000 },
      _parse: JSON.parse,
      async _post(payload: import("../src/queue-broker-ports").Rpc) {
        return {
          status: 200,
          raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
        };
      },
      ...syntheticProbe(identity),
    };
    const broker = await serve(
      { backend: "addin", timeoutMs: 1000 },
      {
        dir,
        confirmOwnership: true,
        createBackend: () =>
          physical as unknown as import("../src/queue-broker-ports").Client,
        nativePath: (file) => file,
        pollMs: 5,
      },
    );
    t.after(async () => {
      await broker.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const a = { clientId: "a", clientToken: "private-a" },
      b = { clientId: "b", clientToken: "private-b" };
    await request(dir, { action: "register", ...a });
    await request(dir, { action: "register", ...b });
    const call = <T = unknown>(
      auth: Auth,
      action: string,
      values: Record<string, unknown> = {},
    ) => request<T>(dir, { auth, action, ...values });
    const submit = (
      auth: Auth,
      sequence?: { action: string; mode?: string; id?: string },
    ) =>
      call<Job>(auth, "submit", {
        request: {
          kind: "rpc",
          requestId: randomUUID(),
          timeoutMs: 1000,
          payload: { jsonrpc: "2.0", id: 1, method: "ping" },
          ...(sequence ? { sequence } : {}),
        },
      });
    async function complete(auth: Auth, id: string) {
      for (let i = 0; i < 200; i++) {
        const { job } = await call<{ job: Job }>(auth, "result", { jobId: id });
        if (job.state === "succeeded") return job;
        assert(
          !["failed", "needs_reconciliation", "expired"].includes(job.state),
          JSON.stringify(job),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Controlled job did not finish");
    }
    const first = await submit(a, { action: "begin", mode });
    const settled = await complete(a, first.id);
    const waiting = await submit(b);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = Date.now();
    if (mode === "exclusive") {
      assert.equal(
        (await call<{ job: Job }>(b, "result", { jobId: waiting.id })).job
          .state,
        "queued",
      );
      await call(a, "release", { sequenceId: settled.sequenceId });
    } else {
      assert.equal(settled.sequenceState, "yielded");
      assert.equal(broker.status().lease, null);
    }
    const result = await complete(b, waiting.id);
    assert(result.finishedAt - before < 2000);
    assert.equal(broker.status().lease, null);
    assert.equal(broker.status().blocked, null);
    if (mode === "automatic") {
      const continued = await submit(a, {
        action: "end",
        id: settled.sequenceId,
      });
      await complete(a, continued.id);
    }
  });

test("broker traces a retained RPC response through publication without logging its text", async (t) => {
  const previousTrace = process.env["FMCAD_DEBUG_TRACE"];
  process.env["FMCAD_DEBUG_TRACE"] = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-trace-"));
  const resources: { broker?: Awaited<ReturnType<typeof serve>> } = {};
  t.after(async () => {
    try {
      await resources.broker?.close();
    } finally {
      if (previousTrace === undefined) delete process.env["FMCAD_DEBUG_TRACE"];
      else process.env["FMCAD_DEBUG_TRACE"] = previousTrace;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const identity = {
    pid: 99,
    birth: "mock:99",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  const privateResponseText = "private-response-text-marker";
  const physical = {
    server: { timeoutMs: 1000 },
    _parse: JSON.parse,
    async _post(payload: import("../src/queue-broker-ports").Rpc) {
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [{ type: "text", text: privateResponseText }],
          },
        }),
      };
    },
    ...syntheticProbe(identity),
  };
  resources.broker = await serve(
    { backend: "addin", timeoutMs: 1000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () =>
        physical as unknown as import("../src/queue-broker-ports").Client,
      nativePath: (file) => file,
      pollMs: 5,
    },
  );
  const auth = { clientId: "trace-client", clientToken: "private-token" };
  await request(dir, { action: "register", ...auth });
  const traceRuntime = load(
    "../src/dist/node-adapters/telemetry/diagnostic-log",
  ) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");
  const requestId = randomUUID();
  const trace = traceRuntime.createDebugTraceContext(
    requestId,
    auth.clientId,
    "cli",
    true,
  );
  assert.ok(trace);
  const accepted = await request<Job>(dir, {
    action: "submit",
    auth,
    request: {
      requestId,
      kind: "rpc",
      timeoutMs: 1000,
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
      debugTrace: trace,
    },
  });
  let result: { job: Job } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    result = await request<{ job: Job }>(dir, {
      action: "result",
      auth,
      jobId: accepted.id,
    });
    if (result.job.state === "succeeded") break;
    assert.notEqual(result.job.state, "needs_reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result?.job.state, "succeeded");
  await traceRuntime.flushDebugTrace();
  const events = traceRuntime.readDebugTrace(trace.traceId);
  const stages = events.map((event) => event["stage"]);
  for (const stage of [
    "request-accepted",
    "preflight",
    "sdk-dispatch",
    "raw-received",
    "parsed",
    "native-receipt",
    "result-published",
  ])
    assert(stages.includes(stage), `missing ${stage} trace stage`);
  assert(
    events.every(
      (event) =>
        event["traceId"] === trace.traceId && event["requestId"] === requestId,
    ),
  );
  const retained = events.find((event) => event["stage"] === "raw-received");
  assert.equal(retained?.["jobId"], accepted.id);
  assert.equal(typeof retained?.["rpcId"], "string");
  assert.equal(typeof retained?.["rawBytes"], "number");
  assert.match(String(retained?.["rawSha256"]), /^[a-f0-9]{64}$/);
  assert.equal(
    retained?.["artifactRef"] && typeof retained["artifactRef"],
    "string",
  );
  assert.equal(retained?.["stdoutObservation"], "not_observed");
  assert.equal(
    events.find((event) => event["stage"] === "result-published")?.["jobId"],
    accepted.id,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-response-text-marker|private-token/,
  );
});

test("broker traces accepted worker IPC across the client and handler", async (t) => {
  const previousTrace = process.env["FMCAD_DEBUG_TRACE"];
  process.env["FMCAD_DEBUG_TRACE"] = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-ipc-broker-trace-"));
  const resources: { broker?: Awaited<ReturnType<typeof serve>> } = {};
  t.after(async () => {
    try {
      await resources.broker?.close();
    } finally {
      if (previousTrace === undefined) delete process.env["FMCAD_DEBUG_TRACE"];
      else process.env["FMCAD_DEBUG_TRACE"] = previousTrace;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const identity = {
    pid: 99,
    birth: "mock:99",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  const privateToken = "private-worker-token-marker";
  const physical = {
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    _post() {
      throw new Error("This worker-status/listTools test must stay offline");
    },
    async listTools() {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return [{ name: "synthetic-tool" }];
    },
    ...syntheticProbe(identity),
  };
  const workerFixture = path.resolve(
    "tests/fixtures/queue-ipc-broker-worker.cjs",
  );
  const diagnosticModule = path.resolve(
    "src/dist/node-adapters/telemetry/diagnostic-log.js",
  );
  resources.broker = await serve(
    { backend: "addin", timeoutMs: 5000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () =>
        physical as unknown as import("../src/queue-broker-ports").Client,
      nativePath: (file) => file,
      pollMs: 5,
      spawnWorker: ((
        _executable: string,
        args: string[],
        options: import("node:child_process").SpawnOptions,
      ) => {
        const requestFile = args[1];
        assert.equal(typeof requestFile, "string");
        return spawn(process.execPath, [workerFixture], {
          ...options,
          env: {
            ...options.env,
            FMCAD_TEST_WORKER_REQUEST_FILE: requestFile,
            FMCAD_TEST_CONNECTION_MODULE: path.resolve(
              "src/queue-connection.js",
            ),
            FMCAD_TEST_DIAGNOSTIC_MODULE: diagnosticModule,
          },
        });
      }) as typeof spawn,
    },
  );

  const auth = { clientId: "ipc-trace-client", clientToken: privateToken };
  await request(dir, { action: "register", ...auth });
  const traceRuntime = load(
    "../src/dist/node-adapters/telemetry/diagnostic-log",
  ) as typeof import("../packages/node-adapters/src/telemetry/diagnostic-log");
  const requestId = randomUUID();
  const trace = traceRuntime.createDebugTraceContext(
    requestId,
    auth.clientId,
    "cli",
    true,
  );
  assert.ok(trace);
  const input = mcpInvocation("fmcad_cad_entity_list", {
    doc: "Model",
    docId: "creation",
    docFileId: "file",
    data: {},
    purpose: "Trace accepted worker IPC",
  });
  const accepted = await request<Job>(dir, {
    action: "submit",
    auth,
    request: {
      requestId,
      kind: "command",
      timeoutMs: 5000,
      cwd: dir,
      argv: input.argv,
      payload: input.invocation,
      description: input.invocation.purpose,
      debugTrace: trace,
    },
  });

  let result: { job: Job } | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    result = await request<{ job: Job }>(dir, {
      action: "result",
      auth,
      jobId: accepted.id,
    });
    if (
      ["succeeded", "failed", "needs_reconciliation"].includes(result.job.state)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result?.job.state, "succeeded", JSON.stringify(result));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await traceRuntime.flushDebugTrace();
  const events = traceRuntime.readDebugTrace(trace.traceId);
  const ipcEvents = events.filter((event) => event["stage"] === "ipc");
  assert(ipcEvents.length > 0, "missing worker IPC trace");
  assert(
    ipcEvents.every(
      (event) =>
        event["jobId"] === accepted.id &&
        event["requestId"] === requestId &&
        event["source"] === "cli" &&
        typeof event["buildHash"] === "string" &&
        typeof event["pid"] === "number",
    ),
  );
  assert.notEqual(
    new Set(ipcEvents.map((event) => event["pid"])).size,
    1,
    "the worker client and broker handler must be separate processes",
  );
  for (const action of ["backend", "worker-status"]) {
    const written = ipcEvents.filter(
      (event) =>
        event["action"] === action && event["ipcStage"] === "request-written",
    );
    assert(written.length >= 1, `missing ${action} request-written trace`);
    for (const item of written) {
      const correlated = ipcEvents.filter(
        (event) => event["messageId"] === item["messageId"],
      );
      for (const stage of [
        "handler-start",
        "request-accepted",
        "reply-emitted",
        "reply-received",
      ])
        assert(
          correlated.some((event) => event["ipcStage"] === stage),
          `missing ${action} IPC stage ${stage}`,
        );
    }
  }
  assert.doesNotMatch(JSON.stringify(events), /private-worker-token-marker/);
});

test("automatic default yields without an agent release and protects pending work", (t) => {
  const { state, submit, advance } = fixture(t, { leaseMs: 1000 });
  submit("a", { sequence: { action: "begin" } });
  const a = state.next()!,
    b = submit("b");
  assert.equal(a.sequenceMode, "automatic");
  assert.equal(state.summary().lease, null);
  advance(100);
  assert.equal(state.next(), null, "A running operation remains exclusive");
  state.finish(a.id);
  assert.equal(state.status(a.id).sequenceState, "yielded");
  assert.equal(state.next()!.id, b.id, "No release call or idle timeout");
  state.finish(b.id);
  assert.throws(
    () => submit("b", { sequence: { action: "continue", id: a.sequenceId } }),
    { code: "SEQUENCE_MISMATCH" },
  );
  const continuation = submit("a", {
    sequence: { action: "end", id: a.sequenceId },
  });
  assert.equal(state.next()!.id, continuation.id);
  state.finish(continuation.id);
  const fresh = submit("a", { sequence: { action: "begin" } });
  assert.equal(state.next()!.id, fresh.id);
  state.block(fresh.id, "unknown synchronous outcome");
  advance(10000);
  assert.equal(state.next(), null);
  assert.equal(state.summary().blocked!.id, fresh.id);
  assert.throws(() => state.release(state.status(fresh.id).sequenceId, "a"), {
    code: "QUEUE_BUSY",
  });
});

test("automatic continuation succeeds without intervening work and end closes its context", (t) => {
  const { state, submit } = fixture(t);
  submit("a", { ownerToken: "secret-a", sequence: { action: "begin" } });
  const first = state.next()!;
  state.finish(first.id);
  assert.throws(
    () =>
      submit("a", {
        ownerToken: "wrong",
        sequence: { action: "continue", id: first.sequenceId },
      }),
    { code: "SEQUENCE_MISMATCH" },
  );
  const continuation = submit("a", {
    ownerToken: "secret-a",
    sequence: { action: "end", id: first.sequenceId },
  });
  assert.equal(state.next()!.id, continuation.id);
  state.finish(continuation.id);
  assert.equal(state.status(continuation.id).sequenceState, "ended");
  assert.equal(state.summary().lease, null);
  assert.throws(
    () =>
      submit("a", {
        ownerToken: "secret-a",
        sequence: { action: "continue", id: first.sequenceId },
      }),
    { code: "SEQUENCE_MISMATCH" },
  );
});

test("intervening queue completion does not invalidate an automatic continuation globally", (t) => {
  const { state, submit } = fixture(t);
  submit("a", { sequence: { action: "begin" } });
  const first = state.next()!;
  state.finish(first.id);
  const other = submit("b");
  const planned = submit("a", {
    sequence: { action: "continue", id: first.sequenceId },
  });
  assert.equal(state.next()!.id, other.id);
  state.finish(other.id);
  assert.equal(state.next()!.id, planned.id);
  assert.equal(state.status(planned.id).state, "running");
});

test("offline calculations, saved-image processing and inspection never enter the Fusion queue", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qs-routing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "fmcad.json");
  fs.writeFileSync(config, "{}");
  const routing = (argv: string[]) =>
    invocationRouting([...argv, "--config", config]);
  const previous = process.env["FMCAD_ROUTING"];
  process.env["FMCAD_ROUTING"] = "queue";
  try {
    for (const argv of [
      ["fit", "stack", "--schema"],
      ["mass", "system", "--schema"],
      ["image", "trace", "--help"],
      ["run", "--list"],
      ["help", "queue"],
    ]) {
      assert.equal(routing(argv), false, argv.join(" "));
    }
    assert.equal(routing(["tools"]), true);
    assert.equal(
      routing([
        "review",
        "--doc",
        "mock",
        "--doc-id",
        "mock",
        "--out",
        "/tmp/mock-review",
      ]),
      true,
      "Only screenshot capture, not image assessment, needs Fusion",
    );
  } finally {
    if (previous === undefined) delete process.env["FMCAD_ROUTING"];
    else process.env["FMCAD_ROUTING"] = previous;
  }
});

test("sequence mode is optional and explicit exclusive mode is validated", (t) => {
  assert.deepEqual(sequenceOptions({ "sequence-action": "begin" }), {
    action: "begin",
  });
  assert.deepEqual(
    sequenceOptions({
      "sequence-action": "begin",
      "sequence-mode": "exclusive",
    }),
    { action: "begin", mode: "exclusive" },
  );
  assert.throws(() =>
    sequenceOptions({ "sequence-action": "begin", "sequence-mode": "unknown" }),
  );
  const { state, submit, advance } = fixture(t, { leaseMs: 100 });
  assert.throws(
    () =>
      submit("a", {
        sequence: {
          action: "begin",
          mode: "unknown" as unknown as import("../packages/core/src/domain/queue-model").SequenceMode,
        },
      }),
    { code: "INVALID_SEQUENCE" },
  );
  submit("a", { sequence: { action: "begin" } });
  const first = state.next()!;
  state.finish(first.id);
  assert.throws(
    () =>
      submit("a", {
        sequence: {
          action: "continue",
          id: first.sequenceId,
          mode: "exclusive",
        },
      }),
    { code: "SEQUENCE_MISMATCH" },
  );
  const continuation = submit("a", {
    sequence: { action: "continue", id: first.sequenceId },
  });
  assert.throws(
    () =>
      submit("a", { sequence: { action: "continue", id: first.sequenceId } }),
    { code: "SEQUENCE_BUSY" },
  );
  advance(100);
  assert.equal(state.next(), null);
  assert.equal(state.status(continuation.id).code, "SEQUENCE_EXPIRED");
});
