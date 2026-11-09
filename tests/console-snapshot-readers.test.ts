import { createRequire } from "node:module";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const load = createRequire(
  path.join(process.cwd(), "tests/console-snapshot-readers.test.js"),
);
const core = load("../packages/core/dist") as typeof import("@fmcad/core");
const { createSnapshotReaders } = load(
  "../packages/node-adapters/dist/console/snapshots",
) as typeof import("../packages/node-adapters/src/console/snapshots");

const readers = createSnapshotReaders({
  base: core.baseSnapshot,
  contains: core.projectContains,
  presence: (observedAtMs, now, alive) =>
    core.classifyPresence(
      {
        version: 1,
        clientId: core.id("client", "direct"),
        instanceId: core.id("instance", "direct"),
        pid: 0,
        birth: null,
        observedAtMs,
        closed: false,
      },
      now,
      alive,
    ),
});
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-read-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("future direct heartbeat is unknown while completed operations remain history", (t) => {
  const project = fixture(t),
    dir = path.join(project, ".cad/telemetry/direct");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "abc.json"), "{}");
  const snapshot = readers.directSnapshot(project, {
    now: () => 100,
    alive: () => true,
    readJson: () => ({
      version: 1,
      project,
      id: "abc",
      observedAt: 101,
      operations: [
        { id: "active", state: "running" },
        { id: "retained", state: "completed", finishedAt: 0 },
      ],
    }),
    operation: core.projectConsoleOperation,
  });
  assert.equal(snapshot.agents![0]!.presence, "unknown");
  assert.equal(snapshot.operations![0]!.state, "unknown");
  assert.equal(snapshot.operations![1]!.state, "completed");
});
test("passive broker reader scopes canonical paths, bounds queue state, and cannot invent control authority", (t) => {
  const dir = fixture(t),
    project = path.join(dir, "project"),
    other = path.join(dir, "project-other");
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(dir, "queue-state.json"), "{}");
  const snapshot = readers.brokerSnapshot(project, {
    dir,
    now: () => 100,
    alive: () => {
      throw new Error("No live owner");
    },
    readJson(file, limit) {
      if (!file.endsWith("queue-state.json"))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      assert.equal(limit, 128 * 1024 * 1024);
      return {
        version: 1,
        paused: false,
        jobs: {
          good: {
            id: "good",
            clientId: "cli:old",
            state: "succeeded",
            request: { cwd: project },
          },
          foreign: { id: "foreign", request: { cwd: other } },
        },
      };
    },
    operation: core.projectConsoleOperation,
    clients: () => ({
      clients: [],
      source: "queue-client-process-heartbeat",
      filesRead: 0,
      filesOmitted: 0,
      errors: 0,
    }),
  });
  assert.deepEqual(
    snapshot.operations!.map((row) => row.id),
    ["good"],
  );
  assert.equal(snapshot.agents![0]!.presence, "unknown");
  assert.equal(snapshot.agents![0]!.source, "job-history");
  assert.equal((snapshot["broker"] as { state: string }).state, "STOPPED");
  assert.equal(snapshot.capabilities!.brokerControl, false);
});
