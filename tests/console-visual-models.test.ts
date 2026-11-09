import { createRequire } from "node:module";

const load = createRequire(
  path.join(process.cwd(), "tests", "console-visual-models.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { ConsoleModel } = load(
  "../src/console-controller",
) as typeof import("../src/composition/library-console-controller");
const { readLogs } = load(
  "../src/console-logs",
) as typeof import("../src/composition/library-console-logs");
const {
  consoleTaskGroup: group,
  consoleTaskCounts: counts,
  consoleRecordedDuration: recordedDuration,
  consoleLogWindowStats: windowStats,
} = load("../src/dist/core") as typeof import("@fmcad/core");
test("unrecognized outcomes stay unresolved; direct completion stays a transport result", () => {
  assert.equal(group({ state: "future-state" }), "unresolved");
  assert.deepEqual(
    counts([
      { state: "running" },
      { state: "queued" },
      { state: "unknown" },
      { state: "completed", outcomeScope: "transport" },
    ]),
    { active: 1, waiting: 1, unresolved: 1, history: 1 },
  );
  assert.equal(recordedDuration({ startedAt: 10, finishedAt: 5 }), null);
  assert.equal(
    windowStats([{ level: "INFO", timestamp: "not-a-time" }])!.invalid,
    1,
  );
});
test("navigation holds the viewport order; passive mode promotes new work and focus is per tab", () => {
  const model = new ConsoleModel();
  assert.equal(model.focus, 4);
  model.tab = 2;
  assert.equal(model.focus, 0);
  model.focus = 2;
  model.update({
    operations: [{ id: "old", state: "succeeded", finishedAt: 10 }],
  });
  model.rows()!;
  model.update({
    operations: [
      { id: "old", state: "succeeded", finishedAt: 10 },
      { id: "new", state: "running", startedAt: 20 },
    ],
  });
  assert.equal(model.rows()![0]!.id, "new");
  model.navigate(1, 1);
  const selected = model.state.selectedId;
  model.update({
    operations: [
      ...model.snapshot.operations!,
      { id: "newer", state: "queued", submittedAt: 30 },
    ],
  });
  assert.equal(model.rows()![0]!.id, "new");
  assert.equal(model.state.selectedId, selected);
  model.tab = 0;
  assert.equal(model.focus, 4);
  model.tab = 2;
  assert.equal(model.focus, 2);
});
test("retained log archives share a bounded budget and truncation does not reuse record identity", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "console-log-window-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const folder = path.join(project, ".cad/logs");
  fs.mkdirSync(folder, { recursive: true });
  const current = path.join(folder, "fmcad.log"),
    archive = path.join(folder, "fmcad-2026-10-20_16.log");
  fs.writeFileSync(
    archive,
    "2026-10-20T16:00:00Z WARN job_failed job=earlier code=FAILED\n",
  );
  fs.writeFileSync(
    current,
    "2026-10-20T17:00:00Z INFO heartbeat broker_process=absent\n",
  );
  const tracker = new Map(),
    first = readLogs(project, {}, 2000, 1024, tracker);
  assert.equal(first.logs!.length, 2);
  assert.ok(first.bytesRead <= 1024);
  assert.deepEqual(
    readLogs(project, {}, 2000, 1024, tracker).logs!.map((row) => row.id),
    first.logs!.map((row) => row.id),
  );
  const previous = first.logs!.at(-1)!.id;
  fs.writeFileSync(current, "different\n");
  const reset = readLogs(project, {}, 2000, 1024, tracker);
  assert.equal(reset.resynced, true);
  assert.notEqual(reset.logs!.at(-1)!.id, previous);
  const tiny = readLogs(project, {}, 1, 64, tracker);
  assert.ok(tiny.logs!.length <= 1);
  assert.ok(tiny.bytesRead <= 64);
});
