import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests", "queue-domain.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
const {
  QueueDomain,
  initialQueueSnapshot,
  transitionQueue,
  selectDocument,
  compareDocumentState,
  budgetTransition,
  budgetRemaining,
  gatePhase,
  controlEligibility,
} = load("../src/dist/core") as typeof import("../packages/core/src");

type JobStatus = {
  id: string;
  state: string;
  code?: string;
  physicalTurns?: number;
  executionOutcome?: string;
  operationResult: {
    executionOutcome: string;
    code: string;
    mayHaveMutated: boolean;
  };
};
type WholeStatus = { paused: boolean; jobs: Record<string, JobStatus> };
type TestQueue = Omit<
  InstanceType<typeof QueueDomain>,
  "status" | "pause" | "submit" | "next"
> & {
  status(): WholeStatus;
  status(id: string): JobStatus;
  pause(value: boolean, request?: string): WholeStatus;
  submit(
    input: import("../packages/core/src/domain/queue-model").QueueRequest,
  ): JobStatus;
  next(): JobStatus | null;
};
function fixture(
  options: Partial<
    import("../packages/core/src/domain/queue-model").QueueDomainOptions
  > = {},
) {
  let time = 1000,
    id = 0;
  const input = {
    now: () => time,
    newId: () => `job-${++id}`,
    hash: (value: string) => value,
    ...options,
  };
  const queue = new QueueDomain(input) as TestQueue;
  const submit = (
    clientId = "a",
    extra: Partial<
      import("../packages/core/src/domain/queue-model").QueueRequest
    > = {},
  ) =>
    queue.submit({
      requestId: `request-${++id}`,
      clientId,
      kind: "rpc",
      payload: { method: "mutate", bytes: "original" },
      timeoutMs: 100,
      ...extra,
    });
  return {
    queue,
    submit,
    advance: (ms: number) => {
      time += ms;
    },
    restore: () =>
      new QueueDomain({ ...input, snapshot: queue.data }) as TestQueue,
  };
}

test("transition inputs produce identical snapshots and persistence intents without mutating input", () => {
  const snapshot = initialQueueSnapshot();
  const before = structuredClone(snapshot);
  const action: import("../packages/core/src/domain/queue-transition").QueueAction =
    {
      type: "submit",
      request: {
        requestId: "r",
        clientId: "a",
        kind: "rpc",
        payload: {},
        timeoutMs: 100,
      },
    };
  const input = { time: 1000, ids: ["job"], hash: (value: string) => value };
  const first = transitionQueue(snapshot, action, input);
  assert.deepEqual(transitionQueue(snapshot, action, input), first);
  assert.deepEqual(snapshot, before);
  assert.ok(
    first.result && typeof first.result === "object" && "id" in first.result,
  );
  assert.equal(first.result.id, "job");
  assert.equal(first.effects.at(-1)!.snapshot.jobs["job"]!.state, "queued");
  const running = transitionQueue(first.state, { type: "next" }, input);
  assert.equal(running.state.active, "job");
  assert.equal(
    transitionQueue(running.state, { type: "next" }, input).result,
    null,
  );
  const recovered = transitionQueue(running.state, { type: "recover" }, input);
  assert.equal(recovered.state.jobs["job"]!.state, "needs_reconciliation");
  assert.deepEqual(
    transitionQueue(running.state, { type: "recover" }, input),
    recovered,
  );
  assert.equal(
    transitionQueue(recovered.state, { type: "next" }, input).result,
    null,
  );
});

test("request conflict, changed immutable bytes and stale revision refuse before job mutation", () => {
  const { queue, submit } = fixture();
  const job = submit();
  const request = queue.data.jobs[job.id]!.request;
  const before = structuredClone(queue.data);
  assert.equal(
    queue.submit({ ...request, description: "new readable label" }).id,
    job.id,
  );
  assert.throws(
    () =>
      queue.submit({
        ...request,
        payload: {
          ...(request.payload as Record<string, unknown>),
          bytes: "changed",
        },
      }),
    { code: "REQUEST_CONFLICT" },
  );
  assert.deepEqual(queue.data, before);
  assert.throws(() => submit("b", { expectedRevision: 1 }), {
    code: "STALE_REVISION",
  });
  assert.deepEqual(queue.data, before);
});

test("queue status and pause preserve reconciled legacy completed outcomes", () => {
  const { queue, submit } = fixture();
  const job = submit();
  queue.next();
  queue.finish(job.id, {
    state: "succeeded",
    code: "OPERATOR_RECEIPT_RECONCILED",
    executionOutcome: "succeeded",
    userScriptSubmitted: true,
    mayHaveMutated: true,
  });
  queue.data.jobs[job.id]!.details!["executionOutcome"] = "completed";

  const status = queue.status();
  assert.equal(status.jobs[job.id]!.state, "succeeded");
  assert.equal(status.jobs[job.id]!.executionOutcome, "completed");
  assert.equal(
    status.jobs[job.id]!.operationResult.executionOutcome,
    "succeeded",
  );
  assert.equal(
    status.jobs[job.id]!.operationResult.code,
    "OPERATOR_RECEIPT_RECONCILED",
  );
  assert.equal(status.jobs[job.id]!.operationResult.mayHaveMutated, true);

  const paused = queue.pause(true, "legacy-outcome-pause");
  assert.equal(paused.paused, true);
  assert.equal(
    paused.jobs[job.id]!.operationResult.executionOutcome,
    "succeeded",
  );
  assert.equal(
    queue.data.jobs[job.id]!.details!["executionOutcome"],
    "completed",
  );
});

test("unknown legacy outcome strings project as unknown instead of blocking queue control", () => {
  const { queue, submit } = fixture();
  const job = submit();
  queue.next();
  queue.finish(job.id, {
    state: "succeeded",
    code: "HISTORICAL_RECEIPT",
    executionOutcome: "succeeded",
    mayHaveMutated: true,
  });
  queue.data.jobs[job.id]!.details!["executionOutcome"] =
    "future-legacy-outcome";

  const projected = queue.status().jobs[job.id]!;
  assert.equal(projected.state, "succeeded");
  assert.equal(projected.executionOutcome, "future-legacy-outcome");
  assert.equal(projected.operationResult.executionOutcome, "unknown");
  assert.equal(projected.operationResult.mayHaveMutated, true);
  assert.equal(projected.operationResult.code, "HISTORICAL_RECEIPT");

  const paused = queue.pause(true, "unknown-legacy-outcome-pause");
  assert.equal(paused.paused, true);
  assert.equal(
    paused.jobs[job.id]!.operationResult.executionOutcome,
    "unknown",
  );
  assert.equal(
    queue.data.jobs[job.id]!.details!["executionOutcome"],
    "future-legacy-outcome",
  );
});

test("limits count local prepare and processing, but these phases do not own SDK admission", () => {
  const { queue, submit } = fixture({ maxQueued: 2, maxPerClient: 1 });
  const a = submit("a", {
    kind: "command",
    phased: true,
    argv: ["run", "x.py"],
    cwd: "/fixture",
  });
  assert.throws(() => submit("a"), { code: "CLIENT_QUEUE_FULL" });
  const b = submit("b");
  assert.throws(() => submit("c"), { code: "QUEUE_FULL" });
  assert.equal(queue.next()!.id, b.id);
  queue.finish(b.id);
  queue.readyTurn(a.id);
  assert.equal(queue.next()!.id, a.id);
  queue.releaseTurn(a.id, 80);
  const c = submit("c");
  assert.equal(queue.next()!.id, c.id);
  queue.finish(c.id);
  queue.readyTurn(a.id);
  assert.equal(queue.next()!.id, a.id);
  queue.releaseTurn(a.id, 20);
  assert.equal(queue.status(a.id).physicalTurns, 2);
  queue.finishLocal(a.id);
});

test("per-client FIFO, fairness, exact expiry, future clock and SDK budget exhaustion", () => {
  const { queue, submit, advance } = fixture();
  const a = submit("a"),
    a2 = submit("a"),
    b = submit("b", { queueTimeoutMs: 10 });
  assert.equal(queue.next()!.id, a.id);
  queue.finish(a.id);
  advance(10);
  assert.equal(queue.next()!.id, a2.id);
  assert.equal(queue.status(b.id).code, "QUEUE_EXPIRED");
  queue.finish(a2.id);
  const local = submit("a", {
    kind: "command",
    phased: true,
    argv: ["x"],
    cwd: "/fixture",
  });
  queue.readyTurn(local.id);
  queue.next();
  queue.releaseTurn(local.id, 0);
  assert.throws(() => queue.readyTurn(local.id), { code: "RUN_TIMEOUT" });
  advance(1e12);
  assert.equal(queue.next(), null);
});

test("restart holds unknown SDK ownership and never replays interrupted local work", () => {
  const { queue, submit, restore } = fixture();
  const local = submit("b", {
    kind: "command",
    phased: true,
    argv: ["x"],
    cwd: "/fixture",
  });
  const sdk = submit("a");
  queue.next();
  queue.markDispatch(sdk.id);
  const restored = restore();
  assert.equal(restored.status(local.id).code, "LOCAL_WORKER_INTERRUPTED");
  assert.equal(restored.status(sdk.id).state, "needs_reconciliation");
  assert.equal(restored.next(), null);
  assert.throws(() => restored.finish(sdk.id), {
    code: "RECONCILIATION_REQUIRED",
  });
  restored.resolve(sdk.id, { state: "failed" });
  assert.equal(restored.next(), null);
});

test("uncertain persistence poisons admissions without publishing the proposed state", () => {
  let fail = false;
  const { queue, submit } = fixture({
    commit: () => {
      if (fail)
        throw Object.assign(Error("uncertain"), {
          code: "STORAGE_UNAVAILABLE",
        });
    },
  });
  const a = submit();
  const before = structuredClone(queue.data);
  fail = true;
  assert.throws(() => queue.next(), { code: "STORAGE_UNAVAILABLE" });
  assert.deepEqual(queue.data, before);
  assert.equal(queue.data.jobs[a.id]!.state, "queued");
  assert.throws(() => queue.next(), { code: "STORAGE_UNAVAILABLE" });
});

test("idle scheduling does not enumerate retained terminal history or persist", () => {
  const { queue, submit } = fixture();
  const job = submit();
  queue.next();
  queue.finish(job.id);
  queue.data.jobs = new Proxy(queue.data.jobs, {
    ownKeys() {
      throw Error("history scan");
    },
  });
  for (let i = 0; i < 1000; i++) assert.equal(queue.next(), null);
});

test("document policy is parsed-intent only and ignores unrelated queue/document changes", () => {
  assert.deepEqual(
    selectDocument({
      kind: "cad",
      name: "A",
      creationId: "a",
      fileId: "file-a",
    }),
    { name: "A", creationId: "a", fileId: "file-a" },
  );
  assert.deepEqual(selectDocument({ kind: "rpc", rpcMethod: "tools/list" }), {
    metadataOnly: true,
  });
  assert.deepEqual(selectDocument({ kind: "docops", target: "docOpenCmd" }), {
    metadataOnly: true,
  });
  assert.equal(selectDocument({ kind: "cad" }), null);
  const a = {
    status: "complete",
    fingerprint: "document-a-only",
    state: { identity: { creationId: "a" } },
  };
  const unrelated = { ...a, queueRevision: 999, otherDocument: "changed" };
  assert.equal(compareDocumentState(a, unrelated), null);
  assert.equal(
    compareDocumentState(a, { ...a, fingerprint: "changed-input" }),
    "DOCUMENT_CHANGED",
  );
  assert.equal(
    compareDocumentState(a, { ...a, state: { identity: { creationId: "b" } } }),
    "DOCUMENT_TARGET_CHANGED",
  );
  assert.equal(compareDocumentState(null, a), "DOCUMENT_BASELINE_REQUIRED");
  assert.equal(
    compareDocumentState(a, { status: "unavailable" }),
    "DOCUMENT_STATE_UNAVAILABLE",
  );
});

test("pause budget and control/drain policy are pure, generation fenced, and handle future clocks", () => {
  const initial = {
    left: 100,
    start: 1000,
    frozen: false,
    ended: false,
    generation: 1,
  };
  assert.equal(budgetRemaining(initial, 900), 100);
  const frozen = budgetTransition(initial, "freeze", 1020);
  assert.equal(frozen.state.left, 80);
  assert.equal(frozen.effect, "cancel");
  assert.equal(budgetRemaining(frozen.state, 1e12), 80);
  assert.equal(
    budgetTransition(frozen.state, "expire", 1e12, 1).effect,
    "none",
  );
  const resumed = budgetTransition(frozen.state, "resume", 2000);
  assert.equal(resumed.effect, "schedule");
  assert.equal(
    budgetTransition(resumed.state, "expire", 2080, resumed.state.generation)
      .effect,
    "expired",
  );
  assert.deepEqual(initial, {
    left: 100,
    start: 1000,
    frozen: false,
    ended: false,
    generation: 1,
  });
  const data = initialQueueSnapshot();
  data.paused = true;
  assert.equal(gatePhase(data, 1, false), "PAUSING");
  assert.equal(gatePhase(data, 0, false), "PAUSED");
  const intent = { paused: false, requestId: "resume", expectedGeneration: 0 };
  assert.throws(() => controlEligibility(data, intent, "instance", 1, false), {
    code: "RECONCILIATION_REQUIRED",
  });
  data.blocked = { id: "unknown", at: 1000, reason: "no proof" };
  assert.equal(gatePhase(data, 0, false), "RECOVERY_BLOCKED");
  assert.throws(() => controlEligibility(data, intent, "instance", 0, false), {
    code: "RECONCILIATION_REQUIRED",
  });
  data.controlRequests = { resume: { paused: false, generation: 1 } };
  assert.deepEqual(controlEligibility(data, intent, "instance", 0, false), {
    appliedGeneration: 1,
  });
  assert.throws(
    () =>
      controlEligibility(
        data,
        { ...intent, paused: true },
        "instance",
        0,
        false,
      ),
    { code: "REQUEST_CONFLICT" },
  );
});
