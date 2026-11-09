import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("typed MCP and compatibility adapters share one catalog snapshot", () => {
  const root = process.cwd();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-mcp-catalog-"),
  );
  const home = path.join(directory, "home");
  const state = path.join(directory, "state");
  fs.mkdirSync(home);
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "fixtures/mcp-catalog-sharing.js"),
        root,
        directory,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env["PATH"],
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: state,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
