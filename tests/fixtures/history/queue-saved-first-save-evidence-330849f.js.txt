'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson, sameInstance, priorProcessAlive } = require('./queue-instance');
const { fileHash } = require('./queue-atomic-migration-files');
const { firstSaveAdmission, firstSavePublication, markerFile } = require('./queue-saved-first-save');
const { savedAdministrativeEvidence } = require('./queue-saved-admin-evidence');
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_FIRST_SAVE_EVIDENCE_REQUIRED' }); };
const reference = file => ({ path: file, sha256: fileHash(file).sha256 });

function firstSaveEvidence(root, epoch, expectedJobId) {
  const marker = markerFile(epoch), grant = readJson(marker), scope = grant.savedFirstSave;
  if (!scope || grant.epochId !== epoch.epochId || !same(grant.document, epoch.document)) fail('Exact first-save origin scope required');
  const state = readJson(path.join(epoch.root, 'queue-state.json'), 256 * 1024 * 1024);
  const matches = Object.values(state.jobs).filter(job => job.clientId === grant.clientId && job.requestId === scope.saveRequestId);
  if (matches.length !== 1 || matches[0].id !== expectedJobId) fail('Exact original first-save job required');
  const job = matches[0];
  if (!/^[a-f0-9-]{36}$/.test(job.id) || job.kind !== 'command' || job.state !== 'succeeded' || job.details?.sdkSettled !== true ||
      job.request.ownerToken !== grant.clientTokenHash || !(job.dispatch?.rpcCount > 0) || job.dispatch.rpcCount !== job.dispatch.completedCount)
    fail('Original first-save job must have known settled success');
  const identity = readJson(path.join(epoch.root, 'instance.json'));
  firstSaveAdmission(epoch, job.request, grant, identity);
  const dir = path.join(root, 'jobs', job.id), worker = path.join(dir, 'worker-identity.json');
  if (priorProcessAlive(readJson(worker)) !== false) fail('Original save worker must have terminated');
  const evidence = [reference(marker), reference(path.join(dir, 'request.json')), reference(path.join(dir, 'outcome.json')), reference(worker)];
  let scripts = 0;
  for (const name of fs.readdirSync(dir).filter(name => /^rpc-.*\.json$/.test(name) && name !== 'rpc-result.json')) {
    const file = path.join(dir, name), record = readJson(file, 128 * 1024 * 1024);
    if (!record.receipt) continue;
    scripts++;
    const binding = record.binding, remote = readJson(record.receipt);
    if (record.terminal !== true || record.failed !== false || record.pythonCheck?.status !== 'passed' ||
        binding?.jobId !== job.id || binding.buildHash !== identity.buildHash ||
        binding.purpose !== 'saved-fixture-first-save-v1' || binding.auditFirstSave !== true ||
        !same(binding.auditExpectedDocument, epoch.document) || !sameInstance(binding.auditExpectedInstance, epoch.currentInstance) ||
        remote.terminal !== true || remote.outcome !== 'succeeded' || !sameInstance(remote.instance, epoch.currentInstance) ||
        Object.keys(binding).some(key => !same(remote[key], binding[key]))) fail('Exact checked first-save physical receipt required');
    evidence.push(reference(file), reference(record.receipt));
  }
  if (scripts !== 1) fail('Exactly one native first-save body required');
  for (const name of ['preflight.json', 'postflight.json']) {
    const file = path.join(dir, name), value = readJson(file), observed = name === 'preflight.json' ? value.instance : value;
    if (observed.documentState?.status !== 'complete' || observed.documentState.state?.identity?.creationId !== epoch.document.creationId)
      fail('Exact first-save pre/postflight identity required');
    evidence.push(reference(file));
  }
  const stdout = require('./queue-response-files').responsePath(root, job, 'stdout.txt');
  if (fs.statSync(stdout).size > 1024 * 1024) fail('Bounded first-save output required');
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(stdout, 'utf8')); } catch { fail('Original typed first-save result required'); }
  if (envelope.success !== true || envelope.operation !== 'document.save_as') fail('Original save envelope is not successful');
  firstSavePublication(grant, envelope.result, null);
  evidence.push(reference(stdout));
  return { grant, identity, job, reply: envelope.result, evidence };
}

function readSavedPublication(root, epoch) {
  const file = path.join(epoch.root, 'saved-first-save-publication.json'), value = readJson(file, 32 * 1024 * 1024);
  if (value.version !== 1 || value.kind !== 'owner-verified-new-saved-publication' || value.epochId !== epoch.epochId ||
      value.ownerClientId !== epoch.ownerClientId || value.ownerTokenHash !== epoch.ownerTokenHash ||
      !same(value.originDocument, epoch.document) || value.publication?.status !== 'complete' || value.publication.grantIssued !== false ||
      !Array.isArray(value.firstSaveEvidence) || !Array.isArray(value.observationEvidence))
    fail('Exact owner publication record required');
  for (const ref of [...value.firstSaveEvidence, ...value.observationEvidence, value.observationReceipt]) {
    if (!ref || !path.isAbsolute(ref.path) || fs.realpathSync(ref.path) !== ref.path || fileHash(ref.path).sha256 !== ref.sha256)
      fail('Saved publication evidence changed');
  }
  const first = firstSaveEvidence(root, epoch, value.firstSaveJobId);
  const firstRefs = new Map(value.firstSaveEvidence.map(ref => [ref.path, ref.sha256]));
  if (firstRefs.size !== value.firstSaveEvidence.length || firstRefs.size !== first.evidence.length ||
      first.evidence.some(ref => firstRefs.get(ref.path) !== ref.sha256) ||
      value.sourceCommit !== first.identity.sourceCommit || value.buildHash !== first.identity.buildHash)
    fail('Saved publication must retain all exact first-save evidence and source identity');
  if (!same(value.publication, firstSavePublication(first.grant, first.reply, value.publication.observation)))
    fail('Saved publication facts differ from the original first save');
  const { proof, binding } = savedAdministrativeEvidence(root, epoch, value.observationReceipt, value.observationEvidence, {
    prefix: 'sp-', purpose: 'saved-first-save-publication-v1', proofName: 'sdk-publication.json', jobId: first.job.id,
    sourceCommit: first.identity.sourceCommit, buildHash: first.identity.buildHash });
  if (binding.firstSaveJobId !== first.job.id ||
      !same(binding.destination, { projectId: first.reply.target.projectId, folderId: first.grant.savedFirstSave.destination.folderId }) ||
      binding.expectedFileId !== (first.reply.targetObserved ? first.reply.current.fileId : null) ||
      !same(proof.observed, value.publication.observation)) fail('Publication must bind the exact original first-save target');
  return { value, reference: reference(file), first };
}

module.exports = { firstSaveEvidence, readSavedPublication, reference };
