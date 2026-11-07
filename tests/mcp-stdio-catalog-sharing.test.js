"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("typed MCP and compatibility adapters share one catalog snapshot", () => {
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-mcp-catalog-"),
  );
  const home = path.join(directory, "home");
  const state = path.join(directory, "state");
  fs.mkdirSync(home);
  const script = `
    const assert = require('node:assert/strict');
    const { PassThrough } = require('node:stream');
    const Module = require('node:module');
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const entry = path.join(root, 'src/dist/entrypoints/mcp-stdio.js');
    const queue = path.join(${JSON.stringify(directory)}, 'queue');
    let factories = 0, toolsReads = 0, contractReads = 0, configured;
    const catalog = {
      tools() { toolsReads++; return []; },
      list() { contractReads++; return []; },
      fromMcp() { throw new Error('not used by tools/list'); },
      isLocal() { return true; },
    };
    const original = Module._load;
    Module._load = function(request, parent, ...args) {
      const loaded = original.call(this, request, parent, ...args);
      if (request === '../api' && parent?.filename === entry)
        return { ...loaded, createCatalogServices() { factories++; return catalog; } };
      if (request === '../../queue-connection.js' && parent?.filename === entry)
        return { queueDirectory: () => queue };
      if (request === '../../mcp-stdio-compat.js' && parent?.filename === entry)
        return { ...loaded, configureCatalogServices(value, tools, contracts) {
          configured = { value, tools, contracts };
          return loaded.configureCatalogServices(value, tools, contracts);
        } };
      return loaded;
    };
    const stdin = new PassThrough();
    let output = '';
    const { startStdio } = require(entry);
    assert.equal(factories, 0, 'import must not construct an MCP catalog');
    assert.equal(startStdio(['--help'], { stdout: { write() {} } }), undefined);
    assert.equal(factories, 0, 'help must not construct an MCP catalog');
    const { closed } = startStdio([], {
      stdin,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { throw new Error('unexpected diagnostic: ' + value); } },
    });
    stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\\n');
    closed.then(() => {
      assert.equal(factories, 1);
      assert.equal(toolsReads, 1);
      assert.equal(contractReads, 1);
      assert.equal(configured.value, catalog);
      assert.deepEqual(configured.tools, []);
      assert.deepEqual(configured.contracts, []);
      const response = JSON.parse(output);
      assert.equal(response.id, 1);
      assert.ok(Array.isArray(response.result.tools));
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: state,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
