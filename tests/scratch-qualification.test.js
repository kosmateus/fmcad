'use strict';
const test = require('node:test');
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prepareScratchQualification } = require('../src/queue-scratch-qualification');
const { prepareRecoveryAuditWire } = require('../src/queue-atomic-recovery-audit');
const { createProductionQueueAdmission } = require('../src/queue-admission');
const { resolveRuntimePaths } = require('../src/dist/config-platform');
const { buildHash } = require('../src/queue-instance');

for (const purpose of ['isolated-scratch-epoch-v1', 'isolated-scratch-close-v1']) {
  test('real checker validates complete final-byte origin for ' + purpose, { timeout: 45000 }, async t => {
    const directory = fs.mkdtempSync('/tmp/opencode/scratch-final-wire-');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const epochId = randomUUID();
    const binding = { purpose, epochId, currentInstance: { pid: 123, birth: 'expected', version: '2706' },
      forbiddenIds: ['historical-closed'], document: { name: 'FMCAD_ISOLATED_' + epochId, creationId: 'new-sdk-id', fileId: null },
      sdkProofPath: path.join(directory, purpose.includes('close') ? 'sdk-closed.json' : 'sdk-qualified.json') };
    const reader = prepareScratchQualification(path.resolve(__dirname, '..'), {}, binding, { directory });
    const prepared = prepareRecoveryAuditWire({ reader, receipt: path.join(directory, 'remote.json'),
      instance: binding.currentInstance, buildHash: buildHash(), jobId: 'historical-holder', auditBinding: binding,
      payload: { jsonrpc: '2.0', id: 'caller', method: 'tools/call', params: { name: 'execute_python',
        arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
    const production = createProductionQueueAdmission(resolveRuntimePaths({ anchor: __filename }).runtime);
    const certificate = await production.admission.check(prepared.outgoing, prepared.artifact);
    assert.equal(certificate.report.status, 'passed', JSON.stringify(certificate.report));
    assert.equal(certificate.report.provenance.checker, 'basedpyright');
    assert.equal(prepared.record.binding.purpose, purpose);
    assert.deepEqual(prepared.record.binding.auditExpectedInstance, binding.currentInstance);
    certificate.fence(prepared.outgoing);
    prepared.outgoing.params.arguments.code += '\n# unexpected bytes';
    assert.throws(() => certificate.fence(prepared.outgoing));
  });
}

test('legacy capability and forged CLI payload options cannot request scratch authority', async () => {
  const { scratchEpochAction } = require('../src/queue-scratch-control');
  const calls = [];
  await assert.rejects(scratchEpochAction({ async call(action) { calls.push(action); return { features: {} }; } },
    'create-isolated-scratch', {}, 'new-build'), { code: 'EPOCH_UNSUPPORTED' });
  assert.deepEqual(calls, ['queue-summary']);
  for (const command of ['create-isolated-scratch', 'close-isolated-scratch']) {
    for (const extra of [['--client', 'foreign'], ['--doc-id', 'old'], ['--accept-outcome', 'aborted'], ['--', 'run']])
      await assert.rejects(require('../src/queue-cli').queueCommand([command, '--job', 'target', '--observation-job', 'prior',
        '--request-id', 'one-scratch', ...extra], { loadConfig() { assert.fail('Bad flags cannot read credentials/config'); } }));
  }
});

for (const [operation, data] of [
  ['sketch.create', { name: 'EpochSection', plane: 'XY' }],
  ['sketch.geometry', { sketch: 'EpochSection', geometry: [{ type: 'rectangle', start: ['0 mm', '0 mm', '0 mm'], end: ['10 mm', '6 mm', '0 mm'] }] }],
  ['model.extrude', { name: 'EpochSolid', profile: { kind: 'profile', sketch: 'EpochSection', index: 0 }, distance: '4 mm', operation: 'newBody' }],
  ['entity.list', { kind: 'body' }],
]) test('minimal MCP path has real final-byte production admission: ' + operation, { timeout: 180000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/opencode/epoch-modeling-wire-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const epochId = randomUUID(), document = { name: 'FMCAD_ISOLATED_' + epochId, creationId: 'proven-new-doc' };
  const artifact = require('../src/cad').prepareCadScript(operation, data, { doc: document.name, docId: document.creationId });
  const binding = { purpose: 'isolated-epoch-modeling-v1', epochId, document, currentInstance: { pid: 123, birth: 'expected', version: '2706' } };
  const prepared = prepareRecoveryAuditWire({ reader: { artifact }, receipt: path.join(directory, 'remote.json'),
    instance: binding.currentInstance, buildHash: buildHash(), jobId: 'new-scratch-job', auditBinding: binding,
    payload: { jsonrpc: '2.0', id: 'caller', method: 'tools/call', params: { name: 'execute_python',
      arguments: { code: artifact.script + '\n\nrun("")\n', persistent: false } } } });
  const production = createProductionQueueAdmission(resolveRuntimePaths({ anchor: __filename }).runtime);
  const certificate = await production.admission.check(prepared.outgoing, prepared.artifact);
  assert.equal(certificate.report.status, 'passed', JSON.stringify(certificate.report));
  assert.equal(certificate.report.provenance.checker, 'basedpyright');
  certificate.fence(prepared.outgoing);
});
