'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { durable, readJson } = require('../src/queue-instance');
const { reference } = require('../src/queue-epoch-lineage');
const digest = value => require('../src/dist/core/application/cad/json').hash(value);
const { closedEpochProof } = require('../src/queue-closed-epoch-proof');

function fixture(t, capture = true) {
  const root = fs.mkdtempSync('/tmp/opencode/closed-epoch-proof-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const epochId = randomUUID(), epoch = path.join(root, 'admission-epochs', epochId);
  fs.mkdirSync(epoch, { recursive: true });
  const pointer = { epochId, root: epoch, ownerClientId: 'original-owner', ownerTokenHash: 'a'.repeat(64),
    document: { name: 'SYNTHETIC_OWNED', creationId: 'owned-scratch-id', fileId: null },
    currentInstance: { pid: 123, birth: 'synthetic-birth', version: 'fixture' },
    ...(capture ? { restoreActiveCreationId: 'original-user-document' } : {}) };
  const dir = path.join(root, 'isolated-scratch-close'); fs.mkdirSync(dir);
  const binding = { purpose: 'isolated-scratch-close-v1', epochId, clientId: pointer.ownerClientId,
    ownerTokenHash: pointer.ownerTokenHash, document: pointer.document, currentInstance: pointer.currentInstance,
    sdkProofPath: path.join(dir, 'sdk-closed.json'),
    ...(capture ? { restoreActiveCreationId: pointer.restoreActiveCreationId } : {}) };
  const proof = { version: 1, purpose: binding.purpose, document: pointer.document, bindingHash: digest(binding),
    closed: true, saved: false, historicalOutcome: 'unknown', originalModelValidation: 'not_performed',
    originalRollbackVerification: 'not_performed',
    ...(capture ? { activeBeforeCloseCreationId: pointer.document.creationId,
      restoredActiveCreationId: pointer.restoreActiveCreationId, activeDocumentRestored: true } : {}) };
  const rpcId = randomUUID(), startBinding = { purpose: binding.purpose, rpcId,
    auditBindingHash: digest(binding), pythonOriginHash: 'b'.repeat(64),
    auditExpectedInstance: pointer.currentInstance };
  const receipt = path.join(dir, 'remote-' + rpcId + '.json');
  durable(path.join(dir, 'intent.json'), { binding, sourceArtifactHash: startBinding.pythonOriginHash }, true);
  durable(path.join(dir, 'start.json'), { binding: startBinding, receipt, pythonCheck: { status: 'passed' } }, true);
  durable(path.join(dir, 'wire.json'), { synthetic: true }, true);
  durable(path.join(dir, 'sdk-closed.json'), proof, true);
  durable(receipt, { ...startBinding, terminal: true, outcome: 'succeeded', instance: pointer.currentInstance }, true);
  const resultFile = path.join(dir, 'result.json');
  durable(resultFile, { kind: 'isolated-scratch-close', status: 'complete', sdkRequestsSent: 1,
    endpointVerified: true, clientId: pointer.ownerClientId, summary: proof }, true);
  const closedFile = path.join(epoch, 'closed.json');
  function publish() {
    durable(closedFile, { epochId, document: pointer.document, historicalOutcome: 'unknown', receipt: reference(resultFile),
      qualificationEvidence: ['intent.json', 'start.json', 'wire.json', 'sdk-closed.json', path.basename(receipt)].map(name => reference(path.join(dir, name))) });
    return reference(closedFile);
  }
  let entry = publish();
  return { root, pointer, dir, proof, receipt, binding, resultFile, closedFile, publish,
    verify: () => closedEpochProof(root, pointer, entry), republish() { entry = publish(); } };
}

test('FAKE files: a real cleanup proof shape includes original SDK, physical outcome and active-document restore', t => {
  const f = fixture(t);
  assert.deepEqual(f.verify().proof, f.proof);
  assert.equal(f.verify().proof.activeDocumentRestored, true);
});

test('FAKE files: historical genesis cleanup without capture remains readable, not silently upgraded to restore PASS', t => {
  const f = fixture(t, false);
  assert.equal(f.verify().proof.activeDocumentRestored, undefined);
});

for (const [name, change, republish = false] of [
  ['label without SDK proof', f => { fs.unlinkSync(path.join(f.dir, 'sdk-closed.json')); }],
  ['changed SDK proof', f => { durable(path.join(f.dir, 'sdk-closed.json'), { ...f.proof, closed: false }); }],
  ['lost physical receipt', f => { fs.unlinkSync(f.receipt); }],
  ['failed physical receipt', f => { durable(f.receipt, { ...readJson(f.receipt), outcome: 'failed' }); }, true],
  ['foreign physical process', f => { durable(f.receipt, { ...readJson(f.receipt), instance: { ...f.pointer.currentInstance, birth: 'foreign' } }); }, true],
  ['unchecked source', f => { const file = path.join(f.dir, 'start.json'); durable(file, { ...readJson(file), pythonCheck: { status: 'failed' } }); }, true],
  ['pending result', f => { durable(f.resultFile, { ...readJson(f.resultFile), status: 'pending' }); }, true],
  ['different document', f => { f.pointer.document.creationId = 'user-document'; }],
  ['missing original restore', f => { f.pointer.restoreActiveCreationId = 'foreign-target'; }],
  ['modified restore evidence', f => { durable(path.join(f.dir, 'sdk-closed.json'), { ...f.proof, activeDocumentRestored: false }); }, true],
]) test('FAKE files: closure authority rejects ' + name + ' without SDK or filesystem mutations', t => {
  const f = fixture(t); change(f);
  if (republish) f.republish();
  assert.throws(f.verify);
});
