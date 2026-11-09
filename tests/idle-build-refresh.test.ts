type MutableClient = InstanceType<
  typeof import("../src/queue-client").QueueClient
> & {
  dir: string;
  options: { cfg: { routing: string; queue: { autoStart: boolean } } };
};
import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests", "idle-build-refresh.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { QueueClient, refreshIdleBroker } = load(
  "../src/queue-client",
) as typeof import("../src/queue-client");

function fixture(t: test.TestContext, change: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrefresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const status = {
    features: { conditionalIdleStop: true },
    buildHash: "old",
    revision: 4,
    control: { instanceId: "old-nonce", activeOperations: 0 },
    jobs: {},
    ...change,
  };
  const client = Object.create(QueueClient.prototype) as MutableClient;
  client.dir = dir;
  client.options = { cfg: { routing: "queue", queue: { autoStart: true } } };
  client.register = async () => {
    calls.push("register");
    return client;
  };
  let submits = 0;
  client.call = async (action, value = {}) => {
    calls.push(action);
    if (action === "status") return status;
    if (action === "stop") {
      assert.equal(value["onlyIfQuiescent"], true);
      assert.equal(value["expectedBuildHash"], "old");
      return { stopping: true };
    }
    if (action === "submit") {
      submits++;
      if (submits === 1)
        throw Object.assign(new Error("not admitted"), {
          code: "BUILD_CHANGED",
          notStarted: true,
        });
      return {
        id: "first-admission",
        state: "preparing",
        requestId: (value["request"] as { requestId: string }).requestId,
      };
    }
    return undefined;
  };
  return { client, calls, status };
}

test("an idle stale broker can reload before the original request is admitted exactly once", async (t) => {
  const f = fixture(t);
  const value = await f.client.submit({
    kind: "command",
    requestId: "original-intent",
    argv: ["tools"],
    timeoutMs: 1000,
  });
  assert.equal(value.id, "first-admission");
  assert.equal(value.requestId, "original-intent");
  assert.deepEqual(f.calls, [
    "register",
    "submit",
    "status",
    "stop",
    "register",
    "submit",
  ]);
});

test("reload never interrupts active, queued, processing, leased, or unknown work", async (t) => {
  for (const status of [
    { active: "a" },
    { blocked: { id: "a" } },
    { held: "unknown" },
    { lease: { id: "a" } },
    { jobs: { a: { state: "queued" } } },
    { jobs: { a: { state: "processing" } } },
    { control: { activeOperations: 1 } },
  ]) {
    const f = fixture(t, status);
    await assert.rejects(refreshIdleBroker(f.client, { requestId: "fresh" }), {
      code: "BUILD_UPGRADE_BUSY",
    });
    assert.equal(f.calls.includes("stop"), false);
  }
});

test("an admitted request ID is never requeued and manual startup stays manual", async (t) => {
  const f = fixture(t, {
    jobs: { old: { requestId: "existing", state: "succeeded" } },
  });
  await assert.rejects(refreshIdleBroker(f.client, { requestId: "existing" }), {
    code: "REQUEST_ALREADY_ADMITTED",
  });
  assert.equal(f.calls.includes("stop"), false);
  const manual = fixture(t);
  manual.client.options.cfg.queue.autoStart = false;
  await assert.rejects(
    refreshIdleBroker(manual.client, { requestId: "fresh" }),
    { code: "BUILD_CHANGED" },
  );
  assert.deepEqual(manual.calls, []);
});

test("transport loss is not converted to automatic resubmission", async (t) => {
  const f = fixture(t),
    calls: Array<{ action: string; value: Record<string, unknown> }> = [];
  f.client.call = async (action, value = {}) => {
    calls.push({ action, value });
    throw Object.assign(new Error("response lost"), {
      code: "QUEUE_IPC_TIMEOUT",
    });
  };
  await assert.rejects(
    f.client.submit({
      kind: "command",
      requestId: "uncertain",
      argv: ["tools"],
      timeoutMs: 1000,
    }),
    { code: "QUEUE_IPC_TIMEOUT" },
  );
  assert.equal(calls.filter((call) => call.action === "submit").length, 1);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["submit", "find-request", "find-request", "find-request"],
  );
  for (const observation of calls.slice(1)) {
    assert.equal(observation.value["requestId"], "uncertain");
    assert.deepEqual(
      observation.value["expectedRequest"],
      calls[0]!.value["request"],
    );
  }
});
