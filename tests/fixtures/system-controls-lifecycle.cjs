"use strict";
// Owned offline supervisor: the real lifecycle dispatcher, gate, durable state
// and IPC client run in a separate process. No Fusion client is constructed.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID, createHash } = require("node:crypto");
const { QueueState } = require("../../src/queue-state");
const { QueueGate } = require("../../src/queue-gate");
const { createAdmin } = require("../../src/queue-console-admin");
const {
  createLifecycleDispatcher,
} = require("../../src/dist/node-adapters/broker-ipc/lifecycle");
const { durable, readJson, processBirth } = require("../../src/queue-instance");
const { queueSocket } = require("../../src/queue-connection");
const dir = process.argv[2];
const requestedBuildHash = process.argv.find((value) =>
  value.startsWith("--build-hash="),
);
const buildHash = requestedBuildHash
  ? requestedBuildHash.slice("--build-hash=".length)
  : "fake-build";
const marker = {
  pid: process.pid,
  birth: processBirth(),
  nonce: randomUUID(),
  protocol: 2,
};
durable(path.join(dir, "broker.lock"), marker, true);
const state = new QueueState(dir);
if (process.argv.includes("--paused"))
  state.pause(true, "startup:" + marker.nonce);
const gate = new QueueGate(state, marker.nonce);
const activeCountArg = process.argv.find((value) =>
  value.startsWith("--active-count="),
);
if (activeCountArg) {
  const count = Number(activeCountArg.slice("--active-count=".length));
  if (Number.isSafeInteger(count) && count >= 0 && count <= 1000)
    for (let index = 0; index < count; index++)
      gate.active.set("fixture-worker-" + index, Date.now());
}
const context = { busy: false, active: null, held: null, stopping: false };
const countsFile = path.join(dir, "counts.json");
const counts = fs.existsSync(countsFile)
  ? readJson(countsFile)
  : { probes: 0, closes: 0 };
const save = () => durable(countsFile, counts);
save();
async function resumeCheck() {
  counts.probes++;
  save();
  if (process.argv.includes("--unknown")) {
    state._commit((d) => {
      d.controlBlocked = { rpcId: "original" };
      return null;
    });
    throw Object.assign(new Error("Original SDK acknowledgement is unknown"), {
      code: "UNKNOWN_RPC",
    });
  }
  return { pid: 42, birth: "offline:42", version: "fake-2026" };
}
async function close() {
  counts.closes++;
  save();
  if (readJson(path.join(dir, "broker.lock")).nonce !== marker.nonce)
    throw Object.assign(new Error("changed"), { code: "LOCK_CHANGED" });
  fs.unlinkSync(path.join(dir, "broker.lock"));
  server.close(() => process.exit(0));
}
const admin = createAdmin({
  state,
  gate,
  dir,
  marker,
  buildHash,
  getContext: () => context,
  setBusy: (value) => {
    context.busy = value;
  },
  resumeCheck,
  observeControlCompletion: async () => {
    throw Object.assign(new Error("No original terminal receipt"), {
      code: "RECEIPT_MISMATCH",
    });
  },
  close,
  diagnostics() {},
  durable,
  readJson,
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
const dispatcher = createLifecycleDispatcher({
  gate,
  admin,
  dir,
  buildHash,
  canResume() {
    if (state.data.controlBlocked)
      throw Object.assign(new Error("unresolved"), {
        code: "RECONCILIATION_REQUIRED",
      });
  },
  resumeCheck,
  diagnostics() {},
});
const server = net.createServer((socket) => {
  let bytes = "";
  socket.on("data", async (chunk) => {
    bytes += chunk;
    if (!bytes.includes("\n")) return;
    socket.removeAllListeners("data");
    try {
      const message = JSON.parse(bytes);
      const clientToken =
        message.action === "register"
          ? message.clientToken
          : message.auth?.clientToken;
      if (
        clientToken !==
        (process.env.FMCAD_FIXTURE_CLIENT_TOKEN || "private-offline")
      )
        throw Object.assign(new Error("auth"), { code: "AUTH_REQUIRED" });
      let result;
      if (message.action === "register")
        result = { clientId: message.clientId, registeredAt: Date.now() };
      else if (message.action === "control-status") result = gate.snapshot();
      else if (message.action === "fixture-finish-workers") {
        gate.active.clear();
        result = gate.snapshot();
      } else if (message.action === "status")
        result = {
          ...state.status(),
          control: gate.snapshot(),
          buildHash: "fake-build",
        };
      else result = await dispatcher.handle(message, message.auth.clientId);
      if (message.dropAck) return socket.destroy();
      socket.end(JSON.stringify({ ok: true, result }) + "\n");
    } catch (error) {
      socket.end(
        JSON.stringify({
          ok: false,
          error: { code: error.code, message: error.message },
        }) + "\n",
      );
    }
  });
});
// The new fixture already owns the exclusive marker; only its stale socket is
// removed, exactly as in production serve(). Receipts/state are never removed.
if (fs.existsSync(queueSocket(dir))) fs.unlinkSync(queueSocket(dir));
server.listen(queueSocket(dir), () => process.send({ ready: true, marker }));
