"use strict";
// Actual production serve()/auth/dispatch with a fake physical backend. Never
// imports or constructs a real Fusion transport and never uses the global dir.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
require("./fake-wsl-platform.cjs")();
const { decodeNativeProgram } = require("./native-source-envelope.cjs");
const { runBoundInstanceProbe } = require("./bound-instance-probe.cjs");
const { serve } = require("../../src/queue-broker");
const { readJson, durable } = require("../../src/queue-instance");
const dir = process.argv[2];
const countsFile = path.join(dir, "counts.json");
const counts = fs.existsSync(countsFile)
  ? readJson(countsFile)
  : { probes: 0, starts: 0 };
const identity = {
  pid: 42,
  birth: "production-fake:42",
  version: "offline-2026",
  activeCommand: "SelectCommand",
  documents: [],
};
const physical = {
  server: {
    backend: "addin",
    url: "http://127.0.0.1:8765/mcp",
    tool: "execute_python",
    timeoutMs: 2000,
  },
  _parse: JSON.parse,
  async _post(payload) {
    assert.equal(payload.method, "tools/call");
    assert.equal(payload.params?.name, "execute_python");
    assert.equal(payload.params.arguments.persistent, false);
    const script = decodeNativeProgram(payload.params.arguments.code);
    const match = script.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    const binding = match ? JSON.parse(JSON.parse(match[1])) : null;
    if (binding?.jobId === "control") {
      counts.probes++;
      durable(countsFile, counts);
      if (process.argv.includes("--unknown"))
        throw Object.assign(
          new Error("Offline lost physical acknowledgement"),
          { code: "UNKNOWN_RPC" },
        );
    }
    let text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity);
    if (binding && file) {
      // Execute the actual production probe/receipt builder against an offline
      // Fusion stub; the generated script itself owns the bound observation.
      const result = runBoundInstanceProbe(script, identity);
      text =
        result.text
          .split(/\r?\n/)
          .find((line) => line.startsWith("FMCAD_QUEUE_INSTANCE ")) || text;
    }
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, stdout: text, stderr: "" }),
            },
          ],
        },
      }),
    };
  },
  async callTool(value, toolName) {
    assert.equal(toolName, "fusion_mcp_execute");
    assert.equal(value.featureType, "script");
    const response = await this._post({
      jsonrpc: "2.0",
      id: "fake-probe",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: {
          code: value.object.script + '\n\nrun("")\n',
          persistent: false,
        },
      },
    });
    const output = JSON.parse(JSON.parse(response.raw).result.content[0].text);
    return { failed: !output.success, text: output.stdout };
  },
};
serve(physical.server, {
  dir,
  confirmOwnership: true,
  createBackend: () => physical,
  pollMs: 5,
  startPaused: process.argv.includes("--paused"),
}).then(
  (broker) => {
    counts.starts++;
    durable(countsFile, counts);
    process.send({ ready: true, buildHash: broker.buildHash });
  },
  (error) => {
    process.stderr.write(error.stack + "\n");
    process.exit(1);
  },
);
