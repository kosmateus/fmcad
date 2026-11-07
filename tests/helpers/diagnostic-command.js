'use strict';
const assert = require('node:assert/strict');
const { main } = require('../../src/cli');
const { prepareRequest } = require('../../src/composition/execution-request');
const { execute } = require('../../src/composition/legacy-worker');
const { BrokerMcpClient } = require('../../packages/node-adapters/dist/fusion-transport/mcp');
const { BrokerAddinClient } = require('../../packages/node-adapters/dist/fusion-transport/addin');

// Replace only the wire endpoint. CLI admission, worker dispatch and response
// parsing remain production code; the removed direct-client CLI hooks are unused.
module.exports = async function invoke(argv, backend = 'mcp', text = 'DONE') {
  const calls = [], wireCalls = [];
  let stdout = '', stderr = '', loads = 0, submissions = 0;
  const Base = backend === 'addin' ? BrokerAddinClient : BrokerMcpClient;
  class Client extends Base {
    constructor(server) {
      super(server, { version: 'test', requestTimeout: () => 100, bridgeSource: () => '' });
    }
    async _openSession() { return 'offline'; }
    async callTool(request, name) {
      calls.push(request);
      return super.callTool(request, name);
    }
    async _post(payload) {
      wireCalls.push(payload);
      const result = backend === 'addin'
        ? { structuredContent: { success: true, stdout: text }, content: [] }
        : { content: [{ type: 'text', text }] };
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) };
    }
  }
  const code = await main(argv, {
    loadConfig() {
      loads++;
      return { cfg: { backend, routing: 'queue', url: 'http://offline.invalid/mcp', tool: 'fusion_mcp_execute' } };
    },
    async runQueued(rawArgv, cfg) {
      submissions++;
      assert.equal(cfg.backend, backend);
      const prepared = prepareRequest({ request: { argv: rawArgv, cwd: process.cwd(), backend } });
      assert.equal(prepared.payload.kind, 'legacy-command');
      const original = process.stdout.write;
      process.stdout.write = value => { stdout += String(value); return true; };
      try {
        return await execute(prepared, new Client(cfg), () => {});
      } finally {
        process.stdout.write = original;
      }
    },
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
    setExitCode() {},
  });
  assert.equal(wireCalls.length, submissions, 'One wire execution per admitted diagnostic');
  for (const payload of wireCalls) {
    assert.equal(payload.params.name, backend === 'addin' ? 'execute_python' : 'fusion_mcp_execute');
  }
  return { code, calls, stdout, stderr, loads };
};
