// Read-only smoke test of the exact stdio entry point used by OpenCode.
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const broker = require('./helpers/live-broker');
const liveContext = broker.context();
const discoveryOnly = process.argv.includes('--discovery-only');
const help = spawnSync(process.execPath, [path.join(__dirname, '../bin/fmcad-mcp.js'), '--help'], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
});
assert.equal(help.status, 0, help.stderr || help.stdout || help.error?.message);
assert.match(help.stdout, /Usage: fmcad-mcp/);
const child = spawn(process.execPath, [path.join(__dirname, '../bin/fmcad-mcp.js'),
  '--routing', 'queue', '--client', liveContext.clientId],
  { stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
let nextId = 1;
let errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
readline.createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  const pending = waiting.get(message.id);
  if (pending) {
    waiting.delete(message.id);
    clearTimeout(pending.timer);
    message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('MCP smoke timeout: ' + errors)); }, 20000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function main() {
  try {
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'fmcad-stdio-smoke', version: '1.0' } });
    assert.equal(init.serverInfo.name, 'fmcad');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request('tools/list', {});
    assert.ok(tools.tools.some(tool => tool.name === 'execute_python'));
    assert.ok(tools.tools.some(tool => tool.name === 'fmcad_execute'));
    if (discoveryOnly) {
      console.log(JSON.stringify({ server: init.serverInfo, tools: tools.tools.length, fusionCall: 'not-run' }));
      return;
    }
    let result = await request('tools/call', { name: 'execute_python', arguments: {
      code: 'print("FUSION_ADDIN_STDIO_OK")', persistent: false,
    } });
    const accepted = result.structuredContent;
    if (liveContext && ['QUEUED', 'ACCEPTED'].includes(accepted?.status)) {
      for (;;) {
        const receipt = await request('tools/call', { name: 'fmcad_queue_result', arguments: { jobId: accepted.jobId } });
        const value = receipt.structuredContent;
        if (['succeeded', 'failed'].includes(value?.job?.state)) {
          assert.ok(value.rpc?.raw, 'Missing owned RPC result; inspect job ' + accepted.jobId);
          const message = JSON.parse(value.rpc.raw);
          assert.equal(message.error, undefined, JSON.stringify(message.error));
          result = message.result;
          break;
        }
        assert.ok(['queued', 'running', 'sending', 'preparing', 'ready', 'processing'].includes(value?.job?.state),
          'Unresolved job; inspect without resubmission: ' + accepted.jobId);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(payload.success, true);
    assert.equal(payload.stdout.trim(), 'FUSION_ADDIN_STDIO_OK');
    console.log(JSON.stringify({ server: init.serverInfo, tools: tools.tools.length, scriptOutput: payload.stdout.trim(), modelModified: false }));
  } finally {
    child.stdin.end();
    child.kill();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
