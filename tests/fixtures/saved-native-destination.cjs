'use strict';
// FAKE readiness ledger and native-destination attestation; never touches Fusion.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = function fixture(f, repo, authorityFile, folderProofFile) {
  const api = require(repo + '/src/queue-instance');
  const { fileHash } = require(repo + '/src/queue-atomic-migration-files');
  const { epochControlDirectory } = require(repo + '/src/queue-epoch-lineage');
  const { savedDestinationApproval } = require(repo + '/src/queue-saved-destination-approval');
  const { savedReadinessEvidence } = require(repo + '/src/queue-saved-readiness-evidence');
  const { readSavedNativeDestination } = require(repo + '/src/queue-saved-native-destination');
  const digest = value => require(repo + '/src/dist/core/application/cad/json').hash(value);
  const ref = file => ({ path: file, sha256: fileHash(file).sha256 });
  const epoch = f.state.epoch, identity = api.readJson(path.join(epoch.root, 'instance.json'));
  const payload = { version: 1, kind: 'cad', operation: 'document.status', doc: epoch.document.name,
    docId: epoch.document.creationId, data: {} };
  const accepted = f.state.submit({ kind: 'command', clientId: f.clientId, ownerToken: epoch.ownerTokenHash,
    requestId: 'fake-owner-readiness', timeoutMs: 1000, cwd: f.base, payload, inputFiles: [],
    argv: require(repo + '/src/cad-service').policyArguments(payload), isolatedEpoch: epoch.epochId, buildHash: identity.buildHash });
  f.state.next();
  f.state.data.jobs[accepted.id].dispatch = { rpcState: 'terminal', rpcCount: 1, completedCount: 1 };
  f.state.finish(accepted.id, { state: 'succeeded', code: 'EXECUTION_COMPLETE', exitCode: 0,
    sdkSettled: true, publicationOutcome: 'published', mayHaveMutated: false });
  const job = f.state.data.jobs[accepted.id], jobDir = path.join(f.dir, 'jobs', job.id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  api.durable(path.join(jobDir, 'request.json'), job.request, true);
  api.durable(path.join(jobDir, 'outcome.json'), { state: job.state, ...job.details }, true);
  api.durable(path.join(jobDir, 'worker-identity.json'), { pid: 2147483644, birth: 'fake-dead-readiness' }, true);
  require('./settled-probes.cjs')(api, jobDir, job.id, identity.buildHash, epoch);
  const nativeRpc = randomUUID(), nativeBinding = { jobId: job.id, rpcId: nativeRpc, requestHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64),
    buildHash: identity.buildHash, isolatedEpoch: epoch.epochId, qualifiedDocumentHash: api.hash(JSON.stringify(epoch.document)),
    auditExpectedInstance: epoch.currentInstance, auditExpectedDocument: epoch.document };
  const nativeReceipt = path.join(jobDir, 'remote-' + nativeRpc + '.json');
  const nativeRemote = { ...nativeBinding, instance: epoch.currentInstance, terminal: true, outcome: 'succeeded' };
  api.durable(nativeReceipt, nativeRemote, true);
  api.durable(path.join(jobDir, 'rpc-' + nativeRpc + '.json'), { binding: nativeBinding, instance: epoch.currentInstance,
    receipt: nativeReceipt, remoteReceipt: nativeRemote, terminal: true, failed: false, nonterminal: false, pythonCheck: { status: 'passed' } }, true);
  fs.writeFileSync(path.join(jobDir, 'stdout.txt'), JSON.stringify({ success: true, operation: 'document.status',
    result: { ...epoch.document, saved: false, modified: false } }), { flag: 'wx' });
  const ready = savedReadinessEvidence(f.dir, epoch, job.id);
  const approved = savedDestinationApproval(authorityFile, folderProofFile, epoch.ownerClientId);
  const requestId = 'fake-native-destination-read', kind = require(repo + '/src/queue-saved-audit-path').savedAuditKind('dp-', requestId);
  const dir = path.join(epochControlDirectory(f.dir, epoch), kind); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binding = { purpose: 'saved-fixture-destination-v1', epochId: epoch.epochId, document: epoch.document,
    currentInstance: epoch.currentInstance, historicalInstance: epoch.originalInstance,
    clientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash, readinessJobId: job.id,
    sourceCommit: identity.sourceCommit, buildHash: identity.buildHash, destination: approved,
    sdkProofPath: path.join(dir, 'sdk-destination.json') };
  const destination = { projectName: approved.projectName, nativeProjectId: 'native-project', nativeHubId: 'native-hub',
    nativeHubName: 'FAKE_HUB', folderName: approved.folderName, folderId: approved.folderId };
  const proof = { version: 1, purpose: binding.purpose, epochId: epoch.epochId, bindingHash: digest(binding),
    document: epoch.document, readOnly: true, destination };
  const rpcId = randomUUID(), sourceArtifactHash = 'd'.repeat(64);
  const sdkBinding = { jobId: job.id, rpcId, buildHash: identity.buildHash, purpose: binding.purpose,
    auditBindingHash: digest(binding), pythonOriginHash: sourceArtifactHash, auditExpectedInstance: epoch.currentInstance };
  const sdkReceipt = path.join(dir, 'remote-' + rpcId + '.json');
  api.durable(path.join(dir, 'intent.json'), { binding, sourceArtifactHash }, true);
  api.durable(path.join(dir, 'start.json'), { binding: sdkBinding, receipt: sdkReceipt, pythonCheck: { status: 'passed' } }, true);
  api.durable(path.join(dir, 'wire.json'), { fakeWireOnly: true }, true);
  api.durable(binding.sdkProofPath, proof, true);
  api.durable(sdkReceipt, { ...sdkBinding, instance: epoch.currentInstance, terminal: true, outcome: 'succeeded' }, true);
  const receipt = path.join(dir, 'result.json');
  api.durable(receipt, { kind, jobId: job.id, requestId, clientId: epoch.ownerClientId, status: 'complete', summary: proof,
    sdkRequestsSent: 1, endpointVerified: true, nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' }, true);
  const evidence = ['intent.json', 'start.json', 'wire.json', 'sdk-destination.json', path.basename(sdkReceipt)].map(name => ref(path.join(dir, name)));
  api.durable(path.join(epoch.root, 'saved-destination-native.json'), { version: 1, kind: 'owner-verified-native-saved-destination',
    epochId: epoch.epochId, originDocument: epoch.document, ownerClientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash,
    sourceCommit: identity.sourceCommit, buildHash: identity.buildHash, approvedDestination: approved,
    destination, readinessJobId: ready.job.id, readinessJobs: ready.jobs, readinessEvidence: ready.evidence,
    receipt: ref(receipt), qualificationEvidence: evidence }, true);
  return { job, nativeDestination: readSavedNativeDestination(f.dir, epoch, approved) };
};
