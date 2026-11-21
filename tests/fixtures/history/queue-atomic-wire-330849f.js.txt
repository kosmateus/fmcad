'use strict';

const { hash, prepareReceiptScript } = require('./queue-instance');
const { verifyPythonArtifact, pythonArtifactManifest, retainPythonOrigin } = require('./python');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const { atomicObservationIdentityHash, assertAtomicObservationIdentity } = require('./atomic-observation-binding');

// One final-byte constructor for the real scoped observer and offline migration
// qualification. This only prepares bytes; it never publishes receipts or sends.
function prepareAtomicObservationWire({ payload, rpcId, observerJobId, targetJobId,
  codeHash, identity, instance, receipt, dispatchTimeoutMs, originArtifact, atomicRuntimeAbi }) {
  if (typeof pythonArtifactManifest !== 'function' || typeof retainPythonOrigin !== 'function')
    throw Object.assign(new Error('Installed production origin-manifest support is unavailable'), { code: 'PYTHON_ADMISSION_UNAVAILABLE' });
  if (!atomicRuntimeAbi || canonicalHash(atomicRuntimeAbi.proof) !== atomicRuntimeAbi.hash ||
      originArtifact?.context?.atomicRuntimeAbiHash !== atomicRuntimeAbi.hash)
    throw Object.assign(new Error('Atomic wire requires its verified ABI proof and exact original executed manifest'), { code: 'BUILD_CHANGED' });
  const origin = pythonArtifactManifest(originArtifact);
  const code = payload.params.arguments.code;
  const request = { jsonrpc: '2.0', method: payload.method,
    ...(Object.hasOwn(payload, 'id') ? { id: payload.id } : {}) };
  const binding = { jobId: observerJobId, rpcId, requestHash: hash(JSON.stringify(payload)), buildHash: codeHash,
    sourceHash: hash(code), observationKind: 'atomic_holder_status',
    observationTargetJobId: targetJobId, observationIdentityHash: atomicObservationIdentityHash(identity),
    atomicRuntimeAbiHash: atomicRuntimeAbi.hash, pythonOriginHash: origin.artifactHash };
  assertAtomicObservationIdentity(identity, binding.observationIdentityHash, atomicRuntimeAbi.proof.identityHash);
  const artifact = retainPythonOrigin(prepareReceiptScript(code, false, receipt, binding), origin);
  verifyPythonArtifact(artifact);
  const wire = structuredClone(payload);
  if (Object.hasOwn(wire, 'id')) wire.id = 'fmcad:' + rpcId;
  wire.params.arguments.code = artifact.script;
  const entry = { binding, instance, request, wireRequest: { jsonrpc: '2.0', method: wire.method,
    ...(Object.hasOwn(wire, 'id') ? { id: wire.id } : {}) }, terminal: false, method: payload.method, receipt,
    atomicRuntimeAbi: atomicRuntimeAbi.proof };
  entry.pythonArtifact = { version: artifact.version, sha256: artifact.sha256, artifactHash: artifact.artifactHash,
    sourceMap: artifact.sourceMap, context: artifact.context, request: artifact.request,
    units: artifact.units.map(({ id, filename, role, sha256 }) => ({ id, filename, role, sha256 })) };
  return { record: entry, rpcId, outgoing: wire, pythonArtifact: artifact, dispatchTimeoutMs };
}

module.exports = { prepareAtomicObservationWire };
