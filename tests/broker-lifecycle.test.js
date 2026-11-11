'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { request, queueDirectory, queueSocket } = require('../src/queue-connection');
const { readJson, durable, processBirth, reclaim } = require('../src/queue-instance');
const { reclaimStart, ensureBroker } = require('../src/queue-autostart');
const { stopBroker, restoreBroker, ownsPersistedResetPause } = require('../src/fusion-reset');
const { createBrokerControl } = require('../src/dist/core/application/broker-control');
const { createBrokerControlPort } = require('../src/dist/node-adapters/broker-ipc/control');
const auth = { clientId: 'offline-owner', clientToken: 'private-offline' };

async function fixture(t, flags = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-lc-'));
  const children = [];
  async function start(extra = flags) {
    const production = flags.includes('--production');
    const child = fork(path.join(__dirname, 'fixtures', production ? 'lifecycle-production.cjs' : 'lifecycle-process.cjs'), [dir, ...extra], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr || 'offline child exited before ready'); })]);
    assert.equal(ready[0].ready, true);
    if (production) await request(dir, { action: 'register', ...auth });
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const child = await start();
  // Production fake probes run real local admission/receipt preparation; keep
  // their harness deadline above the old one-second false timeout only there.
  const callTimeoutMs = flags.includes('--production') ? 5000 : 1000;
  const call = (action, rest = {}) => request(dir, { action, auth, ...rest }, { timeoutMs: callTimeoutMs });
  const fence = async () => {
    const current = await call('control-status');
    return { requestId: randomUUID(), instanceId: current.instanceId, expectedGeneration: current.generation };
  };
  return { dir, child, start, call, fence };
}

test('production dispatcher advertises working actions and persists paused distinct reload identity', async t => {
  const f = await fixture(t, ['--production', '--paused']);
  const initial = await f.call('control-status');
  assert.equal(initial.phase, 'PAUSED'); assert.equal(initial.capabilities.inspect, true);
  assert.match(initial.buildHash, /^[a-f0-9]{64}$/);
  const inspected = await f.call('console-inspect', { control: await f.fence() });
  assert.equal(inspected.instance.pid, 42);
  assert.equal((await f.call('control-status')).phase, 'PAUSED');
  const resumed = await f.call('resume', { control: await f.fence() });
  assert.equal(resumed.phase, 'RUNNING');
  await f.call('drain', { control: await f.fence() });
  const control = await f.fence();
  const exited = once(f.child, 'exit');
  const ack = await f.call('console-reload', { control });
  await exited;
  assert.equal(readJson(ack.releaseFile).outcome, 'released');
  await f.start(['--paused']);
  const after = await f.call('control-status');
  assert.notEqual(after.instanceId, initial.instanceId);
  assert.equal(after.buildHash, initial.buildHash);
  assert.equal(after.phase, 'PAUSED'); assert.equal(after.activeOperations, 0);
  await assert.rejects(f.call('resume', { control }), { code: 'INSTANCE_CHANGED' });
});

test('production unresolved inspection refuses stop/reload and duplicate requests never dispatch again', async t => {
  const f = await fixture(t, ['--production', '--unknown']);
  const control = await f.fence();
  await assert.rejects(f.call('console-inspect', { control }));
  await assert.rejects(f.call('console-inspect', { control }));
  const status = await f.call('control-status');
  assert.equal(status.phase, 'RECOVERY_BLOCKED');
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
  for (const action of ['console-stop', 'console-reload'])
    await assert.rejects(f.call(action, { control: await f.fence() }), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
  const saved = readJson(path.join(f.dir, 'queue-state.json'));
  const exited = once(f.child, 'exit'); f.child.kill('SIGTERM'); await exited;
  reclaim(f.dir);
  assert.deepEqual(readJson(path.join(f.dir, 'queue-state.json')), saved);
  await f.start(['--unknown']);
  const restored = await f.call('control-status');
  assert.equal(restored.phase, 'RECOVERY_BLOCKED');
  assert.notEqual(restored.instanceId, status.instanceId);
  await assert.rejects(f.call('console-inspect', { control: await f.fence() }));
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
});

test('production IPC client disconnect loses ACK but original inspect receipt prevents replay', async t => {
  const f = await fixture(t, ['--production', '--paused']);
  const control = await f.fence();
  const socket = net.createConnection(queueSocket(f.dir));
  await once(socket, 'connect');
  await new Promise((resolve, reject) => socket.write(JSON.stringify({ action: 'console-inspect', auth, control }) + '\n', error => error ? reject(error) : resolve()));
  socket.destroy();
  const receipt = path.join(f.dir, 'console-admin-' + createHash('sha256').update(control.requestId).digest('hex') + '.json');
  // The production fake still runs local Python admission before its synthetic
  // receipt is written; observe that owned intent without changing its deadline.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(receipt) && readJson(receipt).status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(readJson(receipt).status, 'completed');
  assert.equal((await f.call('console-inspect', { control })).requestId, control.requestId);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
});

test('isolated dispatcher enforces capabilities, mandatory fences, generation and explicit resume', async t => {
  const f = await fixture(t, ['--paused']);
  const before = await f.call('control-status');
  assert.equal(before.phase, 'PAUSED'); assert.equal(before.buildHash, 'fake-build');
  for (const action of ['inspect', 'pause', 'drain', 'resume', 'stop', 'reload', 'restart']) assert.equal(before.capabilities[action], true);
  assert.equal(before.capabilities.reset, false); assert.equal(before.capabilities.start, false);
  await assert.rejects(f.call('resume'), { code: 'INVALID_REQUEST' });
  const old = await f.fence();
  const resumed = await f.call('resume', { control: old });
  assert.equal(resumed.phase, 'RUNNING');
  await assert.rejects(f.call('pause', { control: { ...old, requestId: randomUUID() } }), { code: 'STATE_CONFLICT' });
  const drained = await f.call('drain', { control: await f.fence() });
  assert.equal(drained.phase, 'PAUSED'); assert.equal(drained.gateClosed, true);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
});

test('shared application and Node adapter use real IPC without retry and keep local reset separate', async t => {
  const f = await fixture(t);
  let sends = 0, resets = 0;
  const client = { call: (action, values) => { sends++; return f.call(action, values); } };
  const port = createBrokerControlPort(client);
  const service = createBrokerControl(port);
  await service.execute('pause', await f.fence());
  assert.equal((await service.read()).phase, 'PAUSED');
  const current = await f.fence();
  const before = sends;
  await assert.rejects(service.execute('resume', { ...current, expectedGeneration: current.expectedGeneration + 1 }), { code: 'STATE_CONFLICT' });
  assert.equal(sends, before + 1, 'Only the fresh read occurs; no mutation is sent');
  await assert.rejects(service.execute('reset', current), { code: 'UNSUPPORTED_BROKER' });
  const explicit = createBrokerControl(createBrokerControlPort(client, { reset: async fence => { resets++; return fence; } }));
  assert.deepEqual(await explicit.execute('reset', current), current);
  assert.equal(resets, 1);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 0);
});

test('lost administrative ACK reads original receipt, never replays probe', async t => {
  const f = await fixture(t);
  const control = await f.fence();
  await assert.rejects(f.call('console-inspect', { control, dropAck: true }));
  const original = await f.call('console-inspect', { control });
  assert.equal(original.requestId, control.requestId);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
  await assert.rejects(f.call('console-reload', { control }), { code: 'REQUEST_CONFLICT' });
});

test('lost resume ACK and duplicate drain cannot alias other actions or clients', async t => {
  const f = await fixture(t, ['--paused']);
  const control = await f.fence();
  await assert.rejects(f.call('resume', { control, dropAck: true }));
  const result = await f.call('resume', { control });
  assert.equal(result.phase, 'RUNNING');
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
  await assert.rejects(f.call('drain', { control }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(request(f.dir, { action: 'resume', auth: { ...auth, clientId: 'other-owner' }, control }), { code: 'REQUEST_CONFLICT' });
});

test('failed resume retains its original no-replay intent across duplicate requests', async t => {
  const f = await fixture(t, ['--paused', '--unknown']);
  const control = await f.fence();
  await assert.rejects(f.call('resume', { control }), { code: 'UNKNOWN_RPC' });
  await assert.rejects(f.call('resume', { control }), { code: 'REQUEST_PENDING' });
  assert.equal((await f.call('control-status')).phase, 'RECOVERY_BLOCKED');
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
});

test('unknown inspection keeps durable pause and refuses reload without replay', async t => {
  const f = await fixture(t, ['--unknown']);
  const control = await f.fence();
  await assert.rejects(f.call('console-inspect', { control }), { code: 'UNKNOWN_RPC' });
  await assert.rejects(f.call('console-inspect', { control }), { code: 'UNKNOWN_RPC' });
  assert.equal((await f.call('control-status')).phase, 'RECOVERY_BLOCKED');
  await assert.rejects(f.call('console-reload', { control: await f.fence() }), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).closes, 0);
  const saved = readJson(path.join(f.dir, 'queue-state.json'));
  const exited = once(f.child, 'exit'); f.child.kill('SIGTERM'); await exited;
  assert.equal(reclaim(f.dir).reconciliationRequired, true);
  assert.deepEqual(readJson(path.join(f.dir, 'queue-state.json')), saved);
  await f.start([]);
  assert.equal((await f.call('control-status')).phase, 'RECOVERY_BLOCKED');
  await assert.rejects(f.call('console-reload', { control: await f.fence() }), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(f.call('resume', { control: await f.fence() }), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 1);
});

test('idle reload publishes release and replacement confirms distinct paused identity', async t => {
  const f = await fixture(t);
  const control = await f.fence();
  const exited = once(f.child, 'exit');
  const ack = await f.call('console-reload', { control });
  await exited;
  assert.equal(readJson(ack.releaseFile).outcome, 'released');
  assert.equal(fs.existsSync(path.join(f.dir, 'broker.lock')), false);
  await f.start(['--paused']);
  const after = await f.call('control-status');
  assert.notEqual(after.instanceId, control.instanceId);
  assert.equal(after.phase, 'PAUSED'); assert.equal(after.buildHash, 'fake-build');
  await assert.rejects(f.call('resume', { control }), { code: 'INSTANCE_CHANGED' });
});

test('reset pause conflict cannot resume foreign generation over real dispatcher IPC', async t => {
  const f = await fixture(t, ['--production']);
  const status = await f.call('status');
  await f.call('pause', { control: await f.fence() });
  const foreign = await f.call('control-status');
  const marker = { buildHash: status.buildHash, resetPause: null };
  const client = { dir: f.dir, call: f.call };
  await assert.rejects(stopBroker(client, marker, status), { code: 'STATE_CONFLICT' });
  await restoreBroker(client, {}, marker);
  assert.deepEqual(await f.call('control-status'), foreign);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 0);
  assert.equal(ownsPersistedResetPause({ resetPause: true }, readJson(path.join(f.dir, 'queue-state.json'))), false);
});

test('production reset restoration resumes only its confirmed instance and generation', async t => {
  const f = await fixture(t, ['--production']);
  const control = await f.fence();
  const paused = await f.call('pause', { control });
  const marker = { protocol: 1, pid: process.pid, birth: processBirth(), buildHash: paused.buildHash, nonce: randomUUID(),
    resetPause: { requestId: control.requestId, instanceId: paused.instanceId, generation: paused.generation } };
  durable(path.join(f.dir, 'fusion-reset.lock'), marker, true);
  const client = { dir: f.dir, call: f.call };
  assert.equal(ownsPersistedResetPause(marker, readJson(path.join(f.dir, 'queue-state.json'))), true);
  await assert.rejects(f.call('resume', {
    control: { requestId: randomUUID(), instanceId: paused.instanceId, expectedGeneration: paused.generation },
  }), { code: 'FUSION_RESET_IN_PROGRESS' });
  await assert.rejects(f.call('resume', {
    control: { requestId: randomUUID(), instanceId: paused.instanceId, expectedGeneration: paused.generation },
    resetOwnerNonce: randomUUID(),
  }), { code: 'FUSION_RESET_IN_PROGRESS' });
  const foreignAuth = { clientId: 'other-offline-owner', clientToken: 'other-private-offline' };
  await request(f.dir, { action: 'register', ...foreignAuth });
  await assert.rejects(request(f.dir, {
    action: 'resume', auth: foreignAuth,
    control: { requestId: randomUUID(), instanceId: paused.instanceId, expectedGeneration: paused.generation },
    resetOwnerNonce: marker.nonce,
  }), { code: 'RESET_PAUSE_UNOWNED' });
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, 0);
  const restored = await restoreBroker(client, {}, marker);
  assert.equal(restored.control.phase, 'RUNNING');
  await f.call('pause', { control: await f.fence() });
  const foreign = await f.call('control-status');
  const probes = readJson(path.join(f.dir, 'counts.json')).probes;
  await assert.rejects(restoreBroker(client, {}, marker), { code: 'RESET_PAUSE_UNOWNED' });
  assert.deepEqual(await f.call('control-status'), foreign);
  assert.equal(readJson(path.join(f.dir, 'counts.json')).probes, probes);
});

test('startup recovery distinguishes exited owner, live owner and reused PID birth', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-lc-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'autostart'));
  const child = fork(path.join(__dirname, 'fixtures/lifecycle-process.cjs'), [dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  const owner = readJson(path.join(dir, 'broker.lock'));
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  // This fixture owns the exact dead marker. Autostart reclaim must still
  // refuse it while broker ownership is present; no broad lock deletion.
  await assert.rejects(async () => reclaimStart(dir), { code: 'BROKER_MARKER_PRESENT' });
  fs.unlinkSync(path.join(dir, 'broker.lock'));
  const claim = { nonce: randomUUID(), pid: owner.pid, birth: owner.birth };
  durable(path.join(dir, 'autostart.lock'), claim, true);
  assert.equal(reclaimStart(dir).reclaimedStartup, true);
  durable(path.join(dir, 'autostart.lock'), { nonce: randomUUID(), pid: process.pid, birth: processBirth() }, true);
  assert.throws(() => reclaimStart(dir), { code: 'STARTER_ALIVE' });
  const live = readJson(path.join(dir, 'autostart.lock'));
  durable(path.join(dir, 'autostart.lock'), { ...live, birth: 'stale-birth-not-current-pid' });
  assert.equal(reclaimStart(dir).reclaimedStartup, true);
});

test('exclusive explicit startup refuses every existing marker without reclaim or spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-lc-exclusive-'));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  t.after(() => {
    if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = queueDirectory(); fs.mkdirSync(dir, { recursive: true });
  for (const name of ['broker.lock', 'autostart.lock', 'recovery.lock']) {
    const file = path.join(dir, name);
    const marker = { pid: process.pid, birth: 'stale-pid-birth', nonce: randomUUID() };
    durable(file, marker, true);
    await assert.rejects(ensureBroker({ routing: 'queue', queue: { exclusiveStart: true, startupTimeoutMs: 100 } }, auth), { code: 'OWNERSHIP_CONFLICT' });
    assert.deepEqual(readJson(file), marker);
    assert.equal(fs.readdirSync(path.join(dir, 'autostart')).length, 0);
    fs.unlinkSync(file); // Only this test's exact marker; no service was started.
  }
});
