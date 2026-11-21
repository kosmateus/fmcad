'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson } = require('./queue-instance');
const { fileHash } = require('./queue-atomic-migration-files');
const { savedAdministrativeEvidence } = require('./queue-saved-admin-evidence');
const { savedReadinessEvidence } = require('./queue-saved-readiness-evidence');
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_NATIVE_DESTINATION_REQUIRED' }); };

function readSavedNativeDestination(root, epoch, approved) {
  const file = path.join(epoch.root, 'saved-destination-native.json');
  if (!fs.existsSync(file)) fail('A separate owner-verified native destination read is required before first-save authority');
  const value = readJson(file, 32 * 1024 * 1024);
  const identity = readJson(path.join(epoch.root, 'instance.json'));
  if (value.version !== 1 || value.kind !== 'owner-verified-native-saved-destination' || value.epochId !== epoch.epochId ||
      value.ownerClientId !== epoch.ownerClientId || value.ownerTokenHash !== epoch.ownerTokenHash ||
      !same(value.originDocument, epoch.document) || !same(value.approvedDestination, approved) ||
      value.sourceCommit !== identity.sourceCommit || value.buildHash !== identity.buildHash ||
      !Array.isArray(value.readinessEvidence)) fail('Exact owner-approved native destination record required');
  const ready = savedReadinessEvidence(root, epoch, value.readinessJobId, value.readinessJobs);
  const refs = new Map(value.readinessEvidence.map(ref => [ref.path, ref.sha256]));
  if (refs.size !== value.readinessEvidence.length || refs.size !== ready.evidence.length ||
      ready.evidence.some(ref => refs.get(ref.path) !== ref.sha256)) fail('Native destination must preserve original readiness evidence');
  const admin = savedAdministrativeEvidence(root, epoch, value.receipt, value.qualificationEvidence, {
    prefix: 'dp-', purpose: 'saved-fixture-destination-v1', proofName: 'sdk-destination.json', jobId: ready.job.id,
    sourceCommit: identity.sourceCommit, buildHash: identity.buildHash });
  if (!same(admin.binding.destination, approved) || admin.binding.readinessJobId !== ready.job.id ||
      !same(value.destination, admin.proof.destination)) fail('Native destination differs from its exact SDK read');
  return { ...value.destination, record: { path: file, sha256: fileHash(file).sha256 } };
}

module.exports = { readSavedNativeDestination };
