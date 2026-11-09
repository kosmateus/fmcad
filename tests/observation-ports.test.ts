import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { ObservationEvent } from "@fmcad/core";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const load = createRequire(path.resolve("tests/observation-ports.test.js"));
const core = load("../src/dist/core") as typeof import("@fmcad/core");
const { createProjectPresencePort } = load(
  "../src/dist/node-adapters/telemetry/client-presence",
) as typeof import("../packages/node-adapters/src/telemetry/client-presence");
const { createTelemetryEventSink } = load(
  "../src/dist/node-adapters/telemetry/event-sink",
) as typeof import("../packages/node-adapters/src/telemetry/event-sink");
const { createTelemetry } = load(
  "../src/direct-telemetry",
) as typeof import("../src/composition/library-direct-telemetry");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observation-ports-"));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project };
}

async function until<T>(
  fn: () => T | null | undefined | false,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(20);
  }
  assert.fail("Observation did not arrive within the test budget");
}

test("two independent processes with one client ID retain per-instance identity and shutdown", async (t) => {
  const { project } = fixture(t);
  const modulePath = load.resolve("../src/client-presence");
  const code =
    `const { startClientPresence } = require(${JSON.stringify(modulePath)});\n` +
    `const presence = startClientPresence('mcp:shared', process.cwd(), { intervalMs: 25 });\n` +
    `console.log(JSON.stringify({ file: presence.file, instanceId: presence.instanceId }));\n` +
    `process.stdin.resume(); process.stdin.once('data', () => { presence.dispose(); process.exit(0); });\n`;
  const start = () => {
    const child = spawn(process.execPath, ["-e", code], {
      cwd: project,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    return { child, output: () => output };
  };
  const first = start(),
    second = start();
  const firstInfo = await until(() =>
    first.output().split("\n").filter(Boolean).length
      ? record(JSON.parse(present(first.output().split("\n")[0])))
      : null,
  );
  const secondInfo = await until(() =>
    second.output().split("\n").filter(Boolean).length
      ? record(JSON.parse(present(second.output().split("\n")[0])))
      : null,
  );
  assert.notEqual(firstInfo["instanceId"], secondInfo["instanceId"]);
  const both = await until(() => {
    const client = (
      load("../src/client-presence") as ReturnType<
        typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
      >
    ).readClientPresence(project).clients[0];
    return client?.processCount === 2 ? client : null;
  });
  assert.equal(both.id, "mcp:shared");
  assert.equal(both.presence, "observed");
  assert.equal(both.observedProcesses, 2);
  assert.equal(
    new Set(both.processes.map((value) => value.instanceId)).size,
    2,
  );
  const firstExit = once(first.child, "exit");
  first.child.stdin.end("stop");
  await firstExit;
  const one = await until(() => {
    const client = (
      load("../src/client-presence") as ReturnType<
        typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
      >
    ).readClientPresence(project).clients[0];
    return client?.processCount === 2 && client.observedProcesses === 1
      ? client
      : null;
  });
  assert.equal(one.presence, "observed");
  const secondExit = once(second.child, "exit");
  second.child.stdin.end("stop");
  await secondExit;
  assert.equal(
    (
      load("../src/client-presence") as ReturnType<
        typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
      >
    )
      .readClientPresence(project)
      .clients.at(0)?.presence,
    "offline",
  );
});

test("presence enumeration is bounded and preserves unknown for missing process identity", (t) => {
  const { project } = fixture(t);
  const directory = path.join(project, ".cad", "telemetry", "clients");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 260; index++) {
    const filename = index.toString(16).padStart(64, "0") + ".json";
    fs.writeFileSync(
      path.join(directory, filename),
      JSON.stringify({
        version: 1,
        instanceId: `instance-${index}`,
        clientId: "shared",
        project,
        pid: 100_000 + index,
        birth: null,
        observedAt: Date.now(),
        closed: false,
      }),
    );
  }
  const result = (
    load("../src/client-presence") as ReturnType<
      typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
    >
  ).readClientPresence(project, {
    alive: () => null,
  });
  assert.equal(result.filesRead, 256);
  assert.equal(result.filesOmitted, 4);
  assert.equal(result.errors, 0);
  assert.equal(present(result.clients[0]).presence, "unknown");
  assert.equal(present(result.clients[0]).processCount, 256);
});

test("instance observation scope isolates failures and disposes only its own presence", async () => {
  const invocation = core.createInvocationContext({
    clientId: "cli:test",
    requestId: "request-1",
    jobId: "job-1",
    projectId: "project-1",
    documentId: "doc-1",
    sessionId: "session-1",
    turnId: "turn-1",
    instanceId: "instance-1",
    source: "cli",
    purpose: "Inspect fit",
  });
  const nowMs = 100;
  const published: ObservationEvent[] = [];
  let disposed = 0;
  let heartbeats = 0;
  const scope = core.createObservationScope({
    invocation,
    clock: { nowMs: () => nowMs },
    events: {
      async publish(event) {
        published.push(event);
      },
      dispose() {
        disposed++;
      },
    },
    presence: {
      async heartbeat(context, atMs) {
        heartbeats++;
        assert.equal(context.instanceId, "instance-1");
        assert.equal(atMs, nowMs);
      },
      async dispose(context, atMs) {
        assert.equal(context.instanceId, "instance-1");
        assert.equal(atMs, nowMs);
        throw new Error("best-effort cleanup");
      },
    },
  });
  assert.equal(
    await scope.publish("request.started", { status: "active" }),
    true,
  );
  assert.equal(await scope.heartbeat(), true);
  assert.equal(present(published[0]).invocation.requestId, "request-1");
  assert.equal(present(published[0]).invocation.jobId, "job-1");
  assert.equal(present(published[0]).invocation.projectId, "project-1");
  assert.equal(present(published[0]).invocation.documentId, "doc-1");
  assert.equal(present(published[0]).invocation.turnId, "turn-1");
  assert.equal(heartbeats, 1);
  await scope.dispose();
  await scope.dispose();
  assert.equal(disposed, 1);
  assert.equal(scope.disposed, true);
  assert.equal(await scope.publish("late.event"), false);
  assert.equal(await scope.heartbeat(), false);
});

test("project presence port binds one invocation instance and disposes only its own record", async (t) => {
  const { project } = fixture(t);
  const port = createProjectPresencePort(project, core);
  const invocation = core.createInvocationContext({
    clientId: "cli:shared",
    requestId: "request",
    instanceId: "instance-one",
    source: "cli",
  });
  const other = core.createInvocationContext({
    clientId: "cli:shared",
    requestId: "request-two",
    instanceId: "instance-two",
    source: "cli",
  });
  await port.heartbeat(invocation, Date.now());
  let client = (
    load("../src/client-presence") as ReturnType<
      typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
    >
  ).readClientPresence(project).clients[0];
  assert.equal(present(client).presence, "observed");
  await port.dispose(other, Date.now());
  assert.equal(
    (
      load("../src/client-presence") as ReturnType<
        typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
      >
    )
      .readClientPresence(project)
      .clients.at(0)?.presence,
    "observed",
  );
  await port.dispose(invocation, Date.now());
  client = (
    load("../src/client-presence") as ReturnType<
      typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
    >
  ).readClientPresence(project).clients[0];
  assert.equal(present(client).presence, "offline");
});

test("telemetry sink bounds events, observes disposal, and never promotes auxiliary failures", async (t) => {
  const invocation = core.createInvocationContext({
    clientId: "mcp:test",
    requestId: "request",
    instanceId: "instance",
    source: "mcp",
  });
  const event: ObservationEvent = {
    version: 1,
    invocation,
    atMs: 1,
    name: "transport.completed",
    data: { status: "completed" },
  };
  const written: ObservationEvent[] = [];
  const sink = createTelemetryEventSink(async (value) => {
    written.push(value);
  }, 1024);
  await sink.publish(event);
  assert.equal(written.length, 1);
  const oversized = { ...event, data: { payload: "x".repeat(2000) } };
  await assert.rejects(sink.publish(oversized), /oversized/);
  present(sink.dispose).call(sink);
  await sink.publish(event);
  assert.equal(written.length, 1);

  const { project } = fixture(t);
  const telemetry = createTelemetry({
    cwd: project,
    invocation,
    now: () => Date.now(),
    events: {
      async publish() {
        throw new Error("auxiliary event sink unavailable");
      },
      dispose() {},
    },
  });
  const transportResult = {
    status: 200,
    raw: JSON.stringify({ result: "private transport payload" }),
  };
  const request = {
    method: "tools/call",
    params: { arguments: { secret: "not persisted" } },
  };
  const result = await telemetry.track(
    request,
    async () => transportResult,
    invocation,
  );
  assert.strictEqual(result, transportResult);
  const snapshot = record(JSON.parse(fs.readFileSync(telemetry.file, "utf8")));
  const operation = record(array(snapshot["operations"])[0]);
  assert.equal(operation["requestId"], "request");
  assert.equal(operation["instanceId"], "instance");
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private transport payload|not persisted|secret/,
  );
  await telemetry.dispose();
});

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
