const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist/src');
const { buildHash, hash, prepareReceiptScript } = require(path.join(dist, 'queue-instance'));
const { resolveRuntimePaths } = require(path.join(dist, 'dist/config-platform'));
const canonicalHash = value => require(path.join(dist, 'dist/core/application/cad/json')).hash(value);
const { cadBundleUnits, preparePythonArtifact, pythonArtifactManifest, retainPythonOrigin } = require(path.join(dist, 'python'));
const runtime = resolveRuntimePaths({ anchor: path.join(dist, 'queue-broker.js') }).runtime;

function preparedObserver(code, directory, preserveOrigin = true, abiKind = 'original-unit-manifest-v1') {
  const rpcId = 'fmcad-observer-test';
  const installation = resolveRuntimePaths({ anchor: path.join(dist, 'queue-broker.js') }).installation;
  const abiPaths = new Set(['runtime/python/fmcad/adapters/fusion/atomic.py',
    'runtime/python/fmcad/adapters/fusion/identity.py', 'runtime/python/fmcad/adapters/fusion/values.py',
    'runtime/python/fmcad/domain/values.py', 'assets/cad/core.py']);
  const abiPinnedUnits = cadBundleUnits(installation).filter(unit => abiPaths.has(unit.filename))
    .map(unit => ({ id: unit.id, filename: unit.filename, sha256: hash(unit.source) }));
  const atomicRuntimeAbi = { version: 1, kind: abiKind, jobId: 'blocked-job',
    requestId: 'blocked-request', jobHash: 'b'.repeat(64), originalBuildHash: 'c'.repeat(64),
    identityHash: 'a'.repeat(64), abiPinnedUnits,
    sourceReceipts: [{ rpcId: '1'.repeat(36), sourceHash: 'd'.repeat(64) },
      { rpcId: '2'.repeat(36), sourceHash: 'e'.repeat(64) }] };
  if (abiKind === 'legacy-full-program-witness-v1') {
    atomicRuntimeAbi.witness = { operation: 'atomic_resolve', rpcId: atomicRuntimeAbi.sourceReceipts[0].rpcId,
      sourceHash: atomicRuntimeAbi.sourceReceipts[0].sourceHash, generatorBuildHash: atomicRuntimeAbi.originalBuildHash,
      reconstructedBuilderArtifactHash: 'f'.repeat(64), originalReceiptArtifactHash: 'e'.repeat(64) };
  }
  const atomicRuntimeAbiHash = canonicalHash(atomicRuntimeAbi);
  const originContext = { kind: 'atomic-status-readonly-v1', executedUnits: [
    'runtime/python/fmcad/adapters/fusion/atomic_status.py', '<fmcad-wrapper>'],
    abiPinnedUnits, atomicRuntimeAbiHash };
  const originalArtifact = preparePythonArtifact([{
    id: 'atomic-status', filename: 'runtime/python/fmcad/adapters/fusion/atomic_status.py',
    source: code, role: 'runtime',
  }, { id: 'wrapper', filename: '<fmcad-wrapper>', source: 'run("")\n', role: 'wrapper' }],
  { context: originContext, request: { operation: 'atomic_status' } });
  const finalCode = originalArtifact.script;
  const original = { jsonrpc: '2.0', id: 'caller', method: 'tools/call',
    params: { name: 'execute_python', arguments: { code: finalCode, persistent: false } } };
  const binding = { jobId: 'observer-job', rpcId, requestHash: hash(JSON.stringify(original)),
    buildHash: buildHash(), sourceHash: hash(finalCode), observationKind: 'atomic_holder_status',
    observationTargetJobId: 'blocked-job', observationIdentityHash: 'a'.repeat(64),
    atomicRuntimeAbiHash, pythonOriginHash: pythonArtifactManifest(originalArtifact).artifactHash };
  const receipt = path.join(directory, 'receipt.json');
  const receiptArtifact = prepareReceiptScript(finalCode, false, receipt, binding, { mapPath: file => file });
  const pythonArtifact = preserveOrigin
    ? retainPythonOrigin(receiptArtifact, pythonArtifactManifest(originalArtifact))
    : receiptArtifact;
  const outgoing = structuredClone(original);
  outgoing.id = 'fmcad:' + rpcId;
  outgoing.params.arguments.code = pythonArtifact.script;
  const record = { binding, atomicRuntimeAbi, receipt, request: { jsonrpc: '2.0', id: original.id, method: original.method },
    wireRequest: { jsonrpc: '2.0', id: outgoing.id, method: outgoing.method }, terminal: false, method: outgoing.method,
    pythonArtifact: { version: pythonArtifact.version, sha256: pythonArtifact.sha256,
      artifactHash: pythonArtifact.artifactHash, sourceMap: pythonArtifact.sourceMap,
      context: pythonArtifact.context, request: pythonArtifact.request,
      units: pythonArtifact.units.map(({ id, filename, role, sha256 }) => ({ id, filename, role, sha256 })) } };
  return { outgoing, pythonArtifact, record, rpcId, dispatchTimeoutMs: 30000 };
}

module.exports = { preparedObserver, runtime };
