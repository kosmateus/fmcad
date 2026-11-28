"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const [runtime, directory, releaseFile] = process.argv.slice(2);
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const { createSnapshotStore } = load(
  "./dist/node-adapters/persistence/records",
);
const pending = path.join(directory, "queue-state.pending.json");
const snapshot = fs.readFileSync(
  path.join(directory, "queue-state.json"),
  "utf8",
);
const io = {
  ...fs,
  unlinkSync(file) {
    if (file === pending) {
      process.send({ kind: "pending" });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(releaseFile)) {
        if (Date.now() >= deadline)
          throw new Error("Reader failed to release fixture commit");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return fs.unlinkSync(file);
  },
};
try {
  createSnapshotStore(directory, io).commit(snapshot);
  process.send({ kind: "committed" });
  process.disconnect();
} catch (error) {
  process.send({ kind: "error", message: String(error) });
  process.disconnect();
  process.exitCode = 1;
}
