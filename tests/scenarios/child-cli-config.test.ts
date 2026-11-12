import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isolateScenarioConfiguration,
  writeChildScenarioConfig,
} from "./child-cli-config";

test("spawned scenario CLI can load its isolated broker configuration", (t) => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-child-config-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    PATH: process.env["PATH"] ?? "",
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    FMCAD_BACKEND: "mcp",
  };
  for (const folder of [
    env["XDG_CONFIG_HOME"]!,
    env["XDG_STATE_HOME"]!,
    env["XDG_CACHE_HOME"]!,
  ])
    fs.mkdirSync(folder, { recursive: true });
  isolateScenarioConfiguration(env);
  const configFile = writeChildScenarioConfig(env["XDG_CONFIG_HOME"]!, {
    backend: "mcp",
    routing: "queue",
    timeoutMs: 180000,
    queue: { autoStart: false },
    backends: { mcp: { url: "http://127.0.0.1:43123/mcp" } },
  });
  env["FMCAD_CONFIG"] = configFile;
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { loadConfig } = require(${JSON.stringify(path.join(root, "src/config.js"))}); process.stdout.write(JSON.stringify(loadConfig().cfg));`,
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(
    child.status,
    0,
    `spawned CLI could not load the scenario endpoint: ${child.stderr}`,
  );
  const config = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.equal(config["url"], "http://127.0.0.1:43123/mcp");
  assert.equal(config["backend"], "mcp");
  assert.equal(config["transport"], "node");
});
