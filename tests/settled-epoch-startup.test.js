'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixtures/settled-epoch-upgrade.cjs');
const api = require('../src/queue-instance');

test('FAKE backend: real broker claims settled paused epoch without any SDK and preserves every job', async t => {
  const root = fs.mkdtempSync('/tmp/opencode/settled-startup-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(root, path.resolve(__dirname, '..'));
  const before = fs.readFileSync(path.join(f.pointer.root, 'queue-state.json'));
  let calls = 0;
  const broker = await require('../src/queue-broker').serve(f.cfg, { dir: f.dir, confirmOwnership: true,
    epochRuntimeUpgradeNonce: f.nonce, autoReconcile: false, createBackend: () => ({ server: { timeoutMs: 1000 },
      _parse: JSON.parse, _post() { calls++; assert.fail('No SDK during handoff'); },
      callTool() { calls++; assert.fail('No SDK probe during handoff'); } }) });
  try {
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.pointer.root, 'queue-state.json')), before);
    assert.equal(broker.status().admissionEpoch, f.pointer.epochId);
  } finally { await broker.close(); }
});

for (const kind of ['missing-release', 'retained-release', 'changed-physical-receipt']) test('FAKE files: claim refuses ' + kind, t => {
  const root = fs.mkdtempSync('/tmp/opencode/settled-claim-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(root, path.resolve(__dirname, '..'));
  const release = path.join(f.dir, 'console-release-' + api.hash(f.approval.requestId + ':pause-stop') + '.json');
  if (kind === 'missing-release') fs.unlinkSync(release);
  if (kind === 'retained-release') api.durable(release, { ...api.readJson(release), outcome: 'retained' });
  if (kind === 'changed-physical-receipt') {
    const remote = f.paused.settledEvidence.find(ref => path.basename(ref.path).startsWith('remote-'));
    api.durable(remote.path, { ...api.readJson(remote.path), terminal: false });
  }
  assert.throws(() => require('../src/queue-epoch-runtime-upgrade').claimEpochRuntimeBroker(f.dir,
    { pid: process.pid, birth: api.processBirth(), nonce: 'new-owner' }, f.nonce, api.buildHash()));
  assert.equal(fs.existsSync(path.join(f.dir, 'broker.lock')), false);
});
