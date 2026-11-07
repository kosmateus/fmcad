'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const api = require('../src/dist/core/application/stage-journal');
const persistence = require('../src/dist/node-adapters/persistence/stage-journal');
const accepted = require('../src/dist/node-adapters/persistence/accepted-inputs');
const { readJson, durable } = require('../src/dist/node-adapters/persistence/records');
const { createNativeReceipts } = require('../src/dist/node-adapters/execution/native-receipt');

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/opencode/stage-journal-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = { clientId: 'client', requestId: 'request', payload: { source: 'original accepted input' } };
  accepted.retainAdmission(root, request);
  const scope = { owner: 'owner', clientId: 'client', project: root, jobId: 'job', sequence: 'none', requestId: 'request', requestHash: 'request-hash', build: 'build', document: 'pinned-doc', inputIdentity: accepted.readAdmission(root, request).inputIdentity };
  const stages = [{ id: 'first', requestHash: 'first-hash', mutates: true }, { id: 'second', requestHash: 'second-hash', mutates: true }];
  const binding = { jobId: scope.jobId, rpcId: 'rpc-first', requestHash: stages[0].requestHash, buildHash: scope.build };
  const reference = persistence.stageReceiptReference(Buffer.from(JSON.stringify(binding)));
  const nativeRecord = { receipt: path.join(root, 'receipt'), binding, instance: { document: scope.document } };
  const native = createNativeReceipts({ readJson, sameInstance: isDeepStrictEqual, identity: ({ identity }) => identity });
  const evidence = persistence.stageEvidence(root, (expected, stage, ref) => {
    if (ref !== reference || stage.requestHash !== binding.requestHash || expected.jobId !== binding.jobId || expected.build !== binding.buildHash || expected.document !== nativeRecord.instance.document) return { status: 'corrupt' };
    // The production native reader, not a fixture success flag, validates the
    // existing broker native lifecycle receipts and their RPC/build/instance.
    const end = native.completion(nativeRecord);
    const hash = end ? persistence.stageReceiptReference(fs.readFileSync(nativeRecord.receipt + '.native-end.json')) : undefined;
    return { status: !end ? 'missing' : end.outcome === 'succeeded' ? 'completed' : 'unknown', sha256: hash, ownerTerminalSha256: hash, nativeTerminalSha256: hash, postflightSha256: hash };
  });
  const journal = persistence.openStageJournal(root, scope, api.validateStageJournal);
  const stage = api.createStageApi(journal, scope);
  function complete() {
    const identity = { kind: 'transaction' };
    durable(nativeRecord.receipt + '.native-start.json', { ...binding, instance: nativeRecord.instance, terminal: false, stage: 'native-start', native: { kind: identity.kind, identity } }, true);
    durable(nativeRecord.receipt + '.native-end.json', { ...binding, instance: nativeRecord.instance, terminal: true, stage: 'native-completion', outcome: 'succeeded', native: { kind: identity.kind, identity, state: { destroyed: true, completed: true } } }, true);
  }
  return { root, scope, stages, reference, evidence, journal, stage, complete, nativeRecord };
}

test('completed stage survives response loss and child process crash; next stage is advice only', t => {
  const f = fixture(t);
  f.stage.plan(f.stages);
  f.stage.started('first', f.reference);
  f.complete();
  const modulePath = require.resolve('../src/dist/node-adapters/persistence/stage-journal');
  // A disconnected second process observes the existing immutable intent.
  const corePath = require.resolve('../src/dist/core/application/stage-journal');
  const result = JSON.parse(execFileSync(process.execPath, ['-e', `const p=require(${JSON.stringify(modulePath)}),a=require(${JSON.stringify(corePath)}); console.log(JSON.stringify(p.openStageJournal(${JSON.stringify(f.root)},${JSON.stringify(f.scope)},a.validateStageJournal).read()));`], { encoding: 'utf8' }));
  assert.equal(result.length, 2);
  const plan = api.resumeStagePlan(persistence.openStageJournal(f.root, f.scope, api.validateStageJournal), f.scope, f.evidence);
  assert.equal(plan.status, 'valid');
  assert.deepEqual(plan.stages, [{ id: 'first', status: 'completed' }, { id: 'second', status: 'notStarted' }]);
  assert.equal(plan.nextStage, 'second');
  assert.equal(plan.replayAllowed, false);
  assert.equal(plan.automaticResume, false);
  assert.ok(plan.revalidate.some(value => value.includes('build')));
  assert.equal(api.revalidateStagePlan(plan, f.journal, f.scope, f.evidence).valid, true);
  const endFile = f.nativeRecord.receipt + '.native-end.json';
  fs.appendFileSync(endFile, '\n');
  assert.equal(api.revalidateStagePlan(plan, f.journal, f.scope, f.evidence).valid, false);
  assert.throws(() => f.stage.started('first', f.reference), /repeated|Invalid/);
});

test('real child exits after durable intent and before response; unknown mutation never replayed', t => {
  const f = fixture(t);
  f.stage.plan(f.stages);
  const p = require.resolve('../src/dist/node-adapters/persistence/stage-journal');
  const a = require.resolve('../src/dist/core/application/stage-journal');
  const child = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(p)}),a=require(${JSON.stringify(a)}); const scope=${JSON.stringify(f.scope)}; a.createStageApi(p.openStageJournal(${JSON.stringify(f.root)},scope,a.validateStageJournal),scope).started('first',${JSON.stringify(f.reference)}); process.exit(19);`]);
  assert.equal(child.status, 19);
  const result = api.resumeStagePlan(f.journal, f.scope, f.evidence);
  assert.equal(result.stages[0].status, 'unknown');
  assert.equal(result.status, 'reconciliationRequired');
  assert.equal(result.nextStage, null);
  assert.equal(result.replayAllowed, false);
  assert.equal(fs.readdirSync(path.join(f.root, 'stages')).length, 2);
});

for (const field of ['owner', 'clientId', 'project', 'jobId', 'sequence', 'requestId', 'requestHash', 'build', 'document', 'inputIdentity']) {
  test(`foreign ${field} refuses journal inspection`, t => {
    const f = fixture(t); f.stage.plan(f.stages); f.stage.started('first', f.reference); f.complete();
    const foreign = { ...f.scope, [field]: 'foreign' };
    const result = api.resumeStagePlan(persistence.openStageJournal(f.root, foreign, api.validateStageJournal), foreign, f.evidence);
    assert.equal(result.status, 'reconciliationRequired');
    assert.equal(result.nextStage, null);
  });
}

test('missing journal is not notStarted; gaps, corruption and missing trailing records require reconciliation', t => {
  const f = fixture(t);
  assert.equal(api.inspectStageJournal(f.journal, f.scope, f.evidence).status, 'missing');
  f.stage.plan(f.stages); f.stage.started('first', f.reference);
  const head = f.journal.read().at(-1).sha256;
  const file = path.join(f.root, 'stages/00000001.json');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, '{}');
  assert.equal(api.inspectStageJournal(f.journal, f.scope, f.evidence).status, 'reconciliationRequired');
  fs.writeFileSync(file, original);
  fs.renameSync(file, path.join(f.root, 'stages/00000002.json'));
  assert.match(api.inspectStageJournal(f.journal, f.scope, f.evidence).reasons[0], /gap/);
  fs.unlinkSync(path.join(f.root, 'stages/00000002.json'));
  assert.match(api.inspectStageJournal(f.journal, f.scope, f.evidence, head).reasons[0], /trailing/);
});

test('scope without an explicit sequence binding is rejected', t => {
  const f = fixture(t);
  f.stage.plan(f.stages);
  const { sequence, ...incomplete } = f.scope;
  assert.equal(typeof sequence, 'string');
  assert.throws(() => api.validateStageJournal([], incomplete), /every identity binding/);
  assert.equal(api.inspectStageJournal(f.journal, incomplete, f.evidence).status, 'reconciliationRequired');
});

test('missing accepted original cannot be replaced by edited input; receipt tampering and mismatched build/doc fail closed', t => {
  const f = fixture(t); f.stage.plan(f.stages); f.stage.started('first', f.reference); f.complete();
  const admitted = accepted.readAdmission(f.root, f.scope);
  fs.unlinkSync(path.join(f.root, 'accepted', admitted.inputs[0].sha256));
  assert.equal(api.resumeStagePlan(f.journal, f.scope, f.evidence).status, 'reconciliationRequired');
  for (const field of ['buildHash', 'instance']) {
    const file = f.nativeRecord.receipt + '.native-end.json';
    const proof = readJson(file);
    fs.writeFileSync(file, JSON.stringify({ ...proof, [field]: field === 'instance' ? { document: 'wrong' } : 'wrong-build' }));
    const result = api.resumeStagePlan(f.journal, f.scope, f.evidence);
    assert.equal(result.status, 'reconciliationRequired');
    assert.equal(result.nextStage, null);
    fs.writeFileSync(file, JSON.stringify(proof));
  }
});

test('append is exclusive, immutable and refuses symlinked record reads', t => {
  const f = fixture(t); f.stage.plan(f.stages);
  const first = f.journal.read()[0];
  assert.throws(() => f.journal.append(first));
  const file = path.join(f.root, 'stages/00000000.json');
  const copy = path.join(f.root, 'copy.json'); fs.copyFileSync(file, copy); fs.unlinkSync(file); fs.symlinkSync(copy, file);
  assert.equal(api.inspectStageJournal(f.journal, f.scope, f.evidence).status, 'reconciliationRequired');
});

test('fully completed plan has no continuation; raw success without bound receipt hash cannot upgrade unknown', t => {
  const f = fixture(t);
  f.stage.plan([f.stages[0]]); f.stage.started('first', f.reference); f.complete();
  assert.equal(api.resumeStagePlan(f.journal, f.scope, f.evidence).nextStage, null);
  assert.equal(api.resumeStagePlan(f.journal, f.scope, f.evidence).status, 'valid');
  const unsafe = { ...f.evidence, receipt: () => ({ status: 'completed', safeReplay: true }) };
  const plan = api.resumeStagePlan(f.journal, f.scope, unsafe);
  assert.equal(plan.stages[0].status, 'unknown');
  assert.equal(plan.replayAllowed, false);
  assert.equal(plan.nextStage, null);
});

test('intent hash binds the exact stage request and mutation metadata', t => {
  const f = fixture(t); f.stage.plan(f.stages);
  const file = path.join(f.root, 'stages/00000000.json');
  const plan = readJson(file); plan.event.stages[0].requestHash = 'substituted';
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.equal(api.resumeStagePlan(f.journal, f.scope, f.evidence).status, 'reconciliationRequired');
  assert.throws(() => f.stage.started('first', f.reference), /corruption/);
});
