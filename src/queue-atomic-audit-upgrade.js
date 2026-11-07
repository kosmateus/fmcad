'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson: boundedJson, sameInstance } = require('./queue-instance');
const { fileHash, directory } = require('./queue-atomic-migration-files');
const { fastenersScope } = require('./atomic-workflow-observation');
const fail = message => { throw Object.assign(new Error(message), { code: 'AUDIT_UPGRADE_PROOF_INVALID' }); };
const read = file => boundedJson(file, 256 * 1024 * 1024);
const observationJobId = '3627db2e-0b9d-4e4f-927f-20cb45deae74';
const previousRequestId = 'measured-fasteners-owner-migration-20261029-v2';

// A second, separately authorized purpose. Never inferred from the number of
// unfinished jobs, and never broadens the consumed legacy migration contract.
function auditUpgradeApproval(approval, dir) {
  if (approval.purpose === undefined) return null;
  if (approval.purpose === 'atomic-audit-facts-recovery-upgrade-v1') {
    const base = auditUpgradeApproval({ ...approval, purpose: 'atomic-recovery-process-loss-audit-upgrade-v1' }, dir);
    const proof = require('./queue-audit-response-proof').auditResponseProof(approval.auditResponseRecovery, dir,
      { jobId: fastenersScope.jobId, observationJobId });
    if (JSON.stringify(base.identity) !== JSON.stringify(proof.originalIdentity) ||
        !require('./queue-instance').sameInstance(approval.currentInstance, proof.currentInstance))
      fail('Response recovery cannot change the owned identity or select another current process');
    const complete = read(proof.files.migrationComplete.path);
    return { ...base, purpose: approval.purpose, observationBuildHash: base.departingBuildHash,
      departingBuildHash: complete.observerBuildHash, previousOwner: complete.owner, auditResponseRecovery: proof };
  }
  if (approval.purpose === 'isolated-scratch-epoch-upgrade-v1') {
    const base = auditUpgradeApproval({ ...approval, purpose: 'atomic-recovery-process-loss-audit-upgrade-v1' }, dir);
    const prerequisite = require('./queue-epoch-prerequisite').epochAuditPrerequisite(approval.epochPrerequisite, dir, approval,
      { jobId: fastenersScope.jobId, observationJobId });
    if (JSON.stringify(base.identity) !== JSON.stringify(prerequisite.identity)) fail('Current audit identity differs from the immutable holder');
    return { ...base, purpose: approval.purpose, observationBuildHash: base.departingBuildHash,
      departingBuildHash: prerequisite.departingBuildHash, previousOwner: prerequisite.previousOwner,
      epochPrerequisite: prerequisite };
  }
  if (!['atomic-recovery-audit-upgrade-v1', 'atomic-recovery-process-loss-audit-upgrade-v1'].includes(approval.purpose))
    fail('Unknown migration purpose');
  const processLoss = approval.purpose === 'atomic-recovery-process-loss-audit-upgrade-v1';
  if (processLoss && (!approval.currentInstance || !Number.isSafeInteger(approval.currentInstance.pid) ||
      Object.keys(approval.currentInstance).sort().join(',') !== 'birth,pid,version' ||
      approval.currentInstance.pid <= 0 || typeof approval.currentInstance.birth !== 'string' || !approval.currentInstance.birth ||
      typeof approval.currentInstance.version !== 'string' || !approval.currentInstance.version))
    fail('Process-loss purpose requires an explicitly selected distinct current process tuple');
  const value = approval.auditUpgrade;
  const previous = path.join(dir, 'atomic-migrations', hash(previousRequestId), 'complete.json');
  const proof = path.join(dir, 'jobs', observationJobId, 'atomic-observation-proof.json');
  if (!value || value.observationJobId !== observationJobId || value.previousComplete?.path !== previous ||
      value.observationProof?.path !== proof) fail('Second handoff is restricted to the exact completed migration and unavailable observer');
  for (const root of [path.dirname(previous), path.dirname(proof)]) {
    directory(root);
    if (fs.realpathSync(root) !== root) fail('Prior handoff evidence must not traverse a symlink');
  }
  for (const entry of [value.previousComplete, value.observationProof]) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '') || fileHash(entry.path).sha256 !== entry.sha256)
      fail('Prior migration/observation proof digest changed');
  }
  const complete = read(previous), observed = read(proof);
  if (complete.kind !== 'atomic-owner-migration' || complete.requestId !== previousRequestId ||
      complete.jobId !== fastenersScope.jobId || complete.gateClosed !== true || complete.unresolved !== true ||
      complete.sdkRequestsSent !== 0 || complete.nativeOutcome !== 'unknown' ||
      complete.backup?.audit !== path.dirname(previous) || complete.backup?.manifest !== 'backup-manifest.json' ||
      observed.kind !== 'atomic_holder_status' || observed.targetJobId !== fastenersScope.jobId ||
      observed.observerJobId !== observationJobId || observed.observerBuildHash !== complete.observerBuildHash ||
      observed.originalBuildHash !== complete.originalBuildHash || observed.remoteOutcome !== 'succeeded' ||
      observed.toolFailed !== false || observed.identityMatches !== false ||
      observed.summary?.status !== 'unavailable' || observed.summary?.outcome !== 'unknown' ||
      observed.summary?.destroyed !== false || observed.summary?.completed !== false)
    fail('Previous handoff or unavailable observation is not the approved history');
  const remotePath = path.join(dir, 'jobs', observationJobId, `atomic-observation-${observed.rpcId}.receipt.json`);
  if (observed.receipt !== remotePath) fail('Unavailable observation receipt escaped its job directory');
  const remote = read(remotePath);
  if (remote.terminal !== true || remote.outcome !== 'succeeded' ||
      observed.binding?.jobId !== observationJobId || observed.binding?.buildHash !== complete.observerBuildHash ||
      !['jobId', 'rpcId', 'requestHash', 'sourceHash', 'buildHash'].every(k => remote[k] === observed.binding[k]) ||
      !sameInstance(remote.instance, observed.observerInstance)) fail('Unavailable observation has no exact terminal transport binding');
  const manifest = path.join(path.dirname(previous), complete.backup.manifest);
  if (complete.backup.audit !== path.dirname(previous) || fileHash(manifest).sha256 !== complete.backup.sha256)
    fail('Original immutable escrow manifest changed');
  return { purpose: approval.purpose, observationJobId, departingBuildHash: complete.observerBuildHash,
    ...(processLoss ? { currentInstance: approval.currentInstance } : {}),
    originalBuildHash: complete.originalBuildHash, previousOwner: complete.owner,
    previousComplete: value.previousComplete, observationProof: value.observationProof,
    remoteReceipt: { path: remotePath, sha256: fileHash(remotePath).sha256 },
    firstBackupManifest: { path: manifest, sha256: complete.backup.sha256 },
    identity: observed.identity, originalInvocationHash: observed.originalInvocationHash,
    sourceEnvelope: observed.sourceEnvelope, reportFingerprint: observed.reportFingerprint };
}

function assertAuditUpgradeSnapshot(upgrade, snapshot, clientId) {
  const { state, identity, owner } = snapshot;
  const target = state.jobs[fastenersScope.jobId], observer = state.jobs[upgrade.observationJobId];
  if (!target || !observer || observer.clientId !== clientId || target.clientId !== clientId ||
      (upgrade.epochPrerequisite && upgrade.epochPrerequisite.clientId !== clientId) ||
      (upgrade.auditResponseRecovery && upgrade.auditResponseRecovery.key.clientId !== clientId) ||
      observer.state !== 'needs_reconciliation' || observer.dispatch?.rpcCount !== 1 || observer.dispatch?.completedCount !== 1 ||
      observer.workflowObservation?.targetJobId !== target.id || observer.workflowObservation?.targetJobHash !== target.hash ||
      observer.workflowObservation?.observerJobHash !== observer.hash ||
      observer.request.buildHash !== (upgrade.observationBuildHash || upgrade.departingBuildHash) || identity.buildHash !== upgrade.originalBuildHash ||
      target.request.buildHash !== upgrade.originalBuildHash ||
      JSON.stringify(owner) !== JSON.stringify(upgrade.previousOwner)) fail('Second handoff no longer owns the exact two unresolved jobs and departing broker');
}

function auditUpgradeStillCurrent(upgrade) {
  if (!upgrade) return true;
  try { return [upgrade.previousComplete, upgrade.observationProof, upgrade.remoteReceipt, upgrade.firstBackupManifest]
    .every(entry => fs.existsSync(entry.path) && fileHash(entry.path).sha256 === entry.sha256) &&
    (!upgrade.epochPrerequisite || require('./queue-epoch-prerequisite').epochPrerequisiteStillCurrent(upgrade.epochPrerequisite)) &&
    (!upgrade.auditResponseRecovery || require('./queue-audit-response-proof').auditResponseProofStillCurrent(upgrade.auditResponseRecovery)); }
  catch { return false; }
}

module.exports = { auditUpgradeApproval, assertAuditUpgradeSnapshot, auditUpgradeStillCurrent };
