import test from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  QueueJob,
  QueueSnapshot,
} from "../packages/core/src/domain/queue-model";
const runtimeRequire = createRequire(__filename);
const root = path.resolve(__dirname, "../..");
const { createPhaseTimingProducer, readPhaseTimingReceipt } = runtimeRequire(
  path.join(root, "packages/node-adapters/dist/telemetry/phase-timings"),
) as typeof import("../packages/node-adapters/src/telemetry/phase-timings");
const { normalizeConsoleTelemetryJob } = runtimeRequire(
  path.join(root, "packages/core/dist/application/console-telemetry"),
) as typeof import("../packages/core/src/application/console-telemetry");
function job(id = "timing-job"): QueueJob {
  return {
    id,
    requestId: "request-" + id,
    clientId: "client",
    kind: "command",
    request: {
      requestId: "request-" + id,
      clientId: "client",
      kind: "command",
      timeoutMs: 1000,
    },
    hash: "hash-" + id,
    order: 0,
    state: "queued",
    submittedAt: 1000,
    queueDeadline: null,
    timeoutMs: 1000,
    sequenceId: null,
    sequenceState: null,
    sequenceMode: "automatic",
  };
}
function snapshot(jobs: QueueJob[], paused = false): QueueSnapshot {
  return {
    version: 1,
    paused,
    revision: 1,
    epoch: 0,
    blocked: null,
    active: null,
    lease: null,
    jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    lastClient: null,
  };
}
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-phase-timing-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let mono = 0,
    wall = 1000;
  const producer = createPhaseTimingProducer({
    monotonicNow: () => mono,
    wallNow: () => wall,
    epoch: "producer-one",
  });
  producer.queueCommitted(snapshot([]), directory);
  return {
    directory,
    producer,
    advance(ms: number) {
      mono += ms;
      wall += ms;
    },
    wall(value: number) {
      wall = value;
    },
  };
}
test("source transitions separate queue waiting, manual pause and actual sending", (t) => {
  const f = fixture(t),
    j = job();
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(20);
  f.producer.queueCommitted(snapshot([j], true), f.directory);
  f.advance(30);
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(40);
  j.state = "running";
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(10);
  j.state = "sending";
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(50);
  f.wall(900);
  j.state = "processing";
  f.producer.queueCommitted(snapshot([j]), f.directory);
  const receipt = readPhaseTimingReceipt(f.directory, j);
  assert.ok(receipt);
  assert.deepEqual(receipt.totals.queueWait, {
    durationMs: 60,
    intervals: 2,
    complete: true,
  });
  assert.deepEqual(receipt.totals.pause, {
    durationMs: 30,
    intervals: 1,
    complete: true,
  });
  assert.deepEqual(receipt.totals.sdkActive, {
    durationMs: 50,
    intervals: 1,
    complete: true,
  });
  assert.deepEqual(
    receipt.queueWaitSamples.map((s) => s.valueMs),
    [20, 40],
  );
  assert.equal(
    receipt.observedAtMs,
    900,
    "a wall-clock adjustment must not change a measured duration",
  );
  const event = normalizeConsoleTelemetryJob(
    { ...j, physicalTurns: 1, sourcePhaseTimings: receipt },
    { sourceId: "fixture", epoch: "one", sequence: 1, readAtMs: 2000 },
  );
  assert.equal(event.timings.queueWaitMs.value, 60);
  assert.equal(event.timings.sdkActiveMs.value, 50);
  assert.equal(
    readPhaseTimingReceipt(f.directory, { ...j, hash: "foreign" }),
    null,
  );
});
test("parallel local jobs have independent monotonic prepare and finalize boundaries", (t) => {
  const f = fixture(t),
    a = job("job-a"),
    b = job("job-b");
  f.producer.localPhase(f.directory, a, "prepare");
  f.advance(10);
  f.producer.localPhase(f.directory, b, "prepare");
  f.advance(20);
  f.producer.localPhase(f.directory, a, null);
  f.advance(30);
  f.producer.localPhase(f.directory, b, null);
  f.producer.localPhase(f.directory, a, "finalize");
  f.advance(5);
  f.producer.localPhase(f.directory, a, null);
  assert.equal(
    readPhaseTimingReceipt(f.directory, a)?.totals.prepare?.durationMs,
    30,
  );
  assert.equal(
    readPhaseTimingReceipt(f.directory, b)?.totals.prepare?.durationMs,
    50,
  );
  assert.equal(
    readPhaseTimingReceipt(f.directory, a)?.totals.finalize?.durationMs,
    5,
  );
});
test("restart and unresolved SDK outcome never fabricate completed intervals", (t) => {
  const f = fixture(t),
    j = job();
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(20);
  const restarted = createPhaseTimingProducer({
    monotonicNow: () => 50,
    wallNow: () => 2000,
    epoch: "producer-two",
  });
  restarted.queueCommitted(snapshot([j]), f.directory);
  j.state = "running";
  restarted.queueCommitted(snapshot([j]), f.directory);
  const receipt = readPhaseTimingReceipt(f.directory, j);
  assert.ok(receipt);
  assert.equal(receipt.totals.queueWait?.complete, false);
  assert.deepEqual(receipt.queueWaitSamples, []);
  j.state = "sending";
  f.producer.queueCommitted(snapshot([j]), f.directory);
  f.advance(10);
  j.state = "needs_reconciliation";
  f.producer.queueCommitted(snapshot([j]), f.directory);
  assert.equal(
    readPhaseTimingReceipt(f.directory, j)?.totals.sdkActive?.complete,
    false,
  );
});
test("queue percentile samples stay bounded while exact source totals are retained", (t) => {
  const f = fixture(t),
    j = job();
  for (let i = 0; i < 130; i++) {
    j.state = "queued";
    f.producer.queueCommitted(snapshot([j]), f.directory);
    f.advance(1);
    j.state = "running";
    f.producer.queueCommitted(snapshot([j]), f.directory);
  }
  const receipt = readPhaseTimingReceipt(f.directory, j);
  assert.ok(receipt);
  assert.equal(receipt.queueWaitSamples.length, 64);
  assert.equal(receipt.totals.queueWait?.durationMs, 130);
  assert.equal(receipt.totals.queueWait?.intervals, 130);
  assert.ok(
    fs.statSync(path.join(f.directory, "jobs", j.id, "phase-timings.json"))
      .size < 32768,
  );
});

test("durable QueueState commits emit measured intervals without polling or SDK probes", (t) => {
  const f = fixture(t);
  const { QueueState } = runtimeRequire(path.join(root, "src/queue-state")) as {
    QueueState: new (
      root: string,
      options: {
        now(): number;
        onCommittedSnapshot(snapshot: QueueSnapshot, root: string): void;
      },
    ) => import("../packages/core/src/domain/queue").QueueDomain;
  };
  const state = new QueueState(f.directory, {
    now: () => 1000,
    onCommittedSnapshot: f.producer.queueCommitted,
  });
  f.producer.queueCommitted(state.data, f.directory);
  const submitted = state.submit({
    kind: "command",
    requestId: "source-integration",
    argv: ["run", "--code", "pass"],
    cwd: f.directory,
    clientId: "client",
    timeoutMs: 1000,
    phased: true,
  });
  const submittedId = submitted["id"];
  assert.equal(typeof submittedId, "string");
  assert.ok(typeof submittedId === "string");
  f.advance(100);
  state.readyTurn(submittedId);
  f.advance(20);
  state.pause(true, "pause-source");
  f.advance(30);
  state.pause(false, "resume-source");
  f.advance(40);
  assert.equal(state.next()?.id, submittedId);
  f.advance(10);
  state.markDispatch(submittedId);
  f.advance(50);
  state.releaseTurn(submittedId, 900);
  const accepted = state.data.jobs[submittedId];
  assert.ok(accepted);
  const receipt = readPhaseTimingReceipt(f.directory, accepted);
  assert.ok(receipt);
  assert.equal(receipt.totals.queueWait?.durationMs, 60);
  assert.equal(receipt.totals.pause?.durationMs, 30);
  assert.equal(receipt.totals.sdkActive?.durationMs, 50);
  assert.equal(
    receipt.totals.prepare,
    undefined,
    "queue timestamps cannot substitute for local worker boundaries",
  );
});
