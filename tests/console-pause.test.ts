import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { at, record, text, number } from "./integration/offline-cli";
const runtimeRequire = createRequire(
  process.cwd() + "/tests/console-pause.test.js",
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
let restorePlatform: (() => void) | undefined;
test.beforeEach(() => {
  restorePlatform = (
    runtimeRequire("./fixtures/fake-wsl-platform.cjs") as () => () => void
  )();
});
test.afterEach(() => {
  restorePlatform?.();
});
const { QueueState } = runtimeRequire("../src/queue-state") as {
  QueueState: new (
    dir: string,
    options?: { now?: () => number },
  ) => import("../packages/core/src/domain/queue").QueueDomain;
};
const { QueueGate } = runtimeRequire(
  "../src/queue-gate",
) as typeof import("../packages/node-adapters/src/execution/gate");
const { PauseBudget } = runtimeRequire(
  "../src/pause-budget",
) as typeof import("../packages/node-adapters/src/execution/pause-budget");
const { acceptedWorkerRequest, queueSocket } = runtimeRequire(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 0;
  const state = new QueueState(dir, { now: () => time });
  return {
    dir,
    state,
    gate: new QueueGate(state, "instance"),
    advance: (ms: number) => {
      time += ms;
    },
    submit: (id: string, queueTimeoutMs = 30000) =>
      state.submit({
        requestId: id,
        clientId: "a",
        kind: "rpc",
        payload: {},
        timeoutMs: 1000,
        queueTimeoutMs,
      }),
  };
}
test("physical admission vs pause, drain, idempotency, conflict, durable intent and unknown", async (t) => {
  const { gate, state, dir } = setup(t);
  let finish: (() => void) | undefined,
    sends = 0;
  const first = gate.run(() => {
    sends++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await gate.control(true, { requestId: "pause", expectedGeneration: 0 });
  assert.equal(gate.snapshot().phase, "PAUSING");
  const second = gate.run(async () => {
    sends++;
  });
  assert.equal(sends, 1);
  present(finish)();
  await first;
  assert.equal(gate.snapshot().phase, "PAUSED");
  assert.equal(new QueueState(dir).data.paused, true);
  assert.equal(
    (await gate.control(true, { requestId: "pause" })).generation,
    1,
  );
  await assert.rejects(gate.control(false, { expectedGeneration: 0 }), {
    code: "STATE_CONFLICT",
  });
  await gate.control(false, { expectedGeneration: 1 }, async () => {});
  await second;
  assert.equal(sends, 2);
  state._commit((d) => {
    d.controlBlocked = true;
    return null;
  });
  assert.equal(gate.snapshot().phase, "RECOVERY_BLOCKED");
  await assert.rejects(
    gate.run(async () => {
      sends++;
    }),
    { code: "RECONCILIATION_REQUIRED" },
  );
});
test("queue budgets: 30-8=22 seconds, arrival in pause, two pauses and restore", (t) => {
  const { state, dir, advance, submit } = setup(t);
  const a = submit("a");
  advance(8000);
  state.pause(true);
  advance(300000);
  const b = submit("b");
  advance(100000);
  assert.equal(state.next(), null);
  state.pause(false);
  assert.equal(
    number(state.status(text(a["id"]))["queueDeadline"]) - state._time(),
    22000,
  );
  assert.equal(
    number(state.status(text(b["id"]))["queueDeadline"]) - state._time(),
    30000,
  );
  advance(2000);
  state.pause(true);
  advance(600000);
  const restored = new QueueState(dir, { now: () => state._time() });
  assert.equal(restored.data.paused, true);
  restored.pause(false);
  assert.equal(
    number(restored.status(text(a["id"]))["queueDeadline"]) - state._time(),
    20000,
  );
  assert.equal(
    number(restored.status(text(b["id"]))["queueDeadline"]) - state._time(),
    28000,
  );
});
test("monotonic budget ignores stale callbacks, freezes only waiting and never restores full time", () => {
  let time = 0,
    expired = 0;
  const callbacks: (() => void)[] = [];
  const budget = new PauseBudget(30000, () => expired++, {
    now: () => time,
    schedule: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel() {},
  });
  time += 8000;
  budget.freeze();
  time += 300000;
  present(callbacks[0])();
  assert.equal(expired, 0);
  assert.equal(budget.remaining(), 22000);
  budget.resume();
  time += 2000;
  budget.freeze();
  time += 900000;
  budget.resume();
  assert.equal(budget.remaining(), 20000);
  present(callbacks[1])();
  assert.equal(expired, 0);
  time += 20000;
  present(callbacks[2])();
  assert.equal(expired, 1);
});
test("actual controlled worker client stays pending during pause, with live heartbeat and one dispatch", async (t) => {
  const { dir } = setup(t);
  let heartbeat = 0,
    dispatches = 0,
    held: net.Socket | undefined;
  const server = net.createServer((socket) =>
    socket.once("data", (data) => {
      const message = JSON.parse(String(data));
      if (message.action === "worker-status") {
        heartbeat++;
        socket.end(
          JSON.stringify({ ok: true, result: { waitingForPause: true } }) +
            "\n",
        );
      } else {
        dispatches++;
        held = socket;
      }
    }),
  );
  await new Promise<void>((resolve) =>
    server.listen(queueSocket(dir), resolve),
  );
  t.after(() => server.close());
  let done = false;
  const pending = acceptedWorkerRequest(
    dir,
    { action: "backend", jobId: "job", workerToken: "token" },
    { pollMs: 5 },
  ).then((value) => {
    done = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(done, false);
  assert.ok(heartbeat > 1);
  assert.equal(dispatches, 1);
  present(held).end(JSON.stringify({ ok: true, result: "completed" }) + "\n");
  assert.equal(await pending, "completed");
});

test("real broker control drains a physical RPC, keeps queued work and resumes through bound readiness receipts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-"));
  const { serve } = runtimeRequire(
    "../src/queue-broker",
  ) as typeof import("../src/queue-broker");
  const { request } = runtimeRequire(
    "../src/queue-connection",
  ) as typeof import("../src/entrypoints/queue-connection");
  const identity = {
    pid: 91,
    birth: "fake:91",
    version: "fake",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "unavailable" },
  };
  let finishPing: (() => void) | undefined,
    sent = 0,
    productScripts = 0;
  const { createBrokerTransport } = runtimeRequire(
    "../src/dist/fusion-transport/broker",
  ) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
  const physical = createBrokerTransport(
    {
      url: "http://queue.invalid",
      tool: "fusion_mcp_execute",
      timeoutMs: 30000,
    },
    {
      version: "fixture",
      requestTimeout: (server) => present(server.timeoutMs),
      bridgeSource: () => assert.fail("MCP does not use a bridge"),
    },
  );
  physical._post = async function (value) {
    const payload = record(value);
    if (payload["method"] === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { protocolVersion: at(payload, "params", "protocolVersion") },
        }),
      };
    if (payload["method"] === "notifications/initialized")
      return { status: 202, raw: "" };
    if (payload["method"] === "ping") {
      sent++;
      if (sent === 1)
        await new Promise<void>((resolve) => {
          finishPing = resolve;
        });
    }
    let script: unknown = payload;
    for (const key of ["params", "arguments", "object", "script"])
      script =
        script && typeof script === "object"
          ? Reflect.get(script, key)
          : undefined;
    if (typeof script === "string" && !script.includes("FMCAD_QUEUE_INSTANCE"))
      productScripts++;
    if (typeof script === "string") {
      const binding = script.match(
        /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
      );
      const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (binding && file) {
        const local = JSON.parse(text(file[1]))
          .replace(/^\\\\wsl\$\\[^\\]+/, "")
          .replaceAll("\\", "/");
        fs.writeFileSync(
          local,
          JSON.stringify({
            ...JSON.parse(JSON.parse(text(binding[1]))),
            terminal: true,
            outcome: "succeeded",
            instance: identity,
          }),
        );
      }
    }
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload["id"],
        result: script
          ? {
              content: [
                {
                  type: "text",
                  text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
                },
              ],
            }
          : {},
      }),
    };
  };
  const broker = await serve(
    { backend: "mcp", timeoutMs: 30000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () =>
        physical as unknown as import("../src/queue-broker-ports").Client,
      nativePath: (file) => file,
      pollMs: 5,
    },
  );
  t.after(async () => {
    await broker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const auth = { clientId: "control-test", clientToken: "private-control" };
  await request(dir, { action: "register", ...auth });
  const call = async (action: string, rest = {}) =>
    record(await request(dir, { action, auth, ...rest }));
  // The fake-clock queue-budget tests above assert pause freezing exactly.
  // Leave room here for the original active RPC's post-resume settlement.
  const submit = (requestId: string) =>
    call("submit", {
      request: {
        kind: "rpc",
        requestId,
        timeoutMs: 30000,
        queueTimeoutMs: 5000,
        payload: { jsonrpc: "2.0", id: requestId, method: "ping" },
      },
    });
  const first = await submit("first");
  for (let i = 0; !finishPing && i < 1000; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    finishPing,
    JSON.stringify(await call("result", { jobId: first["id"] })),
  );
  const before = await call("control-status");
  const paused = await call("pause", {
    control: {
      requestId: "pause",
      instanceId: before["instanceId"],
      expectedGeneration: before["generation"],
    },
  });
  assert.equal(paused["phase"], "PAUSING");
  const second = await submit("second");
  const stale = await call("submit", {
    request: {
      kind: "command",
      requestId: "stale-context",
      timeoutMs: 30000,
      argv: ["stats", "--doc", "OldModel"],
      cwd: dir,
    },
  });
  finishPing();
  for (
    let i = 0;
    (await call("control-status"))["phase"] !== "PAUSED" && i < 100;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(
    record((await call("result", { jobId: second["id"] }))["job"])["state"],
    "queued",
  );
  assert.equal(sent, 1);
  const current = await call("control-status");
  assert.equal(current["phase"], "PAUSED");
  await call("resume", {
    control: {
      requestId: "resume",
      expectedGeneration: current["generation"],
      instanceId: current["instanceId"],
    },
  });
  for (let i = 0; i < 2000; i++) {
    const result = await call("result", { jobId: second["id"] });
    if (record(result["job"])["state"] === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    record((await call("result", { jobId: first["id"] }))["job"])["state"],
    "succeeded",
  );
  assert.equal(
    record((await call("result", { jobId: second["id"] }))["job"])["state"],
    "succeeded",
  );
  for (let i = 0; i < 2000; i++) {
    if (
      record((await call("result", { jobId: stale["id"] }))["job"])["state"] ===
      "failed"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rejected = await call("result", { jobId: stale["id"] });
  assert.equal(record(rejected["job"])["state"], "failed");
  // Static admission is now covered by the real strict inspection gate. This
  // scenario must reach the stale-document guard after resume, never pass merely
  // because a generated program fails to typecheck before that guard is exercised.
  // Resume may invalidate preparation first (DOCUMENT_CHANGED); if preparation
  // finishes afterward, the fresh probe reports the explicitly unavailable target.
  // Both are document fences. Checker failures are no longer accepted here.
  assert.ok(
    ["DOCUMENT_CHANGED", "DOCUMENT_STATE_UNAVAILABLE"].includes(
      text(at(rejected, "job", "code")),
    ),
    JSON.stringify(rejected),
  );
  assert.equal(
    at(rejected, "job", "operationResult", "executionOutcome"),
    "not_started",
  );
  assert.equal(
    productScripts,
    0,
    "Unversioned queued context must be refreshed before original execution",
  );
  assert.equal(sent, 2);
});
