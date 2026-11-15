'use strict';
// Synthetic legacy shapes, not a physical Fusion receipt. Never loads a test module.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const ref = file => ({ path: file, sha256: hash(fs.readFileSync(file)) });

function createFixture(t, repo) {
  const normal = require(repo + '/src/dist/composition/queue-normal-cold-successor');
  const { QueueState } = require(repo + '/src/queue-state');
  const dir = fs.mkdtempSync('/tmp/opencode/normal-retry-integration-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = { ...normal.normalColdProfile, epochId: randomUUID(), epochClientId: 'epoch:' + randomUUID(),
    jobId: randomUUID(), jobClientId: 'job:' + randomUUID(), jobRequestId: 'original:' + randomUUID(),
    rpcId: randomUUID(), creationId: randomUUID(), documentName: 'Untitled', requestKind: 'raw-rpc',
    sourceCommit: '1'.repeat(40), buildHash: '2'.repeat(64), configHash: '3'.repeat(64),
    sdk: { pid: 123456, birth: '134391913505880644', version: '2706-fixture' },
    metadata: { pid: 123457, birth: 'synthetic-boot:original' } };
  const epoch = path.join(dir, 'admission-epochs', p.epochId);
  const jobClient = { dir, auth: { clientId: p.jobClientId, clientToken: 'synthetic-job-token' } };
  const epochClient = { dir, auth: { clientId: p.epochClientId, clientToken: 'synthetic-epoch-token' } };
  const owner = { ...p.metadata, nonce: randomUUID(), protocol: 2 };
  const pointer = { epochId: p.epochId, root: epoch, ownerClientId: p.epochClientId,
    ownerTokenHash: hash(epochClient.auth.clientToken), currentInstance: p.sdk,
    document: { creationId: randomUUID(), fileId: null } };
  write(path.join(dir, 'clients.json'), { [p.jobClientId]: hash(jobClient.auth.clientToken),
    [p.epochClientId]: hash(epochClient.auth.clientToken) });
  write(path.join(dir, 'broker.lock'), owner);
  write(path.join(dir, 'isolated-admission-epoch.json'), pointer);
  write(path.join(dir, `broker-lifecycle-${owner.nonce}.json`), {
    owner, buildHash: p.buildHash, configHash: p.configHash, stage: 'recovery' });
  const identity = { sourceCommit: p.sourceCommit, buildHash: p.buildHash,
    configHash: p.configHash, instance: p.sdk };
  write(path.join(dir, 'instance.json'), identity);
  write(path.join(epoch, 'instance.json'), { buildHash: p.buildHash, configHash: p.configHash, instance: p.sdk });
  const close = path.join(dir, 'epoch-successions', hash('prior-close'), 'isolated-scratch-close');
  const closeFiles = ['result.json', 'intent.json', 'start.json', 'wire.json', 'sdk-closed.json', `remote-${randomUUID()}.json`]
    .map(name => { const file = path.join(close, name); write(file, { synthetic: true }); return ref(file); });
  write(path.join(epoch, 'closed.json'), { epochId: p.epochId, document: pointer.document,
    admissionMode: 'normal-multidocument', historicalOutcome: 'unknown', receipt: closeFiles[0],
    qualificationEvidence: closeFiles.slice(1) });
  const history = new QueueState(dir);
  const historical = history.submit({ kind: 'rpc', clientId: p.epochClientId,
    requestId: 'history:' + randomUUID(), timeoutMs: 30000, payload: { method: 'ping' } });
  history.next(); history.markDispatch(historical.id);
  history.finish(historical.id, { state: 'needs_reconciliation', code: 'SYNTHETIC_UNKNOWN' });
  const payload = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'execute_python',
    arguments: { code: 'print("FUSION_ADDIN_STDIO_OK")', persistent: false } } };
  const current = new QueueState(epoch);
  current.submit({ kind: 'rpc', backend: 'mcp', ownerToken: hash(jobClient.auth.clientToken), payload,
    requestId: p.jobRequestId, clientId: p.jobClientId, timeoutMs: 30000, cwd: dir }, p.jobId);
  current.next(); current.markDispatch(p.jobId, { rpcCount: 1, completedCount: 0 });
  current.finish(p.jobId, { state: 'needs_reconciliation', code: 'SYNTHETIC_UNKNOWN' });
  p.jobHash = current.data.jobs[p.jobId].hash;
  Object.assign(pointer, { originalInstance: p.sdk,
    historicalSnapshotHash: ref(path.join(dir, 'queue-state.json')).sha256,
    historicalIdentityHash: ref(path.join(dir, 'instance.json')).sha256,
    qualificationReceipt: closeFiles[0], qualificationEvidence: closeFiles.slice(1),
    quarantinedJobIds: [randomUUID(), randomUUID()] });
  write(path.join(dir, 'isolated-admission-epoch.json'), pointer);
  p.requestHash = hash(JSON.stringify(payload)); p.sourceHash = hash(payload.params.arguments.code);
  const rpcFile = path.join(dir, 'jobs', p.jobId, `rpc-${p.rpcId}.json`);
  write(rpcFile, { terminal: false, method: payload.method,
    request: { jsonrpc: '2.0', id: payload.id, method: payload.method },
    wireRequest: { jsonrpc: '2.0', id: 'fmcad:' + p.rpcId, method: payload.method },
    instance: { ...p.sdk, documents: [{ id: p.creationId, fileId: null, isSaved: false, isModified: false }] },
    binding: { jobId: p.jobId, rpcId: p.rpcId, requestHash: p.requestHash,
      sourceHash: p.sourceHash, buildHash: p.buildHash } });
  const sourceFile = path.join(dir, 'predecessor-ready.json');
  write(sourceFile, { physicalREADY: true, sourceCommit: p.sourceCommit, buildHash: p.buildHash, sdk: p.sdk });
  const targetFile = path.join(dir, 'target.json');
  write(targetFile, { ...p, kind: 'normal-currentstore-target-v1', predecessorSource: ref(sourceFile) });
  const baseRequestId = 'normal-cold:' + randomUUID();
  const ports = { sdkProcess: process => process.pid === p.sdk.pid
    ? { state: 'absent', pid: process.pid, errorId: 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand', observedAtUtc: new Date().toISOString() }
    : { state: 'present', ...process, observedAtUtc: new Date().toISOString() }, producerAbsent: () => true };
  const authorization = normal.authorizeNormalCurrentStore(jobClient, baseRequestId, ref(targetFile));
  const retirement = normal.recordNormalProducerRetirement(epochClient, baseRequestId, authorization, ports);
  const expectedProcess = { pid: 900001,
    birth: String(BigInt(Date.now() + 10) * 10000n + 116444736000000000n) };
  const deathFile = path.join(dir, 'sdk-death-proof.json');
  const now = new Date(Date.now() - 1000).toISOString();
  write(deathFile, { version: 1, kind: 'sdk-process-death-proof-v1', expectedProcess: p.sdk,
    before: { state: 'present', ...p.sdk, exe: 'C:\\Fusion\\Fusion360.exe', windowHandle: '123', observedAtUtc: now },
    handleBoundExit: { pid: p.sdk.pid, birth: p.sdk.birth, hasExited: true, observedAtUtc: now },
    after: { state: 'absent', pid: p.sdk.pid, observedAtUtc: now,
      errorId: 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand' },
    bindings: { jobAuthorization: authorization, originalRpc: ref(rpcFile), predecessorState: ref(path.join(epoch, 'queue-state.json')) } });
  const normalStore = { kind: p.kind, jobAuthorization: authorization,
    deathProof: ref(deathFile), producerRetirement: retirement };
  return { dir, epoch, p, pointer, owner, epochClient, baseRequestId, expectedProcess,
    normalStore, ports, rpcFile, identity, write, ref, hash };
}

module.exports = { createFixture, write, ref, hash };
