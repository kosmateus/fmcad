'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, durable } = require('../../src/queue-instance');
const { fileHash } = require('../../src/queue-atomic-migration-files');
const { auditUpgradeApproval } = require('../../src/queue-atomic-audit-upgrade');

module.exports = function fixture(dir, snapshot, proofExtras = {}) {
  const jobId = '5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a';
  const observationJobId = '3627db2e-0b9d-4e4f-927f-20cb45deae74';
  const requestId = 'measured-fasteners-owner-migration-20261029-v2';
  const prior = path.join(dir, 'atomic-migrations', hash(requestId));
  const observedDir = path.join(dir, 'jobs', observationJobId);
  fs.mkdirSync(prior, { recursive: true }); fs.mkdirSync(observedDir, { recursive: true });
  const manifest = path.join(prior, 'backup-manifest.json'); durable(manifest, { fixture: 'first immutable escrow' }, true);
  const completeFile = path.join(prior, 'complete.json');
  durable(completeFile, { kind: 'atomic-owner-migration', requestId, jobId, owner: snapshot.owner,
    originalBuildHash: snapshot.identity.buildHash, observerBuildHash: snapshot.status.control.buildHash,
    gateClosed: true, unresolved: true, sdkRequestsSent: 0, nativeOutcome: 'unknown',
    backup: { audit: prior, manifest: 'backup-manifest.json', sha256: fileHash(manifest).sha256 } }, true);
  const rpcId = '11111111-1111-4111-8111-111111111111';
  const binding = { jobId: observationJobId, rpcId, requestHash: hash('prior request'),
    sourceHash: hash('prior status'), buildHash: snapshot.status.control.buildHash };
  const receipt = path.join(observedDir, `atomic-observation-${rpcId}.receipt.json`);
  durable(receipt, { ...binding, terminal: true, outcome: 'succeeded', instance: snapshot.identity.instance }, true);
  const proofFile = path.join(observedDir, 'atomic-observation-proof.json');
  durable(proofFile, { kind: 'atomic_holder_status', targetJobId: jobId, observerJobId: observationJobId,
    originalBuildHash: snapshot.identity.buildHash, observerBuildHash: snapshot.status.control.buildHash,
    remoteOutcome: 'succeeded', toolFailed: false, identityMatches: false,
    summary: { status: 'unavailable', outcome: 'unknown', destroyed: false, completed: false },
    binding, rpcId, receipt, observerInstance: snapshot.identity.instance, identity: { commandId: 'fixture-owned' }, ...proofExtras }, true);
  const approval = { purpose: 'atomic-recovery-audit-upgrade-v1', auditUpgrade: { observationJobId,
    previousComplete: { path: completeFile, sha256: fileHash(completeFile).sha256 },
    observationProof: { path: proofFile, sha256: fileHash(proofFile).sha256 } } };
  return { approval, upgrade: auditUpgradeApproval(approval, dir), proofFile, completeFile };
};
