import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
test("default MCP process constructs its passive producer once and closes it without contaminating protocol frames", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-default-producer-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "observe.cjs"),
    trace = path.join(directory, "trace.jsonl");
  fs.writeFileSync(
    path.join(directory, "invalid.json"),
    "{invalid configuration",
  );
  fs.writeFileSync(
    preload,
    `
    const fs=require('node:fs'),Module=require('node:module'),load=Module._load;
    Module._load=function(name,...args){
      if(name==='../composition/control-center-telemetry.js')return {createMcpStdioTelemetry(options){
        const record=value=>fs.appendFileSync(process.env.E_TRACE,JSON.stringify(value)+'\\n');
        record({event:'create',options});
        if(process.env.E_FAILURE==='create')throw Error('private producer failure');
        return {publishOwnedResult(){throw Error('local discovery cannot publish an owned artifact');},async close(){record({event:'close'});if(process.env.E_FAILURE==='close')throw Error('private close failure');}};
      }};
      return load.call(this,name,...args);
    };
  `,
  );
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_DATA_HOME: path.join(directory, "data"),
    FMCAD_CONFIG: path.join(directory, "invalid.json"),
    E_TRACE: trace,
    LC_ALL: "en_US.UTF-8",
  };
  for (const failure of ["", "create", "close"]) {
    fs.rmSync(trace, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        path.join(process.cwd(), "bin/fmcad-mcp.js"),
        "--client",
        "producer-owner",
      ],
      {
        cwd: directory,
        env: { ...env, E_FAILURE: failure },
        input:
          JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }) + "\n",
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), {
      jsonrpc: "2.0",
      id: "ping",
      result: {},
    });
    assert.equal(
      result.stderr,
      failure === "create"
        ? "fmcad: passive telemetry unavailable; MCP remains available.\n"
        : "",
    );
    assert.doesNotMatch(result.stderr, /private/);
    const events = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line) as unknown));
    assert.deepEqual(
      events.map((event) => event["event"]),
      failure === "create" ? ["create"] : ["create", "close"],
    );
    const options = object(events[0]?.["options"]);
    assert.equal(options["clientId"], "producer-owner");
    assert.equal(typeof options["instanceId"], "string");
    assert.match(options["instanceId"] as string, /^[0-9a-f-]{36}$/);
    assert.equal(
      options["queueDirectory"],
      path.join(directory, "state/fmcad/queue"),
    );
  }
  for (const args of [["--help"], ["--unknown-option"]]) {
    fs.rmSync(trace, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        path.join(process.cwd(), "bin/fmcad-mcp.js"),
        ...args,
      ],
      {
        cwd: directory,
        env: { ...env, E_FAILURE: "create" },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(
      fs.existsSync(trace),
      false,
      "early help/parse failure must not construct telemetry",
    );
    assert.equal(result.status, args[0] === "--help" ? 0 : 1);
  }
});
