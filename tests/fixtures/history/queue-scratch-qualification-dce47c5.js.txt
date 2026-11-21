'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { preparePythonArtifact } = require('./python');
const { hash, fusionPath } = require('./queue-instance');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'SCRATCH_QUALIFICATION_INVALID' }); };
const literal = value => value === null ? 'None' : value === true ? 'True' : value === false ? 'False' :
  Array.isArray(value) ? '[' + value.map(literal).join(', ') + ']' : typeof value === 'object'
    ? '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + literal(v)).join(', ') + '}' : JSON.stringify(value);

function prepareScratchQualification(installation, _identity, binding, { directory }) {
  const closing = binding.purpose === 'isolated-scratch-close-v1';
  const inputs = ['runtime/python/recovery/atomic_audit.py', 'runtime/python/recovery/scratch_epoch.py'].map((filename, i) => ({
    id: i ? 'fresh-scratch' : 'audit-types', filename, role: 'runtime', source: fs.readFileSync(path.join(installation, filename), 'utf8'),
  }));
  const proofPath = path.join(directory, closing ? 'sdk-closed.json' : 'sdk-qualified.json');
  if (binding.sdkProofPath !== proofPath) fail('Scratch proof escaped its broker-derived directory');
  const args = { epochId: binding.epochId, name: 'FMCAD_ISOLATED_' + binding.epochId,
    proofPath: fusionPath(proofPath), bindingHash: canonicalHash(binding),
    ...(closing ? { document: binding.document,
      ...(Object.hasOwn(binding, 'restoreActiveCreationId') ? { restoreActiveCreationId: binding.restoreActiveCreationId } : {}) }
      : { forbiddenIds: binding.forbiddenIds, ...(binding.captureActiveDocument === true ? { captureActiveDocument: true } : {}) }) };
  inputs.push({ id: 'wrapper', filename: '<fmcad-fresh-scratch>', role: 'wrapper', source: `
_EP_REQUEST: AaObject = ${literal(args)}
def run(_context: str) -> None:
    import adsk.core
    result = ${closing ? 'close_qualified_scratch' : 'qualify_new_scratch'}(_aa_cast(EpochApplication, adsk.core.Application.get()), _EP_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(result, allow_nan=False))
` });
  const artifact = preparePythonArtifact(inputs, { request: args,
    context: { kind: binding.purpose, ...binding } });
  return { artifact, sourceFile: path.join(installation, inputs[1].filename), sourceSha256: hash(inputs[1].source), proofPath };
}

function resultValue(reply) {
  let text = reply?.result?.content?.find(row => row.type === 'text')?.text;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) fail('No bounded scratch result');
  try { const wrapped = JSON.parse(text); if (typeof wrapped.stdout === 'string') text = wrapped.stdout; } catch { /* Plain line. */ }
  let result;
  try { result = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('FMCAD_RESULT ')).slice(13)); }
  catch { fail('Malformed scratch qualification'); }
  return result;
}

function parseScratchQualification(reply, _identity, binding) {
  const result = resultValue(reply);
  const keys = ['version', 'purpose', 'epochId', 'bindingHash', 'document', 'independent', 'empty', 'unsaved', 'activeCommand',
    'beforeIdsHash', 'historicalOutcome', 'originalModelValidation', 'originalRollbackVerification',
    ...(binding.captureActiveDocument === true ? ['previousActiveCreationId'] : [])];
  if (!result || Object.keys(result).sort().join(',') !== keys.sort().join(',') || result.version !== 1 ||
      result.purpose !== 'isolated-scratch-epoch-v1' || result.epochId !== binding.epochId ||
      result.bindingHash !== canonicalHash(binding) || !result.document ||
      Object.keys(result.document).sort().join(',') !== 'creationId,fileId,name' ||
      result.document.name !== 'FMCAD_ISOLATED_' + binding.epochId || result.document.fileId !== null ||
      typeof result.document.creationId !== 'string' || !result.document.creationId ||
      binding.forbiddenIds?.includes(result.document.creationId) ||
      result.independent !== true || result.empty !== true || result.unsaved !== true ||
      !['', 'SelectCommand'].includes(result.activeCommand) ||
      !/^[a-f0-9]{64}$/.test(result.beforeIdsHash || '') || result.historicalOutcome !== 'unknown' ||
      result.originalModelValidation !== 'not_performed' || result.originalRollbackVerification !== 'not_performed')
    fail('Scratch identity/independence/empty/unsaved proof is incomplete');
  if (binding.captureActiveDocument === true && result.previousActiveCreationId !== null &&
      (typeof result.previousActiveCreationId !== 'string' || !result.previousActiveCreationId ||
        result.previousActiveCreationId === result.document.creationId)) fail('Invalid pre-scratch active document identity');
  return result;
}

function parseScratchClose(reply, _identity, binding) {
  const result = resultValue(reply);
  const keys = ['version', 'purpose', 'document', 'bindingHash', 'closed', 'saved', 'historicalOutcome',
    'originalModelValidation', 'originalRollbackVerification',
    ...(Object.hasOwn(binding, 'restoreActiveCreationId') ? ['activeBeforeCloseCreationId', 'restoredActiveCreationId', 'activeDocumentRestored'] : [])];
  if (!result || Object.keys(result).sort().join(',') !== keys.sort().join(',') || result.version !== 1 ||
      result.purpose !== 'isolated-scratch-close-v1' || result.bindingHash !== canonicalHash(binding) ||
      canonicalHash(result.document) !== canonicalHash(binding.document) || result.closed !== true || result.saved !== false ||
      result.historicalOutcome !== 'unknown' || result.originalModelValidation !== 'not_performed' ||
      result.originalRollbackVerification !== 'not_performed') fail('Exact qualified scratch-only close proof required');
  if (Object.hasOwn(binding, 'restoreActiveCreationId')) {
    const before = result.activeBeforeCloseCreationId;
    const target = before === binding.document.creationId ? binding.restoreActiveCreationId : before;
    if ((before !== null && (typeof before !== 'string' || !before)) || result.activeDocumentRestored !== true ||
        result.restoredActiveCreationId !== target) fail('Active-document restoration proof does not match the captured or user-selected identity');
  }
  return result;
}

module.exports = { prepareScratchQualification, parseScratchQualification, parseScratchClose };
