'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareReceiptScript } = require('../src/queue-instance');

for (const mode of ['valid', 'foreign-file', 'foreign-project', 'foreign-folder', 'version-drift',
  'unsaved', 'incomplete', 'linked', 'missing', 'duplicate', 'renamed', 'invalid', 'wrong-purpose', 'mixed-scopes'])
test('FAKE SDK: separate saved fixture guard before body: ' + mode, t => {
  const dir = fs.mkdtempSync('/tmp/opencode/saved-document-guard-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, 'body-ran'), receipt = path.join(dir, 'receipt.json');
  const expected = { name: 'OWNED_NEW_FILE', creationId: 'owned-creation', fileId: 'new-file',
    projectId: 'native-project', folderId: 'new-folder', version: 1 };
  const binding = { jobId: 'fake-job', rpcId: 'fake-rpc', buildHash: 'fake-build',
    purpose: mode === 'wrong-purpose' ? 'general-modeling' : 'saved-fixture-modeling-v1', auditExpectedSavedDocument: expected };
  if (mode === 'mixed-scopes') binding.auditExpectedDocument = { name: expected.name, creationId: expected.creationId, fileId: null };
  const prepared = prepareReceiptScript(`with open(${JSON.stringify(body)}, 'w') as stream:\n    stream.write('ran')\n`,
    false, receipt, binding, { mapPath: value => value });
  const bootstrap = `import sys, types\n` +
    `core=types.ModuleType('adsk.core'); adsk=types.ModuleType('adsk'); adsk.core=core\n` +
    `class NativeFile(types.SimpleNamespace):\n    @property\n    def parentProject(self):\n        raise RuntimeError('DataFile.parentProject InternalValidationError')\n` +
    `file=NativeFile(id=${JSON.stringify(mode === 'foreign-file' ? 'foreign' : expected.fileId)},` +
    `parentFolder=types.SimpleNamespace(id=${JSON.stringify(mode === 'foreign-folder' ? 'foreign' : expected.folderId)},` +
    `parentProject=types.SimpleNamespace(id=${JSON.stringify(mode === 'foreign-project' ? 'foreign' : expected.projectId)})),` +
    `versionNumber=${mode === 'version-drift' ? 2 : 1},isComplete=${mode === 'incomplete' ? 'False' : 'True'})\n` +
    `doc=types.SimpleNamespace(name=${JSON.stringify(mode === 'renamed' ? 'RENAMED' : expected.name)},creationId='owned-creation',` +
    `isValid=${mode === 'invalid' ? 'False' : 'True'},isSaved=${mode === 'unsaved' ? 'False' : 'True'},` +
    `dataFile=${mode === 'unsaved' ? 'None' : 'file'},allDocumentReferences=types.SimpleNamespace(count=${mode === 'linked' ? 1 : 0}))\n` +
    `rows=${mode === 'missing' ? '[]' : mode === 'duplicate' ? '[doc,doc]' : '[doc]'}\n` +
    `app=types.SimpleNamespace(version='fake',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),` +
    `documents=types.SimpleNamespace(count=len(rows),item=lambda i:rows[i]))\n` +
    `core.Application=types.SimpleNamespace(get=lambda:app); sys.modules.update({'adsk':adsk,'adsk.core':core})\n` + prepared.script;
  const result = spawnSync('python3', ['-B', '-c', bootstrap], { encoding: 'utf8', timeout: 10000 });
  const record = JSON.parse(fs.readFileSync(receipt));
  assert.equal(record.terminal, true); assert.equal(fs.existsSync(body), mode === 'valid');
  assert.equal(record.outcome, mode === 'valid' ? 'succeeded' : 'failed');
  if (mode === 'valid') assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
});

test('production checker qualifies the separate saved guard with exact file/project/folder/version and SDK0',
  { timeout: 180000 }, async t => {
    const dir = fs.mkdtempSync('/tmp/opencode/saved-document-admission-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const api = require('../src/queue-instance'), wire = require('../src/queue-atomic-recovery-audit');
    const document = { name: 'OFFLINE_SAVED', creationId: 'owned-new', fileId: 'new-file',
      projectId: 'native-project', folderId: 'owned-folder', version: 1 };
    const instance = { pid: process.pid, birth: api.processBirth(), version: 'offline-fixture' };
    const artifact = require('../src/cad').prepareCadScript('document.status', {},
      { doc: document.name, docId: document.creationId, docFileId: document.fileId, projectId: document.projectId });
    const prepared = wire.prepareRecoveryAuditWire({ reader: { artifact }, receipt: path.join(dir, 'never-sent.json'),
      instance, buildHash: api.buildHash(), jobId: 'offline-saved-only',
      auditBinding: { purpose: 'saved-fixture-modeling-v1', currentInstance: instance, expectedSavedDocument: document },
      payload: { jsonrpc: '2.0', id: 'offline', method: 'tools/call', params: { name: 'execute_python',
        arguments: { code: artifact.script + '\n\nrun("")\n', persistent: false } } } });
    const runtime = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: __filename }).runtime;
    const certificate = await require('../src/queue-admission').createProductionQueueAdmission(runtime).admission.check(prepared.outgoing, prepared.artifact);
    assert.equal(certificate.report.status, 'passed');
    assert.deepEqual(prepared.record.binding.auditExpectedSavedDocument, document);
    assert.equal(prepared.record.binding.auditExpectedDocument, undefined);
    certificate.fence(prepared.outgoing);
    const changed = structuredClone(prepared.outgoing); changed.params.arguments.code += '\n# changed';
    assert.throws(() => certificate.fence(changed));
    assert.equal(fs.existsSync(path.join(dir, 'never-sent.json')), false);
  });
