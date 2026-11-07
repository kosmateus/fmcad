'use strict';
// Synthetic filesystem/physical fixture only; never use it on a live queue.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
module.exports = function fixture(base, root) {
  const f = require('./current-epoch-upgrade.cjs')(base, root);
  const api = require(root + '/src/queue-instance');
  const { fileHash } = require(root + '/src/queue-atomic-migration-files');
  const previousBuildHash = 'a'.repeat(64), state = structuredClone(f.paused.state);
  for (const job of Object.values(state.jobs)) {
    const rpcId = randomUUID(), dir = path.join(f.dir, 'jobs', job.id);
    fs.mkdirSync(dir, { recursive: true });
    job.state = 'succeeded'; job.code = 'EXECUTION_COMPLETE';
    job.request.buildHash = previousBuildHash; job.request.isolatedEpoch = f.pointer.epochId;
    job.details = { code: job.code, exitCode: 0, sdkSettled: true, mayHaveMutated: true, publicationOutcome: 'published' };
    job.dispatch = { rpcState: 'terminal', rpcCount: 1, completedCount: 1 }; job.physicalTurns = 1;
    api.durable(path.join(dir, 'outcome.json'), { state: job.state, ...job.details }, true);
    api.durable(path.join(dir, 'worker-identity.json'), { pid: 2147483644, birth: 'synthetic-dead-worker' }, true);
    require('./settled-probes.cjs')(api, dir, job.id, previousBuildHash, f.pointer);
    const binding = { jobId: job.id, rpcId, requestHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64),
      buildHash: previousBuildHash, isolatedEpoch: f.pointer.epochId,
      qualifiedDocumentHash: api.hash(JSON.stringify(f.pointer.document)), auditExpectedInstance: f.pointer.currentInstance };
    const receipt = path.join(dir, 'remote-' + rpcId + '.json');
    const remoteReceipt = { ...binding, instance: f.pointer.currentInstance, terminal: true, outcome: 'succeeded' };
    api.durable(receipt, remoteReceipt, true);
    api.durable(path.join(dir, 'rpc-' + rpcId + '.json'), { binding, instance: f.pointer.currentInstance, receipt, remoteReceipt,
      terminal: true, failed: false, nonterminal: false, pythonCheck: { status: 'passed' } }, true);
  }
  api.durable(path.join(f.pointer.root, 'queue-state.json'), state);
  const settledEvidence = require(root + '/src/queue-settled-epoch-evidence').settledEpochEvidence(f.dir, state, f.pointer);
  const approval = { ...f.approval, version: 1, purpose: 'quiescent-settled-isolated-epoch-upgrade-v1',
    previousBuildHash, epochId: f.pointer.epochId, document: f.pointer.document, currentInstance: f.pointer.currentInstance,
    candidateRoot: require(root + '/src/dist/config-platform').resolveRuntimePaths({ anchor: path.join(root, 'src/queue-epoch-runtime-upgrade.js') }).installation,
    pointerHash: fileHash(path.join(f.dir, 'isolated-admission-epoch.json')).sha256,
    settledJobIds: Object.keys(state.jobs), settledEvidenceHash: api.hash(JSON.stringify(settledEvidence)) };
  delete approval.rejectedJobIds;
  const paused = { ...f.paused, state, identity: { ...f.paused.identity, buildHash: previousBuildHash },
    owner: f.oldOwner, ownerTokenHash: f.pointer.ownerTokenHash, pointerHash: approval.pointerHash, settledEvidence,
    selectedLive: true, historicalDead: true, brokerLive: true,
    control: { instanceId: f.oldOwner.nonce, buildHash: previousBuildHash, generation: state.controlGeneration,
      contextEpoch: state.contextEpoch, activeOperations: 0, activeIds: [], gateClosed: true } };
  api.durable(path.join(f.audit, 'paused.json'), paused);
  api.durable(path.join(f.audit, 'intent.json'), { approval, nonce: f.nonce, ownerTokenHash: f.pointer.ownerTokenHash });
  const requestId = approval.requestId + ':pause-stop';
  const releaseFile = path.join(f.dir, 'console-release-' + api.hash(requestId) + '.json');
  api.durable(releaseFile, { terminal: true, outcome: 'released', requestId,
    instanceId: f.oldOwner.nonce, buildHash: previousBuildHash }, true);
  api.durable(path.join(f.audit, 'cooperative-release.json'), { path: releaseFile, sha256: fileHash(releaseFile).sha256 }, true);
  return { ...f, approval, paused };
};
