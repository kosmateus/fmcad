'use strict';
const fs = require('node:fs');
const path = require('node:path');
const installation = process.env.FMCAD_TEST_LEGACY_843_RUNTIME;
module.exports = function responseFixture(dir, scope, identity, currentInstance, historicalInstance, owner) {
  const { hash, durable } = require('../../src/queue-instance');
  const { fileHash } = require('../../src/queue-atomic-migration-files');
  if (!installation) throw new Error('FMCAD_TEST_LEGACY_843_RUNTIME must name the exact qualified 843 runtime');
  const a = require(installation + '/src/queue-atomic-recovery-audit');
  const { pythonArtifactManifest } = require(installation + '/src/python');
  const migrationId = 'completed-843-response-fixture', migrationAudit = path.join(dir, 'atomic-migrations', hash(migrationId));
  const audit = path.join(dir, 'jobs', scope.jobId, 'atomic-recovery-audit');
  for (const p of [migrationAudit, audit]) fs.mkdirSync(p, { recursive: true });
  const key = { jobId: scope.jobId, observationJobId: scope.observationJobId || '3627db2e-0b9d-4e4f-927f-20cb45deae74',
    requestId: 'original-failed-audit-fixture', clientId: 'original-owner' };
  const binding = { purpose: 'atomic-recovery-audit-v1', targetJobId: key.jobId, observationJobId: key.observationJobId,
    clientId: key.clientId, auditBuildHash: '14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d',
    control: { instanceId: owner.nonce }, currentInstance, historicalInstance };
  const reader = a.prepareRecoveryAudit(installation, identity, binding);
  const payload = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_python',
    arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } };
  const prepared = a.prepareRecoveryAuditWire({ payload, reader, receipt: path.join(audit, 'remote-fixture.json'),
    instance: currentInstance, buildHash: binding.auditBuildHash, jobId: key.jobId, auditBinding: binding,
    rpcId: '11111111-1111-4111-8111-111111111111' });
  const approved = { purpose: 'atomic-recovery-process-loss-audit-upgrade-v1', candidateRoot: installation,
    buildHash: binding.auditBuildHash, currentInstance };
  const records = { migrationIntent: { binding: { requestId: migrationId, clientId: key.clientId, approvalHash: hash(JSON.stringify(approved)) }, approved },
    migrationComplete: { kind: 'atomic-owner-migration', purpose: approved.purpose, requestId: migrationId, jobId: key.jobId,
      owner, currentAuditInstance: currentInstance, observerBuildHash: binding.auditBuildHash, gateClosed: true, unresolved: true,
      sdkRequestsSent: 0, nativeOutcome: 'unknown', currentModelingAdmission: 'blocked' },
    auditIntent: { key, binding, identity, sourceSha256: reader.sourceSha256, sourceArtifactHash: reader.artifact.artifactHash },
    auditStart: { ...prepared.record, pythonCheck: { status: 'passed', provenance: { artifactHash: prepared.artifact.artifactHash,
      wireHash: prepared.artifact.sha256 } }, originArtifactHash: reader.artifact.artifactHash },
    auditWire: { outgoing: prepared.outgoing, artifact: pythonArtifactManifest(prepared.artifact) },
    auditResult: { kind: 'atomic-recovery-audit', ...key, status: 'failed', code: 'EPROTO', sdkRequestsSent: 1,
      currentInstance, historicalInstance, historicalProcessState: 'terminated', currentModelingAdmission: 'blocked',
      endpointVerified: false, nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' },
    auditRemote: { ...prepared.record.binding, terminal: true, outcome: 'succeeded', instance: currentInstance } };
  const paths = { migrationIntent: path.join(migrationAudit, 'intent.json'), migrationComplete: path.join(migrationAudit, 'complete.json'),
    auditIntent: path.join(audit, 'intent.json'), auditStart: path.join(audit, 'start.json'), auditWire: path.join(audit, 'wire.json'),
    auditResult: path.join(audit, 'result.json'), auditRemote: path.join(audit, 'remote-fixture.json') };
  const files = {};
  for (const [name, p] of Object.entries(paths)) { durable(p, records[name], true); files[name] = { path: p, sha256: fileHash(p).sha256 }; }
  return { files, records, key, migrationAudit };
};
