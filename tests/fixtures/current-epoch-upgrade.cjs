'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
module.exports = function fixture(base, root) {
  const api = require(root + '/src/queue-instance'), { QueueState } = require(root + '/src/queue-state');
  const { fileHash } = require(root + '/src/queue-atomic-migration-files');
  const dir = path.join(base, 'queue'); fs.mkdirSync(dir);
  const q = new QueueState(dir), clientId = 'synthetic-original-owner', token = 'a'.repeat(64), tokenHash = api.hash(token);
  const req = (id, operation) => ({ kind: 'command', requestId: id, clientId, timeoutMs: 1000, cwd: base,
    backend: 'addin', buildHash: 'historical', argv: ['cad', 'batch'], payload: { kind: 'cad', version: 1,
      operation, doc: 'Historical', docId: 'old-doc-id', data: {} } });
  const target = q.submit(req('historical-request', 'batch.run')); q.next(); q.block(target.id, { code: 'UNKNOWN' });
  const observation = req('historical-observer', 'batch.reconcile');
  observation.payload.data = { reportPath: path.join(base, 'report'), blockedJobId: target.id,
    commandId: 'fmcad_atomic_' + 'b'.repeat(32), sessionNonce: 'c'.repeat(32) };
  const observer = q.submit(observation);
  q.armWorkflowObservation(observer.id, { version: 1, kind: 'atomic-holder-status', targetJobId: target.id,
    targetRequestId: target.requestId, targetClientId: clientId, targetJobHash: q.data.jobs[target.id].hash,
    observerJobHash: q.data.jobs[observer.id].hash, targetBuildHash: 'historical', observerBuildHash: 'historical',
    projectDirectory: base, paused: false, controlGeneration: 0, contextEpoch: 0,
    reportPath: path.join(base, 'report'), reportFingerprint: 'd'.repeat(64), commandId: observation.payload.data.commandId,
    sessionNonce: observation.payload.data.sessionNonce, docId: 'old-doc-id' });
  q.next(); q._commit(d => { d.jobs[observer.id].state = 'needs_reconciliation'; d.paused = true; return null; });
  const cfg = { backend: 'addin', url: 'http://never-send.invalid', headers: {}, tool: 'execute_python', transport: 'node',
    protocolVersion: '2025-06-18', timeoutMs: 180000, routing: 'queue', queue: {} };
  const current = { pid: process.pid, birth: api.processBirth(), version: 'fixture' }, historical = { pid: 2147483646, birth: 'dead:fixture', version: 'fixture' };
  api.durable(path.join(dir, 'instance.json'), { buildHash: 'historical', configHash: api.brokerConfigHash(cfg), instance: historical }, true);
  api.durable(path.join(dir, 'clients.json'), { [clientId]: tokenHash }, true);
  const epochId = randomUUID(), epochDir = path.join(dir, 'admission-epochs', epochId);
  const document = { name: 'FMCAD_ISOLATED_' + epochId, creationId: 'really-new-synthetic-id', fileId: null };
  const proofDir = path.join(dir, 'isolated-scratch-qualification'); fs.mkdirSync(proofDir);
  const receipt = path.join(proofDir, 'result.json');
  api.durable(receipt, { kind: 'isolated-scratch-qualification', status: 'complete', clientId,
    currentInstance: current, nativeOutcome: 'unknown', summary: { purpose: 'isolated-scratch-epoch-v1', epochId, document } }, true);
  const evidence = ['intent.json', 'start.json', 'wire.json', 'sdk-qualified.json', 'remote-' + randomUUID() + '.json'].map(name => {
    const file = path.join(proofDir, name); api.durable(file, { syntheticSdkEvidence: name }, true);
    return { path: file, sha256: fileHash(file).sha256 };
  });
  const pointer = { version: 1, kind: 'isolated-fresh-scratch-epoch', epochId, root: epochDir, document,
    ownerClientId: clientId, ownerTokenHash: tokenHash, currentInstance: current, originalInstance: historical,
    historicalSnapshotHash: fileHash(path.join(dir, 'queue-state.json')).sha256,
    historicalIdentityHash: fileHash(path.join(dir, 'instance.json')).sha256,
    qualificationReceipt: { path: receipt, sha256: fileHash(receipt).sha256 }, qualificationEvidence: evidence,
    quarantinedJobIds: [target.id, observer.id], historicalOutcome: 'unknown', originalModelValidation: 'not_performed',
    originalRollbackVerification: 'not_performed' };
  const state = require(root + '/src/queue-isolated-epoch').openIsolatedEpoch(dir, { recover: false });
  state.installEpoch(pointer, { buildHash: api.buildHash(), configHash: api.brokerConfigHash(cfg), instance: current },
    { createdAtMs: Date.now(), bindingHash: 'synthetic-creation' });
  const rejectedJobIds = [];
  for (const requestId of ['synthetic-smoke-local-failure-1', 'synthetic-smoke-local-failure-2']) {
    const job = state.submit({ kind: 'command', requestId, clientId, timeoutMs: 1000, phased: true, cwd: base,
      argv: ['cad', 'sketch', 'create'], payload: { version: 1, kind: 'cad', operation: 'sketch.create',
        doc: document.name, docId: document.creationId, data: { name: 'S', plane: 'XY' } } });
    state.finishLocal(job.id, { state: 'failed', code: 'PYTHON_CHECK_REJECTED', executionOutcome: 'not_started',
      userScriptSubmitted: false, mayHaveMutated: false, sdkSettled: true }); rejectedJobIds.push(job.id);
  }
  state.pause(true, 'synthetic-upgrade-pause');
  const nonce = randomUUID(), audit = path.join(dir, 'epoch-runtime-upgrades', api.hash('synthetic-upgrade'));
  fs.mkdirSync(audit, { recursive: true });
  const oldOwner = { pid: 2147483647, birth: 'dead:old-broker', nonce: 'old-broker' };
  const paused = { pointer, state: state.data, identity: JSON.parse(fs.readFileSync(path.join(epochDir, 'instance.json'))),
    rootStateHash: pointer.historicalSnapshotHash, rootIdentityHash: pointer.historicalIdentityHash,
    grantsHash: api.hash('[]') };
  const approval = { clientId, granteeClientId: clientId, requestId: 'synthetic-upgrade', buildHash: api.buildHash(),
    sourceCommit: 'e'.repeat(40), rejectedJobIds };
  const guard = { kind: 'isolated-epoch-runtime-upgrade', nonce, audit, clientId };
  const stages = { intent: { approval, nonce, ownerTokenHash: tokenHash }, paused: { ...paused, owner: oldOwner },
    stopped: { owner: oldOwner }, installed: { buildHash: approval.buildHash },
    identity: { current: { ...paused.identity, sourceCommit: approval.sourceCommit } },
    'launch-intent': { buildHash: approval.buildHash } };
  for (const [name, value] of Object.entries(stages)) api.durable(path.join(audit, name + '.json'), value, true);
  api.durable(path.join(epochDir, 'instance.json'), stages.identity.current);
  for (const name of ['atomic-migration.lock', 'recovery.lock']) api.durable(path.join(dir, name), guard, true);
  return { dir, audit, nonce, pointer, cfg, oldOwner, token, clientId, approval, paused, guard };
};
