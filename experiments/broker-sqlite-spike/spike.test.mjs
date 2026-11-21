import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ask } from "./wire.mjs";
import { fixture, request, until } from "./fixtures/harness.mjs";

const submit = (client, req, timeout) =>
  client.call("submit", { request: req }, timeout);
const recover = (client, req) =>
  client.call("recover-admission", { request: req });
const get = (client, op, requestId, timeout) =>
  client.call(op, { requestId }, timeout);
const status = (client, id) => get(client, "status", id);
const result = (client, id) => get(client, "result", id);
const effects = async (f) =>
  (await f.effects()).map((call) => `${call.requestId}:${call.phase}`);
const attempts = async (f) =>
  (await f.attempts()).map((call) => `${call.requestId}:${call.phase}`);
const noProof = (state) => state.state === "UNKNOWN" && state.holdsTurn;
const expectError = (promise, code) => assert.rejects(promise, { code });
const waitStarted = (receiver, id) =>
  receiver.wait(
    (event) => event.kind === "physical-start" && event.value.requestId === id,
  );
const waitPrepared = (broker, id) =>
  broker.wait(
    (event) => event.kind === "prepare-end" && event.value.requestId === id,
  );

test("competing brokers bind once; separate client processes observe durable identity and owner isolation", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const peers = [
    f.startBroker({ admissionOnly: true }),
    f.startBroker({ admissionOnly: true }),
  ];
  const starts = await Promise.all(
    peers.map((p) =>
      p.wait(({ kind }) => ["ready", "startup-error"].includes(kind)),
    ),
  );
  assert.deepEqual(starts.map(({ kind }) => kind).sort(), [
    "ready",
    "startup-error",
  ]);
  assert.equal(
    starts.find(({ kind }) => kind === "startup-error").code,
    "EADDRINUSE",
  );
  assert.equal((await f.admin("metrics")).epoch, 1);
  const { settings } = await f.admin("metrics");
  assert.deepEqual(settings, {
    journal: "wal",
    synchronous: 2,
    busyTimeoutMs: 100,
    engine: "3.54.1",
  });
  assert.deepEqual((await f.receiverAdmin("metrics")).settings, settings);
  const [alice, bob] = await f.clients();
  assert.notEqual(alice.pid, bob.pid);
  const r1 = request("r1", { z: 3, a: [null, { z: 9, b: "ł🙂" }] });
  const [one, two] = await Promise.all([
    submit(alice, r1),
    submit(bob, request("r2")),
  ]);
  assert.equal(one.owner, "alice");
  assert.equal(two.owner, "bob");
  assert.notEqual(one.id, two.id);
  assert.deepEqual(
    await submit(alice, {
      ...r1,
      description: "ignored",
      payload: { a: [null, { b: "ł🙂", z: 9 }], z: 3 },
    }),
    one,
  );
  assert.deepEqual(await recover(alice, r1), one);
  const [producerOne, producerTwo] = await f.clients(["alice", "alice"]);
  const matching = await Promise.all([
    submit(producerOne, request("race")),
    submit(producerTwo, request("race")),
  ]);
  assert.notEqual(producerOne.pid, producerTwo.pid);
  assert.deepEqual(matching[0], matching[1]);
  await Promise.all([
    expectError(submit(alice, request("r1", { z: 2 })), "REQUEST_CONFLICT"),
    expectError(submit(bob, r1), "REQUEST_CONFLICT"),
    expectError(recover(alice, { ...r1, timeoutMs: 9 }), "REQUEST_CONFLICT"),
    expectError(recover(bob, r1), "NOT_FOUND"),
    expectError(status(alice, "r2"), "NOT_FOUND"),
    expectError(get(bob, "cancel", "r1"), "NOT_FOUND"),
    expectError(
      ask(f.brokerPath, { op: "status", token: "alice", requestId: "r1" }),
      "UNAUTHORIZED",
    ),
  ]);
  assert.deepEqual(await f.effects(), []);
});

test("a competing SQLite writer causes a bounded durable refusal, not a phantom ACK", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  await f.broker({ admissionOnly: true });
  const [alice] = await f.clients();
  const req = request("locked");
  const writer = await f.lockWriter();
  await expectError(submit(alice, req), "SQLITE_BUSY");
  await expectError(recover(alice, req), "NOT_FOUND");
  const metrics = await f.admin("metrics");
  assert.equal(metrics.transactions.admit.commits, 0);
  assert.equal(metrics.transactions.admit.failures, 1);
  writer.release("unlock");
  assert.equal((await writer.wait(({ kind }) => kind === "exit")).code, 0);
  assert.equal(
    (await submit(alice, request("fresh-after-refusal"))).state,
    "accepted",
  );
  assert.deepEqual(await f.effects(), []);
});

test("SIGKILL inside SQLite admission before COMMIT rolls back without an ACK", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker({ crashInsideAdmission: "interrupted" });
  const [alice] = await f.clients();
  const req = request("interrupted");
  await expectError(submit(alice, req), "REPLY_LOST");
  assert.equal(
    (await broker.wait(({ kind }) => kind === "exit")).signal,
    "SIGKILL",
  );
  await f.broker();
  await expectError(recover(alice, req), "NOT_FOUND");
  assert.deepEqual(await f.effects(), []);
  const fresh = await submit(alice, request("fresh"));
  assert.equal((await result(alice, fresh.requestId)).state, "succeeded");
  assert.deepEqual(await effects(f), ["fresh:main"]);
  assert.deepEqual(await attempts(f), ["fresh:main"]);
});

test("crash after COMMIT before ACK preserves admission and restart processes only undispatched work", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker({ gates: ["before-ack:unanswered"] });
  const [alice] = await f.clients();
  const req = request("unanswered");
  const reply = expectError(submit(alice, req), "REPLY_LOST");
  const {
    value: { id },
  } = await broker.at("before-ack:unanswered");
  assert.equal((await recover(alice, req)).id, id);
  assert.deepEqual(await f.effects(), []);
  assert.equal((await broker.kill()).signal, "SIGKILL");
  await reply;
  await f.broker();
  assert.equal((await recover(alice, req)).id, id);
  assert.equal((await result(alice, req.requestId)).id, id);
  assert.deepEqual(await effects(f), ["unanswered:main"]);
  assert.deepEqual(await attempts(f), ["unanswered:main"]);
});

test("crash after ACK preserves the acknowledged job and does not create another identity", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker({ gates: ["prepare:acknowledged"] });
  const [alice] = await f.clients();
  const req = request("acknowledged");
  const receipt = await submit(alice, req);
  await broker.at("prepare:acknowledged");
  assert.deepEqual(await f.effects(), []);
  await broker.kill();
  await f.broker();
  const recovered = await recover(alice, req);
  const terminal = await result(alice, req.requestId);
  assert.equal(recovered.hash, receipt.hash);
  assert.equal(terminal.id, receipt.id);
  assert.equal(terminal.state, "succeeded");
  assert.deepEqual(await effects(f), ["acknowledged:main"]);
  assert.deepEqual(await attempts(f), ["acknowledged:main"]);
});

test("lost ACK is recovered by lookup without a second submit", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker({ gates: ["before-ack:lost"] });
  const [alice] = await f.clients();
  const req = request("lost");
  const reply = expectError(submit(alice, req, 100), "WAIT_TIMEOUT");
  const {
    value: { id },
  } = await broker.at("before-ack:lost");
  await reply;
  assert.equal((await recover(alice, req)).id, id);
  broker.release("before-ack:lost");
  assert.equal((await result(alice, req.requestId)).state, "succeeded");
  assert.equal((await f.admin("metrics")).transactions.admit.commits, 1);
  assert.deepEqual(await effects(f), ["lost:main"]);
  assert.deepEqual(await attempts(f), ["lost:main"]);
});

test("receiver crash after the effect but before receipt yields UNKNOWN, preserves the turn and never replays", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({ gates: ["after-effect:effect-gap"] });
  const broker = await f.broker();
  const [alice, bob] = await f.clients();
  const req = request("effect-gap");
  const admitted = await submit(alice, req);
  const { value: call } = await receiver.at("after-effect:effect-gap");
  assert.deepEqual(await effects(f), ["effect-gap:main"]);
  assert.deepEqual(await f.attempts(), [call]);
  assert.equal((await receiver.kill()).signal, "SIGKILL");
  assert.ok(noProof(await result(alice, req.requestId)));
  await broker.kill();
  const successor = await f.receiver();
  const newBroker = await f.broker();
  const restarted = await get(alice, "reconcile", req.requestId);
  assert.ok(noProof(restarted));
  assert.equal(restarted.id, admitted.id);
  assert.deepEqual(restarted.receipts, {});
  assert.deepEqual(await get(alice, "reconcile", req.requestId), restarted);
  assert.deepEqual(await f.attempts(), [call]);
  assert.deepEqual(await f.sendReceiver("lookup", call), {
    state: "active",
    receipt: null,
  });
  await expectError(f.sendReceiver("dispatch", call), "STALE_EPOCH");
  assert.deepEqual(await f.attempts(), [call, call]); // Exactly one manual stale attempt.
  await submit(bob, request("blocked"));
  await waitPrepared(newBroker, "blocked");
  assert.equal((await status(bob, "blocked")).state, "ready");
  assert.deepEqual(await effects(f), ["effect-gap:main"]);
  assert.deepEqual(await f.attempts(), [call, call]);
  assert.ok(!successor.events.some(({ kind }) => kind === "physical-start"));
});

test("receiver crash after its admission but before any effect is also UNKNOWN rather than retried", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({ gates: ["before-effect:before-effect"] });
  const broker = await f.broker();
  const [alice] = await f.clients();
  const req = request("before-effect");
  await submit(alice, req);
  const { value: call } = await receiver.at("before-effect:before-effect");
  assert.deepEqual(await f.attempts(), [call]);
  await receiver.kill();
  assert.ok(noProof(await result(alice, req.requestId)));
  await broker.kill();
  await f.receiver();
  await f.broker();
  const unresolved = await get(alice, "reconcile", req.requestId);
  assert.ok(noProof(unresolved));
  assert.deepEqual(await get(alice, "reconcile", req.requestId), unresolved);
  assert.deepEqual(await f.sendReceiver("lookup", call), {
    state: "active",
    receipt: null,
  });
  assert.deepEqual(await f.effects(), []);
  assert.deepEqual(await f.attempts(), [call]);
});

test("missing receiver reply after a committed receipt is reconciled using the original identity", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({
    gates: ["before-receiver-reply:receipt-gap"],
  });
  await f.broker();
  const [alice, bob] = await f.clients();
  const admitted = await submit(alice, request("receipt-gap"));
  const { value: call } = await receiver.at(
    "before-receiver-reply:receipt-gap",
  );
  assert.deepEqual(await f.attempts(), [call]);
  await receiver.kill();
  assert.ok(noProof(await result(alice, "receipt-gap")));
  await f.receiver();
  await expectError(get(bob, "reconcile", "receipt-gap"), "NOT_FOUND");
  const settled = await get(alice, "reconcile", "receipt-gap");
  assert.equal(settled.state, "succeeded");
  assert.equal(settled.id, admitted.id);
  assert.deepEqual(settled.receipts.main.call, call);
  assert.deepEqual(await get(alice, "reconcile", "receipt-gap"), settled);
  assert.deepEqual(await f.attempts(), [call]);
  assert.deepEqual(await effects(f), ["receipt-gap:main"]);
});

test("broker dies after main receipt before its reply; repeated reconciliation does not dispatch a replacement postflight", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({
    gates: ["before-receiver-reply:gap:main"],
  });
  const broker = await f.broker();
  const [alice] = await f.clients();
  await submit(alice, request("gap", { postflight: true }));
  const { value: main } = await receiver.at("before-receiver-reply:gap:main");
  assert.deepEqual(await f.attempts(), [main]);
  assert.deepEqual((await status(alice, "gap")).receipts, {});
  assert.equal((await broker.kill()).signal, "SIGKILL");
  receiver.release("before-receiver-reply:gap:main");
  await f.broker();
  assert.equal((await f.admin("metrics")).epoch, main.epoch + 1);
  const held = await get(alice, "reconcile", "gap");
  assert.ok(noProof(held));
  assert.deepEqual(Object.keys(held.receipts), ["main"]);
  assert.deepEqual(held.receipts.main.call, main);
  assert.deepEqual(await get(alice, "reconcile", "gap"), held);
  assert.deepEqual(await f.attempts(), [main]);
  assert.deepEqual(await effects(f), ["gap:main"]);
});

test("a missing postflight after the durable main receipt holds the turn and rejects a delayed old epoch at the receiver", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker({ gates: ["before-postflight:missing"] });
  const [alice, bob] = await f.clients();
  await submit(alice, request("missing", { postflight: true }));
  const { value: late } = await broker.at("before-postflight:missing");
  const before = await status(alice, "missing");
  assert.equal(before.receipts.main.outcome, "complete");
  assert.equal(before.receipts.postflight, undefined);
  const main = before.receipts.main.call;
  assert.deepEqual(await f.attempts(), [main]);
  assert.equal(await f.sendReceiver("lookup", late), null);
  await broker.kill();
  const next = await f.broker();
  const unknown = await get(alice, "reconcile", "missing");
  assert.ok(noProof(unknown));
  assert.deepEqual(unknown.receipts, before.receipts);
  assert.deepEqual(await get(alice, "reconcile", "missing"), unknown);
  assert.deepEqual(await f.attempts(), [main]);
  assert.equal(late.epoch + 1, (await f.admin("metrics")).epoch);
  await expectError(f.sendReceiver("dispatch", late), "STALE_EPOCH");
  assert.deepEqual(await f.attempts(), [main, late]); // Manual delivery, not replay.
  assert.equal(await f.sendReceiver("lookup", late), null);
  await submit(bob, request("no-turn"));
  await waitPrepared(next, "no-turn");
  assert.deepEqual(await effects(f), ["missing:main"]);
  assert.deepEqual(await f.attempts(), [main, late]);
  assert.equal((await status(bob, "no-turn")).state, "ready");
});

test("cancel before local dispatch and durable withdrawal after intent reject delayed delivery even after receiver restart", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver();
  const broker = await f.broker({
    gates: ["prepare:local", "before-dispatch:withdraw"],
  });
  const [alice, bob] = await f.clients();
  await submit(alice, request("local"));
  await broker.at("prepare:local");
  const local = await get(alice, "cancel", "local");
  assert.equal(local.state, "not_started");
  assert.equal(local.holdsTurn, false);
  broker.release("prepare:local");
  await submit(alice, request("withdraw"));
  const { value: delayed } = await broker.at("before-dispatch:withdraw");
  assert.equal(await f.sendReceiver("lookup", delayed), null);
  assert.deepEqual(await f.attempts(), []);
  const canceled = await get(alice, "cancel", "withdraw");
  assert.equal(canceled.holdsTurn, false);
  assert.equal(canceled.state, "not_started");
  assert.deepEqual(canceled.receipts.main, {
    call: delayed,
    outcome: "not_started",
  });
  await receiver.kill();
  await f.receiver();
  const withdrawn = { state: "withdrawn", receipt: canceled.receipts.main };
  assert.deepEqual(await f.sendReceiver("lookup", delayed), withdrawn);
  assert.deepEqual(await f.sendReceiver("dispatch", delayed), withdrawn);
  assert.deepEqual(await f.attempts(), [delayed]);
  await submit(bob, request("next"));
  assert.equal((await result(bob, "next")).state, "succeeded");
  broker.release("before-dispatch:withdraw");
  await until(
    () => attempts(f),
    (seen) => seen.length >= 3,
  );
  assert.deepEqual(await attempts(f), [
    "withdraw:main",
    "next:main",
    "withdraw:main",
  ]);
  assert.deepEqual(await status(alice, "withdraw"), canceled);
  assert.deepEqual(await effects(f), ["next:main"]);
});

test("a committed withdrawal survives a crash before the broker could acknowledge it", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({
    gates: ["before-withdraw-reply:withdrawn"],
  });
  const broker = await f.broker({ gates: ["before-dispatch:withdrawn"] });
  const [alice, bob] = await f.clients();
  await submit(alice, request("withdrawn"));
  const { value: call } = await broker.at("before-dispatch:withdrawn");
  const reply = expectError(get(alice, "cancel", "withdrawn"), "REPLY_LOST");
  await receiver.at("before-withdraw-reply:withdrawn");
  assert.deepEqual(await f.attempts(), []);
  await broker.kill();
  await reply;
  await receiver.kill();
  await f.receiver();
  await f.broker();
  const terminal = await result(alice, "withdrawn");
  assert.equal(terminal.state, "not_started");
  assert.deepEqual(terminal.receipts.main, { call, outcome: "not_started" });
  assert.deepEqual(await get(alice, "reconcile", "withdrawn"), terminal);
  assert.deepEqual(await get(alice, "reconcile", "withdrawn"), terminal);
  assert.deepEqual(await f.attempts(), []);
  await expectError(f.sendReceiver("dispatch", call), "STALE_EPOCH");
  assert.deepEqual(await f.attempts(), [call]);
  await submit(bob, request("freed"));
  assert.equal((await result(bob, "freed")).state, "succeeded");
  assert.deepEqual(await effects(f), ["freed:main"]);
  assert.deepEqual(await attempts(f), ["withdrawn:main", "freed:main"]);
});

test("independent clients prepare concurrently; cancellation and a wait timeout do not free an admitted physical turn", async (t) => {
  const f = await fixture(t.after.bind(t));
  const receiver = await f.receiver({
    gates: ["before-effect:alice-op:main", "before-effect:bob-op:main"],
  });
  const broker = await f.broker({
    gates: ["prepare:alice-op", "prepare:bob-op"],
  });
  const [alice, bob] = await f.clients();
  assert.notEqual(alice.pid, bob.pid);
  await Promise.all([
    submit(alice, request("alice-op", { postflight: true })),
    submit(bob, request("bob-op")),
  ]);
  await Promise.all([
    broker.at("prepare:alice-op"),
    broker.at("prepare:bob-op"),
  ]);
  assert.ok(!broker.events.some(({ kind }) => kind === "prepare-end"));
  broker.release("prepare:alice-op");
  const { value: activeCall } = await receiver.at(
    "before-effect:alice-op:main",
  );
  assert.deepEqual(await f.sendReceiver("dispatch", activeCall), {
    state: "active",
    receipt: null,
  });
  await expectError(
    f.sendReceiver("dispatch", { ...activeCall, hash: "different-hash" }),
    "CALL_CONFLICT",
  );
  await expectError(
    f.sendReceiver("dispatch", {
      ...activeCall,
      id: "contender:main",
      jobId: "contender",
    }),
    "PHYSICAL_BUSY",
  );
  const canceled = await get(alice, "cancel", "alice-op");
  assert.equal(canceled.state, "running");
  assert.equal(canceled.holdsTurn, true);
  assert.equal(canceled.cancelRequested, true);
  await expectError(get(alice, "result", "alice-op", 60), "WAIT_TIMEOUT");
  broker.release("prepare:bob-op");
  await waitPrepared(broker, "bob-op");
  assert.equal((await status(bob, "bob-op")).state, "ready");
  assert.deepEqual(await f.effects(), []);
  assert.deepEqual(await attempts(f), [
    "alice-op:main",
    "alice-op:main",
    "alice-op:main",
    "alice-op:main",
  ]);
  assert.equal(
    receiver.events.filter(({ kind }) => kind === "physical-start").length,
    1,
  );
  receiver.release("before-effect:alice-op:main");
  const first = await result(alice, "alice-op");
  assert.equal(first.state, "succeeded");
  assert.deepEqual(Object.keys(first.receipts), ["main", "postflight"]);
  assert.deepEqual(await f.sendReceiver("dispatch", activeCall), {
    state: "complete",
    receipt: first.receipts.main,
  });
  assert.equal(
    first.receipts.main.call.preparedHash,
    createHash("sha256").update('{"postflight":true}').digest("hex"),
  );
  await waitStarted(receiver, "bob-op");
  await receiver.at("before-effect:bob-op:main");
  receiver.release("before-effect:bob-op:main");
  assert.equal((await result(bob, "bob-op")).state, "succeeded");
  await receiver.wait(
    ({ kind, value }) =>
      kind === "physical-end" && value.requestId === "bob-op",
  );
  const trace = receiver.events
    .filter(({ kind }) => kind.startsWith("physical-"))
    .map(({ kind, value }) => `${kind}:${value.requestId}:${value.phase}`);
  assert.deepEqual(trace, [
    "physical-start:alice-op:main",
    "physical-end:alice-op:main",
    "physical-start:alice-op:postflight",
    "physical-end:alice-op:postflight",
    "physical-start:bob-op:main",
    "physical-end:bob-op:main",
  ]);
  assert.deepEqual(await effects(f), [
    "alice-op:main",
    "alice-op:postflight",
    "bob-op:main",
  ]);
});

test("foreign receipt cannot release the turn; a bound stored receipt can settle it without another effect", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver({ corruptReplyFor: "receipt" });
  await f.broker();
  const [alice, bob] = await f.clients();
  await submit(alice, request("receipt"));
  const unknown = await result(alice, "receipt");
  assert.ok(noProof(unknown));
  assert.deepEqual(unknown.receipts, {});
  await expectError(get(bob, "reconcile", "receipt"), "NOT_FOUND");
  const verified = await get(alice, "reconcile", "receipt");
  assert.equal(verified.state, "succeeded");
  assert.equal(verified.receipts.main.call.owner, "alice");
  assert.deepEqual(await get(alice, "reconcile", "receipt"), verified);
  assert.deepEqual(await f.attempts(), [verified.receipts.main.call]);
  assert.deepEqual(await effects(f), ["receipt:main"]);
});

const legacyCopy = new URL("./fixtures/legacy-unknown.json", import.meta.url);
const encodeCopy = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

test("legacy fixture has a canonical SHA-256 reference hash", async () => {
  const { snapshot, receipts } = JSON.parse(await readFile(legacyCopy));
  const job = snapshot.jobs[snapshot.active];
  // Reference QueueDomain hashes the lexically ordered JSON request including clientId.
  const referenceInput =
    '{"clientId":"alice","kind":"rpc","payload":{"document":"fixture-document-5","file":"fixture-file-2","version":"fixture-version-3"},"requestId":"legacy-request-19","timeoutMs":5000}';
  assert.deepEqual(job.request, JSON.parse(referenceInput));
  assert.match(job.hash, /^[0-9a-f]{64}$/);
  assert.equal(
    job.hash,
    createHash("sha256").update(referenceInput).digest("hex"),
  );
  assert.equal(receipts[0].hash, job.hash);
});

test("out-of-scope or inconsistent legacy copies are refused atomically over IPC", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker();
  const [alice, bob] = await f.clients();
  const source = JSON.parse(await readFile(legacyCopy));
  const job = source.snapshot.jobs[source.snapshot.active];
  const requestId = job.requestId;
  const foreign = {
    id: "foreign-job",
    requestId: "foreign-request",
    clientId: "bob",
  };
  const checks = [
    (copy) => {
      copy.snapshot.jobs[foreign.id] = { ...job, ...foreign };
    },
    (copy) => {
      copy.receipts[0].owner = "bob";
    },
    (copy) => {
      copy.receipts[0].requestId = foreign.requestId;
    },
    (copy) => {
      copy.receipts[0].jobId = foreign.id;
    },
    (copy) => {
      copy.receipts[0].hash = "f".repeat(64);
    },
    (copy) => {
      copy.snapshot.jobs[job.id].request.clientId = "bob";
    },
    (copy) => {
      copy.snapshot.jobs[job.id].request.requestId = foreign.requestId;
    },
    (copy) => {
      copy.snapshot.jobs[job.id].hash = "f".repeat(64);
      copy.receipts[0].hash = "f".repeat(64);
    },
    (copy) => {
      copy.snapshot.jobs[job.id].hash = "f".repeat(65);
      copy.receipts[0].hash = "f".repeat(65);
    },
  ];
  for (const corrupt of checks) {
    const copy = structuredClone(source);
    corrupt(copy);
    await expectError(
      f.admin("copy-history", { bytes: encodeCopy(copy) }),
      "INVALID_HISTORY",
    );
    await expectError(status(alice, requestId), "NOT_FOUND");
    await expectError(status(bob, foreign.requestId), "NOT_FOUND");
  }
  assert.equal((await f.admin("metrics")).transactions.importCopy.commits, 0);
  await broker.kill();
  await f.broker();
  await expectError(status(alice, requestId), "NOT_FOUND");
  assert.deepEqual(await f.attempts(), []);
  // No ghost key or turn survives the rejected copies.
  await submit(alice, request(requestId, job.request.payload));
  assert.equal((await result(alice, requestId)).state, "succeeded");
  await submit(bob, request(foreign.requestId));
  assert.equal((await result(bob, foreign.requestId)).state, "succeeded");
});

test("legacy UNKNOWN copy retains raw admin evidence, exposes only owner metadata, and never executes or cleans up", async (t) => {
  const f = await fixture(t.after.bind(t));
  await f.receiver();
  const broker = await f.broker();
  const [alice, bob] = await f.clients();
  const original = await readFile(legacyCopy);
  const copied = join(f.dir, "legacy-source-copy.json");
  const retained = join(f.dir, "fixture-document-5");
  await writeFile(copied, original);
  await writeFile(retained, "retained");
  const bytes = (await readFile(copied)).toString("base64");
  const source = JSON.parse(original);
  const job = source.snapshot.jobs[source.snapshot.active];
  const imported = await f.admin("copy-history", { bytes });
  assert.equal(imported.id, job.id);
  assert.equal(imported.owner, job.clientId);
  assert.equal(imported.requestId, job.requestId);
  assert.equal(imported.hash, job.hash);
  assert.ok(noProof(imported));
  assert.deepEqual(Buffer.from(imported.archivedBytes, "base64"), original);
  assert.deepEqual(await f.admin("copy-history", { bytes }), imported);
  const publicView = {
    id: job.id,
    owner: job.clientId,
    requestId: job.requestId,
    hash: job.hash,
    state: "UNKNOWN",
    holdsTurn: true,
    cancelRequested: false,
    receipts: {},
    historical: true,
  };
  assert.deepEqual(await status(alice, job.requestId), publicView);
  assert.deepEqual(await result(alice, job.requestId), publicView);
  await expectError(alice.call("copy-history", { bytes }), "UNAUTHORIZED");
  await expectError(recover(alice, request(job.requestId)), "NOT_FOUND");
  await expectError(submit(alice, request(job.requestId)), "REQUEST_CONFLICT");
  await expectError(status(bob, job.requestId), "NOT_FOUND");
  await expectError(result(bob, job.requestId), "NOT_FOUND");
  await broker.kill();
  const next = await f.broker();
  assert.deepEqual(await get(alice, "reconcile", job.requestId), publicView);
  assert.deepEqual(await get(alice, "cancel", job.requestId), publicView);
  assert.deepEqual(await f.admin("copy-history", { bytes }), imported);
  await submit(bob, request("after-import"));
  await waitPrepared(next, "after-import");
  assert.equal((await status(bob, "after-import")).state, "ready");
  assert.deepEqual(await readFile(copied), original);
  assert.equal(await readFile(retained, "utf8"), "retained");
  assert.deepEqual(await f.effects(), []);
  assert.deepEqual(await f.attempts(), []);
});
