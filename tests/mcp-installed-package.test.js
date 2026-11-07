'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const execute = (id, operation, data = {}, context = {}, meta) => request(id, 'tools/call', {
  name: 'fmcad_execute', arguments: { operation, data, context }, ...(meta ? { _meta: { fmcad: meta } } : {}),
});

function installedClient(t, executable, directory) {
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory,
    FMCAD_CONFIG: path.join(directory, 'config.json'), FMCAD_BACKEND: 'addin', FMCAD_ROUTING: 'queue',
    FMCAD_PROJECT_DIRECTORY: directory };
  delete env.NODE_PATH;
  const child = spawn(executable, [], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
  });
  return {
    async request(value) {
      child.stdin.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
      const line = await lines.next();
      assert.equal(line.done, false, diagnostics);
      return JSON.parse(line.value);
    },
    notify(value) { child.stdin.write(JSON.stringify(value) + '\n'); },
    async close() {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], diagnostics);
      assert.equal((await lines.next()).done, true);
      assert.equal(diagnostics, '');
    },
  };
}

test('installed npm tarball resolves its declared runtime dependencies without checkout or NODE_PATH', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/opencode/mcp-installed-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd: root, encoding: 'utf8',
  }));
  const isolatedEnv = { ...process.env };
  delete isolatedEnv.NODE_PATH;
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', directory, path.join(directory, packed[0].filename)], { cwd: directory, env: isolatedEnv });
  const installed = path.join(directory, 'node_modules/fmcad');

  // These inputs would make accidental application configuration discovery fail.
  fs.writeFileSync(path.join(directory, 'config.json'), '{ INVALID standalone configuration');
  fs.writeFileSync(path.join(directory, 'opencode.json'), '{ INVALID OpenCode configuration');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const installedBin = path.join(directory, 'node_modules/.bin/fmcad-mcp');
  assert(fs.existsSync(installedBin), 'npm must create the installed MCP executable link');
  assert(require.resolve('terminal-kit', { paths: [installed] }));
  assert(require.resolve('jsonc-parser', { paths: [installed] }));

  const client = installedClient(t, installedBin, directory);
  const initialized = await client.request(request(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }));
  assert.equal(initialized.id, 0);
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  client.notify({ jsonrpc: '2.0', method: 'tools/call', params: {
    name: 'execute_python', arguments: { code: 'raise Exception()', persistent: false },
  } });
  const tools = await client.request(request('catalog', 'tools/list'));
  for (const name of ['fmcad_execute', 'fmcad_help', 'fmcad_queue_begin', 'fmcad_cad_entity_list'])
    assert(tools.result.tools.some(tool => tool.name === name), name);
  for (const name of ['fmcad_cad_measure_baseline_capture', 'fmcad_cad_measure_baseline_inspect', 'fmcad_cad_measure_baseline_compare'])
    assert(tools.result.tools.some(tool => tool.name === name), name);
  assert(tools.result.tools.find(tool => tool.name === 'execute_python').annotations.deprecated);
  assert.deepEqual(Object.fromEntries(Object.entries(tools.result.tools.find(tool => tool.name === 'fmcad_execute').inputSchema.properties.context.properties)
    .filter(([key]) => key !== 'projectDirectory')),
    Object.fromEntries(Object.entries(tools.result.tools.find(tool => tool.name.startsWith('fmcad_cad_')).inputSchema.properties)
      .filter(([key]) => key !== 'data')));
  assert(!tools.result.tools.some(tool => tool.name === 'fmcad_cad_document_save_native'));
  const help = await client.request(request('help', 'tools/call', {
    name: 'fmcad_help', arguments: { operation: 'entity.list' },
  }));
  assert.equal(help.result.structuredContent.operations[0].operation, 'entity.list');
  const project = path.join(directory, 'baseline-project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.cad'));
  const missingBaseline = await client.request(execute('baseline-integrity', 'measure.baseline.inspect', {
    baseline: {
      version: 1,
      scope: 'durable',
      owner: createHash('sha256').update(fs.realpathSync(project)).digest('hex'),
      id: 'missing-baseline',
      sha256: '0'.repeat(64),
    },
  }, {}, { projectDirectory: project }));
  assert.equal(missingBaseline.error, undefined, JSON.stringify(missingBaseline));
  assert.equal(missingBaseline.result.isError, false);
  assert.equal(missingBaseline.result.structuredContent.operation, 'measure.baseline.inspect');
  assert.equal(missingBaseline.result.structuredContent.result.status, 'missing');
  const local = await client.request(execute('local', 'entity.list', {}, { doc: 'Model', preview: true }));
  assert.equal(local.result.structuredContent.state, 'input-validated-only');
  const cliEnv = { ...isolatedEnv, FMCAD_CONFIG: path.join(directory, 'config.json') };
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(installed, manifest.bin.fmcad),
    'cad', 'entity', 'list', '--doc', 'Model', '--preview', '--json'], {
    cwd: directory, encoding: 'utf8', env: cliEnv,
  }));
  assert.deepEqual(local.result.structuredContent, cli);
  for (const message of [
    execute('unknown-field', 'entity.list', { nonexistent: true }, { doc: 'Model' }),
    request('shell', 'tools/call', { name: 'fmcad_execute', arguments: { command: 'touch /never' } }),
    execute('pin', 'entity.list', {}, { doc: 'Model', docId: 'with whitespace' }),
    execute('purpose', 'entity.list', {}, { doc: 'Model', purpose: 'A' }, { description: 'B' }),
    request('legacy', 'tools/call', { name: 'execute_python', arguments: { code: 'print(1)' } }),
  ]) assert.equal((await client.request(message)).error.code, -32602);
  assert.equal((await client.request(request('read', 'resources/read', { uri: 'file:///private' }))).error.code, -32601);
  assert.equal((await client.request(request('prompt', 'prompts/get', { name: 'unimplemented' }))).error.code, -32601);
  assert.equal((await client.request('{broken')).error.code, -32700);
  assert.equal((await client.request({ jsonrpc: '2.0', id: false, method: 'ping' })).error.code, -32600);

  // The poisoned config is only relevant to SDK work, not startup/discovery.
  fs.unlinkSync(path.join(directory, 'config.json'));
  const absent = await client.request(execute('absent', 'entity.list', {}, { doc: 'Model' }));
  assert.equal(absent.error.code, -32000);
  assert.match(absent.error.message, /FMCAD_BROKER_UNAVAILABLE/);
  assert.deepEqual((await client.request(request('after', 'ping'))).result, {});
  await client.close();
  assert(!fs.existsSync(path.join(directory, 'node_modules/@opencode-ai')));
  assert(!fs.existsSync(path.join(directory, 'fmcad/queue/broker.lock')));
});
