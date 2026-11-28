/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS subprocess fixture. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { BrokerMcpClient } = require("../../packages/node-adapters/dist/fusion-transport/mcp.js");
const { decodeNativeProgram } = require("./native-source-envelope.cjs");
const { runBoundInstanceProbe } = require("./bound-instance-probe.cjs");

test("worker snapshot attestation fails closed on pending writes and storage errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-fence-"));
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key]);
  }
  const load = createRequire(
    path.resolve(__dirname, "../../dist/src/queue-broker.js"),
  );
  const { serve } = load("./queue-broker");
  const ipc = load("./queue-connection");
  const { buildHash } = load("./queue-instance");
  const { QueueDomain } = load("./dist/core/domain/queue");
  const originalCommit = QueueDomain.prototype._commit;
  const states = new Set();
  QueueDomain.prototype._commit = function (...args) {
    states.add(this);
    return Reflect.apply(originalCommit, this, args);
  };
  const directory = path.join(root, "queue");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const script = path.join(project, "owned.py");
  fs.writeFileSync(script, "def run(context: str) -> None:\n    pass\n");
  let worker, capability, spawned;
  const ready = new Promise((resolve) => {
    spawned = resolve;
  });
  let dispatches = 0;
  const instance = {
    pid: 99,
    birth: "synthetic:99",
    version: "offline",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  const preparedProbes = new Map();
  const probeReceipts = [];
  const fake = new BrokerMcpClient(
    {
      backend: "mcp",
      url: "http://offline.invalid",
      tool: "fusion_mcp_execute",
      timeoutMs: 1000,
    },
    {
      version: "offline",
      bridgeSource: () => "",
      requestTimeout: () => 1000,
    },
  );
  const prepareCallTool = fake.prepareCallTool.bind(fake);
  fake.prepareCallTool = async (args, tool, manifest) => {
    const script = args?.object?.script;
    if (
      typeof script === "string" &&
      decodeNativeProgram(script).includes("_qr_path = ")
    ) {
      assert.ok(manifest, "probe sends must retain their checked source manifest");
      assert.equal(
        manifest.sha256,
        createHash("sha256").update(script, "utf8").digest("hex"),
        "the manifest must bind the exact probe source sent to the backend",
      );
      preparedProbes.set(script, manifest);
    }
    return prepareCallTool(args, tool, manifest);
  };
  fake._post = async (payload) => {
    if (payload.method === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "offline-fixture", version: "offline" },
          },
        }),
      };
    if (payload.method === "notifications/initialized")
      return { status: 200, raw: "" };
    const args = payload.params?.arguments;
    const script = args?.object?.script;
    if (
      payload.method === "tools/call" &&
      typeof script === "string" &&
      preparedProbes.has(script)
    ) {
      const manifest = preparedProbes.get(script);
      assert.ok(manifest, "MCP probes must pass through prepared admission");
      const source = decodeNativeProgram(script);
      assert.match(source, /FMCAD_QUEUE_INSTANCE /);
      let text;
      if (source.includes("_qr_path = ")) {
        const probe = runBoundInstanceProbe(script, instance);
        text = probe.text;
        probeReceipts.push({ manifest, script, receipt: probe.receipt });
      } else {
        text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance);
      }
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text }] },
        }),
      };
    }
    dispatches++;
    assert.fail("No physical port may run in this fixture");
  };
  const broker = await serve(
    { backend: "mcp", timeoutMs: 10000 },
    {
      dir: directory,
      confirmOwnership: true,
      pollMs: 60000,
      nativePath: (file) => file,
      createBackend: () => fake,
      spawnWorker(_exe, _args, options) {
        capability = {
          jobId: options.env.FMCAD_QUEUE_WORKER_JOB,
          workerToken: options.env.FMCAD_QUEUE_WORKER_TOKEN,
        };
        worker = new EventEmitter();
        worker.pid = process.pid;
        worker.kill = () => {
          setImmediate(() => worker.emit("close", 1));
          return true;
        };
        setImmediate(() => {
          worker.emit("spawn");
          spawned();
        });
        return worker;
      },
    },
  );
  const originalStat = fs.lstatSync;
  let state;
  try {
    const startup = probeReceipts.find(
      ({ receipt }) => receipt.stage === "startup",
    );
    assert.ok(startup, "startup must execute and persist its bound probe");
    assert.equal(startup.receipt.stage, "startup");
    assert.deepEqual(
      startup.manifest.request,
      Object.fromEntries(
        Object.entries(startup.receipt).filter(
          ([key]) =>
            ![
              "terminal",
              "outcome",
              "instance",
              "probeObservation",
            ].includes(key),
        ),
      ),
      "the checked artifact must carry the exact binding persisted in its receipt",
    );
    assert.equal(
      startup.manifest.sha256,
      createHash("sha256").update(startup.script, "utf8").digest("hex"),
    );
    assert.match(startup.manifest.artifactHash, /^[a-f0-9]{64}$/);
    assert.equal(startup.receipt.buildHash, buildHash());
    assert.equal(startup.receipt.terminal, true);
    assert.equal(startup.receipt.outcome, "succeeded");
    assert.equal(startup.receipt.instance.pid, instance.pid);
    assert.equal(startup.receipt.instance.birth, instance.birth);
    assert.equal(startup.receipt.instance.version, instance.version);
    assert.deepEqual(startup.receipt.probeObservation, {
      schema: "fmcad-instance-probe-v1",
      identity: {
        pid: instance.pid,
        birth: instance.birth,
        version: instance.version,
        activeCommand: instance.activeCommand,
        documents: instance.documents,
      },
    });
    const auth = {
      clientId: "snapshot-owner",
      clientToken: "private-worker-fixture",
    };
    await ipc.request(directory, { action: "register", ...auth });
    const job = await ipc.request(directory, {
      action: "submit",
      auth,
      request: {
        kind: "command",
        requestId: "snapshot-original",
        cwd: project,
        argv: ["run", script],
        backend: "mcp",
        timeoutMs: 10000,
      },
    });
    await ready;
    state = [...states].findLast((value) => value.data.jobs[job.id]);
    assert.ok(state);
    const file = path.join(directory, "queue-state.json");
    const pending = path.join(directory, "queue-state.pending.json");
    const before = fs.readFileSync(file);
    const snapshot = () =>
      ipc.request(directory, {
        action: "worker-status",
        ...capability,
        snapshotFence: true,
      });
    const plain = await ipc.request(directory, {
      action: "worker-status",
      ...capability,
    });
    assert.equal("snapshotHash" in plain, false);
    const attested = await snapshot();
    assert.equal(
      attested.snapshotHash,
      createHash("sha256")
        .update(JSON.stringify(JSON.parse(before)))
        .digest("hex"),
    );
    await assert.rejects(
      ipc.request(directory, {
        action: "worker-status",
        ...capability,
        workerToken: "foreign",
        snapshotFence: true,
      }),
      { code: "INVALID_CAPABILITY" },
    );
    await assert.rejects(
      ipc.request(directory, {
        action: "worker-status",
        ...capability,
        jobId: "foreign",
        snapshotFence: true,
      }),
      { code: "INVALID_CAPABILITY" },
    );
    fs.writeFileSync(pending, "unresolved", { flag: "wx" });
    await assert.rejects(snapshot(), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(fs.readFileSync(pending, "utf8"), "unresolved");
    fs.unlinkSync(pending); // Only our synthetic test marker.
    for (const kind of ["directory", "symlink"]) {
      if (kind === "directory") fs.mkdirSync(pending);
      else fs.symlinkSync(script, pending);
      try {
        await assert.rejects(snapshot(), { code: "STORAGE_UNAVAILABLE" });
        assert.equal(fs.lstatSync(pending).isSymbolicLink(), kind === "symlink");
      } finally {
        if (kind === "directory") fs.rmdirSync(pending);
        else fs.unlinkSync(pending);
      }
    }
    for (const code of ["EACCES", "EIO"]) {
      fs.lstatSync = function (file, ...args) {
        if (String(file) === pending)
          throw Object.assign(new Error("injected storage error"), { code });
        return Reflect.apply(originalStat, this, [file, ...args]);
      };
      try {
        await assert.rejects(snapshot(), { code: "STORAGE_UNAVAILABLE" });
      } finally {
        fs.lstatSync = originalStat;
      }
    }
    for (const [field, value] of [
      ["_writing", true],
      ["_fault", new Error("injected durable fault")],
    ]) {
      const original = state[field];
      state[field] = value;
      try {
        await assert.rejects(snapshot(), { code: "STORAGE_UNAVAILABLE" });
      } finally {
        state[field] = original;
      }
    }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal((await snapshot()).snapshotHash, attested.snapshotHash);
    assert.equal(dispatches, 0);
  } finally {
    fs.lstatSync = originalStat;
    QueueDomain.prototype._commit = originalCommit;
    // End only the fake EventEmitter worker; no OS signal or SDK exists here.
    worker?.emit("close", 1);
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
