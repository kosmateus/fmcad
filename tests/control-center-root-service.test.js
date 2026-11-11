"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { dependencies } = require("../dist/src/dist/composition/opencode");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("optional OpenCode web setup starts installed static assets without a read-model fallback", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-control-center-root-"),
  );
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const xdg = Object.fromEntries(
    ["config", "data", "state", "cache"].map((name) => [
      name,
      path.join(root, `xdg-${name}`),
    ]),
  );
  for (const directory of [home, temp, ...Object.values(xdg)])
    fs.mkdirSync(directory, { recursive: true });

  const keys = [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "FMCAD_CONFIG",
    "FMCAD_CONTROL_CENTER_PORT",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home,
    TMPDIR: temp,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
    XDG_CACHE_HOME: xdg.cache,
  });
  delete process.env.FMCAD_CONFIG;
  process.env.FMCAD_CONTROL_CENTER_PORT = String(await unusedPort());

  const serviceDirectory = path.join(xdg.data, "fmcad", "control-center");
  let servicePid;
  t.after(async () => {
    if (servicePid) {
      try {
        process.kill(servicePid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(servicePid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
      }
    }
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deps = dependencies();
  assert.equal(typeof deps.ensureWeb, "function");
  try {
    await deps.ensureWeb();
  } catch (error) {
    const diagnostics = path.join(
      temp,
      `fmcad-control-center-${process.getuid?.() ?? "unknown"}`,
      createHash("sha256")
        .update(path.resolve(serviceDirectory))
        .digest("hex")
        .slice(0, 24),
      "service.log",
    );
    const log = fs.existsSync(diagnostics)
      ? fs.readFileSync(diagnostics, "utf8")
      : "";
    throw new Error(`${error.message}${log ? `\n${log}` : ""}`, {
      cause: error,
    });
  }
  const discovery = JSON.parse(
    fs.readFileSync(path.join(serviceDirectory, "service.json"), "utf8"),
  );
  servicePid = discovery.pid;
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0);
  const base = `http://localhost:${discovery.port}`;
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /\/assets\/control-center\/web\/index\.js/);
});

test("standalone MCP automatically starts the installed console and keeps stdout framed", async (t) => {
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const {
    processBirthIdentity,
    processIsAlive,
  } = require("../dist/src/dist/control-center/server/identity.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-mcp-console-"));
  const port = await unusedPort();
  const dataHome = path.join(root, "data");
  const stateHome = path.join(root, "state");
  const configFile = path.join(root, "config.json");
  const discoveryFile = path.join(
    dataHome,
    "fmcad/control-center/service.json",
  );
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      backend: "addin",
      routing: "queue",
      controlCenter: { port },
      queue: { autoStart: false },
    }),
  );
  const child = spawn(
    process.execPath,
    [path.resolve(__dirname, "../dist/bin/fmcad-mcp.js")],
    {
      cwd: root,
      env: {
        ...process.env,
        FMCAD_CONFIG: configFile,
        FMCAD_CONTROL_CENTER_PORT: String(port),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const closed = once(child, "close");
  let service;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
    if (!service && fs.existsSync(discoveryFile))
      service = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
    if (service && processBirthIdentity(service.pid) === service.processBirth) {
      process.kill(service.pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (
        processIsAlive(service.pid, service.processBirth) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(processIsAlive(service.pid, service.processBirth), false);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
  );
  const deadline = Date.now() + 15000;
  while (
    (!output.includes("\n") || !fs.existsSync(discoveryFile)) &&
    Date.now() < deadline
  ) {
    assert.equal(child.exitCode, null, diagnostics);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(JSON.parse(output), { jsonrpc: "2.0", id: 1, result: {} });
  assert.ok(fs.existsSync(discoveryFile), diagnostics);
  service = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
  assert.equal(service.port, port);
  const response = await fetch(`http://localhost:${port}/`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const snapshot = await fetch(
    `http://localhost:${port}/api/v1/console/snapshot?scope=global`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(snapshot.status, 200);
  const value = await snapshot.json();
  assert.ok(value.snapshotToken, JSON.stringify(value));
  assert.equal(value.scope.kind, "global");
  assert.equal(
    fs.existsSync(path.join(stateHome, "fmcad/queue/broker.lock")),
    false,
  );
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, diagnostics);
});
