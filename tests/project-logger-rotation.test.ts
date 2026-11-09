import { createRequire } from "node:module";
import test from "node:test";
const load = createRequire(
  path.join(process.cwd(), "tests/project-logger-rotation.test.js"),
);
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
type Logger = Pick<
  typeof import("../src/composition/library-project-observer"),
  | "appendSafe"
  | "workspaceLog"
  | "locations"
  | "ensureProjectLogger"
  | "stopProjectLogger"
  | "createEventSink"
>;
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

function observerRequest(socketPath: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = "";
    socket.setTimeout(2000, () =>
      socket.destroy(new Error("Observer response timeout")),
    );
    socket.once("error", reject);
    socket.once("connect", () => socket.end(text + "\n"));
    socket.on("data", (bytes) => {
      response += bytes.toString("utf8");
    });
    socket.once("end", () => resolve(response));
  });
}

test("observer rejects unauthorized and malformed observations without mutating queue state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-protocol-"));
  const queueDir = path.join(dir, "queue");
  const project = path.join(dir, "project");
  fs.mkdirSync(queueDir);
  fs.mkdirSync(project);
  const file = path.join(queueDir, "queue-state.json");
  const queue = JSON.stringify({
    version: 1,
    jobs: {},
    active: null,
    blocked: null,
    lease: null,
    paused: false,
  });
  fs.writeFileSync(file, queue);
  const config = locations(queueDir);
  let started = false;
  try {
    const ready = await ensureProjectLogger({
      queueDir,
      pollMs: 20,
      heartbeatMs: 40,
    });
    assert.ok("ok" in ready);
    assert.equal(ready.ok, true);
    started = true;
    const control: unknown = JSON.parse(
      fs.readFileSync(path.join(config.stateDir, "observer.json"), "utf8"),
    );
    assert.ok(
      control &&
        typeof control === "object" &&
        "token" in control &&
        typeof control.token === "string",
    );
    const core = load("../src/dist/core") as typeof import("@fmcad/core");
    const invocation = core.createInvocationContext({
      clientId: "client",
      requestId: "request",
      instanceId: "instance",
      source: "cli",
    });
    const valid = {
      version: 1,
      atMs: Date.now(),
      name: "client.requested",
      invocation,
      data: { status: "accepted" },
    };
    for (const message of [
      { method: "attach", token: "wrong-token", cwd: project },
      {
        method: "observation",
        token: control.token,
        cwd: project,
        event: { ...valid, invocation: { ...invocation, clientId: "" } },
      },
      {
        method: "observation",
        token: control.token,
        cwd: project,
        event: { ...valid, data: { status: "x".repeat(6500) } },
      },
      {
        method: "observation",
        token: control.token,
        cwd: "relative",
        event: valid,
      },
      {
        method: "client",
        token: control.token,
        cwd: project,
        event: "unknown_event",
      },
    ])
      assert.deepEqual(
        JSON.parse(
          await observerRequest(config.socket, JSON.stringify(message)),
        ),
        { ok: false },
      );
    assert.deepEqual(JSON.parse(await observerRequest(config.socket, "{")), {
      ok: false,
    });
    assert.equal(await observerRequest(config.socket, "x".repeat(8193)), "");
    assert.equal(fs.existsSync(path.join(project, ".cad")), false);
    assert.equal(fs.readFileSync(file, "utf8"), queue);
    assert.deepEqual(
      JSON.parse(
        await observerRequest(
          config.socket,
          JSON.stringify({
            method: "attach",
            token: control.token,
            cwd: project,
          }),
        ),
      ),
      { ok: true },
    );
    const log = workspaceLog(project, config);
    assert.ok(log);
    for (let i = 0; i < 100 && !fs.existsSync(log); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(fs.readFileSync(log, "utf8"), /observer_attached/);
    assert.equal(fs.readFileSync(file, "utf8"), queue);
  } finally {
    if (started) await stopProjectLogger({ queueDir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
