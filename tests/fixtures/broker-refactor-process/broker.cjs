"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fork } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const { respond } = require("./channel.cjs");
const [dir, crash = "none"] = process.argv.slice(2);
const {
  decodeNativeProgram,
  nativeReceipts,
} = require("../native-source-envelope.cjs");
// Existing explicit test-only platform/checker adapters. Physical execution is
// always the fake below; no production fence or recovery guard is disabled.
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, parent, ...rest) {
  const loaded = originalLoad.call(this, name, parent, ...rest);
  if (
    name === "./dist/config-platform" &&
    parent?.filename.endsWith("/src/queue-instance.js")
  )
    return { ...loaded, toWindowsPath: (file) => file };
  return loaded;
};
const admission = require(path.join(root, "src/queue-admission.js"));
admission.createProductionQueueAdmission = () => ({
  admission: {
    async check() {
      return { kind: "python", fence() {} };
    },
  },
  async checkPrepared() {
    return {};
  },
  fencePrepared() {},
  checkerFingerprint() {
    return "explicit fake checker for multiprocess contract";
  },
});
// Existing snapshot-store seam, wrapping the *real* durable commit. Exit after
// persistence, before QueueDomain publishes/submit can write an ACK.
if (crash === "admission" || crash === "commit-failure") {
  const records = require(
    path.join(root, "src/dist/node-adapters/persistence/records.js"),
  );
  const create = records.createSnapshotStore;
  records.createSnapshotStore = (directory, io = fs) => {
    let injecting = false;
    const store = create(
      directory,
      crash === "commit-failure"
        ? {
            ...io,
            renameSync(from, to) {
              if (injecting && to === path.join(directory, "queue-state.json"))
                throw Object.assign(new Error("Injected admission ENOSPC"), {
                  code: "ENOSPC",
                });
              return io.renameSync(from, to);
            },
          }
        : io,
    );
    return {
      ...store,
      commit(serialized) {
        const snapshot = JSON.parse(serialized);
        injecting = Object.values(snapshot.jobs).some(
          (job) => job.requestId === "request-A",
        );
        store.commit(serialized);
        if (injecting && crash === "admission") process.exit(86);
      },
    };
  };
}
const { durable, reclaim } = require(path.join(root, "src/queue-instance.js"));
const { serve } = require(path.join(root, "src/queue-broker.js"));
const instance = {
  pid: 999,
  birth: "mock:999",
  version: "mock",
  activeCommand: "SelectCommand",
  documents: [],
  documentState: { status: "unscoped" },
};
const observation = {
  ...instance,
  documentState: {
    status: "complete",
    fingerprint: "process-contract",
    state: { identity: { creationId: "document-A" }, references: [] },
  },
};
let active = 0,
  maximum = 0,
  rpc = 0,
  sends = 0,
  calls = 0;
const workers = new Map(),
  gates = new Map();
function emit(event, values = {}) {
  process.send?.({ event, ...values });
}
function receipts(script, value = instance) {
  const entries = nativeReceipts(script, dir, value);
  for (const entry of entries) durable(entry.file, entry.value);
  return entries;
}
function gate(key) {
  return new Promise((resolve) => gates.set(key, resolve));
}
const physical = {
  server: { timeoutMs: 20000 },
  _parse: JSON.parse,
  async _openSession() {
    return "offline-process-session";
  },
  async _post(payload) {
    const script = payload.params?.arguments?.object?.script || "";
    const source = decodeNativeProgram(script);
    const tag = /PROCESS_([AB])/.exec(source)?.[1];
    if (!tag) throw new Error("Unexpected fake physical script");
    const documentId = payload.params.arguments.object.documentId;
    assert.equal(
      documentId,
      "document-" + tag,
      "exact document pin forwarded with each owner's script",
    );
    ++sends;
    ++calls;
    ++active;
    maximum = Math.max(maximum, active);
    const pending = gate("physical-" + tag);
    emit("physical", {
      tag,
      documentId,
      rpcId: payload.id,
      sends,
      active,
      maximum,
    });
    try {
      await pending;
      receipts(script);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ tag, document: documentId }),
              },
            ],
          },
        }),
      };
    } finally {
      --active;
    }
  },
  async callTool(value, toolName) {
    const script = value.object?.script || "";
    const source = decodeNativeProgram(script);
    if (source.includes("FMCAD_QUEUE_INSTANCE")) {
      ++calls;
      ++active;
      maximum = Math.max(maximum, active);
      try {
        if (source.includes("postflight-") && crash === "postflight") {
          const entries = nativeReceipts(script, dir, observation);
          const pending = gate("postflight");
          emit("postflight", { entries });
          await pending;
        }
        const entries = receipts(script, observation);
        return {
          failed: !entries.some((entry) => entry.value.probeObservation),
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observation),
        };
      } finally {
        --active;
      }
    }
    const response = await this._post({
      jsonrpc: "2.0",
      id: ++rpc,
      method: "tools/call",
      params: { name: toolName || "fusion_mcp_execute", arguments: value },
    });
    return {
      failed: false,
      text: JSON.parse(response.raw).result.content[0].text,
    };
  },
};
let broker;
respond(async (message) => {
  if (message.action === "release-prepare") {
    workers.get(message.tag).send({ release: message.tag });
    return true;
  }
  if (message.action === "release-publish") {
    workers.get(message.tag).send({ releasePublish: message.tag });
    return true;
  }
  if (message.action === "release-physical") {
    gates.get("physical-" + message.tag)?.();
    return true;
  }
  if (message.action === "counts") return { active, maximum, sends, calls };
  if (message.action === "status") return broker.status();
  throw new Error("Unknown broker fixture command");
});
(async () => {
  if (fs.existsSync(path.join(dir, "broker.lock"))) reclaim(dir);
  broker = await serve(
    { backend: "mcp", timeoutMs: 20000, queue: { preparationConcurrency: 2 } },
    {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      nativePath: (file) => file,
      pollMs: 5,
      autoReconcile: false,
      spawnWorker(_exe, args, options) {
        const child = fork(path.join(__dirname, "worker.cjs"), [args[1]], {
          ...options,
          stdio: [...options.stdio, "ipc"],
        });
        child.on("message", (message) => {
          if (
            message.fixture === "preparing" ||
            message.fixture === "publishing"
          ) {
            workers.set(message.tag, child);
            emit(message.fixture, message);
          }
        });
        return child;
      },
    },
  );
  emit("ready", { pid: process.pid });
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.send(
    { event: "startup-failed", code: error.code, sends, active, maximum },
    () => process.exit(1),
  );
});
