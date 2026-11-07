'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createAdmin } = require('../src/queue-console-admin');
const { createServices } = require('../src/console-services');
const { inspectLocks } = require('../src/console-locks');
const hash = text => createHash('sha256').update(text).digest('hex');
const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const tick = () => new Promise(resolve => setImmediate(resolve));

function adminFixture() {
  const files = new Map();
  const context = { busy: false, active: null, held: null, stopping: false };
  const counts = { probes: 0, observations: 0, closes: 0, diagnostics: 0 };
  const state = { data: { paused: false, controlGeneration: 0 },
    summary() { return { active: this.data.active, blocked: this.data.blocked, lease: this.data.lease }; },
    pause(paused) { if (this.data.paused !== paused) this.data.controlGeneration++; this.data.paused = paused; },
    _commit(fn) { return fn(this.data); } };
  const gate = { instanceId: 'old', active: new Map(), resuming: false, administrative: fn => fn() };
  const instance = { pid: 42, birth: 'boot:99', version: '2026', activeCommand: 'SelectCommand' };
  const deps = { state, gate, dir: '/fixture', marker: { nonce: 'old' }, buildHash: 'build',
    getContext: () => context, setBusy: value => { context.busy = value; },
    resumeCheck: async () => { counts.probes++; return instance; },
    observeControlCompletion: async () => { counts.observations++; return { terminal: true, outcome: 'succeeded', instance }; },
    close: async () => { counts.closes++; assert.equal(state.data.paused, true); assert.equal(context.busy, false); },
    diagnostics: () => counts.diagnostics++, durable: (file, value, exclusive) => {
      if (exclusive && files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(file, structuredClone(value));
    }, readJson: file => files.has(file) ? structuredClone(files.get(file)) : absent(), hash };
  return { files, context, counts, state, gate, deps, instance,
    message: (action, id = 'request') => ({ action, control: { requestId: id, instanceId: 'old', expectedGeneration: 0 } }) };
}

test('construction performs no administrative or service actions', () => {
  const f = adminFixture(); createAdmin(f.deps);
  let reads = 0;
  createServices({ cfg: { routing: 'queue' }, control: { read() { reads++; throw new Error('unexpected'); } }, ensureBroker() { throw new Error('unexpected'); } });
  assert.equal(reads, 0); assert.equal(f.files.size, 0);
  assert.deepEqual(f.counts, { probes: 0, observations: 0, closes: 0, diagnostics: 0 });
});

test('admin validates own mandatory fences, identity, generation and request conflicts', async () => {
  const f = adminFixture(), admin = createAdmin(f.deps);
  assert.equal(admin.accepts('console-inspect'), true); assert.equal(admin.accepts('resume'), false);
  for (const control of [{ requestId: 'x' }, Object.create({ requestId: 'x', instanceId: 'old', expectedGeneration: 0 }),
    { requestId: 'x', instanceId: 'old', expectedGeneration: -1 }]) {
    await assert.rejects(admin.handle({ action: 'console-inspect', control }, 'client'), { code: 'INVALID_REQUEST' });
  }
  const wrong = f.message('console-inspect'); wrong.control.instanceId = 'other';
  await assert.rejects(admin.handle(wrong, 'client'), { code: 'INSTANCE_CHANGED' });
  const stale = f.message('console-inspect'); stale.control.expectedGeneration = 1;
  await assert.rejects(admin.handle(stale, 'client'), { code: 'STATE_CONFLICT' });
  await admin.handle(f.message('console-inspect', '__proto__'), 'client');
  await assert.rejects(admin.handle(f.message('console-restart', '__proto__'), 'client'), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.counts.probes, 1);
});

test('inspection caches durably across admin reconstruction and never repeats SDK', async () => {
  const f = adminFixture(), message = f.message('console-inspect');
  const first = await createAdmin(f.deps).handle(message, 'client');
  assert.deepEqual(await createAdmin(f.deps).handle(message, 'client'), first);
  assert.equal(f.counts.probes, 1);
  assert.equal(f.files.get('/fixture/console-fusion-observation.json').instance.pid, 42);
  assert.equal(f.context.busy, false); assert.equal(f.gate.adminTransition, null);
});

test('unknown inspection stays paused/blocked; same request never replays', async () => {
  const f = adminFixture();
  f.deps.resumeCheck = async () => {
    f.counts.probes++; f.state.data.controlBlocked = { rpcId: 'original' };
    throw Object.assign(new Error('lost response'), { code: 'UNKNOWN_RPC' });
  };
  const admin = createAdmin(f.deps), message = f.message('console-inspect');
  await assert.rejects(admin.handle(message, 'client'), { code: 'UNKNOWN_RPC' });
  await assert.rejects(admin.handle(message, 'client'), { code: 'UNKNOWN_RPC' });
  assert.equal(f.counts.probes, 1); assert.equal(f.state.data.paused, true);
  assert.equal(f.state.data.controlBlocked.rpcId, 'original');
});

test('blocked inspection only observes original receipt and stays paused', async () => {
  const f = adminFixture(); f.state.data.controlBlocked = { rpcId: 'original' }; f.context.held = 'unknown control';
  const value = await createAdmin(f.deps).handle(f.message('console-inspect'), 'client');
  assert.equal(value.reconciled, true); assert.equal(f.counts.probes, 0); assert.equal(f.counts.observations, 1);
  assert.equal(f.state.data.paused, true); assert.equal(f.state.data.controlBlocked, undefined);
});

test('failed original terminal receipt cannot become a successful inspection', async () => {
  const f = adminFixture(); f.state.data.controlBlocked = { rpcId: 'original' };
  f.deps.observeControlCompletion = async () => ({ terminal: true, outcome: 'failed', instance: f.instance });
  await assert.rejects(createAdmin(f.deps).handle(f.message('console-inspect'), 'client'), { code: 'INSPECTION_FAILED' });
  assert.equal(f.counts.probes, 0); assert.equal(f.state.data.paused, true);
  assert.equal(f.files.has('/fixture/console-fusion-observation.json'), false);
});

test('restart and inspect reject work, leases and concurrent administrative calls', async () => {
  const mutations = [f => { f.state.data.active = 'job'; }, f => { f.state.data.blocked = { id: 'job' }; },
    f => { f.state.data.lease = { id: 'lease' }; }, f => { f.context.active = { unknown: true }; },
    f => { f.context.busy = true; }, f => { f.gate.active.set('rpc', 1); },
    f => { f.gate.resuming = true; }, f => { f.gate.adminTransition = 'restart'; }];
  for (const action of ['console-restart', 'console-inspect']) for (const mutate of mutations) {
    const f = adminFixture(); mutate(f);
    await assert.rejects(createAdmin(f.deps).handle(f.message(action), 'client'));
    assert.equal(f.counts.closes, 0); assert.equal(f.counts.probes, 0);
  }
  const f = adminFixture(); f.state.data.controlBlocked = { rpcId: 'unknown' };
  await assert.rejects(createAdmin(f.deps).handle(f.message('console-restart'), 'client'), { code: 'RECONCILIATION_REQUIRED' });
});

test('lifecycle stop and reload never abandon queued/local unknown work', async () => {
  for (const action of ['console-stop', 'console-reload', 'console-restart']) {
    for (const state of ['queued', 'preparing', 'processing', 'running', 'needs_reconciliation']) {
      const f = adminFixture(); f.state.data.jobs = { job: { state } };
      await assert.rejects(createAdmin(f.deps).handle(f.message(action), 'client'), { code: 'QUEUE_BUSY' });
      assert.equal(f.counts.closes, 0); assert.equal(f.files.size, 0);
    }
    const f = adminFixture(); f.state.data.localUnknown = { id: 'local' };
    await assert.rejects(createAdmin(f.deps).handle(f.message(action), 'client'), { code: 'RECONCILIATION_REQUIRED' });
  }
});

test('restart ACK precedes deferred close and binds a durable release; duplicate intent does not close twice', async () => {
  const f = adminFixture(), admin = createAdmin(f.deps), message = f.message('console-restart');
  const ack = await admin.handle(message, 'client');
  assert.equal(f.counts.closes, 0); assert.equal(f.state.data.paused, true);
  assert.deepEqual(await admin.handle(message, 'client'), ack);
  await tick();
  assert.deepEqual(f.files.get(ack.releaseFile), { terminal: true, outcome: 'released', requestId: 'request', instanceId: 'old', buildHash: 'build' });
  assert.equal(f.counts.closes, 1);
});

test('failed close publishes retained proof without claiming release', async () => {
  const f = adminFixture(); f.deps.close = async () => { throw Object.assign(new Error('retained'), { code: 'LOCK_CHANGED' }); };
  const ack = await createAdmin(f.deps).handle(f.message('console-restart'), 'client'); await tick();
  assert.equal(f.files.get(ack.releaseFile).outcome, 'retained');
});

function servicesFixture({ stopped = false, receipt = 'released' } = {}) {
  let time = 0, started = false, reads = 0;
  const calls = [], files = new Map(), markers = new Set();
  const before = { protocol: 1, instanceId: 'old', buildHash: 'build', generation: 3, activeOperations: 0,
    phase: 'PAUSED', gateClosed: true, unresolved: false, capabilities: { inspect: true, restart: true } };
  const after = { ...before, instanceId: 'new' };
  const control = { client: { dir: '/fixture', auth: { clientId: 'test', clientToken: 'fixture' },
    async call(action, values) {
      calls.push({ action, values });
      if (action === 'console-inspect') return { inspected: true };
      const releaseFile = '/fixture/console-release-' + hash(values.control.requestId) + '.json';
      if (receipt !== null) files.set(releaseFile, { terminal: true, outcome: receipt,
        requestId: values.control.requestId, instanceId: 'old', buildHash: 'build' });
      return { acknowledged: true, requestId: values.control.requestId, instanceId: 'old', buildHash: 'build', releaseFile };
    } }, async read() { reads++; if (stopped && !started) return absent(); return this.current = started ? after : before; } };
  const starts = [];
  const options = { cfg: { routing: 'queue', queue: { autoStart: false } }, control,
    fs: { lstatSync(file) { if (!markers.has(path.basename(file))) return absent(); return {}; } },
    readJson: file => files.has(file) ? files.get(file) : absent(), now: () => time,
    sleep: async ms => { time += ms; }, requestID: () => 'request', timeoutMs: 100,
    ensureBroker: async (cfg, auth) => { starts.push({ cfg, auth }); started = true; } };
  return { options, control, calls, files, markers, starts, before, after, reads: () => reads };
}

test('inspect uses fresh fences and sends once; errors only read status', async () => {
  const f = servicesFixture(), services = createServices(f.options);
  await services.inspect(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].values.control, { requestId: 'request', instanceId: 'old', expectedGeneration: 3 });
  let sent = 0;
  f.control.client.call = async () => { sent++; throw Object.assign(new Error('unknown'), { code: 'UNKNOWN_RPC' }); };
  const reads = f.reads(); await assert.rejects(services.inspect(), { code: 'UNKNOWN_RPC' });
  assert.equal(sent, 1); assert.equal(f.reads(), reads + 2); assert.equal(f.starts.length, 0);
});

test('restart requires release proof then uses temporary paused exclusive startup flags', async () => {
  const f = servicesFixture(); const result = await createServices(f.options).restart();
  assert.equal(result.restarted, true); assert.equal(f.calls.length, 1); assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0].cfg.queue, { autoStart: true, autoRecover: false, startPaused: true, exclusiveStart: true });
  assert.equal(f.options.cfg.queue.autoStart, false);
  assert.equal(f.calls.some(call => call.action === 'resume'), false);
});

test('explicit startup reads queue snapshots using the persistence store limit', async () => {
  const f = servicesFixture({ stopped: true });
  const readJson = f.options.readJson;
  let snapshotLimit;
  f.options.readJson = (file, maxBytes) => {
    if (file === '/fixture/queue-state.json') snapshotLimit = maxBytes;
    return readJson(file);
  };
  await createServices(f.options).start();
  assert.equal(snapshotLimit, 128 * 1024 * 1024);
  assert.equal(f.starts.length, 1);
});

test('missing/retained/misbound releases never start a broker', async () => {
  for (const outcome of [null, 'retained']) {
    const f = servicesFixture({ receipt: outcome });
    await assert.rejects(createServices(f.options).restart()); assert.equal(f.calls.length, 1); assert.equal(f.starts.length, 0);
  }
  const f = servicesFixture(); const original = f.control.client.call;
  f.control.client.call = async (...args) => {
    const ack = await original(...args); f.files.get(ack.releaseFile).instanceId = 'wrong'; return ack;
  };
  await assert.rejects(createServices(f.options).restart(), { code: 'RECEIPT_MISMATCH' }); assert.equal(f.starts.length, 0);
});

test('marker conflicts and persisted unknown ownership refuse explicit start', async () => {
  for (const marker of ['broker.lock', 'autostart.lock', 'recovery.lock']) {
    const f = servicesFixture({ stopped: true }); f.markers.add(marker);
    await assert.rejects(createServices(f.options).restart(), { code: 'OWNERSHIP_CONFLICT' }); assert.equal(f.starts.length, 0);
  }
  for (const field of ['active', 'blocked', 'lease', 'controlBlocked']) {
    const f = servicesFixture({ stopped: true });
    f.files.set('/fixture/queue-state.json', { version: 1, paused: true, jobs: {}, active: null, [field]: 'unknown' });
    await assert.rejects(createServices(f.options).restart(), { code: 'RECONCILIATION_REQUIRED' }); assert.equal(f.starts.length, 0);
  }
});

test('stopped start is explicit; direct/legacy/running/recovery-blocked states reject', async () => {
  const f = servicesFixture({ stopped: true });
  assert.equal((await createServices(f.options).restart()).restarted, false); assert.equal(f.calls.length, 0);
  const direct = servicesFixture(); direct.options.cfg.routing = 'direct';
  await assert.rejects(createServices(direct.options).restart(), { code: 'UNSUPPORTED_ROUTING' }); assert.equal(direct.reads(), 0);
  const legacy = servicesFixture(); legacy.before.protocol = 0;
  await assert.rejects(createServices(legacy.options).restart(), { code: 'UNSUPPORTED_BROKER' }); assert.equal(legacy.calls.length, 0);
  for (const phase of ['RUNNING', 'RECOVERY_BLOCKED']) {
    const bad = servicesFixture(); bad.after.phase = phase;
    await assert.rejects(createServices(bad.options).restart());
    assert.equal(bad.calls.some(call => call.action === 'resume'), false);
  }
});

test('start is not resume/restart and reload requires its own capability and action', async () => {
  const running = servicesFixture();
  await assert.rejects(createServices(running.options).start(), { code: 'BROKER_ALREADY_RUNNING' });
  assert.equal(running.calls.length, 0); assert.equal(running.starts.length, 0);
  const stopped = servicesFixture({ stopped: true });
  assert.equal((await createServices(stopped.options).start()).started, true);
  const reload = servicesFixture(); reload.before.capabilities.reload = true;
  assert.equal((await createServices(reload.options).reload()).restarted, true);
  assert.equal(reload.calls[0].action, 'console-reload');
  const unsupported = servicesFixture();
  await assert.rejects(createServices(unsupported.options).reload(), { code: 'UNSUPPORTED_BROKER' });
  assert.equal(unsupported.calls.length, 0);
});

function lockFilesystem({ locks = '', pid = 12, ticks = '99', deny = false } = {}) {
  const root = '/project/.beads/embeddeddolt';
  const data = new Map([['/proc/locks', locks], ['/proc/sys/kernel/random/boot_id', '12345678-1234-1234-1234-123456789abc'],
    ['/proc/' + pid + '/stat', pid + ' (name with spaces) ' + ['S', ...Array(18).fill('0'), ticks].join(' ')]]);
  const handles = new Map(); let next = 0;
  const stat = (dir = false) => ({ dev: 2049n, ino: 123n, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });
  return { constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
    lstatSync(file) { if ([root, '/project/.beads'].includes(file)) return stat(true); if (file === root + '/.lock') return stat(); return absent(); },
    opendirSync() { return { readSync: () => null, closeSync() {} }; },
    openSync(file) { if (deny) throw Object.assign(new Error('denied'), { code: 'EACCES' }); if (!data.has(file)) return absent(); const fd = ++next; handles.set(fd, { bytes: Buffer.from(data.get(file)), offset: 0 }); return fd; },
    readSync(fd, target, offset, length) { const h = handles.get(fd); const count = h.bytes.copy(target, offset, h.offset, h.offset + length); h.offset += count; return count; },
    closeSync(fd) { handles.delete(fd); } };
}

test('lock file existence, unsupported platform and denied evidence are unknown', () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { platform: 'linux', deny: true }]) {
    const value = inspectLocks('/project', { fs: lockFilesystem(options), now: () => 123, platform: options.platform });
    assert.equal(value.status, 'unknown'); assert.equal(value.entries[0].exists, true); assert.equal(value.readAt, 123);
  }
});

test('only matching device/inode plus positive PID and birth proves observed advisory ownership', () => {
  const valid = '1: POSIX ADVISORY WRITE 12 08:01:123 0 EOF\n';
  const value = inspectLocks('/project', { fs: lockFilesystem({ locks: valid }), platform: 'linux' });
  assert.equal(value.status, 'active'); assert.equal(value.entries[0].owners[0].pid, 12);
  assert.match(value.entries[0].owners[0].birth, /:99$/);
  for (const locks of [valid.replace(':123 ', ':124 '), valid.replace('08:01', '08:02'), valid.replace('WRITE 12', 'WRITE -1'), valid.replace('POSIX', '-> POSIX')]) {
    assert.equal(inspectLocks('/project', { fs: lockFilesystem({ locks }), platform: 'linux' }).status, 'unknown');
  }
});
