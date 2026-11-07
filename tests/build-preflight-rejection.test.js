'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { request } = require('../src/queue-connection');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a local build mismatch before sending preflight is terminal not_started, never a false unknown hold', async t => {
  const parent = path.join(__dirname, '..', '.test-artifacts');fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, 'build-guard-'));
  const runtime = path.join(work, 'runtime');fs.mkdirSync(runtime);
  for (const file of ['package.json', 'src', 'assets', 'bin', 'runtime']) fs.cpSync(path.join(__dirname, '..', file), path.join(runtime, file), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlocal-'));
  let probes = 0, sdk = 0;
  const instance = { pid: 123, birth: 'mock:123', version: 'mock', activeCommand: 'SelectCommand', documents: [] };
  const physical = { server: { timeoutMs: 5000 }, _parse: JSON.parse,
    async _post() { sdk++;throw Error('No SDK operation may be dispatched'); },
    async callTool() { probes++;return { failed: false, text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(instance) }; } };
  const { serve } = require(path.join(runtime, 'src/queue-broker'));
  const broker = await serve({ backend: 'mcp', timeoutMs: 5000 }, { dir, confirmOwnership: true, createBackend: () => physical, pollMs: 3000 });
  t.after(async () => { await broker.close();fs.rmSync(dir, { recursive: true, force: true });fs.rmSync(work, { recursive: true, force: true }); });
  const auth = { clientId: 'a', clientToken: 'secret-a' };await request(dir, { action: 'register', ...auth });
  const script = path.join(dir, 'operation.py');fs.writeFileSync(script, 'def run(context): pass\n');
  const job = await request(dir, { action: 'submit', auth, request: { kind: 'command', requestId: randomUUID(), argv: ['run', script],
    cwd: dir, timeoutMs: 5000, inputFiles: [{ path: script, sha256: createHash('sha256').update(fs.readFileSync(script)).digest('hex') }] } });
  const read = () => request(dir, { action: 'result', auth, jobId: job.id });
  let ready = false;
  for (let i = 0; i < 200; i++) { if ((await read()).job.state === 'queued') { ready = true;break; }await sleep(10); }
  assert.equal(ready, true, 'Worker finished preparation before the first scheduler turn');
  fs.appendFileSync(path.join(runtime, 'src/help.js'), '\n// Controlled local build change; no product files.\n');
  let result;
  for (let i = 0; i < 300; i++) { result = await read();if (result.job.state === 'failed') break;await sleep(10); }
  assert.equal(result.job.state, 'failed');assert.equal(result.job.code, 'BUILD_CHANGED_BEFORE_EXECUTION');
  assert.equal(result.job.executionOutcome, 'not_started');assert.equal(result.job.mayHaveMutated, false);
  assert.equal(broker.status().blocked, null);assert.equal(broker.status().lease, null);
  assert.equal(probes, 1, 'Only the startup probe was sent; preflight never entered the SDK');assert.equal(sdk, 0);
});

test('a build change after fully receipted idle SDK completion does not invent an unknown postflight call', async t => {
  const parent = path.join(__dirname, '..', '.test-artifacts');fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, 'post-build-')), runtime = path.join(work, 'runtime');fs.mkdirSync(runtime);
  for (const file of ['package.json', 'src', 'assets', 'bin', 'runtime']) fs.cpSync(path.join(__dirname, '..', file), path.join(runtime, file), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpost-'));
  const qi = require(path.join(runtime, 'src/queue-instance'));let probes = 0, sdk = 0, lastScript;
  const identity = { pid: 123, birth: 'mock:123', version: 'mock', activeCommand: 'SelectCommand', documents: [] };
  const physical = { server: { timeoutMs: 5000 }, _parse: JSON.parse,
    async _post(payload) {
      sdk++;const script = payload.params.arguments.object.script;lastScript = script;
      const binding = JSON.parse(JSON.parse(script.match(/_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/)[1]));
      const receipt = JSON.parse(script.match(/_qr_path = ("(?:\\.|[^"\\])*")/)[1]).replace(/^\\\\wsl\$\\[^\\]+/, '').replaceAll('\\', '/');
      qi.durable(receipt, { ...binding, terminal: true, outcome: 'succeeded', instance: identity });
      fs.appendFileSync(path.join(runtime, 'src/help.js'), '\n// controlled change after SDK receipt\n');
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'done' }] } }) };
    },
    async callTool(value) {
      if (value.object.script.includes('FMCAD_QUEUE_INSTANCE')) { probes++;return { failed: false, text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(identity) }; }
      const response = await this._post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fusion_mcp_execute', arguments: value } });
      return { failed: false, text: JSON.parse(response.raw).result.content[0].text };
    } };
  const broker = await require(path.join(runtime, 'src/queue-broker')).serve({ backend: 'mcp', timeoutMs: 5000 }, { dir, confirmOwnership: true, createBackend: () => physical, pollMs: 5 });
  t.after(async () => { await broker.close();fs.rmSync(dir, { recursive: true, force: true });fs.rmSync(work, { recursive: true, force: true }); });
  const auth = { clientId: 'a', clientToken: 'private-a' };await request(dir, { action: 'register', ...auth });
  const file = path.join(dir, 'operation.py');fs.writeFileSync(file, 'def run(context): pass\n');
  const job = await request(dir, { action: 'submit', auth, request: { kind: 'command', requestId: randomUUID(), argv: ['run', file], cwd: dir, timeoutMs: 5000,
    inputFiles: [{ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] } });
  let result;
  for (let i = 0; i < 500; i++) { result = await request(dir, { action: 'result', auth, jobId: job.id });if (result.job.state === 'failed') break;await sleep(10); }
  assert.equal(result.job.code, 'SDK_COMPLETE_BUILD_CHANGED');assert.equal(result.execution.sdkSettled, true);
  assert.equal(result.execution.postflightSubmitted, false);assert.equal(result.job.mayHaveMutated, true);
  assert.equal(broker.status().blocked, null);assert.equal(broker.status().lease, null);assert.equal(sdk, 1);assert.equal(probes, 2);
  const jobDir = path.join(dir, 'jobs', job.id);
  const rpcFile = fs.readdirSync(jobDir).find(name => /^rpc-.*\.json$/.test(name));
  const record = qi.readJson(path.join(jobDir, rpcFile));
  assert.equal(record.pythonArtifact.sha256, createHash('sha256').update(lastScript).digest('hex'));
  assert.match(record.binding.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(record.remoteReceipt.sourceHash, record.binding.sourceHash);
  assert.ok(record.pythonArtifact.units.some(unit => unit.filename === '<fmcad-queue>'));
  assert.ok(record.pythonArtifact.units.some(unit => unit.filename === '<fmcad-wire>'));
});
