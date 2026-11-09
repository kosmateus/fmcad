'use strict';
const test = require('node:test');
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash, durable, buildHash } = require('../src/queue-instance');
const { assertHeld } = require('../src/queue-atomic-migration');
const { auditUpgradeApproval, assertAuditUpgradeSnapshot, auditUpgradeStillCurrent } = require('../src/queue-atomic-audit-upgrade');
const { fastenersScope: scope } = require('../src/atomic-workflow-observation');
const createHistory = require('./fixtures/atomic-audit-upgrade.cjs');

test('second-window approval cannot reuse a qualification that only passed the first handoff', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-audit-qualification-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidateRoot = path.resolve(__dirname, '../dist'), installRoot = path.join(dir, 'installed');
  fs.mkdirSync(installRoot);
  const qualification = path.join(dir, 'qualification.json');
  const codeHash = buildHash(candidateRoot), sourceCommit = 'a'.repeat(40);
  durable(qualification, { sourceCommit, buildHash: codeHash, productionAdmission: true, passed: true });
  const approval = path.join(dir, 'approval.json');
  durable(approval, { version: 1, purpose: 'atomic-recovery-audit-upgrade-v1', sourceCommit, buildHash: codeHash,
    admissionModuleSha256: hash(fs.readFileSync(path.join(candidateRoot, 'src/queue-admission.js'))),
    checkerFingerprint: 'f'.repeat(64), candidateRoot, installRoot,
    qualification: { path: qualification, sha256: hash(fs.readFileSync(qualification)) } });
  await assert.rejects(require('../src/queue-atomic-migration-runtime').approvedCandidate(approval,
    () => assert.fail('No checker or final artifact may be used with an unqualified second window')),
  { code: 'QUALIFICATION_UNAVAILABLE' });
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-audit-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const observerId = '3627db2e-0b9d-4e4f-927f-20cb45deae74', clientId = 'owner';
  const target = { id: scope.jobId, requestId: scope.requestId, clientId, hash: hash('original'), kind: 'command',
    state: 'needs_reconciliation', physicalTurns: 2, dispatch: { rpcCount: 2, completedCount: 2 },
    request: { buildHash: 'original', cwd: scope.projectDirectory, backend: 'addin', payload: {
      version: 1, kind: 'cad', operation: 'batch.run', doc: 'Owned', docId: scope.docId,
      data: { runId: 'original', reportPath: scope.reportPath, atomic: true } } } };
  const observer = { id: observerId, clientId, hash: hash('observer'), state: 'needs_reconciliation',
    request: { buildHash: 'departing' }, dispatch: { rpcCount: 1, completedCount: 1 },
    workflowObservation: { targetJobId: target.id, targetJobHash: target.hash, observerJobHash: hash('observer') } };
  const owner = { pid: 123, birth: 'fixture:123', nonce: 'departing-owner', protocol: 2 };
  const snapshot = { owner, identity: { buildHash: 'original', instance: { pid: 456, birth: 'fixture:456', version: '2706' } },
    state: { jobs: { [target.id]: target, [observer.id]: observer }, active: observer.id, blocked: { id: target.id },
      paused: true, lease: null, controlGeneration: 25, contextEpoch: 12 },
    status: { paused: true, lease: null, stopping: false, nonterminalJobCount: 2, control: { instanceId: owner.nonce, buildHash: 'departing',
      generation: 25, contextEpoch: 12, activeOperations: 0, activeIds: [], gateClosed: true } } };
  return { dir, snapshot, clientId, ...createHistory(dir, snapshot) };
}

test('explicit second-window approval binds first complete, unavailable receipt and both unknown jobs', t => {
  const f = fixture(t);
  assert.equal(auditUpgradeApproval({ version: 1 }, f.dir), null);
  assert.equal(auditUpgradeStillCurrent(f.upgrade), true);
  assert.doesNotThrow(() => assertHeld(f.snapshot, f.clientId, scope, true, f.upgrade));
  assert.throws(() => assertHeld(f.snapshot, f.clientId, scope), { code: 'HOLDER_CHANGED' });
  assert.equal(f.upgrade.departingBuildHash, 'departing');
  assert.equal(f.upgrade.originalBuildHash, 'original');
});

test('changed predecessor, unavailable proof or original escrow digest refuses second-window acquisition', t => {
  for (const field of ['previousComplete', 'observationProof']) {
    const f = fixture(t), file = f.approval.auditUpgrade[field].path;
    fs.appendFileSync(file, '\n');
    assert.throws(() => auditUpgradeApproval(f.approval, f.dir), { code: 'AUDIT_UPGRADE_PROOF_INVALID' });
    assert.equal(auditUpgradeStillCurrent(f.upgrade), false);
  }
  const f = fixture(t);
  durable(f.upgrade.firstBackupManifest.path, { altered: true });
  assert.throws(() => auditUpgradeApproval(f.approval, f.dir), { code: 'AUDIT_UPGRADE_PROOF_INVALID' });
});

test('wrong observer client, body hash, state, unfinished RPC or departing owner cannot be normalized away', t => {
  const f = fixture(t);
  for (const change of [
    s => { s.owner.birth = 'reused-pid'; }, s => { s.identity.buildHash = 'departing'; },
    s => { s.state.jobs[f.upgrade.observationJobId].clientId = 'foreign'; },
    s => { s.state.jobs[f.upgrade.observationJobId].hash = 'changed'; },
    s => { s.state.jobs[f.upgrade.observationJobId].state = 'succeeded'; },
    s => { s.state.jobs[f.upgrade.observationJobId].dispatch.completedCount = 0; },
  ]) {
    const snapshot = structuredClone(f.snapshot); change(snapshot);
    assert.throws(() => assertAuditUpgradeSnapshot(f.upgrade, snapshot, f.clientId), { code: 'AUDIT_UPGRADE_PROOF_INVALID' });
  }
});

test('real audit migration preflight certifies canonical final bytes without original ABI exemptions or sends', { timeout: 30000 }, async () => {
  const api = require('../src/queue-atomic-recovery-audit');
  const admission = require('../src/queue-admission');
  const identity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32), sessionNonce: 'b'.repeat(32), runId: 'owned',
    requestHash: 'c'.repeat(64), backend: 'addin', resolvedIdentity: { name: 'Owned', creationId: 'owned-id', fileId: null } };
  const binding = { purpose: 'atomic-recovery-audit-v1', targetJobId: scope.jobId,
    observationJobId: '3627db2e-0b9d-4e4f-927f-20cb45deae74', priorProofHash: 'd'.repeat(64) };
  const reader = api.prepareRecoveryAudit(path.resolve(__dirname, '..'), identity, binding);
  const prepare = () => api.prepareRecoveryAuditWire({ reader, auditBinding: binding, jobId: scope.jobId,
    buildHash: buildHash(), instance: { pid: 123, birth: 'fixture', version: '2706' },
    receipt: '/tmp/opencode/not-sent-audit-preflight.receipt.json', rpcId: '11111111-1111-4111-8111-111111111111',
    payload: { jsonrpc: '2.0', id: 'preflight', method: 'tools/call', params: { name: 'execute_python',
      arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
  const first = await admission.recoveryAuditAdmissionPreflight(prepare());
  const second = await admission.recoveryAuditAdmissionPreflight(prepare());
  assert.equal(first.status, 'passed');
  assert.equal(first.checker.name, 'basedpyright');
  assert.deepEqual(first, second, 'Same request-bound admission must be stable across continuation, not timestamp/random bound');
  assert.equal(first.executedUnits.length, 2);
  assert.equal(Object.hasOwn(first, 'abiPinnedUnits'), false, 'Audit does not interpret a transactional ABI');
  const tampered = prepare(); tampered.outgoing.params.arguments.code += '\n';
  await assert.rejects(admission.recoveryAuditAdmissionPreflight(tampered), { code: 'WORKFLOW_ARTIFACT_CHANGED' });
});
