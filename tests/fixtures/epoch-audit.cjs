'use strict';
// Synthetic physical evidence in a private test directory, never a live receipt.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function epochAuditFixture(dir, scope, identity, currentInstance, originalInstance, owner) {
  const { durable, hash } = require('../../src/queue-instance');
  const { fileHash } = require('../../src/queue-atomic-migration-files');
  const { prepareRecoveryAudit, prepareRecoveryAuditWire } = require('../../src/queue-atomic-recovery-audit');
  const { pythonArtifactManifest } = require('../../src/python');
  const observer = '3627db2e-0b9d-4e4f-927f-20cb45deae74';
  const requestId = 'completed-process-loss-fixture';
  const completeFile = path.join(dir, 'atomic-migrations', hash(requestId), 'complete.json');
  fs.mkdirSync(path.dirname(completeFile), { recursive: true });
  durable(completeFile, { version: 1, kind: 'atomic-owner-migration', purpose: 'atomic-recovery-process-loss-audit-upgrade-v1',
    requestId, jobId: scope.jobId, owner, observerBuildHash: 'departing-build', currentAuditInstance: currentInstance,
    gateClosed: true, unresolved: true, sdkRequestsSent: 0, nativeOutcome: 'unknown', currentModelingAdmission: 'blocked' }, true);
  const audit = path.join(dir, 'jobs', scope.jobId, 'atomic-recovery-audit'); fs.mkdirSync(audit, { recursive: true });
  const key = { jobId: scope.jobId, observationJobId: observer, requestId: 'actual-current-audit-fixture', clientId: 'original-owner' };
  const binding = { purpose: 'atomic-recovery-audit-v1', targetJobId: scope.jobId, observationJobId: observer,
    clientId: key.clientId, auditBuildHash: 'departing-build', currentInstance, historicalInstance: originalInstance };
  const reader = prepareRecoveryAudit(path.resolve(__dirname, '../..'), identity, binding);
  const prepared = prepareRecoveryAuditWire({ reader, receipt: path.join(audit, 'remote-fixture.json'), instance: currentInstance,
    buildHash: 'departing-build', jobId: scope.jobId, auditBinding: binding, rpcId: '11111111-1111-4111-8111-111111111111',
    payload: { jsonrpc: '2.0', id: 'caller', method: 'tools/call', params: { name: 'execute_python',
      arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
  const summary = { version: 1, purpose: 'atomic-recovery-audit-v1', profile: 'atomic-recovery-counts-v1', requestIdentity: identity,
    nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed', modulePresent: false,
    ui: { activeCommand: 'SelectCommand', idle: true }, commandDefinition: { status: 'absent' },
    document: { status: 'absent', matches: 0 }, snapshot: null, fingerprint: null };
  const records = { auditIntent: { key, binding, identity },
    auditStart: { ...prepared.record, pythonCheck: { status: 'passed' }, originArtifactHash: reader.artifact.artifactHash },
    auditWire: { outgoing: prepared.outgoing, artifact: pythonArtifactManifest(prepared.artifact) },
    auditResult: { kind: 'atomic-recovery-audit', ...key, status: 'complete', summary, sdkRequestsSent: 1,
      currentInstance, historicalInstance: originalInstance, historicalProcessState: 'terminated', endpointVerified: true,
      currentModelingAdmission: 'blocked', nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' },
    remoteReceipt: { ...prepared.record.binding, terminal: true, outcome: 'succeeded', instance: currentInstance } };
  const filenames = { auditIntent: 'intent.json', auditStart: 'start.json', auditWire: 'wire.json', auditResult: 'result.json', remoteReceipt: 'remote-fixture.json' };
  const files = { migrationComplete: { path: completeFile, sha256: fileHash(completeFile).sha256 } };
  for (const [name, value] of Object.entries(records)) {
    const file = path.join(audit, filenames[name]); durable(file, value, true); files[name] = { path: file, sha256: fileHash(file).sha256 };
  }
  return { files, records };
};
