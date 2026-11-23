import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AdminOptions } from "../src/queue-console-admin";

const load = createRequire(process.cwd() + "/tests/admin-original-receipt.test.js");
const { createAdmin } = load("../src/queue-console-admin") as
  typeof import("../src/queue-console-admin");
const { QueueDomain } = load("../src/dist/core/domain/queue") as
  typeof import("../packages/core/src/domain/queue");
const { QueueGate } = load("../src/queue-gate") as
  typeof import("../packages/node-adapters/dist/execution/gate");

test("a late original control receipt cannot clear a newer unresolved probe", async () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const state = new QueueDomain({
    now: Date.now, newId: randomUUID, hash, commit: () => {},
  });
  state.beginControlProbe("original");
  const gate = new QueueGate(state, "instance");
  const files = new Map<string, unknown>();
  const counts = { probes: 0, observations: 0 };
  let busy = false;
  const dependencies: AdminOptions = {
    state, gate, dir: "/fixture", marker: { nonce: "instance" }, buildHash: "build",
    getContext: () => ({ active: false, busy, stopping: false, held: "original" }),
    setBusy: (value) => { busy = value; },
    resumeCheck: async () => {
      counts.probes++;
      assert.fail("Observing the original receipt must not send another probe");
    },
    observeControlCompletion: async () => {
      counts.observations++;
      const receipt = await Promise.resolve({
        terminal: true, outcome: "succeeded",
        instance: { pid: 42, birth: "birth", version: "version" },
      });
      assert.equal(state.settleControlProbe("original"), true);
      state.beginControlProbe("newer");
      return receipt;
    },
    close: async () => assert.fail("An inspection cannot restart the broker"),
    diagnostics: () => {},
    durable: (file, value) => { files.set(file, structuredClone(value)); },
    readJson: (file) => {
      if (files.has(file)) return structuredClone(files.get(file));
      throw Object.assign(new Error("Absent fixture record"), { code: "ENOENT" });
    },
    hash,
  };
  await assert.rejects(createAdmin(dependencies).handle({
    action: "console-inspect",
    control: { requestId: "inspect", instanceId: "instance", expectedGeneration: 0 },
  }, "owner"), { code: "RECONCILIATION_REQUIRED" });
  assert.deepEqual(state.data.controlBlocked, { rpcId: "newer" });
  assert.equal(state.data.paused, true);
  assert.equal(gate.adminTransition, null);
  assert.equal(busy, false);
  assert.deepEqual(counts, { probes: 0, observations: 1 });
  assert.equal(files.has("/fixture/console-fusion-observation.json"), false);
});
