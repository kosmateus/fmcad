'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('../src/queue-instance');
const { epochAdmission } = require('../src/queue-isolated-epoch');
const { grantSavedFirstSave, firstSaveAdmission, firstSavePublication } = require('../src/queue-saved-first-save');

function fixture(t) {
  return require('./fixtures/saved-first-save.cjs')(t, path.resolve(__dirname, '..'));
}

test('FAKE metadata: owner scope pins one first-save request/destination without sending SDK', t => {
  const f = fixture(t), grant = f.grant();
  assert.deepEqual(f.grant(), grant);
  assert.doesNotThrow(() => firstSaveAdmission(f.state.epoch, f.request(), grant, f.identity));
  assert.equal(grant.document.fileId, null);
  assert.equal(grant.savedFirstSave.destination.grantIssued, false);
  assert.equal(Object.keys(f.state.data.jobs).length, 1);
  assert.equal(epochAdmission(f.state, f.request(), f.clients).kind, 'saved-first-save');
  const ordinary = f.request({ operation: 'document.status', data: {} });
  ordinary.clientId = f.clientId;
  assert.throws(() => epochAdmission(f.state, ordinary, f.clients), { code: 'SAVED_FIRST_SAVE_PENDING' });
});

test('FAKE metadata: workspace approval alone never substitutes for native destination proof', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.state.epoch.root, 'saved-destination-native.json'));
  assert.throws(f.grant, { code: 'SAVED_NATIVE_DESTINATION_REQUIRED' });
  assert.equal(fs.existsSync(path.join(f.state.epoch.root, 'saved-first-save-scope.json')), false);
});

test('FAKE metadata: caller-edited native project ID cannot replace the observed SDK record', t => {
  const f = fixture(t), file = path.join(f.state.epoch.root, 'saved-destination-native.json');
  const value = api.readJson(file); value.destination.nativeProjectId = 'caller-supplied-project'; api.durable(file, value);
  assert.throws(f.grant, { code: 'SAVED_NATIVE_DESTINATION_REQUIRED' });
  assert.equal(fs.existsSync(path.join(f.state.epoch.root, 'saved-first-save-scope.json')), false);
});

for (const mode of ['request-id', 'saved-document', 'project', 'native-project-id', 'folder', 'filename', 'folder-id', 'confirmation', 'other-operation', 'argv', 'extra-input', 'runtime'])
test('FAKE metadata: first-save admission rejects ' + mode, t => {
  const f = fixture(t), grant = f.grant(), request = f.request();
  if (mode === 'request-id') request.requestId = 'second-save';
  if (mode === 'saved-document') request.payload.docFileId = 'existing-file';
  if (mode === 'project') request.payload.data.project = 'USER_PROJECT';
  if (mode === 'native-project-id') request.payload.data.expectedProjectId = 'urn:adsk.workspace:guessed-alias';
  if (mode === 'folder') request.payload.data.folder = 'USER_FOLDER';
  if (mode === 'filename') request.payload.data.name = 'existing-name';
  if (mode === 'folder-id') request.payload.data.expectedFolderId = 'foreign-folder';
  if (mode === 'confirmation') request.payload.data.confirm = false;
  if (mode === 'other-operation') request.payload.operation = 'shape.box';
  if (mode !== 'argv') request.argv = require('../src/cad-service').policyArguments(request.payload);
  else request.argv.push('--unapproved');
  if (mode === 'extra-input') request.inputFiles = [{ path: '/unapproved' }];
  assert.throws(() => firstSaveAdmission(f.state.epoch, request, grant,
    mode === 'runtime' ? { ...f.identity, buildHash: 'a'.repeat(64) } : f.identity));
});

test('FAKE metadata: non-owner, model history and ordinary grants cannot become first-save scope', t => {
  const f = fixture(t);
  assert.throws(() => grantSavedFirstSave(f.p, f.message, 'native'), { code: 'NOT_OWNER' });
  f.state.data.jobs.modeled = { state: 'succeeded' };
  assert.throws(f.grant, { code: 'SAVED_FIRST_SAVE_FRESH_REQUIRED' });
  delete f.state.data.jobs.modeled;
  const file = path.join(f.state.epoch.root, 'access-' + api.hash('native\0' + f.p.clients().native) + '.json');
  api.durable(file, { epochId: f.state.epoch.epochId, document: f.state.epoch.document }, true);
  assert.throws(f.grant, { code: 'GRANT_SCOPE_CONFLICT' });
});

test('production checker prepares first-save target pin without sending SDK or claiming publication',
  { timeout: 180000 }, async t => {
    const dir = fs.mkdtempSync('/tmp/opencode/first-save-target-check-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const document = { name: 'OFFLINE_NEW_FIXTURE', creationId: 'offline-fresh-created', fileId: null };
    const instance = { pid: process.pid, birth: api.processBirth(), version: 'offline-fixture' };
    const artifact = require('../src/cad').prepareCadScript('document.save_as', { name: document.name,
      project: 'APPROVED_TEST_PROJECT', expectedProjectId: 'native-project', folder: 'APPROVED_NEW_FOLDER', expectedFolderId: 'approved-folder-id', confirm: true },
    { doc: document.name, docId: document.creationId });
    const prepared = require('../src/queue-atomic-recovery-audit').prepareRecoveryAuditWire({ reader: { artifact },
      receipt: path.join(dir, 'never-sent.json'), instance, buildHash: api.buildHash(), jobId: 'offline-first-save-target',
      auditBinding: { purpose: 'saved-fixture-first-save-v1', firstSave: true, currentInstance: instance, expectedDocument: document },
      payload: { jsonrpc: '2.0', id: 'offline', method: 'tools/call', params: { name: 'execute_python',
        arguments: { code: artifact.script + '\n\nrun("")\n', persistent: false } } } });
    const runtime = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: __filename }).runtime;
    const certificate = await require('../src/queue-admission').createProductionQueueAdmission(runtime).admission.check(prepared.outgoing, prepared.artifact);
    assert.equal(certificate.report.status, 'passed'); certificate.fence(prepared.outgoing);
    assert.equal(fs.existsSync(path.join(dir, 'never-sent.json')), false);
  });

for (const mode of ['valid', 'dirty', 'saved', 'inactive', 'busy', 'wrong-purpose', 'false-flag'])
test('FAKE SDK: first save requires the fresh unmodified origin at the native boundary: ' + mode, t => {
  const dir = fs.mkdtempSync('/tmp/opencode/first-save-boundary-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, 'body'), receipt = path.join(dir, 'receipt.json');
  const prepared = api.prepareReceiptScript(`with open(${JSON.stringify(body)}, 'w') as stream:\n    stream.write('ran')\n`,
    false, receipt, { jobId: 'fake', rpcId: 'fake-rpc', buildHash: 'fake-build',
      purpose: mode === 'wrong-purpose' ? 'ordinary-modeling' : 'saved-fixture-first-save-v1',
      auditFirstSave: mode !== 'false-flag', auditExpectedDocument: { name: 'FRESH', creationId: 'fresh-id', fileId: null } },
  { mapPath: value => value });
  const bootstrap = `import sys, types\n` +
    `core=types.ModuleType('adsk.core'); adsk=types.ModuleType('adsk'); adsk.core=core\n` +
    `doc=types.SimpleNamespace(name='FRESH',creationId='fresh-id',isValid=True,isSaved=${mode === 'saved' ? 'True' : 'False'},` +
    `isModified=${mode === 'dirty' ? 'True' : 'False'},dataFile=None,allDocumentReferences=types.SimpleNamespace(count=0))\n` +
    `app=types.SimpleNamespace(version='fake',activeDocument=${mode === 'inactive' ? 'object()' : 'doc'},` +
    `userInterface=types.SimpleNamespace(activeCommand=${JSON.stringify(mode === 'busy' ? 'UserCommand' : 'SelectCommand')}),` +
    `documents=types.SimpleNamespace(count=1,item=lambda i:doc))\n` +
    `core.Application=types.SimpleNamespace(get=lambda:app);sys.modules.update({'adsk':adsk,'adsk.core':core})\n` + prepared.script;
  const result = spawnSync('python3', ['-B', '-c', bootstrap], { encoding: 'utf8', timeout: 10000 });
  assert.equal(fs.existsSync(body), mode === 'valid');
  assert.equal(JSON.parse(fs.readFileSync(receipt)).outcome, mode === 'valid' ? 'succeeded' : 'failed');
  if (mode === 'valid') assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
});

test('FAKE publication: accepted save is separate from complete observation; never issues a modeling grant', t => {
  const f = fixture(t), grant = f.grant(), destination = grant.savedFirstSave.destination, origin = grant.document;
  const reply = { accepted: true, copyRequested: false, status: 'pending', pending: true, targetObserved: false, current: null,
    original: { ...origin, saved: false, modified: false },
    target: { name: origin.name, projectName: destination.projectName, projectId: grant.savedFirstSave.nativeDestination.nativeProjectId,
      folderId: destination.folderId, folder: destination.folderName } };
  const observed = { name: origin.name, creationId: origin.creationId, fileName: origin.name, fileId: 'new-file',
    projectId: grant.savedFirstSave.nativeDestination.nativeProjectId, folderId: destination.folderId, saved: true, modified: false, isComplete: true, version: 1 };
  assert.equal(firstSavePublication(grant, reply, null).status, 'accepted');
  assert.equal(firstSavePublication(grant, reply, { ...observed, isComplete: false }).status, 'pending');
  assert.equal(firstSavePublication(grant, reply, { ...observed, fileId: null, isComplete: null }).status, 'pending');
  assert.equal(firstSavePublication(grant, reply, { ...observed, folderId: null, projectId: null, isComplete: false }).status, 'pending');
  assert.equal(firstSavePublication(grant, reply, { ...observed, fileId: null,
    dataFileError: { type: 'RuntimeError', message: 'Failed to get temporary file' } }).status, 'unknown');
  const complete = firstSavePublication(grant, reply, observed);
  assert.equal(complete.status, 'complete'); assert.equal(complete.grantIssued, false);
  assert.equal(complete.document.projectId, grant.savedFirstSave.nativeDestination.nativeProjectId);
  assert.equal(complete.cloudProjectId, destination.cloudProjectId);
  assert.notEqual(complete.cloudProjectId, complete.document.projectId);
  assert.equal(firstSavePublication(grant, { accepted: false }, observed).status, 'failed');
  assert.equal(firstSavePublication(grant, null, observed).status, 'unknown');
  for (const [field, value] of [['creationId', 'foreign'], ['projectId', 'foreign'], ['folderId', 'foreign'],
    ['fileName', 'foreign'], ['version', 2]]) {
    assert.throws(() => firstSavePublication(grant, reply, { ...observed, [field]: value }),
      { code: 'SAVED_FIRST_SAVE_PUBLICATION_INVALID' });
  }
  assert.throws(() => firstSavePublication(grant, { ...reply,
    original: { ...reply.original, saved: true, fileId: 'user-file' } }, observed),
  { code: 'SAVED_FIRST_SAVE_PUBLICATION_INVALID' });
  assert.throws(() => firstSavePublication(grant, { ...reply, targetObserved: true,
    current: { ...observed, fileId: 'previously-observed-file' } }, observed),
    { code: 'SAVED_FIRST_SAVE_PUBLICATION_INVALID' });
  assert.equal(firstSavePublication(grant, { ...reply, targetObserved: false,
    current: { ...observed, fileId: 'not-yet-target', folderId: 'not-yet-target-folder' } }, observed).status, 'complete');
});
