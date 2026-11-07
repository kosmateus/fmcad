'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { serve } = require('../src/queue-broker');
const { request } = require('../src/queue-connection');
const { QueueState } = require('../src/queue-state');
const { readOwnedResult } = require('../src/queue-response-files');
const { readAcceptedInput } = require('../src/dist/node-adapters/persistence/accepted-inputs');

function fixture(t, cleanup = true) {
  const root = fs.mkdtempSync('/tmp/opencode/execution-integrated-');
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'queue'), project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.cad'), { recursive: true });
  return { root, dir, project };
}

test('broker large project RPC/provenance survive restart; foreign owner and symlink fail closed', async t => {
  const f = fixture(t, false); let sends = 0, broker;
  const identity = { pid: 99, birth: 'mock:99', version: 'mock', activeCommand: 'SelectCommand', documents: [], documentState: { status: 'metadata-only' } };
  const physical = { server: { timeoutMs: 3000 }, _parse: JSON.parse,
    async _post(payload) { sends++; return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { data: 'x'.repeat(1100 * 1024) } }) }; },
    async callTool() { return { failed: false, text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(identity) }; } };
  const start = () => serve({ backend: 'addin', timeoutMs: 3000 }, { dir: f.dir, confirmOwnership: true, createBackend: () => physical, pollMs: 5 });
  broker = await start();
  t.after(async () => { try { if (broker) await broker.close(); } finally { fs.rmSync(f.root, { recursive: true, force: true }); } });
  const auth = { clientId: 'owner', clientToken: 'secret-owner' }, foreign = { clientId: 'foreign', clientToken: 'secret-foreign' };
  await request(f.dir, { action: 'register', ...auth }); await request(f.dir, { action: 'register', ...foreign });
  const call = (action, values = {}) => request(f.dir, { action, auth, ...values });
  const source = path.join(f.project, 'source.py'); fs.writeFileSync(source, 'accepted-source\r\n');
  const input = { kind: 'rpc', requestId: randomUUID(), timeoutMs: 3000, cwd: f.project, payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    inputFiles: [{ path: source, sha256: createHash('sha256').update('accepted-source\r\n').digest('hex') }] };
  const job = await call('submit', { request: input });
  let result;
  for (let i = 0; i < 200; i++) {
    result = await call('result', { jobId: job.id });
    if (result.job.state === 'succeeded') break;
    assert.equal(['failed', 'needs_reconciliation'].includes(result.job.state), false, JSON.stringify(result.job));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.job.state, 'succeeded');
  assert.equal(result.outputs.rpc.artifact.storage, 'project');
  assert.equal(result.provenance.status, 'available');
  assert.deepEqual(JSON.parse(readAcceptedInput(f.dir, result.provenance.inputs[0]).bytes), input.payload);
  fs.writeFileSync(source, 'current-source');
  await broker.close(); broker = null;
  broker = await start();
  const after = await call('result', { jobId: job.id });
  assert.equal(readAcceptedInput(f.dir, after.provenance.inputs[1]).bytes.toString(), 'accepted-source\r\n');
  assert.deepEqual(after.outputs.rpc.artifact, result.outputs.rpc.artifact);
  const bytes = readOwnedResult(f.dir, { jobId: job.id, cwd: f.project }, after.outputs.rpc.artifact);
  assert.equal(JSON.parse(JSON.parse(bytes).raw).result.data.length, 1100 * 1024);
  await assert.rejects(request(f.dir, { action: 'result', auth: foreign, jobId: job.id }), /Only the submitting client/);
  const retried = await call('submit', { request: input }); assert.equal(retried.id, job.id); assert.equal(sends, 1);
  // Historical records without provenance must not capture today's input on retry.
  fs.rmSync(path.join(f.dir, 'admissions'), { recursive: true });
  assert.equal((await call('submit', { request: input })).id, job.id);
  assert.deepEqual((await call('result', { jobId: job.id })).provenance, { status: 'missing' });
  fs.unlinkSync(after.outputs.rpc.path); fs.symlinkSync('/etc/passwd', after.outputs.rpc.path);
  await assert.rejects(call('result', { jobId: job.id }), /ELOOP|symbolic|symlink/);
  assert.equal(sends, 1, 'artifact faults never replay execution');
});

test('integrated queue commit failure preserves unfinished receipt and blocks restart', t => {
  const f = fixture(t), state = new QueueState(f.dir);
  const job = state.submit({ clientId: 'owner', requestId: 'once', kind: 'rpc', timeoutMs: 1000, payload: {} });
  state.next();
  const receipt = path.join(f.dir, 'receipt.json'); fs.writeFileSync(receipt, '{"terminal":false}');
  const original = fs.renameSync;
  fs.renameSync = (...args) => {
    if (args[1] === state.file) throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' });
    return original(...args);
  };
  try { assert.throws(() => state.finish(job.id), { code: 'STORAGE_UNAVAILABLE' }); }
  finally { fs.renameSync = original; }
  assert.throws(() => state.status(job.id), { code: 'STORAGE_UNAVAILABLE' });
  assert.notEqual(state.data.jobs[job.id].state, 'succeeded');
  assert.throws(() => state.next(), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(receipt, 'utf8'), '{"terminal":false}');
  assert.throws(() => new QueueState(f.dir), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(JSON.parse(fs.readFileSync(state.file)).jobs[job.id].state, 'running');
});

test('version-1 unfinished snapshots restore unknown, corrupt/truncated/unknown versions never succeed', t => {
  const f = fixture(t), state = new QueueState(f.dir);
  const job = state.submit({ clientId: 'owner', requestId: 'once', kind: 'rpc', timeoutMs: 1000, payload: {} });
  state.next();
  const restored = new QueueState(f.dir);
  assert.equal(restored.status(job.id).state, 'needs_reconciliation'); assert.equal(restored.next(), null);
  const snapshot = JSON.parse(fs.readFileSync(state.file)); snapshot.version = 999;
  fs.writeFileSync(state.file, JSON.stringify(snapshot));
  assert.throws(() => new QueueState(f.dir), { code: 'CORRUPT_STATE' });
  fs.writeFileSync(state.file, '{"version":1');
  assert.throws(() => new QueueState(f.dir), { code: 'CORRUPT_STATE' });
});
