import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests/console-offline.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createAdapter } = load(
  "../src/console-data",
) as typeof import("../src/composition/library-console-data");
test("stopped broker retains project history and logs without a marker or a connection attempt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    dir = path.join(root, "queue");
  fs.mkdirSync(project);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(project, "fmcad.log"),
    "2026-10-20T12:00:00Z INFO job_succeeded job=one\n",
  );
  fs.writeFileSync(
    path.join(dir, "queue-state.json"),
    JSON.stringify({
      version: 1,
      paused: false,
      revision: 1,
      active: null,
      blocked: null,
      jobs: {
        one: {
          id: "one",
          state: "succeeded",
          clientId: "known-history",
          code: "EXECUTION_COMPLETE",
          request: { cwd: project },
        },
      },
    }),
  );
  const adapter = createAdapter({ project, dir, cfg: { routing: "queue" } });
  const value = adapter.read();
  assert.equal(value.mode, "broker");
  assert.equal((value["broker"] as { state: string }).state, "STOPPED");
  assert.equal(value.available, true);
  assert.equal(value.operations![0]!.id, "one");
  assert.equal(value.operations![0]!["code"], "EXECUTION_COMPLETE");
  assert.equal(value.logs!.length, 1);
  assert.equal(value.capabilities!.brokerControl, false);
  assert.equal(
    (value["fusion"] as { connectivity: string }).connectivity,
    "unknown",
  );
  fs.writeFileSync(path.join(dir, "queue-state.json"), "{broken");
  fs.appendFileSync(
    path.join(project, "fmcad.log"),
    "2026-10-20T12:00:01Z WARN event new log\n",
  );
  const partial = adapter.read();
  assert.equal(partial.available, false);
  assert.equal(partial.operations![0]!.id, "one");
  assert.equal(partial.logs!.length, 2);
});
