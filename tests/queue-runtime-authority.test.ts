import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createQueueRuntimeAuthority,
  type RuntimeAuthorityCapture,
  type RuntimeAuthorityPins,
} from "../src/queue-runtime-authority";
import {
  QueueGate,
  type GateActivityToken,
  type GateAdminToken,
} from "../packages/node-adapters/src/execution/gate";
import { QueueDomain } from "../packages/core/src/domain/queue";

const pins = (): RuntimeAuthorityPins => ({
  instance: { pid: 42, birth: "original", version: "1" },
  identityFile: "/original/instance.json",
  epochId: "epoch-original",
  root: "/original",
  buildHash: "build",
  configHash: "config",
  processUnavailable: false,
});
const changed = { code: "RUNTIME_AUTHORITY_CHANGED" };

test("authority owns immutable identity and snapshots cannot become captures", () => {
  const initial = pins();
  const authority = createQueueRuntimeAuthority(initial, {
    verifyCurrent: () => true,
    verifyTransition: () => true,
  });
  const snapshot = authority.snapshot();
  assert.notEqual(snapshot, initial);
  assert.notEqual(snapshot.instance, initial.instance);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.instance), true);
  assert.throws(
    () =>
      authority.assertCurrent(snapshot as unknown as RuntimeAuthorityCapture),
    changed,
  );
  const other = createQueueRuntimeAuthority(initial, {
    verifyCurrent: () => true,
    verifyTransition: () => true,
  });
  assert.throws(() => other.assertCurrent(authority.capture()), changed);
});

test("authority preserves observation identity data but owns an immutable detached copy", () => {
  const instance = {
    pid: 42,
    birth: "original",
    version: "1",
    documents: [{ isModified: false }],
  };
  const authority = createQueueRuntimeAuthority(
    { ...pins(), instance },
    {
      verifyCurrent: () => true,
      verifyTransition: () => true,
    },
  );
  instance.documents[0]!.isModified = true;
  assert.equal(authority.snapshot().instance?.documents[0]?.isModified, false);
  assert.equal(Object.isFrozen(authority.snapshot().instance?.documents), true);
  assert.equal(
    Object.isFrozen(authority.snapshot().instance?.documents[0]),
    true,
  );
});

test("late continuation rechecks original durable pins, without sending or recapturing", async () => {
  let durableCurrent = true;
  const authority = createQueueRuntimeAuthority(pins(), {
    verifyCurrent: () => durableCurrent,
    verifyTransition: () => false,
  });
  const capture = authority.capture();
  let sends = 0;
  const continuation = Promise.resolve().then(() => {
    authority.assertCurrent(capture);
    sends++;
  });
  durableCurrent = false;
  await assert.rejects(continuation, changed);
  assert.equal(sends, 0);
  assert.throws(() => authority.capture(), changed);
});

test("only verified transition advances authority and invalidates all prior captures", () => {
  let verified = false;
  const authority = createQueueRuntimeAuthority(pins(), {
    verifyCurrent: () => true,
    verifyTransition(previous, next) {
      assert.equal(previous.instance?.birth, "original");
      assert.equal(next.epochId, "epoch-next");
      return verified;
    },
  });
  const original = authority.capture();
  const next = { ...pins(), epochId: "epoch-next" };
  assert.throws(() => authority.transition(original, next), changed);
  assert.equal(authority.snapshot().epochId, "epoch-original");
  authority.assertCurrent(original);
  verified = true;
  authority.transition(original, next);
  assert.throws(() => authority.assertCurrent(original), changed);
  assert.throws(() => authority.transition(original, next), changed);
  authority.assertCurrent(authority.capture());
});

test("an asynchronous verifier cannot silently grant identity authority", () => {
  const authority = createQueueRuntimeAuthority(pins(), {
    verifyCurrent: (() => Promise.resolve(true)) as unknown as () => boolean,
    verifyTransition: () => true,
  });
  assert.throws(() => authority.capture(), changed);
  const transition = createQueueRuntimeAuthority(pins(), {
    verifyCurrent: () => true,
    verifyTransition: (() => Promise.resolve(true)) as unknown as () => boolean,
  });
  assert.throws(
    () => transition.transition(transition.capture(), pins()),
    changed,
  );
});

function queue(
  commit?: (
    snapshot: import("../packages/core/src/domain/queue-model").QueueSnapshot,
  ) => void,
) {
  let id = 0;
  return new QueueDomain({
    now: () => 100,
    newId: () => String(++id),
    hash: (text) => createHash("sha256").update(text).digest("hex"),
    ...(commit ? { commit } : {}),
  });
}

test("control probe settlement cannot clear a newer or unrelated durable RPC", () => {
  const state = queue();
  state.beginControlProbe("original");
  assert.throws(() => state.beginControlProbe("replacement"), {
    code: "RECONCILIATION_REQUIRED",
  });
  assert.equal(state.settleControlProbe("other"), false);
  assert.deepEqual(state.data.controlBlocked, { rpcId: "original" });
  assert.equal(state.settleControlProbe("original"), true);
  state.beginControlProbe("next");
  assert.equal(state.settleControlProbe("original"), false);
  assert.deepEqual(state.data.controlBlocked, { rpcId: "next" });
});

test("writer readiness reports actual in-flight commits and retained durable faults", () => {
  let fault = false;
  const observed: boolean[] = [];
  const owner: { state?: QueueDomain } = {};
  const state = queue(() => {
    if (!owner.state) return; // Constructor commits before the fixture is bound.
    const state = owner.state;
    observed.push(state.writerStatus().writing);
    assert.equal(state.writerStatus().ready, false);
    if (fault) throw new Error("disk unavailable");
  });
  owner.state = state;
  assert.deepEqual(state.writerStatus(), {
    ready: true,
    writing: false,
    faulted: false,
  });
  state.beginControlProbe("original");
  assert.deepEqual(observed, [true]);
  fault = true;
  assert.throws(() => state.settleControlProbe("original"), /disk unavailable/);
  assert.deepEqual(state.data.controlBlocked, { rpcId: "original" });
  assert.deepEqual(state.writerStatus(), {
    ready: false,
    writing: false,
    faulted: true,
  });
});

test("activity completion uses exact owner token and cannot clear another native activity", () => {
  const gate = new QueueGate(queue(), "broker");
  const peer = new QueueGate(queue(), "peer");
  const first = gate.beginActivity();
  const second = gate.beginActivity();
  assert.equal(gate.endActivity({ id: first.id } as GateActivityToken), false);
  assert.equal(peer.endActivity(first), false);
  assert.equal(gate.hasOtherActivity(first), true);
  const view = gate.active;
  (view as Map<string, number>).clear();
  assert.equal(gate.activeCount, 2);
  assert.equal(gate.endActivity(first), true);
  assert.equal(gate.endActivity(first), false);
  assert.equal(gate.hasOtherActivity(second), false);
  assert.equal(gate.hasActivity(second), true);
  assert.equal(gate.endActivity(second), true);
});

test("admin scope completion is exact-token and does not confer pause bypass", async () => {
  const state = queue();
  const gate = new QueueGate(state, "broker");
  const scope = gate.beginAdminTransition("atomic-recovery-audit");
  assert.throws(() => gate.beginAdminTransition("restart"), {
    code: "BROKER_BUSY",
  });
  assert.equal(gate.endAdminTransition({} as GateAdminToken), false);
  assert.equal(gate.adminTransition, "atomic-recovery-audit");
  await assert.rejects(gate.control(true), { code: "BROKER_BUSY" });
  assert.equal(gate.endAdminTransition(scope), true);
  assert.equal(gate.endAdminTransition(scope), false);
  const newer = gate.beginAdminTransition("inspect");
  assert.equal(gate.endAdminTransition(scope), false);
  assert.equal(gate.adminTransition, "inspect");
  assert.equal(gate.endAdminTransition(newer), true);
  await gate.control(true);
  let sent = false;
  const pending = gate.run(async () => {
    sent = true;
  });
  await Promise.resolve();
  assert.equal(sent, false);
  // Only the existing explicit administrative AsyncLocalStorage scope bypasses.
  await gate.administrative(() => gate.run(async () => "inspection"));
  assert.equal(sent, false);
  await gate.control(false);
  await pending;
  assert.equal(sent, true);
  assert.equal(gate.activeCount, 0);
});

test("resume retains generation fences and cannot overlap another control or admin transition", async () => {
  const state = queue();
  const gate = new QueueGate(state, "broker");
  await gate.control(true, { requestId: "pause" });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = gate.control(
    false,
    {
      requestId: "resume",
      instanceId: "broker",
      expectedGeneration: state.data.controlGeneration || 0,
    },
    () => waiting,
  );
  assert.equal(gate.resuming, true);
  await assert.rejects(gate.control(true, { requestId: "overlap" }), {
    code: "STATE_CONFLICT",
  });
  assert.throws(() => gate.beginAdminTransition("inspect"), {
    code: "BROKER_BUSY",
  });
  release();
  await resume;
  await assert.rejects(
    gate.control(true, {
      requestId: "late-pause",
      expectedGeneration: 0,
    }),
    { code: "STATE_CONFLICT" },
  );
  assert.equal(state.data.paused, false);
  assert.equal(gate.resuming, false);
});

test("run releases only its token on failure while native activity remains accounted", async () => {
  const gate = new QueueGate(queue(), "broker");
  const native = gate.beginActivity();
  await assert.rejects(
    gate.run(async () => {
      throw new Error("failed send");
    }),
    /failed send/,
  );
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.hasActivity(native), true);
  gate.endActivity(native);
});
