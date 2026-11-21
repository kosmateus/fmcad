"use strict";
// Separate process: module-level fake ports cannot affect other broker tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phased-close-broker-"));
const children = [];
const environment = require(
  path.join(root, "dist/tests/runtime-test-environment.js"),
).isolateRuntimeTestEnvironment(dir);
const restorePlatform = require("./fake-wsl-platform.cjs")();
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  const value = originalLoad.call(this, name, parent, ...args);
  if (
    name === "./dist/config-platform" &&
    parent?.filename.endsWith("/src/queue-instance.js")
  )
    return { ...value, toWindowsPath: (file) => file };
  return value;
};
let release, entered;
const waiting = new Promise((resolve) => {
  release = resolve;
});
const ready = new Promise((resolve) => {
  entered = resolve;
});
const admission = require(path.join(root, "src/queue-admission.js"));
admission.createProductionQueueAdmission = () => ({
  admission: {
    async check() {
      entered();
      await waiting;
      return { kind: "python", fence() {} };
    },
  },
  async checkPrepared() {},
  fencePrepared() {},
  checkerFingerprint() {
    return "lifecycle-barrier";
  },
});
const { serve } = require(path.join(root, "src/queue-broker.js"));
const { request } = require(path.join(root, "src/queue-connection.js"));
const { inputFiles } = require(path.join(root, "src/queue-client.js"));
const {
  decodeNativeProgram,
  nativeReceipts,
} = require("./native-source-envelope.cjs");
const { durable } = require(path.join(root, "src/queue-instance.js"));
const worker = path.join(dir, "worker.cjs");
const script = path.join(dir, "fixture.py");
fs.writeFileSync(script, "def run(context: str) -> None:\n    pass\n");
fs.writeFileSync(
  worker,
  `
const { run } = require(${JSON.stringify(path.join(root, "src/queue-worker.js"))});
run(process.argv[2], {async execute(request, backend) {
  await backend.callTool({featureType: "script", object: {script: "def run(context: str) -> None: pass"}});
  throw new Error("SDK must not be called");
}}).then(code => {process.exitCode = code;}, error => {console.error(error);process.exitCode = 1;});
`,
);
let broker;
const watchdog = setTimeout(() => {
  console.error("broker/worker heartbeat close deadlock");
  for (const child of children) child.kill("SIGKILL");
  process.exitCode = 1;
  process.exit(1);
}, 8000);
(async () => {
  let sdkCalls = 0;
  broker = await serve(
    { backend: "mcp", timeoutMs: 5000 },
    {
      dir,
      confirmOwnership: true,
      pollMs: 5,
      nativePath: (file) => file,
      createBackend: () => ({
        server: { timeoutMs: 5000 },
        _parse: JSON.parse,
        async _openSession() {
          return "fixture";
        },
        async _post() {
          sdkCalls++;
          throw new Error("unexpected SDK send");
        },
        async callTool(value) {
          const script = value.object?.script || "";
          if (!decodeNativeProgram(script).includes("FMCAD_QUEUE_INSTANCE")) {
            sdkCalls++;
            throw new Error("unexpected SDK send");
          }
          const instance = {
            pid: 999,
            birth: "mock:999",
            version: "mock",
            activeCommand: "SelectCommand",
            documents: [],
            documentState: {
              status: "complete",
              fingerprint: "one",
              state: { identity: { creationId: "A" }, references: [] },
            },
          };
          for (const item of nativeReceipts(script, dir, instance))
            durable(item.file, item.value);
          return {
            failed: false,
            text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
          };
        },
      }),
      spawnWorker(exe, args, options) {
        const child = spawn(exe, [worker, args[1]], options);
        children.push(child);
        return child;
      },
    },
  );
  const auth = { clientId: "owner", clientToken: "token" };
  await request(dir, { action: "register", ...auth });
  const argv = ["run", script];
  const job = await request(dir, {
    action: "submit",
    auth,
    request: {
      kind: "command",
      requestId: "close-request",
      argv,
      cwd: dir,
      timeoutMs: 5000,
      backend: "mcp",
      inputFiles: inputFiles(argv, dir),
    },
  });
  await ready;
  assert.equal(broker.status().jobs[job.id].state, "preparing");
  const closing = broker.close();
  // Keep the suspended checker through one real worker heartbeat interval.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  release();
  await closing;
  assert.equal(sdkCalls, 0);
  assert.equal(children.length, 1);
  assert.notEqual(children[0].exitCode, null);
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
  );
  assert.equal(snapshot.jobs[job.id].state, "failed");
  assert.equal(snapshot.jobs[job.id].code, "BROKER_STOPPING");
  assert.equal(fs.existsSync(path.join(dir, "broker.lock")), false);
  console.log("PASS real broker, worker and heartbeat close without SDK");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    restorePlatform();
    environment.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
