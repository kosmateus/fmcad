'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Actual post-transition mismatch shape, synthetic files/processes only.
module.exports = function fixture(base, repo, { effectiveConfig, sourceConfig, historicalBuildHash } = {}) {
  const f = require('./dead-epoch-successor.cjs')(base, repo, { inFlight: true, sourceConfig, historicalBuildHash });
  const api = require(repo + '/src/queue-instance');
  const lineage = require(repo + '/src/queue-epoch-lineage');
  const pointer = f.inspection.pointer;
  const cfg = { ...f.cfg, ...(effectiveConfig || { backend: 'mcp', url: 'http://127.0.0.1:1/never-called', tool: 'fixture' }) };
  const transition = path.join(f.dir, 'physical-backend-transitions', 'synthetic-to-mcp');
  fs.mkdirSync(transition, { recursive: true });
  const identity = { ...f.inspection.identity, configHash: api.brokerConfigHash(cfg), buildHash: 'c'.repeat(64) };
  api.durable(path.join(transition, 'instance.json'), identity);
  const receiptFile = path.join(f.dir, `broker-startup-${f.previousOwner.nonce}.receipt.json`);
  api.durable(receiptFile, { brokerNonce: f.previousOwner.nonce, ownerPid: f.previousOwner.pid,
    ownerBirth: f.previousOwner.birth, buildHash: identity.buildHash, stage: 'startup',
    auditExpectedInstance: pointer.currentInstance, instance: pointer.currentInstance,
    terminal: true, outcome: 'succeeded' });
  const head = { version: 1, kind: 'owner-bound-physical-backend-transition', requestId: 'synthetic-to-mcp',
    ownerClientId: f.clientId, ownerTokenHash: api.hash(f.token), epochId: pointer.epochId,
    previousConfig: f.cfg, nextConfig: cfg,
    previousConfigHash: api.brokerConfigHash(f.cfg), nextConfigHash: identity.configHash,
    predecessor: [path.join(f.dir, 'instance.json'), path.join(pointer.root, 'instance.json'),
      path.join(f.dir, 'isolated-admission-epoch.json')].map(lineage.reference),
    observation: [lineage.reference(receiptFile)], identity: lineage.reference(path.join(transition, 'instance.json')) };
  const headFile = path.join(f.dir, 'physical-backend-head.json');
  api.durable(path.join(transition, 'transition.json'), head);
  api.durable(headFile, head);
  const lifecycleFile = path.join(f.dir, `broker-lifecycle-${f.previousOwner.nonce}.json`);
  api.durable(lifecycleFile, { owner: f.previousOwner, buildHash: identity.buildHash,
    configHash: identity.configHash, stage: 'ready' });
  const approval = { ...f.approval, physicalBackendHead: lineage.reference(headFile) };
  const approvalFile = path.join(base, 'backend-successor-approval.json');
  api.durable(approvalFile, approval);
  return { ...f, cfg, approval, approvalFile, head, headFile, transition, receiptFile, lifecycleFile,
    effectiveIdentity: identity, client: { dir: f.dir, auth: { clientId: f.clientId, clientToken: f.token } },
    qualifiedCreationUpgrade(published, buildHash = 'e'.repeat(64)) {
      const digest = require(repo + '/src/dist/core/application/cad/json').hash;
      const dir = path.dirname(published.pointer.qualificationReceipt.path);
      const remote = published.pointer.qualificationEvidence.find(ref => /^remote-/.test(path.basename(ref.path))).path;
      const binding = { purpose: 'isolated-scratch-epoch-v1', epochId: published.pointer.epochId,
        clientId: f.clientId, control: { buildHash: published.authority.buildHash },
        targetJobId: published.pointer.quarantinedJobIds[0], observationJobId: published.pointer.quarantinedJobIds[1],
        currentInstance: published.pointer.currentInstance, successorAuthorityHash: published.entry.sha256,
        sdkProofPath: path.join(dir, 'sdk-qualified.json') };
      const sdk = { version: 1, purpose: binding.purpose, epochId: binding.epochId,
        bindingHash: digest(binding), document: published.pointer.document,
        independent: true, empty: true, unsaved: true, historicalOutcome: 'unknown',
        previousActiveCreationId: published.pointer.restoreActiveCreationId };
      const physical = { jobId: published.pointer.quarantinedJobIds[0], rpcId: path.basename(remote).slice(7, -5),
        requestHash: api.hash('synthetic-create'), buildHash: published.authority.buildHash,
        sourceHash: 'a'.repeat(64),
        purpose: binding.purpose, auditBindingHash: digest(binding), pythonOriginHash: 'b'.repeat(64),
        auditExpectedInstance: published.pointer.currentInstance };
      api.durable(path.join(dir, 'intent.json'), { binding, sourceArtifactHash: physical.pythonOriginHash });
      api.durable(path.join(dir, 'start.json'), { binding: physical, receipt: remote,
        instance: published.pointer.currentInstance, pythonCheck: { status: 'passed' } });
      api.durable(path.join(dir, 'sdk-qualified.json'), sdk);
      api.durable(remote, { ...physical, terminal: true, outcome: 'succeeded', instance: published.pointer.currentInstance });
      api.durable(published.pointer.qualificationReceipt.path, { kind: 'isolated-scratch-qualification', status: 'complete',
        sdkRequestsSent: 1, endpointVerified: true, clientId: f.clientId,
        currentInstance: published.pointer.currentInstance, summary: sdk });
      published.pointer.qualificationEvidence = published.pointer.qualificationEvidence.map(ref => lineage.reference(ref.path));
      published.pointer.qualificationReceipt = lineage.reference(published.pointer.qualificationReceipt.path);
      api.durable(path.join(f.dir, 'isolated-admission-epoch.json'), published.pointer);
      // Existing normal-mode runtime refresh changes active identity, not the
      // immutable creation authority/physical receipt or SDK identity.
      published.identity.buildHash = buildHash;
      api.durable(path.join(published.pointer.root, 'instance.json'), published.identity);
      return published;
    },
    inverse() {
      const next = path.join(f.dir, 'physical-backend-transitions', 'synthetic-inverse');
      fs.mkdirSync(next);
      api.durable(path.join(next, 'predecessor-head.json'), head);
      const owner = { ...f.previousOwner, nonce: 'synthetic-inverse-owner' };
      const nextIdentity = { ...identity, configHash: api.brokerConfigHash(f.cfg), buildHash: 'd'.repeat(64) };
      api.durable(path.join(next, 'instance.json'), nextIdentity);
      const nextReceipt = path.join(f.dir, `broker-startup-${owner.nonce}.receipt.json`);
      api.durable(nextReceipt, { brokerNonce: owner.nonce, ownerPid: owner.pid, ownerBirth: owner.birth,
        buildHash: nextIdentity.buildHash, stage: 'startup', auditExpectedInstance: pointer.currentInstance,
        instance: pointer.currentInstance, terminal: true, outcome: 'succeeded' });
      const inverse = { ...head, requestId: 'synthetic-inverse', previousConfig: cfg, nextConfig: f.cfg,
        previousConfigHash: identity.configHash, nextConfigHash: nextIdentity.configHash,
        predecessor: [...head.predecessor, head.identity, lineage.reference(path.join(next, 'predecessor-head.json')), ...head.observation],
        observation: [lineage.reference(nextReceipt)], identity: lineage.reference(path.join(next, 'instance.json')) };
      api.durable(path.join(next, 'transition.json'), inverse);
      api.durable(headFile, inverse);
      api.durable(path.join(f.dir, 'broker.lock'), owner);
      api.durable(path.join(f.dir, `broker-lifecycle-${owner.nonce}.json`), {
        owner, buildHash: nextIdentity.buildHash, configHash: nextIdentity.configHash, stage: 'ready' });
      api.durable(approvalFile, { ...approval, previousOwner: owner, physicalBackendHead: lineage.reference(headFile) });
      return { cfg: f.cfg, identity: nextIdentity };
    },
    restoreAfterPublish(published) {
      const next = path.join(f.dir, 'physical-backend-transitions', 'synthetic-next-epoch-restore');
      fs.mkdirSync(next);
      const owner = { ...f.previousOwner, nonce: 'synthetic-next-epoch-owner' };
      const nextIdentity = { ...published.identity, configHash: api.brokerConfigHash(f.cfg) };
      api.durable(path.join(next, 'instance.json'), nextIdentity);
      const nextReceipt = path.join(f.dir, `broker-startup-${owner.nonce}.receipt.json`);
      api.durable(nextReceipt, { brokerNonce: owner.nonce, ownerPid: owner.pid, ownerBirth: owner.birth,
        buildHash: nextIdentity.buildHash, stage: 'startup', auditExpectedInstance: published.pointer.currentInstance,
        instance: published.pointer.currentInstance, terminal: true, outcome: 'succeeded' });
      const restored = { ...head, requestId: 'synthetic-next-epoch-restore', epochId: published.pointer.epochId,
        previousConfig: cfg, nextConfig: f.cfg, previousConfigHash: identity.configHash, nextConfigHash: nextIdentity.configHash,
        predecessor: [path.join(f.dir, 'instance.json'), path.join(published.pointer.root, 'instance.json'),
          path.join(f.dir, 'isolated-admission-epoch.json')].map(lineage.reference).concat(published.entry,
            published.authority.backendTransition.head),
        observation: [lineage.reference(nextReceipt)], identity: lineage.reference(path.join(next, 'instance.json')) };
      api.durable(path.join(next, 'transition.json'), restored);
      api.durable(headFile, restored);
      const lifecycleFile = path.join(f.dir, `broker-lifecycle-${owner.nonce}.json`);
      api.durable(lifecycleFile, { owner, buildHash: nextIdentity.buildHash, configHash: nextIdentity.configHash, stage: 'ready' });
      const audit = path.join(f.dir, 'epoch-successions', api.hash('synthetic-future-cold'));
      fs.mkdirSync(audit);
      const snapshot = lineage.predecessorSnapshot(f.dir, audit, true);
      return { cfg: f.cfg, identity: nextIdentity, owner, audit, snapshot,
        proof: { head: lineage.reference(path.join(next, 'transition.json')), lifecycle: lineage.reference(lifecycleFile) },
        head: restored, transition: next };
    },
    publish() {
      const client = { dir: f.dir, auth: { clientId: f.clientId, clientToken: f.token } };
      const inspection = require(repo + '/src/queue-epoch-successor').inspectSuccessor(client, cfg, approvalFile, f.requestId);
      const authority = { ...f.authority, configHash: identity.configHash, backendTransition: inspection.backendTransition };
      api.durable(f.authorityEntry.path, authority);
      const entry = lineage.reference(f.authorityEntry.path);
      const pointer = { ...f.pointer, succession: entry };
      const nextIdentity = { ...f.identity, configHash: identity.configHash };
      const state = require(repo + '/src/queue-isolated-epoch').openIsolatedEpoch(f.dir, { recover: false });
      state.installEpoch(pointer, nextIdentity, f.initialization);
      return { pointer, identity: nextIdentity, authority, entry, state };
    } };
};
