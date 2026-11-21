"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const { run } = require(path.join(root, "src/queue-worker.js"));
const releases = new Map();
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  if (message.release) releases.get(message.release)?.();
  if (message.releasePublish)
    releases.get("publish-" + message.releasePublish)?.();
});
run(process.argv[2], {
  async execute(request, backend, onOutcome) {
    const script = fs.readFileSync(request.argv[1], "utf8");
    const tag = /PROCESS_([AB])/.exec(script)[1];
    // The production worker is in its local preparation phase, before asking
    // the real broker for a turn. Only the application service is a fake.
    await new Promise((resolve) => {
      releases.set(tag, resolve);
      process.send({ fixture: "preparing", tag, pid: process.pid });
    });
    process.send({ fixture: "requesting", tag, pid: process.pid });
    const result = await backend.callTool({
      featureType: "script",
      object: {
        script,
        documentId: request.argv[request.argv.indexOf("--doc-id") + 1],
      },
    });
    onOutcome({ settled: true });
    if (tag === "B")
      await new Promise((resolve) => {
        releases.set("publish-B", resolve);
        process.send({ fixture: "publishing", tag, pid: process.pid });
      });
    process.stdout.write(result.text + "\n");
    return result.failed ? 1 : 0;
  },
}).then(
  (code) => {
    process.exitCode = code;
    process.disconnect?.();
  },
  (error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
    process.disconnect?.();
  },
);
