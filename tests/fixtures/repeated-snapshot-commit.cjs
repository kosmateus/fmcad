"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const [runtime, directory] = process.argv.slice(2);
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const { createSnapshotStore } = load(
  "./dist/node-adapters/persistence/records",
);
const store = createSnapshotStore(directory);
const snapshot = store.restore();
process.on("message", () => {
  try {
    store.commit(snapshot);
    const bytes = fs.readFileSync(path.join(directory, "queue-state.json"));
    process.send({
      kind: "committed",
      snapshotHash: createHash("sha256")
        .update(JSON.stringify(JSON.parse(bytes)))
        .digest("hex"),
    });
  } catch (error) {
    process.send({ kind: "error", code: error.code, message: error.message });
  }
});
process.send({ kind: "ready" });
