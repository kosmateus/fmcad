'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { durable, hash } = require('../src/queue-instance');
const { settledEpochEvidence } = require('../src/queue-settled-epoch-evidence');
const { assertEpochUpgrade, assertSettledEpochUpgrade, createSettledEpochRuntimeUpgrade } = require('../src/queue-epoch-runtime-upgrade');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'settled-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instance = { pid: 2147483645, birth: 'synthetic', version: 'fixture' };
  const pointer = { kind: 'isolated-fresh-scratch-epoch', epochId: randomUUID(), ownerClientId: 'owner', ownerTokenHash: 'credential-hash',
    currentInstance: instance, document: { name: 'SYNTHETIC', creationId: 'synthetic-doc', fileId: null },
    historicalSnapshotHash: 'root-hash', historicalIdentityHash: 'identity-hash' };
  const build = 'a'.repeat(64), id = randomUUID(), rpcId = randomUUID();
  const dir = path.join(root, 'jobs', id); fs.mkdirSync(dir, { recursive: true });
  const details = { code: 'EXECUTION_COMPLETE', exitCode: 0, sdkSettled: true, mayHaveMutated: true, publicationOutcome: 'published' };
  const job = { id, state: 'succeeded', code: 'EXECUTION_COMPLETE', details,
    request: { buildHash: build, isolatedEpoch: pointer.epochId, payload: { kind: 'cad', doc: pointer.document.name, docId: pointer.document.creationId } },
    dispatch: { rpcState: 'terminal', rpcCount: 1, completedCount: 1 }, sequenceId: null };
  const binding = { jobId: id, rpcId, buildHash: build, isolatedEpoch: pointer.epochId,
    qualifiedDocumentHash: hash(JSON.stringify(pointer.document)), requestHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64), auditExpectedInstance: instance };
  const receipt = path.join(dir, 'remote-' + rpcId + '.json');
  const remote = { ...binding, terminal: true, outcome: 'succeeded', instance };
  const record = { binding, receipt, instance, remoteReceipt: remote, terminal: true, failed: false, nonterminal: false, pythonCheck: { status: 'passed' } };
  durable(path.join(dir, 'outcome.json'), { state: job.state, ...details }, true);
  durable(path.join(dir, 'worker-identity.json'), { pid: 2147483644, birth: 'synthetic:dead-worker' }, true);
  require('./fixtures/settled-probes.cjs')(require('../src/queue-instance'), dir, id, build, pointer);
  const rpcFile = path.join(dir, 'rpc-' + rpcId + '.json');
  durable(rpcFile, record, true); durable(receipt, remote, true);
  const state = { jobs: { [id]: job }, paused: false, controlGeneration: 1, contextEpoch: 2 };
  const evidence = () => settledEpochEvidence(root, state, pointer);
  const refs = evidence();
  const snapshot = { state, pointer, identity: { buildHash: build, instance }, owner: { nonce: 'old-owner' },
    ownerTokenHash: pointer.ownerTokenHash, pointerHash: 'pointer-hash', rootStateHash: pointer.historicalSnapshotHash,
    rootIdentityHash: pointer.historicalIdentityHash, settledEvidence: refs,
    grantsHash: 'grants', evidenceHash: 'evidence', selectedLive: true, historicalDead: true, brokerLive: true,
    control: { instanceId: 'old-owner', buildHash: build, generation: 1, contextEpoch: 2, activeOperations: 0, activeIds: [], gateClosed: false } };
  const approval = { version: 1, purpose: 'quiescent-settled-isolated-epoch-upgrade-v1', clientId: 'owner',
    epochId: pointer.epochId, document: pointer.document, currentInstance: instance, pointerHash: snapshot.pointerHash,
    previousBuildHash: build, buildHash: 'd'.repeat(64), sourceCommit: 'e'.repeat(40), requestId: 'synthetic-upgrade',
    settledJobIds: [id], settledEvidenceHash: hash(JSON.stringify(refs)) };
  return { root, dir, state, pointer, job, record, rpcFile, receipt, remote, evidence, approval, snapshot };
}

test('FAKE files: successful SDK evidence is independently bound and the historical SDK0 contract still rejects it', t => {
  const f = fixture(t);
  assert.equal(f.evidence().length, 12);
  assertSettledEpochUpgrade(f.snapshot, f.approval);
  assert.throws(() => assertEpochUpgrade(f.snapshot, f.approval));
  assert.throws(() => assertEpochUpgrade(f.snapshot, { ...f.approval, purpose: 'quiescent-isolated-epoch-checker-upgrade-v1', rejectedJobIds: [] }),
    { code: 'EPOCH_UPGRADE_REQUIRES_SDK0' });
});

for (const [name, change] of [
  ['wrong owner', f => { f.approval.clientId = 'foreign'; }],
  ['wrong credential', f => { f.snapshot.ownerTokenHash = 'foreign'; }],
  ['missing carried job', f => { f.approval.settledJobIds = []; }],
  ['duplicate carried job', f => { f.approval.settledJobIds.push(f.job.id); }],
  ['legacy rejected IDs', f => { f.approval.rejectedJobIds = []; }],
  ['changed evidence hash', f => { f.approval.settledEvidenceHash = 'f'.repeat(64); }],
  ['active operation', f => { f.snapshot.control.activeOperations = 1; }],
  ['active lease', f => { f.snapshot.state.lease = {}; }],
  ['unknown local control', f => { f.snapshot.state.controlBlocked = {}; }],
  ['cleanup intent', f => { f.snapshot.cleanupIntent = true; }],
  ['uncertain selected process', f => { f.snapshot.selectedLive = null; }],
]) test('FAKE snapshot: settled contract refuses ' + name, t => {
  const f = fixture(t); change(f);
  assert.throws(() => assertSettledEpochUpgrade(f.snapshot, f.approval));
});

for (const [name, change] of [
  ['unknown job', f => { f.job.state = 'needs_reconciliation'; }],
  ['unsettled job', f => { f.job.details.sdkSettled = false; }],
  ['failed job', f => { f.job.state = 'failed'; }],
  ['other document', f => { f.job.request.payload.docId = 'foreign'; }],
  ['raw script', f => { f.job.request.payload.kind = 'run'; }],
  ['active lease identity', f => { f.job.sequenceId = 'lease'; }],
  ['missing RPC', f => { fs.unlinkSync(f.rpcFile); }],
  ['unpublished outcome', f => { durable(path.join(f.dir, 'outcome.json'), { ...f.job.details, state: 'succeeded', publicationOutcome: 'unknown' }); }],
  ['live worker', f => { const api = require('../src/queue-instance'); durable(path.join(f.dir, 'worker-identity.json'), { pid: process.pid, birth: api.processBirth() }); }],
  ['terminal flag alone', f => { f.record.nonterminal = true; durable(f.rpcFile, f.record); }],
  ['wrong epoch RPC', f => { f.record.binding.isolatedEpoch = 'foreign'; durable(f.rpcFile, f.record); }],
  ['relabeled job build', f => { f.job.request.buildHash = 'd'.repeat(64); }],
  ['unchecked RPC', f => { f.record.pythonCheck.status = 'rejected'; durable(f.rpcFile, f.record); }],
  ['missing physical receipt', f => { fs.unlinkSync(f.receipt); }],
  ['forged receipt cache', f => { f.record.remoteReceipt.outcome = 'failed'; durable(f.rpcFile, f.record); }],
  ['foreign process', f => { durable(f.receipt, { ...f.remote, instance: { ...f.remote.instance, birth: 'other' } }); }],
  ['extra remote receipt', f => { durable(path.join(f.dir, 'remote-unaccounted.json'), {}); }],
  ['orphan native end', f => { durable(f.receipt + '.native-end.json', {}); }],
  ['missing postflight', f => { fs.unlinkSync(path.join(f.dir, 'postflight.json')); }],
  ['failed preflight', f => { durable(path.join(f.dir, 'preflight-result.json'), { stage: 'instance_probe', failed: true }); }],
  ['unaccounted probe', f => { durable(path.join(f.dir, 'postflight-unaccounted.receipt.json'), {}); }],
]) test('FAKE files: reject ' + name + ' without SDK or state changes', t => {
  const f = fixture(t); change(f); assert.throws(f.evidence);
});

test('FAKE files: a later runtime identity preserves the original build on already settled jobs', t => {
  const f = fixture(t);
  const original = f.evidence();
  f.snapshot.identity.buildHash = 'd'.repeat(64);
  f.snapshot.control.buildHash = 'd'.repeat(64);
  f.approval.previousBuildHash = 'd'.repeat(64);
  // Reproduce the former adapter call with the later departing build. The
  // reader must not replace a job's original build with this extra argument.
  assert.deepEqual(settledEpochEvidence(f.root, f.state, f.pointer, f.approval.previousBuildHash), original);
  assertSettledEpochUpgrade(f.snapshot, f.approval);
  assert.equal(f.job.request.buildHash, 'a'.repeat(64));
});

test('FAKE files: an exact granted fixed program may carry known successful SDK evidence without promoting raw scripts', t => {
  const f = fixture(t), api = require('../src/queue-instance');
  const installation = path.resolve(__dirname, '../dist');
  const contract = require('../src/queue-native-fixture-grant').fixtureContract('sketch-proof-program-v1');
  const originalBuild = api.buildHash(installation), tokenHash = api.hash('synthetic-fixed-client');
  const script = path.join(installation, contract.script);
  f.job.clientId = 'fixed-client'; f.job.kind = 'command';
  f.job.request = { ...f.job.request, kind: 'command', clientId: f.job.clientId, buildHash: originalBuild,
    payload: { version: 1, kind: 'run', request: { name: script, hasArgs: true, helperVersion: 'cad-v1', readOnlyOperations: [],
      doc: f.pointer.document.name, identity: { docId: f.pointer.document.creationId },
      args: { approved: true, creationId: f.pointer.document.creationId,
        expectedFusionVersion: f.pointer.currentInstance.version, fixturePrefix: 'NQFIXED01' } } },
    inputFiles: [{ path: script, sha256: contract.scriptSha256 }] };
  f.job.request.argv = require('../src/cad-service').policyArguments(f.job.request.payload);
  durable(path.join(f.root, 'clients.json'), { [f.job.clientId]: tokenHash }, true);
  const grantFile = path.join(f.pointer.root || f.root, 'access-' + api.hash(f.job.clientId + '\0' + tokenHash) + '.json');
  f.pointer.root = f.root;
  const grant = { epochId: f.pointer.epochId, clientId: f.job.clientId, clientTokenHash: tokenHash, document: f.pointer.document,
    nativeFixture: { version: 1, ...contract, sourceCommit: 'e'.repeat(40), buildHash: originalBuild } };
  durable(grantFile, grant, true);
  for (const name of fs.readdirSync(f.dir).filter(name => name.endsWith('.json'))) {
    const file = path.join(f.dir, name);
    const replaceBuild = value => {
      if (!value || typeof value !== 'object') return;
      if (Object.hasOwn(value, 'buildHash')) value.buildHash = originalBuild;
      for (const child of Object.values(value)) replaceBuild(child);
    };
    const value = JSON.parse(fs.readFileSync(file)); replaceBuild(value);
    if (name.startsWith('rpc-')) delete value.nonterminal;
    durable(file, value);
  }
  assert.equal(f.evidence().length, 16);
  f.job.request.inputFiles[0].sha256 = 'f'.repeat(64);
  assert.throws(f.evidence, /exact registered source/);
});

for (const crashStage of [null, 'paused', 'escrow', 'stopped', 'installed', 'identity', 'launch-intent', 'complete'])
test('FAKE ports: settled handoff preserves evidence through ' + (crashStage || 'normal completion'), async t => {
  const f = fixture(t), records = {}, calls = [];
  let crash = crashStage;
  const p = { authenticate: async () => {}, claim: async () => {}, unclaim() {}, approve: async () => f.approval,
    read: stage => records[stage], publish(stage, value) {
      records[stage] = structuredClone(value);
      if (stage === crash) { crash = null; throw new Error('synthetic publication interruption'); }
    },
    observe: async () => structuredClone(f.snapshot),
    async pause() { f.state.paused = true; f.state.controlGeneration++; f.snapshot.control.generation++; f.snapshot.control.gateClosed = true; },
    escrow: async () => ({ ref: 'synthetic' }), verifyEscrow: async () => {}, guardStartup: async () => {},
    stop: async () => { calls.push('cooperative-stop'); }, waitDead: async () => {}, localFence: async () => {},
    install: async () => { calls.push('immutable-candidate'); return { immutableReleases: true }; }, verifyInstalled: async () => {},
    writeEpochIdentity: async (_old, next) => { f.snapshot.identity = next; }, start: async () => { calls.push('one-worker'); },
    observeReady: async () => ({ ...structuredClone(f.snapshot), owner: { nonce: 'new-owner' },
      control: { ...f.snapshot.control, instanceId: 'new-owner', buildHash: f.approval.buildHash } }), release: async () => {} };
  const run = createSettledEpochRuntimeUpgrade(p);
  if (crashStage) await assert.rejects(run(), /synthetic publication interruption/);
  const receipt = await run(); await run();
  assert.equal(receipt.kind, 'quiescent-settled-isolated-epoch-runtime-upgrade');
  assert.equal(receipt.sdkRequestsSent, 0);
  assert.deepEqual(receipt.settledJobIds, f.approval.settledJobIds);
  assert.equal(receipt.localRejectedJobIds, undefined);
  assert.equal(receipt.publicReceipt.rejectedJobIds, undefined);
  assert.deepEqual(calls, ['cooperative-stop', 'immutable-candidate', 'one-worker']);
});

test('real queue store: shared pause/console-stop fence does not change the already captured paused state', t => {
  const root = fs.mkdtempSync('/tmp/opencode/settled-pause-stop-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = new (require('../src/queue-state').QueueState)(root);
  state.pause(true, 'owner:pause-stop');
  const before = fs.readFileSync(path.join(root, 'queue-state.json'));
  state.pause(true, 'owner:pause-stop');
  assert.deepEqual(fs.readFileSync(path.join(root, 'queue-state.json')), before);
});

for (const mode of ['missing-end', 'successful-end', 'failed-end', 'foreign-native-identity']) test('FAKE files: native lifecycle requires original successful completion: ' + mode, t => {
  const f = fixture(t);
  const identity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32), runId: 'settled-native-fixture', requestHash: 'b'.repeat(64),
    sessionNonce: 'c'.repeat(32), backend: 'addin', resolvedIdentity: { creationId: f.pointer.document.creationId } };
  const declaration = { ...f.record.binding, instance: f.pointer.currentInstance, terminal: false, stage: 'native-start',
    native: { kind: 'atomic-batch', identity } };
  durable(f.receipt + '.native-start.json', declaration, true);
  if (mode !== 'missing-end') {
    const completion = { ...f.record.binding, instance: f.pointer.currentInstance, terminal: true, stage: 'native-completion',
      outcome: mode === 'failed-end' ? 'failed' : 'succeeded', native: { kind: 'atomic-batch', identity: structuredClone(identity),
        state: { destroyed: true, completed: mode !== 'failed-end' } } };
    if (mode === 'foreign-native-identity') completion.native.identity.sessionNonce = 'd'.repeat(32);
    durable(f.receipt + '.native-end.json', completion, true);
  }
  if (mode === 'successful-end') assert.equal(f.evidence().length, 14);
  else assert.throws(f.evidence);
});
