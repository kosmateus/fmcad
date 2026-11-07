'use strict';

const { hash: canonicalJsonHash } = require('./dist/core/application/cad/json');
const { verifyPythonArtifact } = require('./python');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// observationIdentityHash is semantic canonical JSON (including nested objects).
// It is NOT binding.sourceHash (unwrapped Python UTF-8) or artifact.sha256
// (final receipt-wrapped Python UTF-8). Those byte identities never normalize.
// Re-export the exact existing implementation used by ABI proof hashing; do not
// introduce an equivalent-looking second serializer or a wire JSON hash.
const atomicObservationIdentityHash = canonicalJsonHash;

function assertAtomicObservationIdentity(identity, declaredHash, expectedHash) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !/^[a-f0-9]{64}$/.test(expectedHash || '') || declaredHash !== expectedHash ||
      atomicObservationIdentityHash(identity) !== expectedHash)
    fail('WORKFLOW_IDENTITY_MISMATCH', 'Observation identity binding differs from the independently pinned identity');
}

function assertAtomicObservationWire(code, artifact) {
  try { verifyPythonArtifact(artifact); }
  catch { fail('WORKFLOW_ARTIFACT_CHANGED', 'Final atomic observation artifact identity changed'); }
  if (typeof code !== 'string' || code !== artifact.script)
    fail('WORKFLOW_ARTIFACT_CHANGED', 'Actual atomic observation wire bytes differ from the verified artifact');
}

module.exports = { atomicObservationIdentityHash, assertAtomicObservationIdentity, assertAtomicObservationWire };
