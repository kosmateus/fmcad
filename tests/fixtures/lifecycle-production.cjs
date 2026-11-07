'use strict';
// Actual production serve()/auth/dispatch with a fake physical backend. Never
// imports or constructs a real Fusion transport and never uses the global dir.
const fs = require('node:fs');
const path = require('node:path');
require('./fake-wsl-platform.cjs')();
const { serve } = require('../../src/queue-broker');
const { readJson, durable } = require('../../src/queue-instance');
const dir = process.argv[2];
const countsFile = path.join(dir, 'counts.json');
const counts = fs.existsSync(countsFile) ? readJson(countsFile) : { probes: 0, starts: 0 };
const identity = { pid: 42, birth: 'production-fake:42', version: 'offline-2026', activeCommand: 'SelectCommand', documents: [] };
const physical = { server: { timeoutMs: 2000 }, _parse: JSON.parse,
  async _post(payload) {
    let script = payload.params?.arguments?.code || payload.params?.arguments?.object?.script || '';
    let match, file;
    for (let depth = 0; depth < 8; depth++) {
      match = script.match(/_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/);
      file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (match && file) break;
      const wrapped = script.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
      if (!wrapped) break;
      script = JSON.parse(wrapped[1]);
    }
    const binding = match ? JSON.parse(JSON.parse(match[1])) : null;
    if (binding?.jobId === 'control') {
      counts.probes++; durable(countsFile, counts);
      if (process.argv.includes('--unknown')) throw Object.assign(new Error('Offline lost physical acknowledgement'), { code: 'UNKNOWN_RPC' });
    }
    if (binding && file) {
      const local = JSON.parse(file[1]).replace(/^\\\\wsl\$\\[^\\]+/, '').replaceAll('\\', '/');
      durable(local, { ...binding, terminal: true, outcome: 'succeeded', instance: identity });
    }
    return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(identity) }] } }) };
  },
  async callTool(value) {
    const response = await this._post({ jsonrpc: '2.0', id: 'fake-probe', method: 'tools/call', params: { name: 'fusion_mcp_execute', arguments: value } });
    return { failed: false, text: JSON.parse(response.raw).result.content[0].text };
  } };
serve({ backend: 'mcp', timeoutMs: 2000 }, { dir, confirmOwnership: true,
  createBackend: () => physical, pollMs: 5, startPaused: process.argv.includes('--paused'),
}).then(broker => {
  counts.starts++; durable(countsFile, counts);
  process.send({ ready: true, buildHash: broker.buildHash });
}, error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
