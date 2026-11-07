'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Synthetic metadata only. No broker/backend/SDK is constructed by this fixture.
module.exports = function fixture(base, repo, { oldProcessAlive = false, inFlight = false } = {}) {
  const api = require(repo + '/src/queue-instance');
  const lineage = require(repo + '/src/queue-epoch-lineage');
  const f = require('./current-epoch-upgrade.cjs')(base, repo);
  for (const name of ['recovery.lock', 'atomic-migration.lock']) fs.unlinkSync(path.join(f.dir, name));
  const previousState = require(repo + '/src/queue-isolated-epoch').openIsolatedEpoch(f.dir, { recover: false });
  previousState.pause(false, 'synthetic-before-process-loss');
  const priorJob = previousState.submit({ kind: 'rpc', clientId: f.clientId, requestId: 'synthetic-prior-model-request',
    timeoutMs: 1000, payload: { jsonrpc: '2.0', id: 'prior', method: 'ping' } });
  previousState.next();
  if (!inFlight) previousState.finish(priorJob.id, { state: 'succeeded', code: 'SYNTHETIC_SUCCESS', sdkSettled: true });
  const oldProcess = oldProcessAlive ? f.pointer.currentInstance : { pid: 2147483645, birth: 'dead:old-epoch', version: 'fixture' };
  f.pointer.currentInstance = oldProcess;
  const receipt = api.readJson(f.pointer.qualificationReceipt.path);
  api.durable(f.pointer.qualificationReceipt.path, { ...receipt, currentInstance: oldProcess });
  f.pointer.qualificationReceipt = lineage.reference(f.pointer.qualificationReceipt.path);
  const auditIdentity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32),
    resolvedIdentity: { name: 'Synthetic historical document', creationId: 'synthetic-historical-document', fileId: null } };
  const genesisIntent = f.pointer.qualificationEvidence.find(entry => path.basename(entry.path) === 'intent.json');
  api.durable(genesisIntent.path, { identity: auditIdentity });
  f.pointer.qualificationEvidence = f.pointer.qualificationEvidence.map(entry => lineage.reference(entry.path));
  const oldIdentityFile = path.join(f.pointer.root, 'instance.json');
  api.durable(oldIdentityFile, { ...api.readJson(oldIdentityFile), buildHash: 'b'.repeat(64), instance: oldProcess });
  api.durable(path.join(f.dir, 'isolated-admission-epoch.json'), f.pointer);
  const previousOwner = { ...f.oldOwner, protocol: 2 };
  api.durable(path.join(f.dir, 'broker.lock'), previousOwner, true);
  const requestId = 'synthetic-dead-epoch-successor', audit = path.join(f.dir, 'epoch-successions', api.hash(requestId));
  fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
  const predecessor = lineage.predecessorSnapshot(f.dir, audit, true);
  const sourceCommit = 'f'.repeat(40), codeHash = api.buildHash();
  const qualificationFile = path.join(audit, 'installed-qualification.json');
  api.durable(qualificationFile, { passed: true, productionAdmission: true, liveSdkRequestsSent: 0,
    publicDirectAccessRefused: true, deadEpochSuccessorReadQualified: true, deadEpochSuccessorRestoreQualified: true,
    sourceCommit, buildHash: codeHash }, true);
  const runtime = require(repo + '/src/dist/config-platform').resolveRuntimePaths({ anchor: path.join(repo, 'src/queue-epoch-successor.js') }).installation;
  const expectedProcess = { pid: process.pid, birth: api.processBirth() }, nonce = randomUUID();
  const authority = { version: 1, kind: 'owner-authenticated-dead-epoch-successor', requestId, nonce,
    clientId: f.clientId, ownerTokenHash: api.hash(f.token), configHash: api.brokerConfigHash(f.cfg),
    predecessor, previousOwner, previousBuildHash: api.readJson(oldIdentityFile).buildHash,
    previousBrokerTerminated: true, previousProcessTerminated: true, expectedProcess,
    candidateRoot: runtime, sourceCommit, buildHash: codeHash, qualification: lineage.reference(qualificationFile),
    permission: 'one-proven-new-document-only', historicalOutcome: 'unknown' };
  const authorityFile = path.join(audit, 'authority.json'); api.durable(authorityFile, authority, true);
  const authorityEntry = lineage.reference(authorityFile);
  const epochId = randomUUID(), creation = path.join(audit, 'isolated-scratch-qualification');
  fs.mkdirSync(creation, { mode: 0o700 });
  const document = { name: 'FMCAD_ISOLATED_' + epochId, creationId: 'synthetic-independent-successor-id', fileId: null };
  const instance = { ...expectedProcess, version: 'fixture', activeCommand: 'SelectCommand', documents: [] };
  const resultFile = path.join(creation, 'result.json');
  api.durable(resultFile, { kind: 'isolated-scratch-qualification', status: 'complete', clientId: f.clientId,
    currentInstance: instance, nativeOutcome: 'unknown', summary: { purpose: 'isolated-scratch-epoch-v1', epochId,
      document, independent: true, empty: true, unsaved: true, previousActiveCreationId: 'synthetic-user-active-document' } }, true);
  const evidence = ['intent.json', 'start.json', 'wire.json', 'sdk-qualified.json', 'remote-' + randomUUID() + '.json'].map(name => {
    const file = path.join(creation, name); api.durable(file, { syntheticSdkEvidence: name }, true); return lineage.reference(file);
  });
  const pointer = { ...f.pointer, epochId, root: path.join(f.dir, 'admission-epochs', epochId), document,
    currentInstance: instance, qualificationReceipt: lineage.reference(resultFile), qualificationEvidence: evidence, succession: authorityEntry,
    restoreActiveCreationId: 'synthetic-user-active-document' };
  const identity = { configHash: api.brokerConfigHash(f.cfg), buildHash: codeHash, sourceCommit, instance };
  const approval = { version: 1, purpose: 'dead-isolated-epoch-successor-v1', requestId, clientId: f.clientId,
    previousOwner,
    predecessorEpochId: f.pointer.epochId, previousBuildHash: authority.previousBuildHash,
    pointerHash: predecessor.pointer.sha256, stateHash: predecessor.state.sha256,
    rootStateHash: predecessor.rootState.sha256, rootIdentityHash: predecessor.rootIdentity.sha256,
    candidateRoot: runtime, sourceCommit, buildHash: codeHash, expectedProcess, qualification: authority.qualification };
  const inspection = { requestId, clientId: f.clientId, ownerTokenHash: authority.ownerTokenHash,
    registeredTokenHash: authority.ownerTokenHash, runtime, codeHash, configHash: authority.configHash,
    pointer: f.pointer, snapshot: predecessor, identity: api.readJson(oldIdentityFile),
    rootIdentity: api.readJson(path.join(f.dir, 'instance.json')), previousOwner,
    previousLifecycle: { owner: previousOwner, buildHash: authority.previousBuildHash,
      configHash: authority.configHash, stage: 'ready' },
    previousBrokerAlive: false, previousProcessAlive: !oldProcessAlive ? false : true, originalProcessAlive: false,
    expectedProcessAlive: true, pending: false, qualification: api.readJson(qualificationFile) };
  return { ...f, audit, requestId, nonce, previousOwner, authority, authorityEntry, pointer, identity, approval, inspection,
    priorJob: { ...priorJob, request: previousState.data.jobs[priorJob.id].request }, auditIdentity,
    initialization: { createdAtMs: Date.now(), bindingHash: 'synthetic-successor-binding' } };
};
