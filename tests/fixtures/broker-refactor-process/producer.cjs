"use strict";
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const { respond } = require("./channel.cjs");
const { QueueClient, inputFiles } = require(
  path.join(root, "src/queue-client.js"),
);
const [project, tag] = process.argv.slice(2);
const client = new QueueClient("owner-" + tag);
const file = path.join(project, tag + ".py");
const argv = [
  "run",
  file,
  "--doc",
  "document-" + tag,
  "--doc-id",
  "document-" + tag,
];
const input = {
  kind: "command",
  requestId: "request-" + tag,
  argv,
  inputFiles: inputFiles(argv, project),
  cwd: project,
  timeoutMs: 20000,
  backend: "mcp",
};
respond(async (message) => {
  if (message.action === "submit")
    return client.submit({
      ...input,
      requestId: message.requestId || input.requestId,
      ...(message.queueTimeoutMs === undefined
        ? {}
        : { queueTimeoutMs: message.queueTimeoutMs }),
    });
  if (message.action === "result")
    return client.call("result", { jobId: message.jobId });
  if (message.action === "complete") return client.wait(message.jobId);
  if (message.action === "lookup")
    return client.call("find-request", { requestId: input.requestId });
  if (message.action === "status") return client.call("status");
  if (message.action === "reconcile")
    return client.call("reconcile", { jobId: message.jobId });
  if (message.action === "stop") return client.call("stop");
  throw new Error("Unknown producer command");
});
client.register().then(
  () => process.send({ event: "ready", pid: process.pid, dir: client.dir }),
  (error) => {
    process.stderr.write(error.stack);
    process.exit(1);
  },
);
