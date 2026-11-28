'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson, durable } = require('./queue-instance');
const { savedAuditKind, savedAuditLegacyKind } = require('./queue-saved-audit-path');
const { createRecoveryAudit } = require('./queue-atomic-recovery-audit');
const { verifyScratchSdkProof } = require('./queue-scratch-control');
const { prepareSavedFixtureReader, parseSavedFixtureReader } = require('./queue-saved-fixture-reader');
const { firstSaveEvidence, readSavedPublication, reference } = require('./queue-saved-first-save-evidence');
const { firstSavePublication } = require('./queue-saved-first-save');
const { epochControlDirectory } = require('./queue-epoch-lineage');
const { savedDestinationApproval } = require('./queue-saved-destination-approval');
const { savedReadinessEvidence } = require('./queue-saved-readiness-evidence');
const { readSavedNativeDestination } = require('./queue-saved-native-destination');
const digest = value => require('./dist/core/application/cad/json').hash(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function createSavedFixtureControl(p) {
  const controllers = new Map();
  function owner(clientId) {
    const epoch = p.state.epoch;
    if (!epoch || clientId !== epoch.ownerClientId || p.clients()[clientId] !== epoch.ownerTokenHash)
      fail('NOT_OWNER', 'Only the original credential-bound owner may observe or retain a first-saved fixture');
    return epoch;
  }
  function controller(phase, requestId) {
    const kind = savedAuditKind(phase === 'probe' ? 'dp-' : phase === 'observe' ? 'sp-' : 'sr-', requestId);
    if (controllers.has(kind)) return controllers.get(kind);
    const value = createRecoveryAudit({ ...p.auditPorts, kind, priorObservationRequired: false,
      extraKeys: phase === 'probe' ? ['epochId', 'authorityFile', 'folderProofFile'] : ['epochId'],
      jobDirectory: () => epochControlDirectory(p.dir, p.state.epoch),
      prepareReader: prepareSavedFixtureReader, parseSummary: parseSavedFixtureReader,
      assertOwner(jobId, _priorObservationId, clientId) {
        const epoch = owner(clientId);
        if (phase === 'probe') savedReadinessEvidence(p.dir, epoch, jobId);
        else firstSaveEvidence(p.dir, epoch, jobId);
      },
      async inspect(message, clientId) {
        const epoch = owner(clientId); p.state.assertEpoch(); p.assertControl(message.control); p.fence(false);
        if (phase === 'probe') {
          savedReadinessEvidence(p.dir, epoch, message.jobId);
          const destination = savedDestinationApproval(message.authorityFile, message.folderProofFile, clientId);
          const identity = readJson(path.join(epoch.root, 'instance.json'));
          return { identity: epoch.document, instance: epoch.currentInstance, binding: {
            purpose: 'saved-fixture-destination-v1', epochId: epoch.epochId, document: epoch.document,
            currentInstance: epoch.currentInstance, historicalInstance: epoch.originalInstance,
            clientId, ownerTokenHash: epoch.ownerTokenHash, readinessJobId: message.jobId,
            sourceCommit: identity.sourceCommit, buildHash: identity.buildHash, destination, before: p.snapshot(),
            sdkProofPath: path.join(epochControlDirectory(p.dir, epoch), kind, 'sdk-destination.json') } };
        }
        const first = firstSaveEvidence(p.dir, epoch, message.jobId);
        const publication = phase === 'retain' ? readSavedPublication(p.dir, epoch) : null;
        const directory = path.join(epochControlDirectory(p.dir, epoch), kind);
        return { identity: epoch.document, instance: epoch.currentInstance,
          binding: { purpose: phase === 'observe' ? 'saved-first-save-publication-v1' : 'saved-fixture-retain-v1',
            epochId: epoch.epochId, document: epoch.document, currentInstance: epoch.currentInstance,
            historicalInstance: epoch.originalInstance, clientId, ownerTokenHash: epoch.ownerTokenHash,
            firstSaveJobId: first.job.id, sourceCommit: first.identity.sourceCommit, buildHash: first.identity.buildHash,
            before: p.snapshot(),
            sdkProofPath: path.join(directory, phase === 'observe' ? 'sdk-publication.json' : 'sdk-retained.json'),
            ...(phase === 'observe' ? {
              destination: { projectId: first.reply.target.projectId, folderId: first.grant.savedFirstSave.destination.folderId },
              expectedFileId: first.reply.targetObserved ? first.reply.current.fileId : null,
            } : { publication: publication.reference, savedDocument: publication.value.publication.document,
              restoreActiveCreationId: epoch.restoreActiveCreationId ?? null }) } };
      },
      fence(value, inFlight) {
        owner(value.binding.clientId); p.state.assertEpoch();
        if (digest(p.snapshot()) !== digest(value.binding.before))
          fail('SAVED_FIXTURE_FENCE_CHANGED', 'Original first-save owner/runtime/state changed during observation or retain');
        p.fence(inFlight);
      },
      async publishComplete(result, prior, receipt) {
        const epoch = owner(result.clientId);
        const evidence = verifyScratchSdkProof(result, prior, receipt, p.auditPorts);
        if (phase === 'probe') {
          const ready = savedReadinessEvidence(p.dir, epoch, result.jobId);
          const identity = readJson(path.join(epoch.root, 'instance.json'));
          const record = { version: 1, kind: 'owner-verified-native-saved-destination', epochId: epoch.epochId,
            originDocument: epoch.document, ownerClientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash,
            sourceCommit: identity.sourceCommit, buildHash: identity.buildHash, approvedDestination: prior.binding.destination,
            destination: result.summary.destination, readinessJobId: ready.job.id, readinessJobs: ready.jobs,
            readinessEvidence: ready.evidence, receipt: reference(receipt), qualificationEvidence: evidence };
          const file = path.join(epoch.root, 'saved-destination-native.json');
          if (fs.existsSync(file)) {
            if (!same(readJson(file), record)) fail('SAVED_DESTINATION_CONFLICT', 'A different native destination is already recorded');
          } else { this.fence({ binding: prior.binding }, false); durable(file, record, true); }
          return { destination: readSavedNativeDestination(p.dir, epoch, prior.binding.destination), grantIssued: false };
        }
        const first = firstSaveEvidence(p.dir, epoch, result.jobId);
        if (phase === 'observe') {
          const publication = firstSavePublication(first.grant, first.reply, result.summary.observed);
          if (publication.status !== 'complete') return { publication: publication.status, grantIssued: false };
          const file = path.join(epoch.root, 'saved-first-save-publication.json');
          const record = { version: 1, kind: 'owner-verified-new-saved-publication', epochId: epoch.epochId,
            originDocument: epoch.document, ownerClientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash,
            sourceCommit: first.identity.sourceCommit, buildHash: first.identity.buildHash,
            firstSaveJobId: first.job.id, publication, firstSaveEvidence: first.evidence,
            observationReceipt: reference(receipt), observationEvidence: evidence };
          if (fs.existsSync(file)) {
            if (!same(readJson(file), record)) fail('SAVED_PUBLICATION_CONFLICT', 'A different publication is already recorded');
          } else { this.fence({ binding: prior.binding }, false); durable(file, record, true); }
          readSavedPublication(p.dir, epoch);
          return { publication: 'complete', record: reference(file), grantIssued: false };
        }
        const publication = readSavedPublication(p.dir, epoch);
        if (!same(prior.binding.publication, publication.reference) ||
            !same(result.summary.savedDocument, publication.value.publication.document))
          fail('SAVED_RETAIN_SCOPE_CHANGED', 'Only the exact separately observed publication may be retained');
        const file = path.join(epoch.root, 'closed.json');
        const closed = { epochId: epoch.epochId, document: epoch.document, historicalOutcome: 'unknown',
          disposition: 'retained-new-saved-file', retentionRequestId: result.requestId,
          savedDocument: result.summary.savedDocument, publication: publication.reference,
          receipt: reference(receipt), qualificationEvidence: evidence };
        if (fs.existsSync(file)) {
          if (!same(readJson(file), closed)) fail('SAVED_RETAIN_SCOPE_CHANGED', 'Retained-file disposition changed');
        } else { this.fence({ binding: prior.binding }, false); durable(file, closed, true); }
        p.closed(epoch);
        return { disposition: 'retained-new-saved-file', activeDocumentRestored: true, savedModelingGrantIssued: false };
      },
    });
    controllers.set(kind, value);
    return value;
  }
  function handle(phase, message, clientId) {
    const epoch = owner(clientId);
    const action = phase === 'probe' ? 'probe-saved-destination' : phase === 'observe' ? 'observe-saved-first-save' : 'retain-saved-fixture';
    const keys = ['action', 'auth', 'control', 'epochId', 'jobId', 'requestId', ...(phase === 'probe' ? ['authorityFile', 'folderProofFile'] : [])];
    if (message.action !== action || Object.keys(message).some(key => !keys.includes(key)) ||
        message.epochId !== epoch.epochId || typeof message.requestId !== 'string' || !message.requestId.trim() || message.requestId.length > 180)
      fail('INVALID_REQUEST', 'Exact saved fixture action/epoch and stable request ID required');
    const prefix = phase === 'probe' ? 'dp-' : phase === 'observe' ? 'sp-' : 'sr-';
    const legacyKind = savedAuditLegacyKind(prefix, message.requestId);
    const legacyDir = path.join(epochControlDirectory(p.dir, epoch), legacyKind);
    if (fs.existsSync(path.join(legacyDir, 'intent.json'))) {
      const prior = readJson(path.join(legacyDir, 'intent.json'));
      const key = { jobId: message.jobId, requestId: message.requestId, clientId };
      if (!same(prior.key, key) || prior.binding?.epochId !== epoch.epochId ||
          prior.binding.ownerTokenHash !== epoch.ownerTokenHash || !same(prior.binding.document, epoch.document))
        fail('AUDIT_ALREADY_REQUESTED', 'An original legacy audit exists; never redirect it to a new SDK attempt');
      const file = path.join(legacyDir, 'result.json');
      if (!fs.existsSync(file)) return { kind: legacyKind, ...key, status: 'pending', receipt: file, legacyRecord: true };
      const original = readJson(file);
      if (original.kind !== legacyKind || Object.entries(key).some(([name, value]) => original[name] !== value))
        fail('AUDIT_RESULT_CHANGED', 'Original legacy audit receipt changed');
      return { ...original, receipt: file, legacyRecord: true };
    }
    if (phase === 'probe' && fs.existsSync(path.join(epoch.root, 'saved-destination-native.json'))) {
      const approved = savedDestinationApproval(message.authorityFile, message.folderProofFile, clientId);
      const destination = readSavedNativeDestination(p.dir, epoch, approved);
      if (readJson(destination.record.path).readinessJobId !== message.jobId) fail('INVALID_REQUEST', 'Original readiness job required');
      return { kind: 'saved-native-destination-record', status: 'complete', alreadyRecorded: true, destination,
        sdkRequestsSent: 0, grantIssued: false };
    }
    if (phase === 'observe' && fs.existsSync(path.join(epoch.root, 'saved-first-save-publication.json'))) {
      const published = readSavedPublication(p.dir, epoch);
      if (message.jobId !== published.value.firstSaveJobId) fail('INVALID_REQUEST', 'Original first-save job required');
      return { kind: 'saved-publication-record', alreadyRecorded: true, status: 'complete',
        publication: published.value.publication, record: published.reference, sdkRequestsSent: 0, grantIssued: false };
    }
    if (phase === 'retain' && !fs.existsSync(path.join(epoch.root, 'saved-first-save-publication.json')))
      fail('SAVED_PUBLICATION_PENDING', 'A separately observed complete publication is required before retaining/closing');
    if (phase === 'retain') {
      const publication = readSavedPublication(p.dir, epoch);
      const file = path.join(epoch.root, 'saved-retention-intent.json');
      const intent = { version: 1, epochId: epoch.epochId, ownerClientId: clientId, ownerTokenHash: epoch.ownerTokenHash,
        requestId: message.requestId, jobId: message.jobId, publication: publication.reference };
      if (message.jobId !== publication.value.firstSaveJobId) fail('INVALID_REQUEST', 'Original first-save job required');
      if (fs.existsSync(file)) {
        if (!same(readJson(file), intent)) fail('SAVED_RETAIN_ALREADY_REQUESTED', 'Never repeat retention/close under another request after an uncertain result');
      } else {
        p.state.assertEpoch(); p.assertControl(message.control); p.fence(false);
        durable(file, intent, true);
      }
    }
    return controller(phase, message.requestId).handle(message, clientId);
  }
  return { probe: (message, clientId) => handle('probe', message, clientId),
    observe: (message, clientId) => handle('observe', message, clientId),
    retain: (message, clientId) => handle('retain', message, clientId) };
}

async function savedFixtureAction(client, action, options, codeHash) {
  if (!['probe-saved-destination', 'grant-saved-first-save', 'observe-saved-first-save', 'retain-saved-fixture'].includes(action))
    fail('INVALID_REQUEST', 'Unknown saved fixture action');
  const status = await client.call('queue-summary');
  if (status.features?.savedFirstSaveLifecycle !== true) fail('SAVED_FIXTURE_UNSUPPORTED', 'Installed broker has no qualified saved first-save lifecycle');
  if (status.control?.buildHash !== codeHash) fail('BUILD_CHANGED', 'Saved fixture CLI and broker must share the same qualified runtime');
  const { instanceId, generation, contextEpoch } = status.control;
  return client.call(action, { ...options, control: { instanceId, generation, contextEpoch, buildHash: codeHash } });
}

module.exports = { createSavedFixtureControl, savedFixtureAction };
