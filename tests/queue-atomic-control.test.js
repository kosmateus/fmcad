'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeAtomic } = require('../src/queue-atomic-control');
const { queueCommand } = require('../src/queue-cli');

test('owner CLI refuses legacy brokers and build drift without submitting a job', async () => {
  for (const [status, code] of [
    [{ control: { buildHash: 'approved' } }, 'ATOMIC_OBSERVATION_UNSUPPORTED'],
    [{ features: { atomicWorkflowObserve: true }, control: { buildHash: 'old-build' } }, 'BUILD_CHANGED'],
  ]) {
    const calls = [];
    await assert.rejects(observeAtomic({ async call(action) { calls.push(action); return status; } },
      { jobId: 'holder', requestId: 'stable', buildHash: 'approved' }), { code });
    assert.deepEqual(calls, ['queue-summary']);
  }
});

test('owner CLI forwards the complete fence once without an identity override or raw argv', async () => {
  const calls = [];
  const control = { instanceId: 'owner-instance', buildHash: 'approved', generation: 24, contextEpoch: 12 };
  const job = { id: 'observer' };
  const value = await observeAtomic({ async call(action, data) {
    calls.push({ action, data });
    return action === 'queue-summary' ? { control, features: { atomicWorkflowObserve: true } } : job;
  } }, { jobId: 'holder', requestId: 'stable', buildHash: 'approved' });
  assert.equal(value, job);
  assert.deepEqual(calls[1], { action: 'observe-atomic', data: { jobId: 'holder', requestId: 'stable', control } });
  assert.equal(calls.length, 2);
});

test('lost owner-control acknowledgement is never retried automatically', async () => {
  let sends = 0;
  await assert.rejects(observeAtomic({ async call(action) {
    if (action === 'queue-summary') return { features: { atomicWorkflowObserve: true },
      control: { buildHash: 'approved', instanceId: 'owner', generation: 24, contextEpoch: 12 } };
    sends++;
    throw Object.assign(new Error('lost ACK'), { code: 'QUEUE_IPC_TIMEOUT' });
  } }, { jobId: 'holder', requestId: 'stable', buildHash: 'approved' }), { code: 'QUEUE_IPC_TIMEOUT' });
  assert.equal(sends, 1);
});

test('owner CLI rejects missing stable identity and client/payload overrides before configuration', async () => {
  for (const argv of [[], ['--job', 'holder'], ['--job', 'holder', '--request-id', 'stable', '--client', 'foreign'],
    ['--job', 'holder', '--request-id', 'stable', '--accept-outcome', 'aborted']]) {
    await assert.rejects(queueCommand(['observe-atomic', ...argv], {
      loadConfig() { assert.fail('invalid input must not read configuration or credentials'); },
    }), /observe-atomic requires/);
  }
});

test('migration CLI requires exact explicit consent and rejects client/payload overrides before configuration', async () => {
  for (const argv of [[], ['--job', 'holder', '--request-id', 'migration', '--migration-approval', '/approved.json'],
    ['--job', 'holder', '--request-id', 'migration', '--migration-approval', '/approved.json', '--preflight', 'true', '--client', 'foreign'],
    ['--job', 'holder', '--request-id', 'migration', '--migration-approval', '/approved.json', '--preflight', 'false']]) {
    await assert.rejects(queueCommand(['migrate-atomic', ...argv], {
      loadConfig() { assert.fail('invalid migration input must not read credentials/configuration'); },
    }), /migrate-atomic requires/);
  }
  await assert.rejects(queueCommand(['pause', '--preflight', 'true'], {
    loadConfig() { assert.fail('a migration-only flag must not silently execute an ordinary pause'); },
  }), /available only for queue migrate-atomic/);
});

test('owner-only CLI credential loading never creates a new identity when credentials are missing', t => {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync('/tmp/opencode/migration-existing-credentials-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = require('node:path').resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');
    const {QueueClient}=require(${JSON.stringify(root + '/src/queue-client')});
    assert.throws(()=>new QueueClient('missing-owner',{existingCredentialsOnly:true}),{code:'ENOENT'});
  `], { env: { ...process.env, XDG_STATE_HOME: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dir), [], 'owner-only admission must not mint a credential or client directory');
});

test('typed observer control preserves retained owner, exact fence and derived request behavior', () => {
  const old = require('./fixtures/historical-module.cjs')(
    '330849f22302bcf0ee955cd1945ddb2040eff8c7', 'src/queue-atomic-control.js');
  const current = require('../src/queue-atomic-control');
  const scope = { jobId: 'holder', requestId: 'original', projectDirectory: '/owned/project', reportPath: '/owned/report',
    commandId: 'fmcad_atomic_' + 'a'.repeat(32), sessionNonce: 'b'.repeat(32), docId: 'owned-doc' };
  const target = { id: 'holder', requestId: 'original', clientId: 'owner', kind: 'command', state: 'needs_reconciliation',
    physicalTurns: 1, dispatch: { rpcCount: 1 }, request: { backend: 'addin', buildHash: 'original-build', cwd: scope.projectDirectory,
      payload: { version: 1, kind: 'cad', operation: 'batch.run', doc: 'Owned model', docId: scope.docId,
        data: { atomic: true, runId: 'owned-run', reportPath: scope.reportPath } } } };
  const control = { instanceId: 'broker-owner', buildHash: 'observer-build', generation: 3, contextEpoch: 4 };
  const message = { jobId: target.id, requestId: 'observe-once', control };
  const invoke = (api, m = message, t = target) => api.observationRequest(m, 'owner', t, control, scope);
  assert.deepEqual(invoke(current), invoke(old));
  for (const mutate of [
    (m, t) => { m.payload = {}; }, (m, t) => { m.control.generation++; },
    (m, t) => { m.control.extra = true; }, (m, t) => { m.control.buildHash = 'foreign'; },
    (m, t) => { t.clientId = 'foreign'; }, (m, t) => { t.state = 'succeeded'; },
    (m, t) => { t.request.payload.docId = 'foreign'; },
  ]) {
    const results = [];
    for (const api of [old, current]) {
      const m = structuredClone(message), t = structuredClone(target); mutate(m, t);
      assert.throws(() => invoke(api, m, t), error => { results.push({ code: error.code, message: error.message }); return true; });
    }
    assert.deepEqual(results[1], results[0]);
  }
});
