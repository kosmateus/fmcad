import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const cp = createRequire(__filename)(
  "node:child_process",
) as typeof import("node:child_process");
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import test from "node:test";
async function run() {
  const source = process.cwd();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-console-installed-"),
  );
  const children: ChildProcess[] = [];
  const originalSpawn = cp.spawn;
  const previous = new Map(
    [
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "HOME",
      "LC_ALL",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}');
    const packed: unknown = JSON.parse(
      cp.execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        { cwd: source, encoding: "utf8" },
      ),
    );
    assert(
      Array.isArray(packed) &&
        packed[0] &&
        typeof packed[0].filename === "string",
    );
    cp.execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        path.join(directory, packed[0].filename),
      ],
      { cwd: directory, stdio: "pipe" },
    );
    Object.assign(process.env, {
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      HOME: directory,
      LC_ALL: "en_US.UTF-8",
    });
    const project = path.join(directory, "registered project");
    fs.mkdirSync(project);
    const installed = path.join(directory, "node_modules/fmcad");
    const { openProjectRegistry } = createRequire(__filename)(
      path.join(
        installed,
        "dist/src/dist/node-adapters/persistence/project-history/registry.js",
      ),
    ) as typeof import("../packages/node-adapters/dist/persistence/project-history/registry");
    const registry = openProjectRegistry();
    registry.register({
      projectId: "project-unicode-α",
      projectPath: project,
      databaseId: "database-test",
      monitoring: false,
      archivedAtMs: null,
      nowMs: Date.now(),
    });
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    await new Promise((r) => server.close(r));
    const config = path.join(directory, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        backend: "addin",
        routing: "queue",
        controlCenter: { port },
        queue: { autoStart: false },
      }),
    );
    const original = cp.spawn;
    cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
      const child = original(...args);
      children.push(child);
      return child;
    }) as typeof cp.spawn;
    const { main } = createRequire(__filename)(
      path.join(installed, "dist/src/cli.js"),
    ) as typeof import("../src/entrypoints/cli");
    async function invoke(args: string[]) {
      let out = "",
        err = "";
      const code = await main(args, {
        cwd: directory,
        stdin: { isTTY: false },
        stdout: {
          write(s) {
            out += s;
          },
        },
        stderr: {
          write(s) {
            err += s;
          },
        },
        setExitCode() {},
      });
      return { code, out, err };
    }
    const denied = await invoke([
      "console",
      "--config",
      config,
      "--project",
      directory,
    ]);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /not registered/);
    assert.equal(children.length, 0);
    for (const alias of ["console", "diagnostic"])
      for (const mode of [[], ["--web"]]) {
        const result = await invoke([
          alias,
          ...mode,
          "--config",
          config,
          "--project",
          project,
        ]);
        assert.equal(result.code, 0, result.err);
        assert.equal(
          result.err,
          alias === "diagnostic"
            ? "diagnostic is an alias; use fmcad console.\n"
            : "",
        );
        const url = new URL(result.out.trim());
        assert.equal(url.searchParams.get("project"), "project-unicode-α");
        assert.equal(Number(url.port), port);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(
          await response.text(),
          /assets\/control-center\/web\/index.js/,
        );
      }
    const global = await invoke(["console", "--config", config]);
    assert.equal(global.code, 0, global.err);
    assert.equal(new URL(global.out.trim()).search, "");
    assert.equal(children.length, 1, "aliases reuse the same shared service");
    console.log(
      "Installed E/F console: registration rejection, both aliases, global view, real readiness, static assets, disposal and shared-service reuse passed.",
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((r) => child.once("exit", r));
        child.ref();
        child.kill("SIGTERM");
        await closed;
      }
    }
    cp.spawn = originalSpawn;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test(
  "installed public console uses registered projects and releases only caller resources",
  { timeout: 90000 },
  run,
);
