"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const load = createRequire(path.resolve(__dirname, "../dist/src/queue-broker.js"));
const { createCheckpointReadWorkflow, createCheckpointViews } = load("./document-checkpoint-broker");
const { createTurnIdentity } = load("./dist/core/application/broker-execution");
const actor = { clientId: "owner", clientTokenHash: "a".repeat(64) };
const target = { creationId: "document" };
const checkpoint = { schema: "fmcad.param-checkpoint-v1", parameters: [] };

test("late checkpoint preparation, notification and cleanup cannot affect a newer attempt", async () => {
  const workflow = createCheckpointReadWorkflow();
  const first = workflow.begin("job", actor, target, createTurnIdentity("job"));
  assert.equal(first.target, target, "preserve original private admission target");
  assert.throws(() => workflow.begin("job", actor, target, createTurnIdentity("job")),
    { code: "CHECKPOINT_READ_UNAVAILABLE" });
  workflow.prune(() => ({ state: "cancelled", code: "CANCELLED" }));
  await assert.rejects(first.result, { code: "CANCELLED" });
  const next = workflow.begin("job", actor, target, createTurnIdentity("job"));
  let notified = false;
  void next.result.then(() => { notified = true; });
  assert.throws(() => workflow.attachSend(first, () => {}),
    { code: "CHECKPOINT_READ_UNAVAILABLE" });
  first.resolve({ jobId: "job", checkpoint });
  first.reject(new Error("late failure"));
  workflow.release(first);
  await Promise.resolve();
  assert.equal(notified, false);
  assert.equal(workflow.read("job"), next);
  const send = () => {};
  workflow.attachSend(next, send);
  assert.equal(next.send, send);
  assert.throws(() => workflow.attachSend(next, () => {}),
    { code: "CHECKPOINT_READ_UNAVAILABLE" });
  next.resolve({ jobId: "job", checkpoint });
  next.reject(new Error("duplicate completion"));
  assert.deepEqual(await next.result, { jobId: "job", checkpoint });
  workflow.release(next);
  assert.equal(workflow.read("job"), undefined);
});

test("terminal checkpoint sweep rejects only its own waiting reads without settling unknown SDK work", async () => {
  const workflow = createCheckpointReadWorkflow();
  const cancelled = workflow.begin("cancelled", actor, target, createTurnIdentity("cancelled"));
  const unknown = workflow.begin("unknown", actor, target, createTurnIdentity("unknown"));
  workflow.prune((id) => id === "cancelled"
    ? { state: "cancelled", code: "CANCELLED" }
    : { state: "needs_reconciliation" });
  await assert.rejects(cancelled.result, { code: "CANCELLED" });
  assert.equal(workflow.read("cancelled"), undefined);
  assert.equal(workflow.read("unknown"), unknown);
  unknown.reject(new Error("notification only; no SDK settlement"));
  await assert.rejects(unknown.result);
  workflow.release(unknown);
});

test("checkpoint generation stays pinned across finished requests and rejects a changed generation", () => {
  const workflow = createCheckpointReadWorkflow();
  assert.equal(workflow.pinGeneration("generation-A"), "generation-A");
  const task = workflow.begin("job", actor, target, createTurnIdentity("job"));
  task.resolve({ jobId: "job", checkpoint });
  workflow.release(task);
  assert.throws(() => workflow.pinGeneration("generation-B"), { code: "DOCUMENT_STATE_CHANGED" });
  assert.equal(workflow.pinGeneration("generation-A"), "generation-A");
});

test("checkpoint views isolate asynchronous operations and retain private copies of projections", async () => {
  const views = createCheckpointViews();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const first = views.run(async () => {
    views.produced("observation");
    views.retainState("observation", checkpoint);
    const checkers = [() => { checks++; }];
    views.retainChecks("observation", checkers);
    checkers.length = 0;
    await waiting;
    assert.equal(views.consumeProduced("observation"), true);
    assert.equal(views.consumeProduced("observation"), false);
    const copy = views.state("observation");
    copy.parameters.push({ name: "not retained" });
    assert.deepEqual(views.state("observation"), checkpoint);
    views.verifyFinal("observation");
  });
  await views.run(async () => {
    await Promise.resolve();
    assert.equal(views.state("observation"), undefined);
    assert.equal(views.consumeProduced("observation"), false);
    assert.throws(() => views.verifyFinal("observation"), { code: "STORAGE_UNAVAILABLE" });
    release();
  });
  await first;
  assert.equal(checks, 1);
  assert.equal(views.state("observation"), undefined);
  assert.throws(() => views.retainChecks("observation", [() => {}]),
    { code: "STORAGE_UNAVAILABLE" });
});
