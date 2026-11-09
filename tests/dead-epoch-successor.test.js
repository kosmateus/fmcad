'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const api = require('../src/queue-instance');
const lineage = require('../src/queue-epoch-lineage');
const { openIsolatedEpoch, isolatedEpochDirectory } = require('../src/queue-isolated-epoch');
const { assertSuccessorApproval, assertCurrentPredecessor } = require('../src/queue-epoch-successor');

function fixture(t, options) {
  // Only spell Windows receipt paths for these synthetic physical ports.
  t.after(require('./fixtures/fake-wsl-platform.cjs')());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-epoch-successor-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return require('./fixtures/dead-epoch-successor.cjs')(base, path.resolve(__dirname, '..'), options);
}

test('FAKE metadata: successor preserves original history, retired in-flight work, request IDs and fresh control generations', t => {
  const f = fixture(t, { inFlight: true });
  assertSuccessorApproval(f.inspection, f.approval);
  const protectedFiles = [f.authority.predecessor.state, f.authority.predecessor.identity,
    f.authority.predecessor.rootState, f.authority.predecessor.rootIdentity,
    ...f.authority.predecessor.qualification];
  const before = protectedFiles.map(entry => api.hash(fs.readFileSync(entry.path)));
  const state = openIsolatedEpoch(f.dir, { recover: false });
  const oldGeneration = state.data.controlGeneration, oldContext = state.data.contextEpoch;
  state.installEpoch(f.pointer, f.identity, f.initialization);
  assert.equal(state.epoch.epochId, f.pointer.epochId);
  assert.equal(state.data.controlGeneration, oldGeneration + 1);
  assert.equal(state.data.contextEpoch, oldContext + 1);
  assert.equal(state.summary().historicalUnknownJobCount, 3);
  assert.equal(state.summary().retiredEpochCount, 1);
  assert.equal(state.status(f.priorJob.id).state, 'running');
  assert.equal(state.status(f.priorJob.id).quarantined, true);
  assert.equal(state.findAnyRequest(f.clientId, f.priorJob.requestId).id, f.priorJob.id);
  assert.throws(() => state.submit({ ...f.priorJob.request, requestId: f.priorJob.requestId }), { code: 'HISTORICAL_REQUEST_QUARANTINED' });
  assert.throws(() => state.cancel(f.priorJob.id, f.clientId), { code: 'INSTANCE_HISTORY_QUARANTINED' });
  assert.throws(() => state.resolve(f.priorJob.id, { state: 'succeeded' }), { code: 'INSTANCE_HISTORY_QUARANTINED' });
  assert.equal(isolatedEpochDirectory(f.dir), f.pointer.root);
  const reopened = openIsolatedEpoch(f.dir);
  assert.equal(reopened.lookup(f.priorJob.id).state, 'running');
  assert.equal(reopened.findAnyRequest(f.clientId, f.priorJob.requestId).quarantined, true);
  assert.deepEqual(protectedFiles.map(entry => api.hash(fs.readFileSync(entry.path))), before);
  assert.equal(lineage.epochControlDirectory(f.dir, reopened.epoch), f.audit);
  assertCurrentPredecessor(f.dir, f.authorityEntry, { allowPublished: true });
});

for (const [name, mutate] of [
  ['foreign owner', value => { value.clientId = 'foreign'; }],
  ['revoked owner credential', value => { value.registeredTokenHash = 'b'.repeat(64); }],
  ['live old broker', value => { value.previousBrokerAlive = true; }],
  ['uncertain old process', value => { value.previousProcessAlive = null; }],
  ['live old process', value => { value.previousProcessAlive = true; }],
  ['uncertain selected process', value => { value.expectedProcessAlive = null; }],
  ['pending store write', value => { value.pending = true; }],
  ['changed current snapshot', value => { value.snapshot.state.sha256 = 'a'.repeat(64); }],
  ['unqualified installed build', value => { value.qualification.passed = false; }],
  ['SDK traffic in qualification', value => { value.qualification.liveSdkRequestsSent = 1; }],
  ['missing successor read qualification', value => { delete value.qualification.deadEpochSuccessorReadQualified; }],
  ['missing successor restore qualification', value => { delete value.qualification.deadEpochSuccessorRestoreQualified; }],
]) test('FAKE metadata: successor rejects ' + name + ' before any source or SDK authority', t => {
  const f = fixture(t), value = structuredClone(f.inspection); mutate(value);
  assert.throws(() => assertSuccessorApproval(value, f.approval));
});

test('FAKE metadata: a live predecessor is never superseded despite self-consistent files', t => {
  const f = fixture(t, { oldProcessAlive: true });
  const state = openIsolatedEpoch(f.dir, { recover: false });
  assert.throws(() => state.installEpoch(f.pointer, f.identity, f.initialization), { code: 'EPOCH_SUCCESSOR_UNPROVEN' });
  assert.throws(() => assertCurrentPredecessor(f.dir, f.authorityEntry), { code: 'EPOCH_SUCCESSOR_FENCE_CHANGED' });
  assert.equal(state.epoch.epochId, f.authority.predecessor.epochId);
});

for (const [name, change] of [
  ['old state', f => api.durable(f.authority.predecessor.state.path, { forged: true })],
  ['old grant', f => api.durable(path.join(f.authority.predecessor.identity.path, '..', 'access-' + 'a'.repeat(64) + '.json'), { forged: true })],
  ['old qualification', f => api.durable(f.authority.predecessor.qualification[0].path, { forged: true })],
  ['installed qualification', f => api.durable(f.authority.qualification.path, { passed: false })],
]) test('FAKE metadata: changed ' + name + ' cannot activate a successor', t => {
  const f = fixture(t); change(f);
  assert.throws(() => openIsolatedEpoch(f.dir, { recover: false }).installEpoch(f.pointer, f.identity, f.initialization));
});

test('FAKE metadata: publishing the same proven successor again is local and idempotent', t => {
  const f = fixture(t), state = openIsolatedEpoch(f.dir, { recover: false });
  state.installEpoch(f.pointer, f.identity, f.initialization);
  const before = fs.readFileSync(path.join(f.dir, 'isolated-admission-epoch.json'));
  state.installEpoch(f.pointer, f.identity, f.initialization);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'isolated-admission-epoch.json')), before);
  assert.equal(Object.keys(state.data.jobs).length, 0);
});
