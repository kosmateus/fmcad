import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createTurnIdentity as turn,
  executeTurn,
  prepare,
  runBrokerProductTurn,
} from "../packages/core/src/application/broker-execution";
import { createBrokerScheduler } from "../packages/core/src/application/broker-scheduler";
import { createBrokerSession } from "../packages/core/src/application/broker-session";
import { completeSdkTurn } from "../packages/core/src/application/execution";
import { QueueDomain } from "../packages/core/src/domain/queue";
import type {
  AtomicWorkflowObservation,
  QueueJob,
} from "../packages/core/src/domain/queue-model";

const context = (id: string) => ({ job: { id } });
const publish = () => undefined;
const stale = { code: "RECONCILIATION_REQUIRED" };
const busy = { code: "BROKER_SESSION_BUSY" };

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a late product preflight cannot execute or publish after its grant is revoked", async () => {
  const started = latch();
  const returned = latch();
  let current = true;
  const never = () => assert.fail("revoked grant reached a later phase");
  const result = runBrokerProductTurn({
    inspectPrepared: () => false,
    errorInfo: never,
    refusePreparation: never,
    verifyLocalInputs: () => true,
    assertCurrent() {
      if (!current) throw Object.assign(new Error("Revoked"), stale);
    },
    async preflight() {
      started.release();
      await returned.promise;
    },
    sameObservedInstance: never,
    refusePreflight: never,
    verifyDocument: never,
    executeAndComplete: never,
  });
  await started.promise;
  current = false;
  returned.release();
  await assert.rejects(result, stale);
});

test("an active snapshot cannot reveal or mutate live execution context", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const job = context("original");
  const grant = session.acquire(job, turn("original"));
  const view = session.snapshot().active;
  assert.ok(view);
  const exposed = Object.getOwnPropertyDescriptor(view, "context");
  if (exposed) Reflect.set(exposed.value.job, "id", "other");
  assert.equal(job.job.id, "original");
  assert.equal(exposed, undefined);
  assert.deepEqual(view, { jobId: "original", generation: grant.generation });
  assert.ok(Object.isFrozen(view));
  session.assertCurrentGrant(grant);
});

function assertNoAuthority(
  session: ReturnType<typeof createBrokerSession<ReturnType<typeof context>>>,
  handle: unknown,
) {
  assert.throws(
    () => Reflect.apply(session.settle, undefined, [handle, publish]),
    stale,
  );
  assert.throws(
    () => Reflect.apply(session.hold, undefined, [handle, "forged hold"]),
    stale,
  );
}

test("an active snapshot cannot publish transitions", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const grant = session.acquire(context("job"), turn("job"));
  const active = session.snapshot().active;
  assert.ok(active);
  assertNoAuthority(session, active);
  session.assertCurrentGrant(grant);
});

test("a held snapshot cannot reveal context or publish transitions", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const grant = session.acquire(context("job"), turn("job"));
  const hold = session.hold(grant, "unknown");
  const held = session.snapshot().held;
  assert.ok(held);
  assert.ok(Object.isFrozen(held));
  assertNoAuthority(session, held);
  assert.deepEqual(held, {
    jobId: "job",
    reason: "unknown",
    generation: hold.generation,
  });
  session.settle(hold, publish);
});

test("only the minted grant owns a physical turn, even for the same job", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const job = context("job");
  const firstTurn = turn("job");
  const first = session.acquire(job, firstTurn);
  assert.equal(first.turn, firstTurn);
  assert.equal(first.context, job);
  session.assertCurrentGrant(first);
  assert.throws(() => session.assertCurrentGrant({ ...first }), stale);
  const other = createBrokerSession<ReturnType<typeof context>>();
  const foreign = other.acquire(job, firstTurn);
  assert.deepEqual(foreign, first);
  assert.throws(() => session.settle(foreign, publish), stale);
  assert.throws(() => session.acquire(job, turn("job")), busy);

  const finished: number[] = [];
  const lateCallback = () =>
    session.settle(first, () => {
      finished.push(first.generation);
    });
  lateCallback();
  assert.throws(() => session.acquire(job, firstTurn), {
    code: "PREPARED_RPC_UNAVAILABLE",
  });
  assert.throws(() => session.acquire(job, turn("wrong job")), {
    code: "PREPARED_RPC_UNAVAILABLE",
  });
  const second = session.acquire(job, turn("job"));
  assert.ok(second.generation > first.generation);
  assert.throws(lateCallback, stale);
  assert.throws(() => session.hold(first, "old timeout"), stale);
  assert.deepEqual(finished, [first.generation]);
  assert.equal(session.snapshot().active?.generation, second.generation);
  session.assertCurrentGrant(second);
});

test("a changed owner context cannot dispatch or settle the original turn", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const job = context("original");
  const grant = session.acquire(job, turn("original"));
  job.job.id = "different";
  assert.throws(() => session.assertCurrentGrant(grant), stale);
  assert.throws(() => session.settle(grant, publish), stale);
  const hold = session.hold(grant, "owner context changed");
  assert.equal(hold.jobId, "original");
});

test("holding fences dispatch; only authorized scoped work can borrow the slot", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const owner = session.acquire(context("owner"), turn("owner"));
  const blocked = session.hold(owner, "remote outcome unknown", () => {
    assert.throws(() => session.assertCurrentGrant(owner), busy);
    assert.equal(session.snapshot().active, null);
  });
  const observer = context("observer");
  assert.equal(blocked.context, owner.context);
  assert.throws(() => session.settle(owner, publish), stale);
  assert.throws(() => session.acquire(observer, turn("observer")), busy);
  assert.throws(
    () => session.acquire(observer, turn("observer"), { ...blocked }),
    busy,
  );
  const scoped = session.acquire(observer, turn("observer"), blocked);
  assert.throws(() => session.settle(blocked, publish), stale);
  session.settle(scoped, publish);
  assert.equal(session.snapshot().held?.generation, blocked.generation);
  session.settle(blocked, publish);
  assert.equal(session.snapshot().held, null);
  assert.throws(
    () => session.acquire(observer, turn("observer"), blocked),
    busy,
  );
});

test("a refused durable transition does not reopen the physical slot", () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const job = context("job");
  const grant = session.acquire(job, turn("job"));
  const diskFault = () => {
    throw new Error("storage unavailable");
  };
  assert.throws(() => session.settle(grant, diskFault), /storage unavailable/);
  session.assertCurrentGrant(grant);
  assert.throws(() => session.hold(grant, "storage unavailable", diskFault));
  assert.throws(() => session.assertCurrentGrant(grant), stale);
  assert.throws(() => session.acquire(job, turn("job")), busy);
  assert.equal(session.snapshot().held?.reason, "storage unavailable");
});

test("late admission cannot send with the old grant of the same job", async () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const job = context("job");
  const logicalTurn = turn("job");
  const prepared = await prepare(logicalTurn, () => "exact checked wire bytes");
  const original = session.acquire(job, logicalTurn);
  const atAdmission = latch();
  const resumeAdmission = latch();
  const sends: string[] = [];
  const result = executeTurn(original, prepared, {
    check() {},
    async admit(send) {
      atAdmission.release();
      await resumeAdmission.promise;
      return send();
    },
    assertCurrentGrant: session.assertCurrentGrant,
    fence: publish,
    async send(bytes) {
      sends.push(bytes);
    },
    settle: publish,
    unknown(error) {
      assert.fail(`must fail before send: ${String(error)}`);
    },
  });
  await atAdmission.promise;
  session.settle(original, publish);
  const replacement = session.acquire(job, turn("job"));
  resumeAdmission.release();
  await assert.rejects(result, stale);
  assert.deepEqual(sends, []);
  session.assertCurrentGrant(replacement);
});

test("an in-flight turn does not lock local preparation, expiry, or wakeups", async () => {
  let now = 0;
  let id = 0;
  const domain = new QueueDomain({
    now: () => now,
    newId: () => `job-${++id}`,
    hash: (input) => createHash("sha256").update(input).digest("hex"),
  });
  const submit = (
    requestId: string,
    clientId: string,
    queueTimeoutMs?: number,
  ) =>
    String(
      domain.submit({
        requestId,
        clientId,
        kind: "command",
        argv: ["fixture"],
        cwd: "/fixture",
        timeoutMs: 100,
        queueTimeoutMs: queueTimeoutMs ?? 1000,
      })["id"],
    );
  const phased = String(
    domain.submit({
      requestId: "between-turns",
      clientId: "B",
      kind: "command",
      argv: ["fixture"],
      cwd: "/fixture",
      phased: true,
      timeoutMs: 70,
      queueTimeoutMs: 100,
    })["id"],
  );
  const first = submit("first", "A");
  const sameOwner = submit("same-owner", "A");
  const expiring = submit("expiring", "C", 10);
  const session = createBrokerSession<{ job: QueueJob }>();
  const starts: string[] = [];
  const deferred: (() => void)[] = [];
  const firstIdle = latch();
  let localPrepared = false;
  const scheduler = createBrokerScheduler({
    maintain() {
      if (!session.snapshot().active) return;
      // With a normal durable turn active, the domain can expire jobs without
      // granting another turn. Local readiness is independent of that slot.
      assert.equal(domain.next(), null);
      if (!localPrepared) {
        localPrepared = true;
        domain.readyTurn(phased);
      }
    },
    canSelect: () => !session.snapshot().active,
    select: () => domain.next(),
    async start(job) {
      const grant = session.acquire({ job }, turn(job.id));
      starts.push(job.id);
      if (job.id === first) await firstIdle.promise;
      if (job.id === phased) {
        assert.equal(job.runDeadline, now + 70);
        session.settle(grant, () => {
          domain.releaseTurn(job.id, 55);
        });
      } else {
        session.settle(grant, () => {
          domain.finish(job.id);
        });
      }
    },
    defer(wake) {
      deferred.push(wake);
    },
    onFailure(error) {
      assert.fail(String(error));
    },
  });

  const executing = scheduler.tick();
  assert.deepEqual(starts, [first]);
  now = 11;
  await scheduler.tick();
  assert.deepEqual(starts, [first]);
  assert.equal(domain.status(expiring)["state"], "expired");
  assert.equal(domain.status(phased)["state"], "queued");
  firstIdle.release();
  await executing;
  scheduler.wakeup();
  assert.equal(deferred.length, 1);
  deferred.shift()?.();
  assert.deepEqual(starts, [first, phased]); // Domain fairness chooses owner B.
  // Local phase can process and make its next turn ready before owner A runs.
  assert.equal(domain.status(phased)["state"], "processing");
  assert.equal(domain.status(phased)["sdkRemainingMs"], 55);
  await scheduler.tick();
  assert.deepEqual(starts, [first, phased, sameOwner]);
});

test("a hold blocks ordinary selection without suspending maintenance", async () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const hold = session.hold(null, "startup awaits evidence");
  let maintained = 0;
  const scheduler = createBrokerScheduler({
    maintain() {
      maintained++;
    },
    canSelect: () => !session.snapshot().held,
    select: () => assert.fail("an unscoped selector must not run under a hold"),
    start: () => assert.fail("no work is authorized"),
    defer: () => assert.fail("an idle tick must not spin"),
    onFailure: (error) => assert.fail(String(error)),
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(maintained, 2);
  assert.equal(session.snapshot().held?.generation, hold.generation);
});

test("the next turn can start before the previous local finalizer returns", async () => {
  const session = createBrokerSession<ReturnType<typeof context>>();
  const jobs = ["first", "second"];
  const finalizing = latch();
  const finalized = latch();
  const calls: string[] = [];
  const scheduled: (() => void)[] = [];
  const scheduler = createBrokerScheduler({
    maintain() {},
    canSelect: () => !session.snapshot().active,
    select: () => jobs.shift() ?? null,
    async start(job) {
      const grant = session.acquire(context(job), turn(job));
      await completeSdkTurn({
        async settle() {},
        async postflight() {
          calls.push(`${job}: SDK settled`);
        },
        release() {
          session.settle(grant, publish);
          scheduler.wakeup();
        },
        async finalize() {
          if (job === "first") {
            finalizing.release();
            await finalized.promise;
          }
          calls.push(`${job}: finalized`);
        },
      });
    },
    defer: (wake) => scheduled.push(wake),
    onFailure: (error) => assert.fail(String(error)),
  });
  const first = scheduler.tick();
  await finalizing.promise;
  assert.deepEqual(calls, ["first: SDK settled"]);
  assert.equal(scheduled.length, 1);
  await scheduler.tick();
  assert.deepEqual(calls, [
    "first: SDK settled",
    "second: SDK settled",
    "second: finalized",
  ]);
  finalized.release();
  await first;
  assert.equal(calls.at(-1), "first: finalized");
});

test("a restored block still selects exactly its armed observer and expires ordinary work", () => {
  let now = 10;
  let id = 0;
  const options = {
    now: () => now,
    newId: () => `id-${++id}`,
    hash: (input: string) => createHash("sha256").update(input).digest("hex"),
  };
  const queue = new QueueDomain(options);
  const command = {
    clientId: "owner",
    kind: "command",
    cwd: "/fixture",
    argv: ["cad"],
    timeoutMs: 100,
    buildHash: "fixture-build",
  };
  queue.submit({ ...command, requestId: "original" });
  const original = queue.next();
  assert.ok(original);
  queue.block(original.id, "remote outcome unknown");

  const data = {
    reportPath: "/fixture/report.json",
    blockedJobId: original.id,
    commandId: `fmcad_atomic_${"c".repeat(32)}`,
    sessionNonce: "d".repeat(32),
  };
  const observation = {
    ...command,
    payload: {
      kind: "cad",
      operation: "batch.reconcile",
      data,
      docId: "original-document",
    },
  };
  const ordinary = String(
    queue.submit({
      ...observation,
      requestId: "unarmed-observer-lookalike",
      queueTimeoutMs: 20,
    })["id"],
  );
  const observerId = String(
    queue.submit({ ...observation, requestId: "armed-observer" })["id"],
  );
  const marker: AtomicWorkflowObservation = {
    version: 1,
    kind: "atomic-holder-status",
    targetJobId: original.id,
    targetRequestId: original.requestId,
    targetClientId: original.clientId,
    targetJobHash: original.hash,
    observerJobHash: queue.data.jobs[observerId]!.hash,
    targetBuildHash: command.buildHash,
    observerBuildHash: command.buildHash,
    projectDirectory: command.cwd,
    paused: false,
    controlGeneration: 0,
    contextEpoch: 0,
    reportPath: data.reportPath,
    reportFingerprint: "e".repeat(64),
    commandId: data.commandId,
    sessionNonce: data.sessionNonce,
    docId: observation.payload.docId,
  };
  queue.armWorkflowObservation(observerId, marker);
  const restored = new QueueDomain({ ...options, snapshot: queue.data });
  now = 30;
  assert.equal(restored.next({ grant: false }), null);
  assert.equal(restored.status(observerId)["state"], "queued");
  assert.equal(restored.status(ordinary)["state"], "expired");
  assert.equal(restored.summary().active, original.id);
  assert.equal(restored.summary().blocked?.id, original.id);
  assert.equal(restored.next()?.id, observerId);
  restored.finish(observerId);
  assert.equal(restored.next(), null);
  assert.equal(restored.status(ordinary)["state"], "expired");
  assert.equal(restored.summary().active, original.id);
  assert.equal(restored.summary().blocked?.id, original.id);
});
