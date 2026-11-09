import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { at, record, text } from "./integration/offline-cli";
const runtimeRequire = createRequire(
  process.cwd() + "/tests/client-presence.test.js",
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
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
const { startClientPresence, readClientPresence } = runtimeRequire(
  "../src/client-presence",
) as ReturnType<
  typeof import("../packages/node-adapters/src/telemetry/client-presence").createClientPresenceAdapter
>;
const { brokerSnapshot } = runtimeRequire(
  "../src/console-data",
) as typeof import("../src/composition/library-console-data");
const { presenceSummary } = runtimeRequire(
  "../src/console-client-identity",
) as typeof import("@fmcad/core");
const { label } = runtimeRequire(
  "../src/console-labels",
) as typeof import("../src/composition/library-console-labels");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => unknown, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(30);
  }
  assert.fail("Presence did not update within the test budget");
}
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "p");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  return { root, project };
}
test("registered queue client publishes real process presence while idle and normal exit becomes offline", async (t) => {
  const { root, project } = fixture(t),
    state = path.join(root, "s"),
    dir = path.join(state, "fmcad/queue");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "queue-state.json"),
    JSON.stringify({
      version: 1,
      paused: false,
      jobs: {
        old: {
          id: "old",
          clientId: "mcp-stdio:old",
          state: "succeeded",
          request: { cwd: project },
        },
      },
    }),
  );
  const actions: unknown[] = [];
  const server = net.createServer((socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString();
      if (!raw.includes("\n")) return;
      const message = record(JSON.parse(text(raw.split("\n")[0])));
      actions.push(message["action"]);
      socket.end(
        JSON.stringify({ ok: true, result: { id: "fixture-job" } }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(path.join(dir, "broker.sock"), resolve),
  );
  t.after(() => server.close());
  const code = `const {QueueClient}=require(${JSON.stringify(runtimeRequire.resolve("../src/queue-client"))});
    (async()=>{const c=new QueueClient('mcp-stdio:live');await c.register();
    await c.call('submit',{request:{kind:'rpc',cwd:process.cwd()}});console.log('READY');
    process.stdin.resume();process.stdin.once('data',()=>process.exit(0));})().catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ["-e", code], {
    cwd: project,
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await until(() => stdout.includes("READY") || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr);
  const first = present(readClientPresence(project).clients[0]);
  assert.equal(first.presence, "observed");
  assert.equal(first.pid, child.pid);
  assert.equal(first.source, "queue-client-process-heartbeat");
  assert.deepEqual(actions, ["register", "submit"]);
  const snapshot = brokerSnapshot(project, { dir });
  assert.equal(
    present(
      present(snapshot.agents).find((agent) => agent.id === "mcp-stdio:live"),
    ).presence,
    "observed",
  );
  assert.equal(
    present(
      present(snapshot.agents).find((agent) => agent.id === "mcp-stdio:old"),
    ).source,
    "job-history",
  );
  const ui = {
    language: "en",
    statusText: () =>
      assert.fail("summary must not render individual presence"),
    L: (key: string) => label(key, "en"),
  };
  assert.match(presenceSummary(snapshot, ui), /presence confirmed/);
  const stale = readClientPresence(project, { now: () => Date.now() + 20000 })
    .clients[0];
  assert.equal(present(stale).presence, "unknown");
  await until(
    () =>
      present(readClientPresence(project).clients[0]?.lastSeen) >
      first.lastSeen,
  );
  const exit = once(child, "exit");
  child.stdin.write("quit");
  await exit;
  assert.equal(
    present(readClientPresence(project).clients[0]).presence,
    "offline",
  );
  assert.deepEqual(
    actions,
    ["register", "submit"],
    "heartbeat must never send another queue or Fusion request",
  );
});
test("presence files contain instance metadata and dispose only their own process record", async (t) => {
  const { project } = fixture(t);
  const one = startClientPresence("opencode:fixture", project, {
    intervalMs: 25,
  });
  t.after(() => one.stop());
  assert.equal(
    (
      runtimeRequire(
        "../src/console-project",
      ) as typeof import("../src/composition/library-console-project")
    ).resolveProject({ project }),
    project,
  );
  const two = startClientPresence("opencode:fixture", project, {
    intervalMs: 25,
  });
  t.after(() => two.dispose());
  assert.notEqual(two, one);
  assert.notEqual(two.instanceId, one.instanceId);
  const value = record(JSON.parse(fs.readFileSync(one.file, "utf8")));
  assert.deepEqual(Object.keys(value).sort(), [
    "birth",
    "clientId",
    "closed",
    "instanceId",
    "observedAt",
    "pid",
    "project",
    "version",
  ]);
  assert.equal(
    present(readClientPresence(project).clients[0]).presence,
    "observed",
  );
  assert.equal(present(readClientPresence(project).clients[0]).processCount, 2);
  one.dispose();
  const afterOne = readClientPresence(project).clients[0];
  assert.equal(present(afterOne).presence, "observed");
  assert.equal(present(afterOne).processCount, 2);
  assert.equal(present(afterOne).observedProcesses, 1);
  two.stop();
  assert.equal(
    present(readClientPresence(project).clients[0]).presence,
    "offline",
  );
});
test("PID birth mismatch, stale and future signals never confirm a client; bad files stay isolated", (t) => {
  const { project } = fixture(t),
    producer = startClientPresence("client", project);
  producer.stop();
  const value = record(JSON.parse(fs.readFileSync(producer.file, "utf8")));
  value["closed"] = false;
  value["birth"] = "wrong-process-birth";
  fs.writeFileSync(producer.file, JSON.stringify(value));
  assert.equal(
    present(readClientPresence(project).clients[0]).presence,
    "offline",
  );
  assert.equal(
    present(readClientPresence(project, { alive: () => null }).clients[0])
      .presence,
    "unknown",
  );
  assert.equal(
    present(
      readClientPresence(project, {
        alive: () => true,
        now: () => Number(value["observedAt"]) + 16000,
      }).clients[0],
    ).presence,
    "unknown",
  );
  assert.equal(
    present(
      readClientPresence(project, {
        alive: () => true,
        now: () => Number(value["observedAt"]) - 1,
      }).clients[0],
    ).presence,
    "unknown",
  );
  fs.writeFileSync(
    path.join(path.dirname(producer.file), "a".repeat(64) + ".json"),
    "{broken",
  );
  const read = readClientPresence(project);
  assert.equal(read.errors, 1);
  assert.equal(read.clients.length, 1);
});
test("multiple processes sharing a client ID prefer a confirmed live signal over closed history", (t) => {
  const { project } = fixture(t),
    producer = startClientPresence("cli:shared", project);
  t.after(() => producer.stop());
  const value = record(JSON.parse(fs.readFileSync(producer.file, "utf8")));
  fs.writeFileSync(
    path.join(path.dirname(producer.file), "b".repeat(64) + ".json"),
    JSON.stringify({
      ...value,
      instanceId: "other-process-instance",
      closed: true,
      observedAt: Number(value["observedAt"]) + 1,
    }),
  );
  const client = readClientPresence(project).clients[0];
  assert.equal(present(client).presence, "observed");
  assert.equal(present(client).processCount, 2);
  assert.equal(present(client).observedProcesses, 1);
});
test("history-only Overview does not imply a broken measured presence state", () => {
  const ui = {
    language: "en",
    statusText: () =>
      assert.fail("summary must not render individual presence"),
    L: (key: string) => label(key, "en"),
  };
  assert.match(
    presenceSummary(
      { agents: [{ id: "old", source: "job-history", presence: "unknown" }] },
      ui,
    ),
    /history only/,
  );
  assert.doesNotMatch(
    presenceSummary(
      {
        available: false,
        agents: [
          {
            id: "live",
            source: "queue-client-process-heartbeat",
            presence: "observed",
          },
        ],
      },
      ui,
    ),
    /presence confirmed/,
  );
});

test("presence does not turn an unrelated caller working directory into a project", (t) => {
  const { root } = fixture(t);
  assert.throws(
    () => startClientPresence("client", root),
    /existing fmcad project/,
  );
  assert.equal(fs.existsSync(path.join(root, ".cad")), false);
});

test("heartbeat write failure cannot fail or replay an accepted submit", async (t) => {
  const { root, project } = fixture(t),
    dir = path.join(root, "q");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(project, ".cad/telemetry"), "not a directory");
  let submissions = 0;
  const server = net.createServer((socket) =>
    socket.once("data", () => {
      submissions++;
      socket.end(
        JSON.stringify({ ok: true, result: { id: "accepted" } }) + "\n",
      );
    }),
  );
  await new Promise<void>((resolve) =>
    server.listen(path.join(dir, "broker.sock"), resolve),
  );
  t.after(() => server.close());
  const { QueueClient } = runtimeRequire(
    "../src/queue-client",
  ) as typeof import("../src/queue-client");
  const client = Object.assign(Object.create(QueueClient.prototype) as object, {
    dir,
    registered: true,
    auth: { clientId: "client" },
  }) as unknown as InstanceType<typeof QueueClient>;
  const result = await client.call("submit", { request: { cwd: project } });
  assert.equal(at(result, "id"), "accepted");
  assert.equal(submissions, 1);
});
