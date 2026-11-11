'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const api = require('../src/queue-instance');

test('lost epoch process keeps authenticated receipts readable without SDK or renewed authority', async t => {
  const base = fs.mkdtempSync('/tmp/opencode/epoch-dead-process-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const f = require('./fixtures/current-epoch-upgrade.cjs')(base, root);
  const state = require('../src/queue-isolated-epoch').openIsolatedEpoch(f.dir, { recover: false });
  state.pause(false, 'fixture-before-process-loss');
  const inFlight = state.submit({ kind: 'command', requestId: 'synthetic-in-flight', clientId: f.clientId,
    timeoutMs: 1000, cwd: base, argv: ['cad', 'sketch', 'create'], payload: { kind: 'cad', version: 1,
      operation: 'sketch.create', doc: f.pointer.document.name, docId: f.pointer.document.creationId,
      data: { name: 'NeverSent', plane: 'XY' } } });
  assert.equal(state.next().id, inFlight.id);
  // Change only synthetic fixture evidence to model a process that exited.
  const dead = { pid: 2147483645, birth: 'dead:qualified-process', version: 'fixture' };
  f.pointer.currentInstance = dead;
  const proof = api.readJson(f.pointer.qualificationReceipt.path);
  api.durable(f.pointer.qualificationReceipt.path, { ...proof, currentInstance: dead });
  f.pointer.qualificationReceipt.sha256 = api.hash(fs.readFileSync(f.pointer.qualificationReceipt.path));
  api.durable(path.join(f.dir, 'isolated-admission-epoch.json'), f.pointer);
  const identity = path.join(f.pointer.root, 'instance.json');
  api.durable(identity, { ...api.readJson(identity), instance: dead });
  for (const name of ['atomic-migration.lock', 'recovery.lock']) fs.unlinkSync(path.join(f.dir, name));
  const protectedFiles = [path.join(f.dir, 'queue-state.json'), path.join(f.dir, 'instance.json'),
    path.join(f.dir, 'isolated-admission-epoch.json'), path.join(f.pointer.root, 'queue-state.json'), identity,
    f.pointer.qualificationReceipt.path];
  const before = protectedFiles.map(file => api.hash(fs.readFileSync(file)));
  const child = spawn(process.execPath, ['-e', `
    (async () => {
      const assert = require('node:assert/strict');
      const broker = await require(${JSON.stringify(root + '/src/queue-broker')}).serve(${JSON.stringify(f.cfg)}, {
        dir: ${JSON.stringify(f.dir)}, confirmOwnership: true, autoReconcile: true,
        createBackend: () => ({ server: { timeoutMs: 1000 }, _parse: JSON.parse,
          _post() { assert.fail('Metadata-only recovery must not send SDK'); },
          callTool() { assert.fail('Metadata-only recovery must not probe'); } }),
      });
      console.log(JSON.stringify(broker.status()));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  const first = await Promise.race([once(child.stdout, 'data'), exited.then(() => {
    throw new Error('Metadata broker exited before ready: ' + stderr);
  })]);
  assert.match(JSON.parse(first[0].toString()).held, /process.*unavailable/i);
  const request = require('../src/queue-connection').request;
  const call = (action, extra = {}) => request(f.dir,
    { action, auth: { clientId: f.clientId, clientToken: f.token }, ...extra });
  const summary = await call('queue-summary');
  assert.equal(summary.isolatedScratchScope.admission, 'blocked-process-unavailable');
  assert.equal(summary.admissionEpoch, f.pointer.epochId);
  // Exercise the emitted library projection too: the new blocked scope is valid
  // status metadata, not a compatibility error or a modeling release.
  const connectionFile = require.resolve('../dist/src/queue-connection');
  const clientFile = require.resolve('../dist/src/queue-client');
  const instanceFile = require.resolve('../dist/src/queue-instance');
  const previousConnection = require.cache[connectionFile];
  const previousClient = require.cache[clientFile];
  const previousInstance = require.cache[instanceFile];
  const replace = (file, exports) => { require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
  replace(connectionFile, { queueDirectory: () => f.dir });
  // The synthetic broker runs from source, not the separately staged package.
  replace(instanceFile, { ...require(instanceFile), buildHash: () => api.buildHash() });
  replace(clientFile, { QueueClient: class {
    register() { return request(f.dir, { action: 'register', clientId: f.clientId, clientToken: f.token }); }
    call(action, extra) { return call(action, extra); }
    dispose() {}
  } });
  try {
    const session = require('../dist/src/dist/composition/library-queue').createQueueSession(f.cfg, f.clientId, base, 'fixture-session');
    await session.start();
    const projected = await session.status();
    assert.equal(projected.blocked, true);
    assert.equal(projected.isolatedScratch.admission, 'blocked-process-unavailable');
    session.dispose();
  } finally {
    if (previousConnection) require.cache[connectionFile] = previousConnection;
    else delete require.cache[connectionFile];
    if (previousClient) require.cache[clientFile] = previousClient;
    else delete require.cache[clientFile];
    if (previousInstance) require.cache[instanceFile] = previousInstance;
    else delete require.cache[instanceFile];
  }
  assert.equal((await call('status', { jobId: inFlight.id })).state, 'running', 'No inferred settlement or rewrite');
  const job = (await call('find-request', { requestId: 'synthetic-smoke-local-failure-1' })).job;
  assert.equal(job.state, 'failed');
  assert.equal((await call('result', { jobId: job.id })).job.state, 'failed');
  assert.equal((await call('status', { jobId: job.id })).state, 'failed');
  for (const action of ['submit', 'resume', 'pause', 'stop', 'reconcile', 'release', 'create-isolated-scratch',
    'close-isolated-scratch', 'grant-isolated-scratch', 'capture-audit-facts']) {
    await assert.rejects(call(action, { request: {}, jobId: job.id }), { code: 'EPOCH_PROCESS_UNAVAILABLE' });
  }
  await assert.rejects(request(f.dir, { action: 'register', clientId: 'new-client', clientToken: 'new-token' }),
    { code: 'EPOCH_PROCESS_UNAVAILABLE' });
  assert.deepEqual(protectedFiles.map(file => api.hash(fs.readFileSync(file))), before);
  assert.equal(fs.existsSync(path.join(f.dir, 'broker-startup-' + summary.control.instanceId + '.receipt.json')), false);
});

test('unavailable process never downgrades corrupt epoch evidence to metadata authority', async t => {
  const base = fs.mkdtempSync('/tmp/opencode/epoch-corrupt-proof-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = require('./fixtures/current-epoch-upgrade.cjs')(base, path.resolve(__dirname, '..'));
  for (const name of ['atomic-migration.lock', 'recovery.lock']) fs.unlinkSync(path.join(f.dir, name));
  api.durable(f.pointer.qualificationEvidence[0].path, { corrupt: true });
  await assert.rejects(require('../src/queue-broker').serve(f.cfg, {
    dir: f.dir, confirmOwnership: true,
    createBackend() { assert.fail('Corrupt evidence must fail before backend construction'); },
  }), { code: 'EPOCH_PROOF_INVALID' });
  assert.equal(fs.existsSync(path.join(f.dir, 'broker.sock')), false);
});
