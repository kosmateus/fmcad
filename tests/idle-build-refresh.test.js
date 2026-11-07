'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueClient, refreshIdleBroker } = require('../src/queue-client');

function fixture(t, change = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrefresh-'));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const status = { features: { conditionalIdleStop: true }, buildHash: 'old', revision: 4, control: { instanceId: 'old-nonce', activeOperations: 0 }, jobs: {}, ...change };
  const client = Object.create(QueueClient.prototype);
  client.dir = dir;client.options = { cfg: { routing: 'queue', queue: { autoStart: true } } };
  client.register = async () => { calls.push('register');return client; };
  let submits = 0;
  client.call = async (action, value) => {
    calls.push(action);
    if (action === 'status') return status;
    if (action === 'stop') { assert.equal(value.onlyIfQuiescent, true);assert.equal(value.expectedBuildHash, 'old');return { stopping: true }; }
    if (action === 'submit') {
      submits++;
      if (submits === 1) throw Object.assign(new Error('not admitted'), { code: 'BUILD_CHANGED', notStarted: true });
      return { id: 'first-admission', state: 'preparing', requestId: value.request.requestId };
    }
  };
  return { client, calls, status };
}

test('an idle stale broker can reload before the original request is admitted exactly once', async t => {
  const f = fixture(t);
  const value = await f.client.submit({ kind: 'command', requestId: 'original-intent', argv: ['tools'], timeoutMs: 1000 });
  assert.equal(value.id, 'first-admission');assert.equal(value.requestId, 'original-intent');
  assert.deepEqual(f.calls, ['register', 'submit', 'status', 'stop', 'register', 'submit']);
});

test('reload never interrupts active, queued, processing, leased, or unknown work', async t => {
  for (const status of [{ active: 'a' }, { blocked: { id: 'a' } }, { held: 'unknown' }, { lease: { id: 'a' } },
    { jobs: { a: { state: 'queued' } } }, { jobs: { a: { state: 'processing' } } }, { control: { activeOperations: 1 } }]) {
    const f = fixture(t, status);
    await assert.rejects(refreshIdleBroker(f.client, { requestId: 'fresh' }), { code: 'BUILD_UPGRADE_BUSY' });
    assert.equal(f.calls.includes('stop'), false);
  }
});

test('an admitted request ID is never requeued and manual startup stays manual', async t => {
  const f = fixture(t, { jobs: { old: { requestId: 'existing', state: 'succeeded' } } });
  await assert.rejects(refreshIdleBroker(f.client, { requestId: 'existing' }), { code: 'REQUEST_ALREADY_ADMITTED' });
  assert.equal(f.calls.includes('stop'), false);
  const manual = fixture(t);manual.client.options.cfg.queue.autoStart = false;
  await assert.rejects(refreshIdleBroker(manual.client, { requestId: 'fresh' }), { code: 'BUILD_CHANGED' });
  assert.deepEqual(manual.calls, []);
});

test('transport loss is not converted to automatic resubmission', async t => {
  const f = fixture(t);let sent = 0;
  f.client.call = async () => { sent++;throw Object.assign(new Error('response lost'), { code: 'QUEUE_IPC_TIMEOUT' }); };
  await assert.rejects(f.client.submit({ kind: 'command', requestId: 'uncertain', argv: ['tools'], timeoutMs: 1000 }), { code: 'QUEUE_IPC_TIMEOUT' });
  assert.equal(sent, 1);
});
