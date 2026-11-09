import { createRequire } from "node:module";
import test from "node:test";
const load = createRequire(
  path.join(process.cwd(), "tests/project-logger-rotation.test.js"),
);
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
type Events = typeof import("../src/composition/library-project-events");
interface Logger extends Pick<Events, "locations" | "createEventSink"> {
  appendSafe(file: string, text: string): Promise<void>;
  workspaceLog(
    cwd: string,
    config: ReturnType<Events["locations"]>,
  ): string | null;
  ensureProjectLogger(options: {
    queueDir: string;
    pollMs?: number;
    heartbeatMs?: number;
  }): Promise<
    | import("../src/composition/library-project-events").ObserverResponse
    | { enabled: false; code?: string }
  >;
  stopProjectLogger(options: { queueDir: string }): Promise<unknown>;
}
const { appendSafe, workspaceLog, locations } = load(
  "../src/opencode/project-logger.cjs",
) as Logger;
const { migrate } = load(
  "../scripts/migrate-project-log",
) as typeof import("../scripts/devtools/migrate-project-log");
const { ensureProjectLogger, stopProjectLogger, createEventSink } = load(
  "../src/opencode/project-logger.cjs",
) as Logger;

test("passive observer restores legacy projects and emits block and recovery details", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const queueDir = path.join(dir, "queue");
  fs.mkdirSync(queueDir);
  const config = locations(queueDir);
  fs.mkdirSync(config.stateDir);
  fs.writeFileSync(
    path.join(config.stateDir, "cursor.json"),
    JSON.stringify({ lastOrder: 0, projects: [path.join(dir, "fmcad.log")] }),
  );
  fs.writeFileSync(
    path.join(queueDir, "queue-state.json"),
    JSON.stringify({
      version: 1,
      jobs: {},
      blocked: { id: "test", reason: "INSTANCE_UNAVAILABLE" },
    }),
  );
  fs.writeFileSync(
    path.join(queueDir, "queue-diagnostics.json"),
    JSON.stringify({
      at: Date.now(),
      held: "INSTANCE_UNAVAILABLE",
      recovery: {
        status: "waiting_for_evidence",
        code: "RECOVERY_PROBE_FAILED",
      },
    }),
  );
  try {
    const ready = await ensureProjectLogger({
      queueDir,
      pollMs: 20,
      heartbeatMs: 40,
    });
    assert.ok("ok" in ready);
    assert.equal(ready.ok, true);
    const file = workspaceLog(dir, config);
    assert.ok(file);
    let text = "";
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("blocked_reason=INSTANCE_UNAVAILABLE")) break;
    }
    assert.match(text, /recovery_code=RECOVERY_PROBE_FAILED/);
    assert.match(text, /blocked_reason=INSTANCE_UNAVAILABLE/);
    assert.equal(fs.existsSync(path.join(dir, "fmcad.log")), false);
    const core = load("../src/dist/core") as typeof import("@fmcad/core");
    const sink = createEventSink(dir, { queueDir });
    const invocation = core.createInvocationContext({
      clientId: "mcp:fixture",
      requestId: "request:fixture",
      jobId: "job:fixture",
      projectId: "project:fixture",
      documentId: "doc:fixture",
      sessionId: "host-session:fixture",
      turnId: "turn:fixture",
      instanceId: "instance:fixture",
      source: "mcp",
    });
    await sink.publish({
      version: 1,
      invocation,
      atMs: Date.now(),
      name: "client.requested",
      data: { status: "accepted", message: "Bearer private-secret" },
    });
    assert.ok(sink.dispose);
    await sink.dispose();
    for (let i = 0; i < 50; i++) {
      text = fs.readFileSync(file, "utf8");
      if (text.includes("observation_client_requested")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const event = text
      .split("\n")
      .find((line) => line.includes("observation_client_requested"));
    assert.ok(event);
    for (const field of [
      "client=",
      "request=",
      "job=",
      "project=",
      "document=",
      "session=",
      "turn=",
      "instance=",
      "source=mcp",
    ]) {
      assert.ok(event.includes(field), `missing correlation field ${field}`);
    }
    assert.doesNotMatch(event, /private-secret|Bearer/);
  } finally {
    await stopProjectLogger({ queueDir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(config.stateDir, { recursive: true, force: true });
  }
});

test("legacy migration splits every line by UTC hour and refuses destination conflicts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const source = path.join(dir, "fmcad.log");
  const first = "2026-10-20T09:59:00.000Z INFO first\n";
  const last = "2026-10-20T10:00:00.000Z INFO last\n";
  fs.writeFileSync(source, first + last);
  const manifest = migrate(dir);
  assert.equal(manifest.lines, 2);
  assert.equal(manifest.outputs.length, 2);
  assert.equal(fs.existsSync(source), false);
  const current = workspaceLog(dir, locations());
  assert.ok(current);
  assert.equal(fs.readFileSync(current, "utf8"), last);
  assert.equal(
    fs.readFileSync(
      path.join(path.dirname(current), "fmcad-2026-10-20_09.log"),
      "utf8",
    ),
    first,
  );
  fs.writeFileSync(source, "2026-10-20T10:30:00.000Z INFO conflicting\n");
  assert.throws(() => migrate(dir), /Destination conflict/);
  assert.ok(fs.existsSync(source));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hourly rotation uses content hour across restart and skipped hours", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const file = workspaceLog(dir, locations());
  assert.ok(file);
  assert.equal(file, path.join(dir, ".cad", "logs", "fmcad.log"));
  const first = "2026-10-20T09:59:59.000Z INFO first\n";
  await appendSafe(file, first);
  await appendSafe(file, "2026-10-20T09:59:59.999Z INFO second\n");
  await appendSafe(file, "2026-10-20T10:00:00.000Z INFO third\n");
  assert.match(
    fs.readFileSync(
      path.join(dir, ".cad/logs/fmcad-2026-10-20_09.log"),
      "utf8",
    ),
    /first\n.*second\n/,
  );
  await appendSafe(file, "2026-10-21T12:00:00.000Z INFO next_day\n");
  assert.match(
    fs.readFileSync(
      path.join(dir, ".cad/logs/fmcad-2026-10-20_10.log"),
      "utf8",
    ),
    /third/,
  );
  assert.match(fs.readFileSync(file, "utf8"), /next_day/);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /third/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("logger refuses symlink logs, symlink directories and archive overwrite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const file = workspaceLog(dir, locations());
  assert.ok(file);
  await appendSafe(file, "2026-10-20T09:00:00.000Z INFO first\n");
  const archive = path.join(path.dirname(file), "fmcad-2026-10-20_09.log");
  fs.writeFileSync(archive, "existing");
  await assert.rejects(
    appendSafe(file, "2026-10-20T10:00:00.000Z INFO next\n"),
    { code: "EEXIST" },
  );
  assert.equal(fs.readFileSync(archive, "utf8"), "existing");
  fs.unlinkSync(file);
  fs.symlinkSync(archive, file);
  await assert.rejects(
    appendSafe(file, "2026-10-20T10:00:00.000Z INFO next\n"),
    { code: "ELOOP" },
  );
  fs.rmSync(path.join(dir, ".cad"), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(dir, ".cad"));
  await assert.rejects(
    appendSafe(file, "2026-10-20T10:00:00.000Z INFO next\n"),
    { code: "UNSAFE_DIRECTORY" },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
