'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertEpochUpgrade, createEpochRuntimeUpgrade } = require('../src/queue-epoch-runtime-upgrade');
const copy = structuredClone;
function fixture() {
  const current = { pid: 10, birth: 'selected', version: '2706' }, document = { name: 'NEW', creationId: 'new-id', fileId: null };
  const approval = { version: 1, purpose: 'quiescent-isolated-epoch-checker-upgrade-v1', requestId: 'repair-once',
    clientId: 'original-owner', epochId: 'epoch', document, currentInstance: current, previousBuildHash: 'f708', buildHash: 'fixed',
    pointerHash: 'pointer-hash', rejectedJobIds: ['local-failed-1', 'local-failed-2'] };
  const rejected = id => ({ id, state: 'failed', code: 'PYTHON_CHECK_REJECTED', sequenceId: null,
    details: { executionOutcome: 'not_started', mayHaveMutated: false, userScriptSubmitted: false, sdkSettled: true } });
  const snapshot = { pointer: { kind: 'isolated-fresh-scratch-epoch', epochId: 'epoch', ownerClientId: 'original-owner',
    ownerTokenHash: 'original-private-token-hash', document, currentInstance: current, historicalSnapshotHash: 'old-root', historicalIdentityHash: 'old-identity' },
  ownerTokenHash: 'original-private-token-hash', pointerHash: 'pointer-hash', rootStateHash: 'old-root', rootIdentityHash: 'old-identity',
  identity: { buildHash: 'f708', instance: current }, owner: { pid: 1, birth: 'old-broker', nonce: 'old' },
  state: { paused: false, controlGeneration: 1, contextEpoch: 1, jobs: Object.fromEntries(approval.rejectedJobIds.map(id => [id, rejected(id)])) },
  control: { instanceId: 'old', buildHash: 'f708', generation: 1, contextEpoch: 1, gateClosed: false, activeOperations: 0, activeIds: [] },
  selectedLive: true, historicalDead: true, brokerLive: true, closed: false, cleanupIntent: false, pending: false,
  grantsHash: 'exact-existing-grants', evidenceHash: 'exact-new-scratch-proof-and-original-ledgers' };
  const records = {}, calls = [];
  let oldLive = true, workerLive = false, crash;
  const p = { snapshot, approval, records, calls,
    set crash(stage) { crash = stage; },
    authenticate: async () => { calls.push('authenticate'); }, claim: async () => { calls.push('claim'); },
    approve: async () => approval, unclaim: () => { calls.push('unclaim'); }, read: stage => records[stage],
    observe: async () => copy(snapshot),
    publish(stage, value) {
      if (records[stage]) assert.deepEqual(records[stage], value);
      else records[stage] = copy(value);
      calls.push('publish:' + stage);
      if (crash === stage) { crash = null; throw new Error('fixture crash'); }
    },
    async pause() { calls.push('pause'); snapshot.state.paused = true; snapshot.state.controlGeneration++;
      snapshot.control.generation++; snapshot.control.gateClosed = true; },
    escrow: async () => { calls.push('small-current-epoch-escrow'); return { reference: 'immutable-current-state-and-full-history-hash-references' }; },
    verifyEscrow: async () => { calls.push('verify-escrow'); }, guardStartup: async () => { calls.push('startup-guard'); },
    async stop() { calls.push('supported-stop'); oldLive = false; },
    async waitDead() { if (oldLive) throw Object.assign(new Error('Original process still live'), { code: 'COOPERATIVE_STOP_UNKNOWN' }); },
    async localFence() { if (oldLive) assert.fail('Never install before old cooperative release'); calls.push('local-fence'); },
    install: async () => { calls.push('install'); return { buildHash: 'fixed' }; }, verifyInstalled: async () => { calls.push('verify-installed'); },
    async writeEpochIdentity(previous, next) { assert.deepEqual(snapshot.identity, previous); snapshot.identity = next; calls.push('new-epoch-runtime-identity'); },
    async start() { if (!workerLive) { calls.push('launch-one-worker'); workerLive = true; } },
    observeReady: async () => ({ ...copy(snapshot), owner: { pid: 2, birth: 'new-broker', nonce: 'new' },
      control: { ...copy(snapshot.control), buildHash: 'fixed', instanceId: 'new' } }),
    release: async () => { calls.push('release-own-guards-after-complete'); },
  };
  return p;
}
test('small current-epoch repair preserves exact old history, scratch/grants and local rejected jobs without SDK', async () => {
  const p = fixture(), jobs = JSON.stringify(p.snapshot.state.jobs), pointer = JSON.stringify(p.snapshot.pointer);
  const result = await createEpochRuntimeUpgrade(p)();
  assert.equal(result.sdkRequestsSent, 0); assert.equal(result.historicalOutcome, 'unknown'); assert.equal(result.grantScopeChanged, false);
  assert.equal(result.gateClosed, true); assert.equal(JSON.stringify(p.snapshot.state.jobs), jobs); assert.equal(JSON.stringify(p.snapshot.pointer), pointer);
  assert.ok(p.calls.indexOf('startup-guard') < p.calls.indexOf('supported-stop'));
  assert.ok(p.calls.indexOf('publish:escrow') < p.calls.indexOf('supported-stop'));
  assert.ok(p.calls.indexOf('publish:complete') < p.calls.indexOf('release-own-guards-after-complete'));
  assert.equal(p.calls.filter(x => x === 'launch-one-worker').length, 1);
});
for (const [name, change] of [
  ['foreign owner', p => { p.approval.clientId = 'foreign'; }],
  ['changed credential', p => { p.snapshot.ownerTokenHash = 'revoked'; }],
  ['other epoch', p => { p.approval.epochId = 'foreign'; }],
  ['forged document', p => { p.approval.document = { ...p.approval.document, creationId: 'old-user-model' }; }],
  ['saved document', p => { p.snapshot.pointer.document.fileId = 'cloud-file'; }],
  ['old history changed', p => { p.snapshot.rootStateHash = 'other'; }],
  ['active SDK', p => { p.snapshot.control.activeOperations = 1; }],
  ['lease', p => { p.snapshot.state.lease = {}; }],
  ['physical dispatch exists', p => { p.snapshot.state.jobs['local-failed-1'].dispatch = { rpcCount: 1 }; }],
  ['native unknown', p => { p.snapshot.state.jobs['local-failed-1'].state = 'needs_reconciliation'; }],
  ['mutation possible', p => { p.snapshot.state.jobs['local-failed-1'].details.mayHaveMutated = true; }],
  ['selected process dead', p => { p.snapshot.selectedLive = false; }],
  ['historical death unproven', p => { p.snapshot.historicalDead = false; }],
  ['cleanup started', p => { p.snapshot.cleanupIntent = true; }],
  ['durable write unresolved', p => { p.snapshot.pending = true; }],
]) test('repair refuses ' + name + ' without pause/stop/install', async () => {
  const p = fixture(); change(p); await assert.rejects(createEpochRuntimeUpgrade(p)());
  assert.equal(p.calls.includes('supported-stop'), false); assert.equal(p.calls.includes('install'), false);
});
test('changed jobs or grants during pause preparation refuse before cooperative stop', async () => {
  for (const field of ['grantsHash', 'evidenceHash']) {
    const p = fixture(), pause = p.pause; p.pause = async () => { await pause(); p.snapshot[field] = 'drift'; };
    await assert.rejects(createEpochRuntimeUpgrade(p)()); assert.equal(p.calls.includes('supported-stop'), false);
  }
});
for (const stage of ['paused', 'escrow', 'stopped', 'installed', 'identity', 'launch-intent'])
  test('interruption after ' + stage + ' resumes exact journal without repeated stop/install or SDK', async () => {
    const p = fixture(); p.crash = stage; const run = createEpochRuntimeUpgrade(p);
    await assert.rejects(run(), /fixture crash/); await run();
    assert.equal(p.calls.filter(x => x === 'supported-stop').length, 1);
    assert.equal(p.calls.filter(x => x === 'install').length, 1);
    assert.equal(p.calls.filter(x => x === 'launch-one-worker').length, 1);
    assert.equal(p.records.complete.sdkRequestsSent, 0);
  });
test('stop intent without observed death fails closed and does not resend stop', async () => {
  const p = fixture(); p.crash = 'stop-intent'; const run = createEpochRuntimeUpgrade(p);
  await assert.rejects(run(), /fixture crash/);
  await assert.rejects(run(), { code: 'COOPERATIVE_STOP_UNKNOWN' });
  assert.equal(p.calls.includes('supported-stop'), false); assert.equal(p.calls.includes('install'), false);
});
test('late ready after one launch can complete without another worker or loss of history', async () => {
  const p = fixture(), observe = p.observeReady; let fail = true;
  p.observeReady = async () => { if (fail) { fail = false; throw new Error('late ready'); } return observe(); };
  const run = createEpochRuntimeUpgrade(p); await assert.rejects(run(), /late ready/); await run();
  assert.equal(p.calls.filter(x => x === 'launch-one-worker').length, 1); assert.equal(p.records.complete.grantScopeChanged, false);
});
test('bounded configured exclusive idle budget covers mandatory local aggregate preparation without altering an active lease', t => {
  const fs = require('node:fs'), path = require('node:path');
  const { QueueState } = require('../src/queue-state');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'epoch-checker-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const idleMs of [60000, 180000]) {
    let now = 1000;
    const q = new QueueState(path.join(root, String(idleMs)), { now: () => now, idleMs, leaseMs: 1800000 });
    const req = { kind: 'command', clientId: 'granted-native', requestId: 'begin', timeoutMs: 180000,
      cwd: root, argv: ['cad', 'sketch', 'create'], sequence: { action: 'begin', mode: 'exclusive' } };
    const first = q.submit(req); q.next();
    const sequenceId = q.data.jobs[first.id].sequenceId; q.finish(first.id, { state: 'succeeded' });
    const second = q.submit({ ...req, requestId: 'continue', phased: true,
      sequence: { action: 'continue', mode: 'exclusive', id: sequenceId } });
    now += 75000; // local checker preparation, not a physical turn
    q.next(); // the ordinary scheduler expires idle leases even during local preparation
    assert.equal(q.data.lease !== null, idleMs === 180000);
    assert.equal(q.data.jobs[second.id].physicalTurns || 0, 0);
    assert.equal(q.leaseMs, 1800000);
  }
});

test('typed checker and settled epoch handoffs preserve retained receipts and effects through interrupted stages', async () => {
  const old = require('./fixtures/historical-module.cjs')(
    '330849f22302bcf0ee955cd1945ddb2040eff8c7', 'src/queue-epoch-runtime-upgrade.js');
  const current = require('../src/queue-epoch-runtime-upgrade');
  for (const settled of [false, true]) for (const stage of [undefined, 'paused', 'escrow', 'stopped', 'installed', 'identity', 'launch-intent', 'complete']) {
    const outputs = [];
    for (const api of [old, current]) {
      const p = fixture();
      if (settled) {
        p.approval.purpose = 'quiescent-settled-isolated-epoch-upgrade-v1';
        p.approval.settledJobIds = p.approval.rejectedJobIds;
        delete p.approval.rejectedJobIds;
        p.snapshot.settledEvidence = [{ receipt: 'owned-terminal-receipt', outcome: 'succeeded' }];
        p.approval.settledEvidenceHash = require('../src/queue-instance').hash(JSON.stringify(p.snapshot.settledEvidence));
        for (const job of Object.values(p.snapshot.state.jobs)) job.state = 'succeeded';
      }
      p.crash = stage;
      const run = (settled ? api.createSettledEpochRuntimeUpgrade : api.createEpochRuntimeUpgrade)(p);
      if (stage) await assert.rejects(run(), /fixture crash/);
      const result = await run();
      outputs.push({ result, records: p.records, calls: p.calls, snapshot: p.snapshot });
    }
    assert.deepEqual(outputs[1], outputs[0], (settled ? 'settled:' : 'checker:') + String(stage));
  }
});

test('persisted settled epoch boundary validates schema before typed handoff policy', () => {
  const p = fixture();
  p.approval.purpose = 'quiescent-settled-isolated-epoch-upgrade-v1';
  p.approval.settledJobIds = p.approval.rejectedJobIds; delete p.approval.rejectedJobIds;
  p.snapshot.settledEvidence = [{ receipt: 'owned' }];
  p.approval.settledEvidenceHash = require('../src/queue-instance').hash(JSON.stringify(p.snapshot.settledEvidence));
  for (const job of Object.values(p.snapshot.state.jobs)) job.state = 'succeeded';
  const api = require('../src/queue-epoch-runtime-upgrade');
  api.assertSettledEpochUpgradeRecord(p.snapshot, p.approval);
  for (const mutate of [
    s => { s.state.jobs = []; }, s => { s.owner.nonce = 3; },
    s => { s.control.activeIds = 'not-an-array'; }, s => { s.state.jobs['local-failed-1'].details.sdkSettled = 'yes'; },
  ]) {
    const changed = structuredClone(p.snapshot); mutate(changed);
    assert.throws(() => api.assertSettledEpochUpgradeRecord(changed, p.approval), { code: 'EPOCH_UPGRADE_CLAIM_UNPROVEN' });
  }
});
