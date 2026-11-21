'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson, hash, buildHash } = require('./queue-instance');
const { exclusive } = require('./queue-atomic-migration-files');
const { savedDestinationApproval } = require('./queue-saved-destination-approval');
const { epochControlDirectory } = require('./queue-epoch-lineage');
const { readSavedNativeDestination } = require('./queue-saved-native-destination');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const markerFile = epoch => path.join(epoch.root, 'saved-first-save-scope.json');

function grantSavedFirstSave(p, message, clientId) {
  const keys = ['action', 'auth', 'control', 'epochId', 'grantClientId', 'requestId', 'saveRequestId', 'authorityFile', 'folderProofFile'];
  if (!message || Object.keys(message).some(key => !keys.includes(key)) || message.action !== 'grant-saved-first-save' ||
      ![message.requestId, message.saveRequestId].every(value => typeof value === 'string' && value.trim() && value.length <= 180))
    fail('INVALID_REQUEST', 'Exact stable grant and first-save request IDs required');
  const epoch = p.state.epoch, clients = p.clients();
  if (!epoch || clientId !== epoch.ownerClientId || clients[clientId] !== epoch.ownerTokenHash)
    fail('NOT_OWNER', 'Only the original credential-bound owner may approve a first save');
  p.state.assertEpoch(); p.assertControl(message.control); p.fence();
  if (fs.existsSync(path.join(epochControlDirectory(p.dir, epoch), 'isolated-scratch-close', 'intent.json')))
    fail('EPOCH_CLEANUP_PENDING', 'Cleanup intent forbids new save authority');
  if (message.epochId !== epoch.epochId || typeof message.grantClientId !== 'string' || message.grantClientId === clientId ||
      !/^[a-f0-9]{64}$/.test(clients[message.grantClientId] || ''))
    fail('SAVED_FIRST_SAVE_CLIENT_REQUIRED', 'Exact fresh epoch and separate registered client required');
  if (epoch.kind !== 'isolated-fresh-scratch-epoch' || epoch.document.fileId !== null)
    fail('SAVED_FIRST_SAVE_FRESH_REQUIRED', 'Existing saved or recovered documents cannot be adopted');
  const identity = readJson(path.join(epoch.root, 'instance.json'));
  if (identity.buildHash !== p.buildHash || p.buildHash !== buildHash() || !/^[a-f0-9]{40}$/.test(identity.sourceCommit || ''))
    fail('BUILD_CHANGED', 'First-save scope requires this exact qualified source/runtime');
  const destination = savedDestinationApproval(message.authorityFile, message.folderProofFile, clientId);
  const nativeDestination = readSavedNativeDestination(p.dir, epoch, destination);
  const grant = { epochId: epoch.epochId, clientId: message.grantClientId, clientTokenHash: clients[message.grantClientId],
    document: epoch.document, savedFirstSave: { version: 1, kind: 'one-new-first-save-v1', requestId: message.requestId,
      saveRequestId: message.saveRequestId, sourceCommit: identity.sourceCommit, buildHash: p.buildHash, destination, nativeDestination } };
  const file = path.join(epoch.root, 'access-' + hash(grant.clientId + '\0' + grant.clientTokenHash) + '.json');
  if (fs.existsSync(file)) {
    if (!same(readJson(file), grant)) fail('GRANT_SCOPE_CONFLICT', 'Never broaden an existing client grant');
    if (!fs.existsSync(markerFile(epoch)) || !same(readJson(markerFile(epoch)), grant))
      fail('SAVED_FIRST_SAVE_SCOPE_INVALID', 'Exact durable first-save marker required');
    return grant;
  }
  const jobs = Object.values(p.state.data.jobs);
  if (jobs.some(job => job.state !== 'succeeded' || job.details?.sdkSettled !== true || job.kind !== 'command' ||
      job.request?.payload?.kind !== 'cad' || !['document.status', 'snapshot'].includes(job.request.payload.operation) ||
      job.request.payload.doc !== epoch.document.name || job.request.payload.docId !== epoch.document.creationId ||
      job.sequenceId || !(job.dispatch?.rpcCount > 0) || job.dispatch.completedCount !== job.dispatch.rpcCount) ||
      p.state.data.active || p.state.data.blocked || p.state.data.lease || p.state.data.localUnknown || p.state.data.controlBlocked ||
      fs.existsSync(path.join(epoch.root, 'closed.json')))
    fail('SAVED_FIRST_SAVE_FRESH_REQUIRED', 'Only settled readiness reads may precede first-save scope');
  const creation = readJson(epoch.qualificationReceipt.path);
  if (creation.status !== 'complete' || creation.summary?.independent !== true || creation.summary.empty !== true ||
      creation.summary.unsaved !== true || !same(creation.summary.document, epoch.document))
    fail('SAVED_FIRST_SAVE_FRESH_REQUIRED', 'Independent empty unsaved creation proof required');
  // Publish the narrowing marker first. A lost reply or interrupted grant write
  // must not reopen ordinary modeling. Repeating an identical grant never saves.
  if (fs.existsSync(markerFile(epoch))) {
    if (!same(readJson(markerFile(epoch)), grant)) fail('GRANT_SCOPE_CONFLICT', 'First-save authority is already pinned');
  } else exclusive(markerFile(epoch), grant);
  exclusive(file, grant);
  return grant;
}

function firstSaveAdmission(epoch, request, grant, identity) {
  const scope = grant?.savedFirstSave;
  if (!scope || scope.version !== 1 || scope.kind !== 'one-new-first-save-v1' ||
      scope.sourceCommit !== identity.sourceCommit || scope.buildHash !== identity.buildHash ||
      !same(grant.document, epoch.document) || grant.epochId !== epoch.epochId ||
      !fs.existsSync(markerFile(epoch)) || !same(readJson(markerFile(epoch)), grant))
    fail('SAVED_FIRST_SAVE_SCOPE_INVALID', 'Exact original first-save scope/source/build required');
  const authority = scope.destination?.evidence?.[0], proof = scope.destination?.evidence?.[1];
  if (!authority || !proof || !same(scope.destination, savedDestinationApproval(authority.path, proof.path, epoch.ownerClientId)))
    fail('SAVED_FIRST_SAVE_SCOPE_INVALID', 'Original owner destination evidence changed');
  if (!same(scope.nativeDestination, readSavedNativeDestination(path.dirname(path.dirname(epoch.root)), epoch, scope.destination)))
    fail('SAVED_FIRST_SAVE_SCOPE_INVALID', 'Native destination identity changed');
  const service = require('./cad-service');
  let payload;
  try { payload = service.decodeInvocation(request.payload); } catch { fail('SAVED_FIRST_SAVE_SCOPE_REQUIRED', 'Typed first-save invocation required'); }
  const expected = { name: epoch.document.name, project: scope.destination.projectName,
    folder: scope.destination.folderName, expectedProjectId: scope.nativeDestination.nativeProjectId,
    expectedFolderId: scope.destination.folderId, confirm: true };
  if (request.kind !== 'command' || request.clientId !== grant.clientId || request.requestId !== scope.saveRequestId || request.phased || request.sequenceId ||
      request.inputFiles?.length || payload.kind !== 'cad' || payload.operation !== 'document.save_as' ||
      payload.doc !== epoch.document.name || payload.docId !== epoch.document.creationId ||
      (payload.docFileId ?? null) !== null || (payload.projectId ?? null) !== null || payload.output !== undefined ||
      !same(payload.data, expected) || !same(request.argv, service.policyArguments(payload)))
    fail('SAVED_FIRST_SAVE_SCOPE_REQUIRED', 'Only one exact first save of the proven-new document to its approved folder is admitted');
  return { kind: 'saved-first-save', purpose: 'saved-fixture-first-save-v1', requiresFreshUnmodified: true };
}

function firstSavePublication(grant, reply, observed) {
  const scope = grant?.savedFirstSave, destination = scope?.destination, origin = grant?.document;
  const invalid = message => fail('SAVED_FIRST_SAVE_PUBLICATION_INVALID', message);
  if (!scope || scope.kind !== 'one-new-first-save-v1' || !origin || origin.fileId !== null || !destination)
    invalid('Original new-document first-save scope required');
  const base = { saveRequestId: scope.saveRequestId, originDocument: origin, grantIssued: false,
    existingDataChangesAllowed: false, retention: 'keep-for-user-inspection' };
  if (!reply || reply.accepted !== true) return { ...base,
    status: reply?.accepted === false ? 'failed' : 'unknown', firstSave: reply ?? null };
  if (!['complete', 'pending'].includes(reply.status) || typeof reply.targetObserved !== 'boolean' ||
      reply.pending !== (reply.status === 'pending') ||
      reply.original?.creationId !== origin.creationId || reply.original?.name !== origin.name ||
      reply.original?.fileId !== null || reply.original?.saved !== false || reply.original?.modified !== false ||
      reply.copyRequested !== false || reply.target?.name !== origin.name ||
      reply.target?.projectName !== destination.projectName || reply.target?.folder !== destination.folderName ||
      reply.target?.folderId !== destination.folderId || reply.target?.projectId !== scope.nativeDestination?.nativeProjectId ||
      typeof reply.target?.projectId !== 'string' || !reply.target.projectId)
    invalid('First-save receipt must retain exact fresh origin and approved destination');
  if (reply.targetObserved === true && (typeof reply.current?.fileId !== 'string' || !reply.current.fileId ||
      reply.current.creationId !== origin.creationId || reply.current.projectId !== reply.target.projectId ||
      reply.current.folderId !== destination.folderId || reply.current.fileName !== origin.name))
    invalid('A targetObserved receipt must contain the exact new file lineage');
  if (!observed) return { ...base, status: 'accepted', firstSave: reply, observation: null };
  if (observed.creationId !== origin.creationId || observed.name !== origin.name)
    invalid('Publication observation belongs to another document');
  if (observed.dataFileError) return { ...base, status: 'unknown', firstSave: reply, observation: observed };
  if (observed.fileId === null && typeof observed.saved === 'boolean')
    return { ...base, status: 'pending', firstSave: reply, observation: observed };
  if (reply.targetObserved === true && observed.fileId !== reply.current.fileId)
    invalid('Publication cannot replace an already observed first-save file lineage');
  if (typeof observed.fileId !== 'string' || !observed.fileId || observed.saved !== true ||
      (observed.fileName != null && observed.fileName !== origin.name) ||
      (observed.projectId != null && observed.projectId !== reply.target.projectId) ||
      (observed.folderId != null && observed.folderId !== destination.folderId))
    invalid('Observed new file must match exact name/project/folder lineage');
  if (observed.fileName !== origin.name || observed.projectId !== reply.target.projectId || observed.folderId !== destination.folderId ||
      observed.isComplete !== true || observed.modified !== false)
    return { ...base, status: 'pending', firstSave: reply, observation: observed };
  if (observed.version !== 1) invalid('Unexpected first-published version; never adopt version drift');
  return { ...base, status: 'complete', firstSave: reply, observation: observed,
    cloudProjectId: destination.cloudProjectId,
    document: { name: observed.name, creationId: observed.creationId, fileId: observed.fileId,
      projectId: observed.projectId, folderId: observed.folderId, version: observed.version } };
}

function firstSavePhase(epoch, jobs) {
  if (!epoch || !fs.existsSync(markerFile(epoch))) return null;
  const grant = readJson(markerFile(epoch));
  if (grant.epochId !== epoch.epochId || !same(grant.document, epoch.document) || grant.savedFirstSave?.kind !== 'one-new-first-save-v1')
    fail('SAVED_FIRST_SAVE_SCOPE_INVALID', 'Malformed first-save phase metadata');
  return Object.values(jobs).some(job => job.clientId === grant.clientId && job.requestId === grant.savedFirstSave.saveRequestId)
    ? 'saved-publication-or-retention-only' : 'qualified-first-save-only';
}

module.exports = { grantSavedFirstSave, firstSaveAdmission, firstSavePublication, firstSavePhase, markerFile };
