'use strict';
const test = require('node:test');
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareAuditFactsCapture, auditFactsAction } = require('../src/queue-audit-facts-capture');
const { prepareRecoveryAuditWire } = require('../src/queue-atomic-recovery-audit');
const { createProductionQueueAdmission } = require('../src/queue-admission');
const { resolveRuntimePaths } = require('../src/dist/config-platform');

test('explicit capture uses actual production final-byte checker and both immutable source units', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/opencode/audit-capture-check-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binding = { purpose: 'atomic-recovery-audit-facts-capture-v1', originalRpcId: 'original-rpc',
    originalEvidenceHash: 'a'.repeat(64), currentInstance: { pid: 1, birth: 'fixture', version: '2706' },
    captureProofPath: path.join(directory, 'sdk-facts.json') };
  const reader = prepareAuditFactsCapture(path.resolve(__dirname, '..'), { commandId: 'fmcad_atomic_fixture',
    resolvedIdentity: { name: 'Historical', creationId: 'historical-id', fileId: null } }, binding, { directory });
  const prepared = prepareRecoveryAuditWire({ reader, receipt: path.join(directory, 'never-sent.json'), instance: binding.currentInstance,
    buildHash: 'fixture-build', jobId: 'old-owned-job', auditBinding: binding,
    payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_python',
      arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
  const production = createProductionQueueAdmission(resolveRuntimePaths({ anchor: __filename }).runtime);
  const certificate = await production.admission.check(prepared.outgoing, prepared.artifact);
  assert.equal(certificate.report.status, 'passed'); assert.equal(certificate.report.provenance.checker, 'basedpyright');
  assert.equal(prepared.artifact.context.origin.units.filter(unit => unit.role === 'runtime').length, 2);
  certificate.fence(prepared.outgoing); prepared.outgoing.params.arguments.code += '\n# changed bytes';
  assert.throws(() => certificate.fence(prepared.outgoing));
  assert.equal(fs.existsSync(binding.captureProofPath), false, 'Checker never executes a read or creates SDK proof');
});

test('legacy capability cannot authorize a new read and CLI requires exact explicit confirmation', async () => {
  const calls = [];
  await assert.rejects(auditFactsAction({ async call(action) { calls.push(action); return { features: {} }; } },
    'capture-audit-facts', {}, 'new'), { code: 'AUDIT_CAPTURE_UNSUPPORTED' });
  assert.deepEqual(calls, ['queue-summary']);
  for (const extra of [[], ['--client', 'foreign'], ['--accept-outcome', 'aborted'], ['--doc-id', 'old'], ['--confirm-read-only', 'false']]) {
    await assert.rejects(require('../src/queue-cli').queueCommand(['capture-audit-facts', '--job', 'target',
      '--observation-job', 'observer', '--request-id', 'ORIGINAL-request', ...extra], {
      loadConfig() { assert.fail('Invalid command must not access private config or credentials'); },
    }));
  }
});

test('recovery runtime cannot reuse a 303 qualification without its explicit capture qualification', async t => {
  const dir = fs.mkdtempSync('/tmp/opencode/capture-qualification-refusal-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidateRoot = path.resolve(__dirname, '../dist'), api = require('../src/queue-instance');
  const installRoot = path.join(dir, 'installed'); fs.mkdirSync(installRoot);
  const sourceCommit = 'a'.repeat(40), codeHash = api.buildHash(candidateRoot), qualification = path.join(dir, 'qualification.json');
  api.durable(qualification, { sourceCommit, buildHash: codeHash, passed: true, productionAdmission: true,
    auditUpgradeQualified: true, processLossAuditQualified: true, isolatedEpochQualified: true }, true);
  const approval = path.join(dir, 'approval.json');
  api.durable(approval, { version: 1, purpose: 'atomic-audit-facts-recovery-upgrade-v1', sourceCommit, buildHash: codeHash,
    candidateRoot, installRoot, checkerFingerprint: 'f'.repeat(64),
    admissionModuleSha256: api.hash(fs.readFileSync(path.join(candidateRoot, 'src/queue-admission.js'))),
    qualification: { path: qualification, sha256: api.hash(fs.readFileSync(qualification)) } }, true);
  await assert.rejects(require('../src/queue-atomic-migration-runtime').approvedCandidate(approval,
    () => assert.fail('Never prepare/send a capture under an unqualified runtime')), { code: 'QUALIFICATION_UNAVAILABLE' });
});
