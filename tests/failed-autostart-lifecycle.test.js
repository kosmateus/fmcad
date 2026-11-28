"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");

const root = path.resolve(__dirname, "..");
const run = promisify(execFile);

async function fixture(t, { dead = false, mismatch, stage = "failed" } = {}) {
  const base = fs.mkdtempSync("/tmp/opencode/failed-autostart-");
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(base, "state"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_CONFIG_HOME: path.join(base, "config"),
  };
  delete env.FMCAD_PHYSICAL_OPERATOR_PROFILE;
  const config = path.join(base, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    routing: "queue",
    backend: "addin",
    queue: { autoStart: true, autoRecover: true, startupTimeoutMs: 500 },
  }));
  env.FMCAD_CONFIG = config;
  // This child owns only an offline supervisor claim. No backend or SDK exists.
  const child = spawn(process.execPath, ["-e", `
    const path = require("node:path");
    const qi = require(${JSON.stringify(path.join(root, "dist/src/queue-instance.js"))});
    const qc = require(${JSON.stringify(path.join(root, "dist/src/queue-connection.js"))});
    const {claimBrokerLifetime} = require(${JSON.stringify(path.join(root, "dist/src/dist/node-adapters/execution/broker-lifetime.js"))});
    const dir = qc.queueDirectory();
    require("node:fs").mkdirSync(dir, {recursive:true, mode:0o700});
    const lifetime = claimBrokerLifetime({
      dir, socket:qc.queueSocket(dir), buildHash:"a".repeat(64),
      configHash:"b".repeat(64), processBirth:qi.processBirth, disposeClient(){}
    });
    lifetime.beginPhysicalProvisioning();
    lifetime.retainBeforeInitializeFailure({
      code:"PHYSICAL_GENERATION_REJECTED", grantIssuance:"unknown"
    });
    console.log(JSON.stringify({dir, owner:lifetime.owner}));
    ${dead ? "" : "setInterval(() => {}, 1000);"}
  `], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(base, { recursive: true, force: true });
  });
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes("\n")) break;
  }
  const { dir, owner } = JSON.parse(output);
  if (dead) await exited;
  const lifecycleFile = path.join(dir, `broker-lifecycle-${owner.nonce}.json`);
  const lifecycle = JSON.parse(fs.readFileSync(lifecycleFile, "utf8"));
  if (mismatch) {
    lifecycle.owner[mismatch] = mismatch === "pid" ? owner.pid + 1 : "foreign";
  }
  lifecycle.stage = stage;
  fs.writeFileSync(lifecycleFile, JSON.stringify(lifecycle));
  const receipt = path.join(dir, `broker-startup-${owner.nonce}.receipt.json`);
  fs.writeFileSync(receipt, JSON.stringify({ terminal: false, outcome: "unknown" }));
  const state = path.join(dir, "queue-state.json");
  fs.writeFileSync(state, JSON.stringify({
    blocked: true, active: "historical-job",
    jobs: { "historical-job": { state: "unknown", requestId: "original" } },
  }));
  const files = ["broker.lock", path.basename(lifecycleFile), path.basename(receipt), "queue-state.json"];
  const before = files.map(name => fs.readFileSync(path.join(dir, name)));
  const client = async (id) => {
    try {
      const result = await run(process.execPath, [
        path.join(root, "dist/bin/fmcad.js"), "doc", "list",
        "--backend", "addin", "--client", id,
      ], { cwd: base, env, timeout: 10000 });
      assert.fail("Public command unexpectedly succeeded: " + result.stdout);
    } catch (error) {
      assert.equal(error.killed, false, String(error));
      assert.equal(typeof error.code, "number", String(error));
      return error.stderr + error.stdout;
    }
  };
  return {
    client,
    assertPreserved() {
      files.forEach((name, i) =>
        assert.deepEqual(fs.readFileSync(path.join(dir, name)), before[i], name));
      assert.deepEqual(fs.readdirSync(path.join(dir, "autostart")), []);
      assert.equal(fs.existsSync(path.join(dir, "autostart.lock")), false);
      assert.equal(fs.existsSync(path.join(dir, "recovery.lock")), false);
      if (!dead) {
        assert.equal(child.exitCode, null, "Client must not kill a live owner");
        assert.equal(child.signalCode, null, "Client must not signal a live owner");
      }
    },
  };
}

for (const dead of [false, true]) {
  test(`public independent clients report bound failed startup (${dead ? "dead" : "live"} owner)`, async (t) => {
    const f = await fixture(t, { dead });
    const replies = await Promise.all([f.client("first-client"), f.client("second-client")]);
    for (const reply of replies) {
      assert.match(reply, /PHYSICAL_GENERATION_REJECTED/);
      assert.doesNotMatch(reply, /Timed out waiting for broker startup/);
    }
    f.assertPreserved();
  });
}

for (const mismatch of ["pid", "birth", "nonce"]) {
  test(`public startup ignores failure belonging to another owner ${mismatch}`, async (t) => {
    const f = await fixture(t, { mismatch });
    assert.match(await f.client("guard-client"), /Timed out waiting for broker startup/);
    f.assertPreserved();
  });
}

test("public startup does not interpret unfinished provisioning as a failed receipt", async (t) => {
  const f = await fixture(t, { stage: "provisioning" });
  assert.match(await f.client("guard-client"), /Timed out waiting for broker startup/);
  f.assertPreserved();
});
