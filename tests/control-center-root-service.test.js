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

test(
  "optional OpenCode web setup starts installed static assets without a read-model fallback",
  { timeout: 20000 },
  async (t) => {
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
  },
);
