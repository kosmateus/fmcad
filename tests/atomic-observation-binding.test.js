'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePythonArtifact } = require('../src/python');
const { hash: rawUtf8Hash } = require('../src/queue-instance');
const { atomicObservationIdentityHash, assertAtomicObservationIdentity,
  assertAtomicObservationWire } = require('../src/atomic-observation-binding');

function identity() {
  return { commandId: 'fmcad_atomic_' + 'a'.repeat(32), runId: 'owned-run', requestHash: 'b'.repeat(64),
    backend: 'addin', sessionNonce: 'c'.repeat(32), documentIdentity: {
      expected: { name: 'owned scratch', creationId: 'scratch-id', fileId: null },
      resolved: { name: 'owned scratch', creationId: 'scratch-id', fileId: null }, assertionsOnly: true,
    }, resolvedIdentity: { name: 'owned scratch', creationId: 'scratch-id', fileId: null } };
}
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
}

test('semantic identity survives nested JSON key ordering but never normalizes final wire bytes', () => {
  assert.equal(atomicObservationIdentityHash, require('../src/dist/core/application/cad/json').hash,
    'wire and ABI proof use the very same canonical implementation, not matching test strings');
  const original = identity(), alternate = reordered(original);
  assert.notEqual(JSON.stringify(original), JSON.stringify(alternate));
  const pinned = atomicObservationIdentityHash(original);
  const declared = atomicObservationIdentityHash(alternate);
  assert.equal(declared, pinned);
  assertAtomicObservationIdentity(alternate, declared, pinned);
  assert.notEqual(rawUtf8Hash(JSON.stringify(original)), rawUtf8Hash(JSON.stringify(alternate)),
    'transport/source byte hashing is deliberately a different contract');
  const artifact = preparePythonArtifact([{ id: 'wire', filename: '<binding-fixture>', role: 'wrapper',
    source: 'value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n' }]);
  let sent = 0;
  const admit = (subject, hash, code, prepared = artifact) => {
    assertAtomicObservationIdentity(subject, hash, pinned);
    assertAtomicObservationWire(code, prepared);
    sent++;
  };
  admit(alternate, declared, artifact.script);
  assert.equal(sent, 1);
  assert.throws(() => admit(alternate, declared, artifact.script + '\n'), { code: 'WORKFLOW_ARTIFACT_CHANGED' });
  assert.equal(sent, 1, 'unchanged semantic identity never authorizes altered actual wire bytes');
});

test('forged identity cannot be admitted even when the attacker rehashes the forged object consistently', () => {
  const original = identity(), pinned = atomicObservationIdentityHash(original);
  let sent = 0;
  for (const mutate of [
    value => { value.sessionNonce = 'd'.repeat(32); },
    value => { value.documentIdentity.expected.creationId = 'foreign-scratch'; },
    value => { value.documentIdentity.resolved.fileId = 'foreign-file'; },
    value => { value.resolvedIdentity.name = 'foreign-name'; },
  ]) {
    const forged = structuredClone(original); mutate(forged);
    const declared = atomicObservationIdentityHash(forged);
    assert.notEqual(declared, pinned);
    assert.throws(() => {
      assertAtomicObservationIdentity(forged, declared, pinned);
      sent++;
    }, { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  }
  assert.equal(sent, 0, 'the independent receipt/proof identity, not a caller-provided new hash, owns admission');
});

test('wire artifact byte/manifest tampering remains a local refusal before the sender', () => {
  const artifact = preparePythonArtifact([{ id: 'wire', filename: '<binding-fixture>', role: 'wrapper', source: 'value: int = 1\n' }]);
  const forged = { ...artifact, bytes: [...artifact.bytes] };
  forged.bytes[0] ^= 1;
  let sent = 0;
  assert.throws(() => {
    assertAtomicObservationWire(artifact.script, forged);
    sent++;
  }, { code: 'WORKFLOW_ARTIFACT_CHANGED' });
  assert.equal(sent, 0);
});
