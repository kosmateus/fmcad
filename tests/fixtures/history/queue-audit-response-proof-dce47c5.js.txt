'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson, sameInstance, buildHash } = require('./queue-instance');
const { fileHash, directory } = require('./queue-atomic-migration-files');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'AUDIT_RESPONSE_PROOF_INVALID' }); };
const frozen843 = '14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d';

function collectAuditResponseFiles(dir, migrationAudit, scope) {
  const audit = path.join(dir, 'jobs', scope.jobId, 'atomic-recovery-audit');
  const start = readJson(path.join(audit, 'start.json'));
  if (path.dirname(start.receipt || '') !== audit) fail('Original physical receipt escaped the exact audit directory');
  const paths = { migrationIntent: path.join(migrationAudit, 'intent.json'), migrationComplete: path.join(migrationAudit, 'complete.json'),
    auditIntent: path.join(audit, 'intent.json'), auditStart: path.join(audit, 'start.json'),
    auditWire: path.join(audit, 'wire.json'), auditResult: path.join(audit, 'result.json'), auditRemote: start.receipt };
  return Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, { path: file, sha256: fileHash(file).sha256 }]));
}

// File-only proof. A successful Python receipt proves execution, never the
// dynamic facts that were printed to a response body which was not persisted.
function auditResponseProof(files, dir, scope) {
  const names = ['migrationIntent', 'migrationComplete', 'auditIntent', 'auditStart', 'auditWire', 'auditResult', 'auditRemote'];
  if (!files || Object.keys(files).sort().join(',') !== names.sort().join(',')) fail('Complete original evidence manifest required');
  for (const entry of Object.values(files)) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !path.isAbsolute(entry.path || '') ||
        fileHash(entry.path).sha256 !== entry.sha256) fail('Original evidence bytes changed');
    directory(path.dirname(entry.path));
    if (fs.realpathSync(entry.path) !== entry.path) fail('Original evidence must not traverse a symlink');
  }
  const read = key => readJson(files[key].path, 256 * 1024 * 1024);
  const migration = read('migrationIntent'), complete = read('migrationComplete'), intent = read('auditIntent'),
    start = read('auditStart'), wire = read('auditWire'), result = read('auditResult'), remote = read('auditRemote');
  const migrationAudit = path.join(dir, 'atomic-migrations', hash(complete.requestId || ''));
  const audit = path.join(dir, 'jobs', scope.jobId, 'atomic-recovery-audit');
  const paths = { migrationIntent: path.join(migrationAudit, 'intent.json'), migrationComplete: path.join(migrationAudit, 'complete.json'),
    auditIntent: path.join(audit, 'intent.json'), auditStart: path.join(audit, 'start.json'),
    auditWire: path.join(audit, 'wire.json'), auditResult: path.join(audit, 'result.json'), auditRemote: start.receipt };
  if (Object.entries(paths).some(([key, file]) => files[key].path !== file) ||
      path.dirname(start.receipt || '') !== audit || complete.kind !== 'atomic-owner-migration' ||
      complete.purpose !== 'atomic-recovery-process-loss-audit-upgrade-v1' || complete.jobId !== scope.jobId ||
      complete.sdkRequestsSent !== 0 || complete.nativeOutcome !== 'unknown' || complete.gateClosed !== true || complete.unresolved !== true ||
      complete.observerBuildHash !== frozen843 || complete.currentModelingAdmission !== 'blocked' ||
      migration.approved?.buildHash !== frozen843 || migration.binding?.requestId !== complete.requestId ||
      hash(JSON.stringify(migration.approved)) !== migration.binding.approvalHash)
    fail('Original completed 843 process-loss migration and approval do not match');
  const key = intent.key, binding = intent.binding;
  if (!key || !binding || key.jobId !== scope.jobId || key.observationJobId !== scope.observationJobId ||
      binding.targetJobId !== key.jobId || binding.observationJobId !== key.observationJobId || binding.clientId !== key.clientId ||
      binding.purpose !== 'atomic-recovery-audit-v1' || binding.auditBuildHash !== frozen843 ||
      migration.binding.clientId !== key.clientId || binding.control?.instanceId !== complete.owner.nonce ||
      !sameInstance(binding.currentInstance, complete.currentAuditInstance) ||
      !sameInstance(binding.currentInstance, migration.approved.currentInstance) ||
      result.kind !== 'atomic-recovery-audit' || result.status !== 'failed' || result.code !== 'EPROTO' ||
      result.sdkRequestsSent !== 1 || result.endpointVerified !== false || result.summary !== undefined ||
      result.currentModelingAdmission !== 'blocked' || result.historicalProcessState !== 'terminated' ||
      !sameInstance(result.historicalInstance, binding.historicalInstance) ||
      Object.entries(key).some(([k, v]) => result[k] !== v) ||
      result.nativeOutcome !== 'unknown' || result.modelValidation !== 'not_performed' || result.rollbackVerification !== 'not_performed' ||
      !sameInstance(result.currentInstance, binding.currentInstance)) fail('Only the exact owned failed EPROTO audit is eligible');
  const root = migration.approved.candidateRoot;
  if (!path.isAbsolute(root || '') || fs.realpathSync(root) !== root || buildHash(root) !== frozen843)
    fail('Original immutable qualified producer runtime is unavailable or changed');
  // The literal caller ID is an actual contract of this frozen McpClient, not a
  // guess from a synthetic response. Reconstruct every original final byte.
  const original = require(path.join(root, 'src/queue-atomic-recovery-audit'));
  const reader = original.prepareRecoveryAudit(root, intent.identity, binding);
  const payload = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_python',
    arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } };
  const expected = original.prepareRecoveryAuditWire({ payload, reader, receipt: start.receipt, instance: binding.currentInstance,
    buildHash: frozen843, jobId: key.jobId, auditBinding: binding, rpcId: start.binding?.rpcId });
  if (reader.artifact.artifactHash !== intent.sourceArtifactHash || reader.sourceSha256 !== intent.sourceSha256 ||
      canonicalHash(start.binding) !== canonicalHash(expected.record.binding) || canonicalHash(wire.outgoing) !== canonicalHash(expected.outgoing) ||
      wire.artifact?.artifactHash !== expected.artifact.artifactHash || start.originArtifactHash !== reader.artifact.artifactHash ||
      start.pythonCheck?.status !== 'passed' || start.pythonCheck.provenance?.artifactHash !== wire.artifact.artifactHash ||
      start.pythonCheck.provenance?.wireHash !== expected.artifact.sha256 ||
      !sameInstance(start.instance, binding.currentInstance)) fail('Original checker/source/origin/final-wire binding does not reconstruct exactly');
  require(path.join(root, 'src/python')).bindPythonArtifactManifest(wire.outgoing.params.arguments.code, wire.artifact);
  if (remote.terminal !== true || remote.outcome !== 'succeeded' || remote.error ||
      Object.entries(start.binding).some(([k, v]) => canonicalHash(remote[k] ?? null) !== canonicalHash(v)) ||
      !sameInstance(remote.instance, binding.currentInstance)) fail('Physical execution has no exact successful process-bound receipt');
  return { version: 1, kind: 'atomic-audit-response-postmortem-v1', key, originalStatus: { status: result.status, code: result.code,
      endpointVerified: result.endpointVerified }, originalRpcId: start.binding.rpcId, currentInstance: binding.currentInstance,
    originalIdentity: intent.identity, originalHistoricalInstance: binding.historicalInstance,
    producerBuildHash: frozen843, files, evidenceHash: canonicalHash(files),
    executionProof: { expectedInstanceMatched: true, exactGuardBeforeBodyVerified: true, synchronousBodyCompleted: true },
    responseContract: { callerId: payload.id, wireId: wire.outgoing.id,
      idRestorationMissingInFrozenAudit: true, ordinaryBrokerRestoresCallerId: true },
    facts: { available: false, summary: null, reason: 'Original frozen controller persisted no raw reply or summary after caller protocol failure' },
    epochEligible: false, historicalOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed', sdkRequestsSent: 0 };
}

function auditResponseProofStillCurrent(proof) {
  try { return Object.values(proof.files).every(entry => fileHash(entry.path).sha256 === entry.sha256); }
  catch { return false; }
}

module.exports = { collectAuditResponseFiles, auditResponseProof, auditResponseProofStillCurrent };
