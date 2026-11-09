'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson, sameInstance } = require('./queue-instance');
const { savedAuditKind } = require('./queue-saved-audit-path');
const { fileHash } = require('./queue-atomic-migration-files');
const { epochControlDirectory } = require('./queue-epoch-lineage');
const { parseSavedFixtureReader } = require('./queue-saved-fixture-reader');
const digest = value => require('./dist/core/application/cad/json').hash(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_ADMIN_EVIDENCE_REQUIRED' }); };

function savedAdministrativeEvidence(root, epoch, receiptRef, evidence, expected) {
  const controlRoot = epochControlDirectory(root, epoch);
  if (!receiptRef || typeof receiptRef.path !== 'string' || path.dirname(path.dirname(receiptRef.path)) !== controlRoot ||
      path.basename(receiptRef.path) !== 'result.json' || fs.realpathSync(receiptRef.path) !== receiptRef.path ||
      fileHash(receiptRef.path).sha256 !== receiptRef.sha256 || !Array.isArray(evidence) || evidence.length !== 5)
    fail('Exact owner administrative receipt and five-artifact evidence set required');
  const result = readJson(receiptRef.path, 32 * 1024 * 1024);
  if (typeof result.requestId !== 'string' || !result.requestId.trim() || result.requestId.length > 180)
    fail('Exact stable administrative request required');
  const kind = savedAuditKind(expected.prefix, result.requestId), directory = path.join(controlRoot, kind);
  const refs = new Map(evidence.map(ref => [ref.path, ref]));
  if (refs.size !== 5 || receiptRef.path !== path.join(directory, 'result.json')) fail('Administrative namespace mismatch');
  function read(name) {
    const file = path.join(directory, name), ref = refs.get(file);
    if (!ref || fs.realpathSync(file) !== file || fileHash(file).sha256 !== ref.sha256) fail('Administrative artifact changed');
    return readJson(file, 32 * 1024 * 1024);
  }
  const intent = read('intent.json'), start = read('start.json'); read('wire.json');
  const proof = read(expected.proofName), binding = intent.binding;
  if (result.kind !== kind || result.status !== 'complete' || result.sdkRequestsSent !== 1 || result.endpointVerified !== true ||
      result.clientId !== epoch.ownerClientId || result.jobId !== expected.jobId || result.nativeOutcome !== 'unknown' ||
      result.modelValidation !== 'not_performed' || result.rollbackVerification !== 'not_performed' || !same(result.summary, proof) ||
      binding?.purpose !== expected.purpose || binding.epochId !== epoch.epochId || binding.clientId !== epoch.ownerClientId ||
      binding.ownerTokenHash !== epoch.ownerTokenHash || !same(binding.document, epoch.document) ||
      !sameInstance(binding.currentInstance, epoch.currentInstance) || binding.sdkProofPath !== path.join(directory, expected.proofName) ||
      binding.sourceCommit !== expected.sourceCommit || binding.buildHash !== expected.buildHash ||
      !/^[a-f0-9]{64}$/.test(intent.sourceArtifactHash || '') || start.binding?.auditBindingHash !== digest(binding) ||
      start.binding.pythonOriginHash !== intent.sourceArtifactHash || start.binding.purpose !== expected.purpose ||
      start.binding.buildHash !== expected.buildHash || start.binding.jobId !== expected.jobId ||
      !sameInstance(start.binding.auditExpectedInstance, epoch.currentInstance) || start.pythonCheck?.status !== 'passed' ||
      !/^[a-f0-9-]{36}$/.test(start.binding.rpcId || '') ||
      start.receipt !== path.join(directory, 'remote-' + start.binding.rpcId + '.json'))
    fail('Administrative evidence must retain exact owner/source/process/purpose binding');
  const remote = read('remote-' + start.binding.rpcId + '.json');
  if (remote.terminal !== true || remote.outcome !== 'succeeded' || !sameInstance(remote.instance, epoch.currentInstance) ||
      Object.keys(start.binding).some(key => !same(remote[key], start.binding[key]))) fail('Known successful physical receipt required');
  parseSavedFixtureReader({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(proof) }] } }, epoch.document, binding);
  return { result, intent, start, proof, binding };
}

module.exports = { savedAdministrativeEvidence };
