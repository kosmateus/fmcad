import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { BrokerDrainState } from "../packages/node-adapters/src/execution/broker-lifetime";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const modulePath = path.join(
  root,
  "src/dist/node-adapters/execution/broker-lifetime",
);
const { claimBrokerLifetime } = load(
  modulePath,
) as typeof import("../packages/node-adapters/src/execution/broker-lifetime");
const instancePath = path.join(root, "src/queue-instance");
const { processBirth } = load(instancePath) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

function directory(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-lifetime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(dir: string, disposeClient = () => {}) {
  return claimBrokerLifetime({
    dir,
    socket: path.join(dir, "queue.sock"),
    buildHash: "test-build",
    configHash: "test-config",
    processBirth,
    disposeClient,
  });
}

const startup = { recovery: false, startupQuiescent: () => true };
const idlePorts = {
  inspectDrain: (): BrokerDrainState => "idle",
  async retireWorkers() {},
  releaseLease() {},
  onShutdownError() {},
  onTransportError() {},
  async dispatch(message: unknown) {
    return message;
  },
  poll() {},
  pollMs: 30_000,
};

function stage(dir: string, nonce: string) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, `broker-lifecycle-${nonce}.json`), "utf8"),
  ).stage;
}

function barrier() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function transact(socket: string, input: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const client = net.createConnection(socket, () => {
      client.write(JSON.stringify(input) + "\n");
    });
    let output = "";
    client.setEncoding("utf8");
    client.on("error", reject);
    client.on("data", (chunk) => (output += chunk));
    client.on("end", () => {
      client.destroy();
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test(
  "broker lifetime: the lock elects one process and ready follows listen",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    const broker = setup(dir);
    const entered = barrier();
    const finishStartup = barrier();
    const initializing = broker.initialize(
      startup,
      async ({ binding, receipt }) => {
        assert.equal(binding.brokerNonce, broker.owner.nonce);
        assert.equal(binding.ownerBirth, processBirth());
        assert.equal(binding.ownerPid, process.pid);
        assert.equal(
          receipt,
          path.join(dir, `broker-startup-${broker.owner.nonce}.receipt.json`),
        );
        entered.open();
        await finishStartup.wait;
      },
    );
    await entered.wait;
    assert.equal(stage(dir, broker.owner.nonce), "starting");
    assert.equal(fs.existsSync(socket), false);

    const contender = spawn(
      process.execPath,
      [
        "-e",
        `
    const [modulePath, instancePath, dir] = process.argv.slice(1);
    const { claimBrokerLifetime } = require(modulePath);
    const { processBirth } = require(instancePath);
    try {
      claimBrokerLifetime({
        dir, socket: dir + "/queue.sock", buildHash: "test-build",
        configHash: "test-config", processBirth, disposeClient() {},
      });
      process.exitCode = 2;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  `,
        modulePath,
        instancePath,
        dir,
      ],
      {
        env: { ...process.env, XDG_RUNTIME_DIR: dir },
        stdio: "inherit",
      },
    );
    t.after(() => contender.kill());
    assert.deepEqual(await once(contender, "exit"), [0, null]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(broker.lock, "utf8")),
      broker.owner,
    );
    finishStartup.open();
    await initializing;
    assert.equal(stage(dir, broker.owner.nonce), "starting");
    assert.equal(fs.existsSync(socket), false);

    await broker.listen(idlePorts);
    t.after(() => broker.close());
    assert.equal(stage(dir, broker.owner.nonce), "ready");
    assert.deepEqual(await transact(socket, { probe: true }), {
      ok: true,
      result: { probe: true },
    });
    await broker.close();
    assert.equal(fs.existsSync(broker.lock), false);
    assert.equal(fs.existsSync(socket), false);
  },
);

test(
  "broker lifetime: listen failure preserves the foreign endpoint and does not publish ready",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    const foreign = net.createServer((connection) => connection.end("foreign"));
    await new Promise<void>((resolve) => foreign.listen(socket, resolve));
    t.after(
      () => new Promise<void>((resolve) => foreign.close(() => resolve())),
    );
    const ino = fs.statSync(socket).ino;
    const broker = setup(dir);
    await broker.initialize(startup, () => {});
    await assert.rejects(broker.listen(idlePorts), { code: "EADDRINUSE" });
    assert.equal(stage(dir, broker.owner.nonce), "starting");
    assert.equal(fs.statSync(socket).ino, ino);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(broker.lock, "utf8")),
      broker.owner,
    );
  },
);

test("broker lifetime: unproven startup retains its exact receipt and never tries twice", async (t) => {
  const dir = directory(t);
  const broker = setup(dir);
  const lostReply = Object.assign(new Error("Unproven original observation"), {
    code: "TRANSPORT_TIMEOUT",
  });
  const accepted = { binding: broker.owner.nonce, outcome: "unknown" };
  const receiptFile = path.join(
    dir,
    `broker-startup-${broker.owner.nonce}.receipt.json`,
  );
  await assert.rejects(
    broker.initialize(startup, ({ receipt }) => {
      fs.writeFileSync(receipt, JSON.stringify(accepted), { flag: "wx" });
      throw lostReply;
    }),
    (error) => error === lostReply,
  );
  await assert.rejects(
    broker.initialize(startup, () =>
      assert.fail("The original startup cannot be replayed"),
    ),
    { code: "BROKER_LIFETIME_STATE" },
  );
  await assert.rejects(broker.listen(idlePorts), {
    code: "BROKER_LIFETIME_STATE",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), accepted);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(broker.lock, "utf8")),
    broker.owner,
  );
  assert.equal(stage(dir, broker.owner.nonce), "starting");
});

test("broker lifetime: startup cleanup does not unlink a replacement marker", async (t) => {
  const dir = directory(t);
  let disposed = false;
  const broker = setup(dir, () => (disposed = true));
  const replacement = path.join(dir, "replacement.json");
  const original = fs.readFileSync(broker.lock);
  fs.writeFileSync(replacement, original, { flag: "wx" });
  const ino = fs.statSync(replacement).ino;
  const wrongConfig = Object.assign(new Error("Wrong config"), {
    code: "CONFIG_CHANGED",
  });
  await assert.rejects(
    broker.initialize(startup, () => {
      // Content alone cannot prove ownership of a different file.
      fs.renameSync(replacement, broker.lock);
      throw wrongConfig;
    }),
    (error) => error === wrongConfig,
  );
  assert.equal(fs.statSync(broker.lock).ino, ino);
  assert.deepEqual(fs.readFileSync(broker.lock), original);
  assert.equal(disposed, false);
  assert.equal(stage(dir, broker.owner.nonce), "starting");
});

test(
  "broker lifetime: shutdown waits for late preparation and the owned worker's retirement",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    let status: BrokerDrainState = "pending";
    let disposed = 0;
    const broker = setup(dir, () => disposed++);
    await broker.initialize(startup, () => {});

    const worker = spawn(
      process.execPath,
      [
        "-e",
        `
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `,
      ],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    const workerExited = once(worker, "exit");
    t.after(() => worker.kill());
    const workerReply = barrier();
    const workerRequested = barrier();
    const retirementBegan = barrier();
    const finishRetirement = barrier();
    await broker.listen({
      ...idlePorts,
      inspectDrain: () => status,
      async dispatch() {
        workerRequested.open();
        await workerReply.wait;
        return { notStarted: true };
      },
      async retireWorkers() {
        retirementBegan.open();
        await finishRetirement.wait;
        workerReply.open();
        worker.stdin.end();
        assert.deepEqual(await workerExited, [0, null]);
      },
    });
    const reply = transact(socket, { pendingWorker: true });
    await workerRequested.wait;
    const close = broker.close();
    const concurrentClose = broker.close();
    assert.equal(broker.stopping, true);
    await nextTurn();
    assert.equal(fs.existsSync(broker.lock), true);
    assert.equal(fs.existsSync(socket), true);
    assert.equal(disposed, 0);
    assert.equal(worker.exitCode, null);
    status = "idle";
    broker.progress();
    await retirementBegan.wait;
    assert.equal(fs.existsSync(broker.lock), true);
    assert.equal(fs.existsSync(socket), true);
    assert.equal(disposed, 0);
    assert.equal(worker.exitCode, null);
    finishRetirement.open();
    assert.deepEqual(await reply, { ok: true, result: { notStarted: true } });
    await Promise.all([close, concurrentClose]);
    assert.equal(disposed, 1);
    assert.equal(fs.existsSync(broker.lock), false);
    assert.equal(fs.existsSync(socket), false);
  },
);

test(
  "broker lifetime: a response completed after worker retirement reaches its IPC client",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    const broker = setup(dir);
    const dispatchEntered = barrier();
    const abandonedEntered = barrier();
    const retired = barrier();
    const response = barrier();
    await broker.initialize(startup, () => {});
    await broker.listen({
      ...idlePorts,
      async dispatch(message) {
        if (message === "abandoned") abandonedEntered.open();
        else dispatchEntered.open();
        await response.wait;
        return { accepted: "original-request" };
      },
      async retireWorkers() {
        retired.open();
      },
    });

    const reply = transact(socket, { submit: "original-request" });
    await dispatchEntered.wait;
    const abandoned = net.createConnection(socket, () => {
      abandoned.write('"abandoned"\n');
    });
    t.after(() => abandoned.destroy());
    const disconnected = once(abandoned, "close");
    await abandonedEntered.wait;
    const close = broker.close();
    await retired.wait;
    await nextTurn(); // The worker cleanup has resolved; the dispatcher hasn't.
    assert.equal(fs.existsSync(broker.lock), true);
    abandoned.destroy();
    await disconnected;
    response.open();
    assert.deepEqual(await reply, {
      ok: true,
      result: { accepted: "original-request" },
    });
    await close;
    assert.equal(fs.existsSync(broker.lock), false);
  },
);

test(
  "broker lifetime: UNKNOWN during retirement retains IPC for status and recovery",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    const broker = setup(dir);
    const retiring = barrier();
    const retire = barrier();
    let status: BrokerDrainState = "idle";
    await broker.initialize(startup, () => {});
    await broker.listen({
      ...idlePorts,
      inspectDrain: () => status,
      async retireWorkers() {
        retiring.open();
        await retire.wait;
      },
      async dispatch(message) {
        if (message === "status") return { status };
        if (message === "recover") {
          status = "idle"; // This fixture represents recovery of original evidence.
          return { reconciled: "original-request" };
        }
        return { admitted: !broker.stopping };
      },
    });
    try {
      const close = broker.close();
      await retiring.wait;
      status = "blocked";
      retire.open();
      await assert.rejects(close, { code: "RECONCILIATION_REQUIRED" });
      assert.deepEqual(
        JSON.parse(fs.readFileSync(broker.lock, "utf8")),
        broker.owner,
      );
      assert.deepEqual(await transact(socket, "status"), {
        ok: true,
        result: { status: "blocked" },
      });
      assert.deepEqual(await transact(socket, "submit"), {
        ok: true,
        result: { admitted: false },
      });
      assert.deepEqual(await transact(socket, "recover"), {
        ok: true,
        result: { reconciled: "original-request" },
      });
      assert.equal(fs.existsSync(broker.lock), true);
      assert.deepEqual(await transact(socket, "submit"), {
        ok: true,
        result: { admitted: false },
      });
      await broker.close();
      assert.equal(fs.existsSync(broker.lock), false);
    } finally {
      status = "idle";
      retire.open();
      await broker.close().catch(() => {});
    }
  },
);

test(
  "broker lifetime: active physical or newly unknown work keeps the owner and the IPC endpoint",
  { timeout: 10_000 },
  async (t) => {
    const dir = directory(t);
    const socket = path.join(dir, "queue.sock");
    let status: BrokerDrainState = "physical";
    const broker = setup(dir);
    await broker.initialize(startup, () => {});
    await broker.listen({ ...idlePorts, inspectDrain: () => status });
    await assert.rejects(broker.close(), { code: "BROKER_BUSY" });
    assert.equal(broker.stopping, false);
    status = "pending";
    const close = broker.close();
    status = "blocked";
    broker.progress();
    await assert.rejects(close, { code: "RECONCILIATION_REQUIRED" });
    await assert.rejects(broker.close(), { code: "RECONCILIATION_REQUIRED" });
    assert.equal(broker.stopping, false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(broker.lock, "utf8")),
      broker.owner,
    );
    assert.deepEqual(await transact(socket, { status: true }), {
      ok: true,
      result: { status: true },
    });
    // Only the external evidence owner can clear its hold, not close().
    status = "idle";
    await broker.close();
  },
);
