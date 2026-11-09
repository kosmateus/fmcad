import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { request, queueDirectory, queueSocket } = load(
  "./src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
const {
  readJson: rawReadJson,
  durable,
  processBirth,
  reclaim,
} = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { reclaimStart, ensureBroker } = load("./src/queue-autostart") as Pick<
  typeof import("../src/entrypoints/queue-autostart"),
  "reclaimStart"
> & {
  // This test deliberately feeds a partial startup configuration to the earlier ownership guard.
  ensureBroker(config: unknown, auth: unknown): Promise<unknown>;
};
interface ResetClient {
  dir: string;
  call(
    action: string,
    rest?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
const { stopBroker, restoreBroker, ownsPersistedResetPause } = load(
  "./src/fusion-reset",
) as {
  stopBroker(
    client: ResetClient,
    marker: unknown,
    status: unknown,
  ): Promise<unknown>;
  restoreBroker(
    client: ResetClient,
    config: unknown,
    marker: unknown,
  ): Promise<unknown>;
  ownsPersistedResetPause(marker: unknown, state: unknown): boolean;
};
const { createBrokerControl } = load(
  "./src/dist/core/application/broker-control",
) as typeof import("../packages/core/src/application/broker-control");
const { createBrokerControlPort } = load(
  "./src/dist/node-adapters/broker-ipc/control",
) as typeof import("../packages/node-adapters/src/broker-ipc/control");
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function number(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}
function readJson(file: string): Record<string, unknown> {
  return record(rawReadJson(file));
}
// Lifecycle children are offline host fixtures; production platform policy is unchanged.
test.beforeEach((t) => {
  assert.ok("after" in t);
  t.after(
    (load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  );
});
const auth = { clientId: "offline-owner", clientToken: "private-offline" };

async function fixture(t: TestContext, flags: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-lc-"));
  const children: ChildProcess[] = [];
  async function start(extra = flags) {
    const production = flags.includes("--production");
    const child = fork(
      path.join(
        root,
        "tests/fixtures",
        production ? "lifecycle-production.cjs" : "lifecycle-process.cjs",
      ),
      [dir, ...extra],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(child);
    let stderr = "";
    assert.ok(child.stderr);
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const ready: unknown[] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(stderr || "offline child exited before ready");
      }),
    ]);
    assert.equal(record(ready[0])["ready"], true);
    if (production) await request(dir, { action: "register", ...auth });
    return child;
  }
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const child = await start();
  // Production fake probes run real local admission/receipt preparation; keep
  // their harness deadline above the old one-second false timeout only there.
  const callTimeoutMs = flags.includes("--production") ? 5000 : 1000;
  const call = async (action: string, rest: Record<string, unknown> = {}) =>
    record(
      await request(
        dir,
        { action, auth, ...rest },
        { timeoutMs: callTimeoutMs },
      ),
    );
  const fence = async () => {
    const current = await call("control-status");
    return {
      requestId: randomUUID(),
      instanceId: text(current["instanceId"]),
      expectedGeneration: number(current["generation"]),
    };
  };
  return { dir, child, start, call, fence };
}

test(
  "production dispatcher advertises working actions and persists paused distinct reload identity",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, ["--production", "--paused"]);
    const initial = await f.call("control-status");
    assert.equal(initial["phase"], "PAUSED");
    assert.equal(record(initial["capabilities"])["inspect"], true);
    assert.match(text(initial["buildHash"]), /^[a-f0-9]{64}$/);
    const inspected = await f.call("console-inspect", {
      control: await f.fence(),
    });
    assert.equal(record(inspected["instance"])["pid"], 42);
    assert.equal((await f.call("control-status"))["phase"], "PAUSED");
    const resumed = await f.call("resume", { control: await f.fence() });
    assert.equal(resumed["phase"], "RUNNING");
    await f.call("drain", { control: await f.fence() });
    const control = await f.fence();
    const exited = once(f.child, "exit");
    const ack = await f.call("console-reload", { control });
    await exited;
    assert.equal(readJson(text(ack["releaseFile"]))["outcome"], "released");
    await f.start(["--paused"]);
    const after = await f.call("control-status");
    assert.notEqual(after["instanceId"], initial["instanceId"]);
    assert.equal(after["buildHash"], initial["buildHash"]);
    assert.equal(after["phase"], "PAUSED");
    assert.equal(after["activeOperations"], 0);
    await assert.rejects(f.call("resume", { control }), {
      code: "INSTANCE_CHANGED",
    });
  },
);

test(
  "production unresolved inspection refuses stop/reload and duplicate requests never dispatch again",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, ["--production", "--unknown"]);
    const control = await f.fence();
    await assert.rejects(f.call("console-inspect", { control }));
    await assert.rejects(f.call("console-inspect", { control }));
    const status = await f.call("control-status");
    assert.equal(status["phase"], "RECOVERY_BLOCKED");
    assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
    for (const action of ["console-stop", "console-reload"])
      await assert.rejects(f.call(action, { control: await f.fence() }), {
        code: "RECONCILIATION_REQUIRED",
      });
    assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
    const saved = readJson(path.join(f.dir, "queue-state.json"));
    const exited = once(f.child, "exit");
    f.child.kill("SIGTERM");
    await exited;
    reclaim(f.dir);
    assert.deepEqual(readJson(path.join(f.dir, "queue-state.json")), saved);
    await f.start(["--unknown"]);
    const restored = await f.call("control-status");
    assert.equal(restored["phase"], "RECOVERY_BLOCKED");
    assert.notEqual(restored["instanceId"], status["instanceId"]);
    await assert.rejects(
      f.call("console-inspect", { control: await f.fence() }),
    );
    assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
  },
);

test(
  "production IPC client disconnect loses ACK but original inspect receipt prevents replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, ["--production", "--paused"]);
    const control = await f.fence();
    const socket = net.createConnection(queueSocket(f.dir));
    await once(socket, "connect");
    await new Promise<void>((resolve, reject) =>
      socket.write(
        JSON.stringify({ action: "console-inspect", auth, control }) + "\n",
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    socket.destroy();
    const receipt = path.join(
      f.dir,
      "console-admin-" +
        createHash("sha256").update(control.requestId).digest("hex") +
        ".json",
    );
    // The production fake still runs local Python admission before its synthetic
    // receipt is written; observe that owned intent without changing its deadline.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (fs.existsSync(receipt) && readJson(receipt)["status"] === "completed")
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(readJson(receipt)["status"], "completed");
    assert.equal(
      (await f.call("console-inspect", { control }))["requestId"],
      control.requestId,
    );
    assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
  },
);

test("isolated dispatcher enforces capabilities, mandatory fences, generation and explicit resume", async (t) => {
  const f = await fixture(t, ["--paused"]);
  const before = await f.call("control-status");
  assert.equal(before["phase"], "PAUSED");
  assert.equal(before["buildHash"], "fake-build");
  for (const action of [
    "inspect",
    "pause",
    "drain",
    "resume",
    "stop",
    "reload",
    "restart",
  ])
    assert.equal(record(before["capabilities"])[action], true);
  assert.equal(record(before["capabilities"])["reset"], false);
  assert.equal(record(before["capabilities"])["start"], false);
  await assert.rejects(f.call("resume"), { code: "INVALID_REQUEST" });
  const old = await f.fence();
  const resumed = await f.call("resume", { control: old });
  assert.equal(resumed["phase"], "RUNNING");
  await assert.rejects(
    f.call("pause", { control: { ...old, requestId: randomUUID() } }),
    { code: "STATE_CONFLICT" },
  );
  const drained = await f.call("drain", { control: await f.fence() });
  assert.equal(drained["phase"], "PAUSED");
  assert.equal(drained["gateClosed"], true);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
});

test("shared application and Node adapter use real IPC without retry and keep local reset separate", async (t) => {
  const f = await fixture(t);
  let sends = 0,
    resets = 0;
  const client = {
    call: (action: string, values?: unknown) => {
      sends++;
      return f.call(action, values == null ? {} : record(values));
    },
  };
  const port = createBrokerControlPort(client);
  const service = createBrokerControl(port);
  await service.execute("pause", await f.fence());
  assert.equal((await service.read()).phase, "PAUSED");
  const current = await f.fence();
  const before = sends;
  await assert.rejects(
    service.execute("resume", {
      ...current,
      expectedGeneration: current.expectedGeneration + 1,
    }),
    { code: "STATE_CONFLICT" },
  );
  assert.equal(
    sends,
    before + 1,
    "Only the fresh read occurs; no mutation is sent",
  );
  await assert.rejects(service.execute("reset", current), {
    code: "UNSUPPORTED_BROKER",
  });
  const explicit = createBrokerControl(
    createBrokerControlPort(client, {
      reset: async (fence) => {
        resets++;
        return fence;
      },
    }),
  );
  assert.deepEqual(await explicit.execute("reset", current), current);
  assert.equal(resets, 1);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 0);
});

test("lost administrative ACK reads original receipt, never replays probe", async (t) => {
  const f = await fixture(t);
  const control = await f.fence();
  await assert.rejects(f.call("console-inspect", { control, dropAck: true }));
  const original = await f.call("console-inspect", { control });
  assert.equal(original["requestId"], control.requestId);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
  await assert.rejects(f.call("console-reload", { control }), {
    code: "REQUEST_CONFLICT",
  });
});

test("lost resume ACK and duplicate drain cannot alias other actions or clients", async (t) => {
  const f = await fixture(t, ["--paused"]);
  const control = await f.fence();
  await assert.rejects(f.call("resume", { control, dropAck: true }));
  const result = await f.call("resume", { control });
  assert.equal(result["phase"], "RUNNING");
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
  await assert.rejects(f.call("drain", { control }), {
    code: "REQUEST_CONFLICT",
  });
  await assert.rejects(
    request(f.dir, {
      action: "resume",
      auth: { ...auth, clientId: "other-owner" },
      control,
    }),
    { code: "REQUEST_CONFLICT" },
  );
});

test("failed resume retains its original no-replay intent across duplicate requests", async (t) => {
  const f = await fixture(t, ["--paused", "--unknown"]);
  const control = await f.fence();
  await assert.rejects(f.call("resume", { control }), { code: "UNKNOWN_RPC" });
  await assert.rejects(f.call("resume", { control }), {
    code: "REQUEST_PENDING",
  });
  assert.equal((await f.call("control-status"))["phase"], "RECOVERY_BLOCKED");
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
});

test("unknown inspection keeps durable pause and refuses reload without replay", async (t) => {
  const f = await fixture(t, ["--unknown"]);
  const control = await f.fence();
  await assert.rejects(f.call("console-inspect", { control }), {
    code: "UNKNOWN_RPC",
  });
  await assert.rejects(f.call("console-inspect", { control }), {
    code: "UNKNOWN_RPC",
  });
  assert.equal((await f.call("control-status"))["phase"], "RECOVERY_BLOCKED");
  await assert.rejects(f.call("console-reload", { control: await f.fence() }), {
    code: "RECONCILIATION_REQUIRED",
  });
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["closes"], 0);
  const saved = readJson(path.join(f.dir, "queue-state.json"));
  const exited = once(f.child, "exit");
  f.child.kill("SIGTERM");
  await exited;
  assert.equal(record(reclaim(f.dir))["reconciliationRequired"], true);
  assert.deepEqual(readJson(path.join(f.dir, "queue-state.json")), saved);
  await f.start([]);
  assert.equal((await f.call("control-status"))["phase"], "RECOVERY_BLOCKED");
  await assert.rejects(f.call("console-reload", { control: await f.fence() }), {
    code: "RECONCILIATION_REQUIRED",
  });
  await assert.rejects(f.call("resume", { control: await f.fence() }), {
    code: "RECONCILIATION_REQUIRED",
  });
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 1);
});

test("idle reload publishes release and replacement confirms distinct paused identity", async (t) => {
  const f = await fixture(t);
  const control = await f.fence();
  const exited = once(f.child, "exit");
  const ack = await f.call("console-reload", { control });
  await exited;
  assert.equal(readJson(text(ack["releaseFile"]))["outcome"], "released");
  assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
  await f.start(["--paused"]);
  const after = await f.call("control-status");
  assert.notEqual(after["instanceId"], control.instanceId);
  assert.equal(after["phase"], "PAUSED");
  assert.equal(after["buildHash"], "fake-build");
  await assert.rejects(f.call("resume", { control }), {
    code: "INSTANCE_CHANGED",
  });
});

test("reset pause conflict cannot resume foreign generation over real dispatcher IPC", async (t) => {
  const f = await fixture(t, ["--production"]);
  const status = await f.call("status");
  await f.call("pause", { control: await f.fence() });
  const foreign = await f.call("control-status");
  const marker = { buildHash: status["buildHash"], resetPause: null };
  const client = { dir: f.dir, call: f.call };
  await assert.rejects(stopBroker(client, marker, status), {
    code: "STATE_CONFLICT",
  });
  await restoreBroker(client, {}, marker);
  assert.deepEqual(await f.call("control-status"), foreign);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 0);
  assert.equal(
    ownsPersistedResetPause(
      { resetPause: true },
      readJson(path.join(f.dir, "queue-state.json")),
    ),
    false,
  );
});

test("production reset restoration resumes only its confirmed instance and generation", async (t) => {
  const f = await fixture(t, ["--production"]);
  const control = await f.fence();
  const paused = await f.call("pause", { control });
  const marker = {
    protocol: 1,
    pid: process.pid,
    birth: processBirth(),
    buildHash: paused["buildHash"],
    nonce: randomUUID(),
    resetPause: {
      requestId: control.requestId,
      instanceId: paused["instanceId"],
      generation: paused["generation"],
    },
  };
  durable(path.join(f.dir, "fusion-reset.lock"), marker, true);
  const client = { dir: f.dir, call: f.call };
  assert.equal(
    ownsPersistedResetPause(
      marker,
      readJson(path.join(f.dir, "queue-state.json")),
    ),
    true,
  );
  await assert.rejects(
    f.call("resume", {
      control: {
        requestId: randomUUID(),
        instanceId: paused["instanceId"],
        expectedGeneration: paused["generation"],
      },
    }),
    { code: "FUSION_RESET_IN_PROGRESS" },
  );
  await assert.rejects(
    f.call("resume", {
      control: {
        requestId: randomUUID(),
        instanceId: paused["instanceId"],
        expectedGeneration: paused["generation"],
      },
      resetOwnerNonce: randomUUID(),
    }),
    { code: "FUSION_RESET_IN_PROGRESS" },
  );
  const foreignAuth = {
    clientId: "other-offline-owner",
    clientToken: "other-private-offline",
  };
  await request(f.dir, { action: "register", ...foreignAuth });
  await assert.rejects(
    request(f.dir, {
      action: "resume",
      auth: foreignAuth,
      control: {
        requestId: randomUUID(),
        instanceId: paused["instanceId"],
        expectedGeneration: paused["generation"],
      },
      resetOwnerNonce: marker.nonce,
    }),
    { code: "RESET_PAUSE_UNOWNED" },
  );
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], 0);
  const restored = await restoreBroker(client, {}, marker);
  assert.equal(record(record(restored)["control"])["phase"], "RUNNING");
  await f.call("pause", { control: await f.fence() });
  const foreign = await f.call("control-status");
  const probes = readJson(path.join(f.dir, "counts.json"))["probes"];
  await assert.rejects(restoreBroker(client, {}, marker), {
    code: "RESET_PAUSE_UNOWNED",
  });
  assert.deepEqual(await f.call("control-status"), foreign);
  assert.equal(readJson(path.join(f.dir, "counts.json"))["probes"], probes);
});

test("startup recovery distinguishes exited owner, live owner and reused PID birth", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-lc-owner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "autostart"));
  const child = fork(
    path.join(root, "tests/fixtures/lifecycle-process.cjs"),
    [dir],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(child, "message");
  const owner = readJson(path.join(dir, "broker.lock"));
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  // This fixture owns the exact dead marker. Autostart reclaim must still
  // refuse it while broker ownership is present; no broad lock deletion.
  await assert.rejects(async () => reclaimStart(dir), {
    code: "BROKER_MARKER_PRESENT",
  });
  fs.unlinkSync(path.join(dir, "broker.lock"));
  const claim = {
    nonce: randomUUID(),
    pid: owner["pid"],
    birth: owner["birth"],
  };
  durable(path.join(dir, "autostart.lock"), claim, true);
  assert.equal(reclaimStart(dir)["reclaimedStartup"], true);
  durable(
    path.join(dir, "autostart.lock"),
    { nonce: randomUUID(), pid: process.pid, birth: processBirth() },
    true,
  );
  assert.throws(() => reclaimStart(dir), { code: "STARTER_ALIVE" });
  const live = readJson(path.join(dir, "autostart.lock"));
  durable(path.join(dir, "autostart.lock"), {
    ...live,
    birth: "stale-birth-not-current-pid",
  });
  assert.equal(reclaimStart(dir)["reclaimedStartup"], true);
});

test("exclusive explicit startup refuses every existing marker without reclaim or spawn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-lc-exclusive-"));
  const old = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = root;
  t.after(() => {
    if (old === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = queueDirectory();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["broker.lock", "autostart.lock", "recovery.lock"]) {
    const file = path.join(dir, name);
    const marker = {
      pid: process.pid,
      birth: "stale-pid-birth",
      nonce: randomUUID(),
    };
    durable(file, marker, true);
    await assert.rejects(
      ensureBroker(
        {
          routing: "queue",
          queue: { exclusiveStart: true, startupTimeoutMs: 100 },
        },
        auth,
      ),
      { code: "OWNERSHIP_CONFLICT" },
    );
    assert.deepEqual(readJson(file), marker);
    assert.equal(fs.readdirSync(path.join(dir, "autostart")).length, 0);
    fs.unlinkSync(file); // Only this test's exact marker; no service was started.
  }
});
