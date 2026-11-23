import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createControlledLifecycleLease,
  type ControlledLifecyclePorts,
} from "../packages/node-adapters/src/execution/controlled-lifecycle-lease";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-lease-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const events: string[] = [];
  const ports: ControlledLifecyclePorts = {
    directory,
    operator: { pid: process.pid, birth: "123" },
    old: { pid: 42, birth: "456" },
    buildHash: "a".repeat(64),
    fence() {
      events.push("owner");
    },
    async assertQuiescent() {
      assert.ok(fs.existsSync(path.join(directory, "fusion-reset.lock")));
      events.push("quiescent");
    },
    async stopBrokerOnce() {
      events.push("supported-stop");
    },
    async assertIngressHeld() {
      events.push("ingress");
    },
    async retireOldNormally(value) {
      assert.deepEqual(value, { pid: 42, birth: "456" });
      events.push("normal-close");
    },
  };
  return { ports, events, file: path.join(directory, "fusion-reset.lock") };
}

test("hold existing reset barrier before producer check and ONE supported stop/retirement", async (t) => {
  const f = fixture(t);
  const operator = createControlledLifecycleLease(f.ports);
  const lease = await operator.acquireExclusiveLifecycleLease();
  assert.ok(f.events.indexOf("quiescent") < f.events.indexOf("supported-stop"));
  const bytes = fs.readFileSync(f.file);
  assert.equal(JSON.parse(bytes.toString()).phase, "controlled-bootstrap-held");
  await lease.retireOldNormally({ pid: 42, birth: "456" });
  await lease.assertCurrent();
  lease.fence();
  await assert.rejects(
    lease.retireOldNormally({ pid: 42, birth: "456" }),
    /single retirement/,
  );
  await assert.rejects(operator.acquireExclusiveLifecycleLease(), /single-use/);
  assert.equal(
    f.events.filter((event) => event === "supported-stop").length,
    1,
  );
  assert.equal(f.events.filter((event) => event === "normal-close").length, 1);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test("pre-existing original barrier prevents stop without replacing its bytes", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "previous-uncertain-intent\n");
  await assert.rejects(
    createControlledLifecycleLease(f.ports).acquireExclusiveLifecycleLease(),
    { code: "EEXIST" },
  );
  assert.equal(fs.readFileSync(f.file, "utf8"), "previous-uncertain-intent\n");
  assert.equal(f.events.includes("supported-stop"), false);
});

test("failure/uncertainty at supported stop retains barrier and never retries", async (t) => {
  const f = fixture(t);
  let count = 0;
  f.ports.stopBrokerOnce = async () => {
    count++;
    throw new Error("Original stop receipt UNKNOWN");
  };
  const operator = createControlledLifecycleLease(f.ports);
  await assert.rejects(
    operator.acquireExclusiveLifecycleLease(),
    /receipt UNKNOWN/,
  );
  assert.ok(fs.existsSync(f.file));
  await assert.rejects(operator.acquireExclusiveLifecycleLease(), /single-use/);
  assert.equal(count, 1);
  assert.equal(f.events.includes("normal-close"), false);
});

test("barrier replacement during awaited stop denies acquisition, never clears replacement", async (t) => {
  const f = fixture(t);
  f.ports.stopBrokerOnce = async () => {
    fs.renameSync(f.file, `${f.file}.original`);
    fs.writeFileSync(f.file, "replacement");
  };
  await assert.rejects(
    createControlledLifecycleLease(f.ports).acquireExclusiveLifecycleLease(),
    /barrier identity changed/,
  );
  assert.equal(fs.readFileSync(f.file, "utf8"), "replacement");
  assert.ok(fs.existsSync(`${f.file}.original`));
  assert.equal(f.events.includes("normal-close"), false);
});

test("revoked ingress after lease acquisition prevents normal-close and cannot revive", async (t) => {
  const f = fixture(t);
  let valid = true;
  f.ports.assertIngressHeld = async () => {
    if (!valid) throw new Error("Original ingress lost");
  };
  const lease = await createControlledLifecycleLease(
    f.ports,
  ).acquireExclusiveLifecycleLease();
  valid = false;
  await assert.rejects(
    lease.retireOldNormally({ pid: 42, birth: "456" }),
    /ingress lost/,
  );
  valid = true;
  assert.throws(lease.fence, /not held/);
  assert.equal(f.events.includes("normal-close"), false);
  assert.ok(fs.existsSync(f.file));
});

test("wrong target never delivers normal-close; post-close tampering revokes", async (t) => {
  const f = fixture(t);
  f.ports.retireOldNormally = async () => {
    f.events.push("normal-close");
    fs.appendFileSync(f.file, "tamper");
  };
  const lease = await createControlledLifecycleLease(
    f.ports,
  ).acquireExclusiveLifecycleLease();
  await assert.rejects(
    lease.retireOldNormally({ pid: 42, birth: "999" }),
    /single retirement/,
  );
  assert.equal(f.events.includes("normal-close"), false);
  await assert.rejects(
    lease.retireOldNormally({ pid: 42, birth: "456" }),
    /barrier identity changed/,
  );
  assert.throws(lease.fence, /not held/);
  assert.equal(f.events.filter((event) => event === "normal-close").length, 1);
});

test("asynchronous owner rejection is denied before any marker or lifecycle action", async (t) => {
  const f = fixture(t);
  f.ports.fence = (() =>
    Promise.reject(new Error("Rejected async owner"))) as unknown as () => void;
  await assert.rejects(
    createControlledLifecycleLease(f.ports).acquireExclusiveLifecycleLease(),
    /must be synchronous/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.events.includes("supported-stop"), false);
});
