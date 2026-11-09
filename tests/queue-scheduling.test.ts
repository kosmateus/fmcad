import type {
  QueueDomainOptions,
  QueueSnapshot,
  QueueRequest,
} from "../packages/core/src/domain/queue-model";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
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
      async callTool() {
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
        };
      },
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
