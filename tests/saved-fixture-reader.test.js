'use strict';
const test = require('node:test');
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('../src/queue-instance');
const { prepareSavedFixtureReader, parseSavedFixtureReader } = require('../src/queue-saved-fixture-reader');
const canonicalHash = value => require('../src/dist/core/application/cad/json').hash(value);

test('FAKE SDK saved publication and retained-file close refuse unsafe states without save/delete', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'saved_fixture_test.py')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

for (const purpose of ['saved-fixture-destination-v1', 'saved-first-save-publication-v1', 'saved-fixture-retain-v1'])
test('production checker qualifies fixed saved fixture administrative source, SDK0: ' + purpose,
  { timeout: 180000 }, async t => {
    const directory = fs.mkdtempSync('/tmp/opencode/saved-fixture-reader-');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const epochId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const document = { name: 'FMCAD_ISOLATED_' + epochId, creationId: 'owned-new', fileId: null };
    const binding = { purpose, epochId, document,
      currentInstance: { pid: process.pid, birth: api.processBirth(), version: 'offline-fixture' },
      sdkProofPath: path.join(directory, purpose.includes('retain') ? 'sdk-retained.json'
        : purpose.includes('destination') ? 'sdk-destination.json' : 'sdk-publication.json'),
      destination: { projectId: 'native-project', projectName: 'APPROVED', folderName: 'APPROVED_NEW_FOLDER', folderId: 'approved-folder' }, expectedFileId: 'new-file',
      savedDocument: { name: document.name, creationId: document.creationId, fileId: 'new-file',
        projectId: 'native-project', folderId: 'approved-folder', version: 1 }, restoreActiveCreationId: 'user-restore' };
    const installation = path.resolve(__dirname, '..');
    const reader = prepareSavedFixtureReader(installation, {}, binding, { directory });
    const prepared = require('../src/queue-atomic-recovery-audit').prepareRecoveryAuditWire({ reader,
      receipt: path.join(directory, 'never-sent.json'), instance: binding.currentInstance,
      buildHash: api.buildHash(), jobId: 'offline-saved-administrative', auditBinding: binding,
      payload: { jsonrpc: '2.0', id: 'offline', method: 'tools/call', params: { name: 'execute_python',
        arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
    const runtime = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: __filename }).runtime;
    const certificate = await require('../src/queue-admission').createProductionQueueAdmission(runtime).admission.check(prepared.outgoing, prepared.artifact);
    assert.equal(certificate.report.status, 'passed'); certificate.fence(prepared.outgoing);
    assert.equal(fs.existsSync(path.join(directory, 'never-sent.json')), false);
    assert.equal(fs.existsSync(binding.sdkProofPath), false);
  });

test('saved reader parser rejects wrong binding, restore identity and extra success fields', () => {
  const binding = { purpose: 'saved-fixture-retain-v1', epochId: 'owned-epoch',
    document: { name: 'OWNED', creationId: 'new-id', fileId: null }, savedDocument: { fileId: 'new-file' },
    restoreActiveCreationId: 'original-active' };
  const result = { version: 1, purpose: binding.purpose, epochId: binding.epochId, document: binding.document,
    savedDocument: binding.savedDocument, bindingHash: canonicalHash(binding), closed: true, saved: true, retained: true,
    activeBeforeCloseCreationId: 'new-id', restoredActiveCreationId: 'original-active', activeDocumentRestored: true };
  const reply = value => ({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(value) }] } });
  assert.deepEqual(parseSavedFixtureReader(reply(result), {}, binding), result);
  for (const changes of [{ bindingHash: 'changed' }, { restoredActiveCreationId: 'foreign' }, { nativeQualified: true }])
    assert.throws(() => parseSavedFixtureReader(reply({ ...result, ...changes }), {}, binding), { code: 'SAVED_FIXTURE_PROOF_INVALID' });
});
