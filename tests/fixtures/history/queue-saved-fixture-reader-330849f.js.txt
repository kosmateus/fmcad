'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { preparePythonArtifact } = require('./python');
const { fusionPath, hash } = require('./queue-instance');
const { assertSavedAuditPathBudget } = require('./queue-saved-audit-path');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_FIXTURE_PROOF_INVALID' }); };
const literal = value => value === null ? 'None' : value === true ? 'True' : value === false ? 'False' :
  Array.isArray(value) ? '[' + value.map(literal).join(', ') + ']' : typeof value === 'object'
    ? '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ': ' + literal(item)).join(', ') + '}' : JSON.stringify(value);

function prepareSavedFixtureReader(installation, _identity, binding, { directory }) {
  assertSavedAuditPathBudget(directory);
  const retaining = binding.purpose === 'saved-fixture-retain-v1';
  const probing = binding.purpose === 'saved-fixture-destination-v1';
  if (!retaining && !probing && binding.purpose !== 'saved-first-save-publication-v1') fail('Unknown saved fixture administrative purpose');
  const proofPath = path.join(directory, retaining ? 'sdk-retained.json' : probing ? 'sdk-destination.json' : 'sdk-publication.json');
  if (binding.sdkProofPath !== proofPath) fail('Saved fixture proof escaped its broker directory');
  const sourceFiles = ['runtime/python/recovery/atomic_audit.py', 'runtime/python/recovery/scratch_epoch.py',
    'runtime/python/recovery/saved_fixture.py'];
  const inputs = sourceFiles.map((filename, index) => ({ id: 'saved-fixture-' + index, filename, role: 'runtime',
    source: fs.readFileSync(path.join(installation, filename), 'utf8') }));
  const args = { epochId: binding.epochId, document: binding.document, proofPath: fusionPath(proofPath), bindingHash: canonicalHash(binding),
    ...(retaining ? { savedDocument: binding.savedDocument, restoreActiveCreationId: binding.restoreActiveCreationId ?? null }
      : { destination: binding.destination, expectedFileId: binding.expectedFileId ?? null }) };
  inputs.push({ id: 'wrapper', filename: '<fmcad-saved-fixture>', role: 'wrapper', source: `
_SAVED_REQUEST: AaObject = ${literal(args)}
def run(_context: str) -> None:
    import adsk.core
    result = ${retaining ? 'retain_saved_fixture' : probing ? 'probe_saved_destination' : 'observe_saved_fixture'}(_aa_cast(SavedFixtureApplication, adsk.core.Application.get()), _SAVED_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(result, allow_nan=False))
` });
  return { artifact: preparePythonArtifact(inputs, { request: args, context: { kind: binding.purpose, ...binding } }),
    sourceFile: path.join(installation, sourceFiles[2]), sourceSha256: hash(inputs[2].source), proofPath };
}

function parseSavedFixtureReader(reply, _identity, binding) {
  let text = reply?.result?.content?.find(row => row.type === 'text')?.text;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) fail('No bounded saved fixture result');
  try { const wrapped = JSON.parse(text); if (typeof wrapped.stdout === 'string') text = wrapped.stdout; } catch { /* Plain text result. */ }
  const lines = text.split(/\r?\n/).filter(line => line.startsWith('FMCAD_RESULT '));
  let result;
  try { if (lines.length !== 1) fail('One saved fixture result required'); result = JSON.parse(lines[0].slice(13)); }
  catch { fail('Malformed saved fixture result'); }
  if (result?.version !== 1 || result.purpose !== binding.purpose || result.epochId !== binding.epochId ||
      result.bindingHash !== canonicalHash(binding) || canonicalHash(result.document) !== canonicalHash(binding.document))
    fail('Saved fixture result does not match its original owner binding');
  const keys = ['version', 'purpose', 'epochId', 'bindingHash', 'document', ...(binding.purpose === 'saved-fixture-retain-v1'
    ? ['savedDocument', 'closed', 'saved', 'retained', 'activeBeforeCloseCreationId', 'restoredActiveCreationId', 'activeDocumentRestored']
    : binding.purpose === 'saved-fixture-destination-v1' ? ['destination', 'readOnly'] : ['observed', 'readOnly'])];
  if (Object.keys(result).sort().join(',') !== keys.sort().join(',')) fail('Unexpected saved fixture proof fields');
  if (binding.purpose === 'saved-fixture-retain-v1') {
    if (result.closed !== true || result.saved !== true || result.retained !== true || result.activeDocumentRestored !== true ||
        canonicalHash(result.savedDocument) !== canonicalHash(binding.savedDocument)) fail('Exact retained saved-file close proof required');
    const target = result.activeBeforeCloseCreationId === binding.document.creationId
      ? binding.restoreActiveCreationId ?? null : result.activeBeforeCloseCreationId;
    if (result.restoredActiveCreationId !== target) fail('Captured active document restore differs');
  } else if (binding.purpose === 'saved-fixture-destination-v1') {
    const destination = result.destination;
    if (result.readOnly !== true || !destination || destination.projectName !== binding.destination.projectName ||
        destination.folderName !== binding.destination.folderName || destination.folderId !== binding.destination.folderId ||
        !['nativeProjectId', 'nativeHubId', 'nativeHubName'].every(key => typeof destination[key] === 'string' && destination[key]))
      fail('Exact read-only native destination identity required');
  } else if (result.readOnly !== true || !result.observed || result.observed.creationId !== binding.document.creationId ||
      result.observed.name !== binding.document.name) fail('Exact read-only publication observation required');
  return result;
}

module.exports = { prepareSavedFixtureReader, parseSavedFixtureReader };
