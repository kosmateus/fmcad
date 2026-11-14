import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { record } from "./integration/offline-cli";
const runtimeRequire = createRequire(
  process.cwd() + "/tests/console-data.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createTelemetry } = runtimeRequire(
  "../src/direct-telemetry",
) as typeof import("../src/composition/library-direct-telemetry");
const { ConsoleStore, createAdapter, directSnapshot } = runtimeRequire(
  "../src/console-data",
) as typeof import("../src/composition/library-console-data");
const { McpClient } = runtimeRequire(
  "../src/client",
) as typeof import("../src/composition/library-client");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    dir = path.join(root, "queue");
  fs.mkdirSync(project);
  fs.mkdirSync(dir);
  return { root, project, dir };
}

test("historical direct observations remain readable while public clients cannot perform discovery", async (t) => {
  const { project, root } = fixture(t);
  let now = 100;
  const telemetry = createTelemetry({ cwd: project, now: () => now });
  const old = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = root;
  t.after(() => {
    if (old === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = old;
  });
  await telemetry.track({ method: "ping" }, async () => ({
    status: 200,
    raw: "PRIVATE_OUTPUT",
  }));
  const adapter = createAdapter({
    project,
    cfg: { routing: "direct" },
    now: () => now,
    alive: () => true,
  });
  const running = adapter.read();
  assert.equal(running.mode, "direct");
  assert.equal(running["broker"], null);
  assert.equal(present(present(running.operations)[0]).state, "completed");
  assert.equal(present(present(running.agents)[0]).presence, "observed");
  const id = present(present(running.operations)[0]).id;
  now = 200;
  const reopened = createAdapter({
    project,
    cfg: { routing: "direct" },
    now: () => now,
    alive: () => true,
  }).read();
  assert.equal(present(present(reopened.operations)[0]).id, id);
  assert.equal(present(present(reopened.operations)[0]).state, "completed");
  assert.equal(
    present(present(reopened.operations)[0])["outcomeScope"],
    "transport",
  );
  assert.equal(present(adapter.read().operations).length, 1);
  assert.doesNotMatch(
    fs.readFileSync(telemetry.file, "utf8"),
    /PRIVATE_PAYLOAD|PRIVATE_OUTPUT/,
  );
  const client = new McpClient({
    routing: "queue",
    url: "http://127.0.0.1:1/fake",
    timeoutMs: 1000,
  });
  await assert.rejects(
    client.controlPost({ jsonrpc: "2.0", id: 1, method: "ping" }),
    { code: "QUEUE_REQUIRED" },
  );
  await assert.rejects(client._post({ method: "tools/call" }), {
    code: "QUEUE_REQUIRED",
  });
  await client.close();
});

test("legacy observation failure stays unknown and preserves the original error", async (t) => {
  const { project } = fixture(t);
  const producer = createTelemetry({ cwd: project });
  const error = new Error("PRIVATE_BACKEND_ERROR");
  await assert.rejects(
    producer.track({ method: "tools/call" }, async () => {
      throw error;
    }),
    (e) => e === error,
  );
  const data = directSnapshot(project, { alive: () => false });
  assert.equal(present(present(data.operations)[0]).state, "unknown");
  assert.equal(present(present(data.agents)[0]).presence, "offline");
  assert.doesNotMatch(
    fs.readFileSync(producer.file, "utf8"),
    /PRIVATE_BACKEND_ERROR/,
  );
});

test("broker snapshot scopes jobs, does not infer agent presence or Fusion idle, resync deduplicates", (t) => {
  const { project, dir, root } = fixture(t);
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(
    path.join(dir, "broker.lock"),
    JSON.stringify({ nonce: "instance-a" }),
  );
  const state = {
    version: 1,
    revision: 4,
    paused: true,
    active: null,
    blocked: null,
    jobs: {
      a: {
        id: "a",
        clientId: "agent-a",
        state: "queued",
        kind: "command",
        request: {
          cwd: project,
          kind: "command",
          argv: [
            "run",
            "observed-script.py",
            "--args",
            '{"private":"PRIVATE_PAYLOAD"}',
          ],
        },
      },
      b: {
        id: "b",
        clientId: "other-agent",
        state: "queued",
        request: { cwd: other },
      },
    },
  };
  const file = path.join(dir, "queue-state.json");
  fs.writeFileSync(file, JSON.stringify(state));
  const adapter = createAdapter({
    project,
    cfg: { routing: "queue" },
    dir,
    alive: () => true,
  });
  const data = adapter.read();
  assert.equal(data.mode, "broker");
  assert.equal(record(data["broker"])["state"], "LEGACY_PAUSE");
  assert.equal(present(data.capabilities).brokerControl, false);
  assert.equal(record(data["fusion"])["connectivity"], "unknown");
  assert.deepEqual(
    present(data.operations).map((job) => job.id),
    ["a"],
  );
  assert.equal(
    present(present(data.operations)[0]).label,
    "run observed-script.py",
  );
  assert.equal(present(present(data.agents)[0]).presence, "unknown");
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_PAYLOAD/);
  assert.equal(present(adapter.read().operations).length, 1);
  fs.writeFileSync(file, "{partial");
  const stale = adapter.read();
  assert.equal(stale.available, false);
  assert.deepEqual(stale.operations, data.operations);
  fs.writeFileSync(file, JSON.stringify({ ...state, revision: 5 }));
  assert.equal(adapter.read()["sequence"], 5);
});

test("missing broker never changes configured topology; missing direct observations are not zero", (t) => {
  const { project, dir } = fixture(t);
  const queued = createAdapter({
    project,
    cfg: { routing: "queue" },
    dir,
  }).read();
  assert.equal(queued.mode, "broker");
  assert.equal(queued.operations, null);
  const direct = createAdapter({
    project,
    cfg: { routing: "direct" },
    dir,
  }).read();
  assert.equal(direct.mode, "direct");
  assert.equal(direct["broker"], null);
  assert.equal(direct.operations, null);
  assert.equal(direct.agents, null);
  assert.equal(direct.available, true);
});

test("store bounds history/logs, preserves active/unknown, and refuses implicit topology changes", () => {
  const store = new ConsoleStore("direct", "/project", {
    historyLimit: 2,
    logLimit: 2,
  });
  const value = {
    mode: "direct",
    project: "/project",
    operations: [
      { id: "open", state: "running" },
      { id: "unknown", state: "unknown" },
      ...[1, 2, 3].map((n) => ({
        id: String(n),
        state: "completed",
        finishedAt: n,
      })),
    ],
    logs: [1, 2, 3] as unknown as import("@fmcad/core").ConsoleRow[],
  };
  const result = store.replace(value);
  assert.deepEqual(
    present(result.operations).map((item) => item.id),
    ["open", "unknown", "3", "2"],
  );
  assert.deepEqual(result.logs, [2, 3]);
  assert.equal(present(result.retention)["terminalTruncated"], 1);
  assert.throws(
    () => store.replace({ ...value, mode: "broker" }),
    /Topology changed/,
  );
});
