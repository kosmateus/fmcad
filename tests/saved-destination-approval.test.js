'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { savedDestinationApproval } = require('../src/queue-saved-destination-approval');

function fixture(t) {
  const dir = fs.mkdtempSync('/tmp/opencode/saved-destination-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = name => path.join(dir, name + '.json');
  const write = (name, value) => { fs.writeFileSync(file(name), JSON.stringify(value)); return {
    path: file(name), sha256: crypto.createHash('sha256').update(fs.readFileSync(file(name))).digest('hex') }; };
  const authority = { version: 1, purpose: 'new-saved-native-fixtures-in-user-confirmed-private-project',
    ownerClientId: 'original-owner', privacyEvidence: 'explicit user confirmation in current conversation; not inferred from membership',
    projectName: 'PRIVATE_TEST', projectId: 'urn:adsk.workspace:test.project:id', projectUrl: 'https://example.test/project',
    hubId: 'test-hub', region: 'US', folderName: 'FMCAD_NATIVE_20261105_123456ab',
    scope: 'one separate new folder and only new qualification files; retain for user inspection; no existing-data or permission changes' };
  const proof = { version: 1, status: 'new-authorized-folder-created-once-and-read-back',
    projectName: authority.projectName, projectId: authority.projectId, folderName: authority.folderName,
    folderId: 'urn:adsk.wipprod:fs.folder:test-new-folder', dataFilesCreated: 0,
    retention: 'Keep new qualification files for user inspection; no deletion or existing-data/permission changes.',
    authority: write('authority', authority),
    creationIntent: write('intent', { operation: 'fusion_data.create_folder', project_name: authority.projectName,
      project_url: authority.projectUrl, hub_id: authority.hubId, region: authority.region, folder_name: authority.folderName }),
    creationResult: write('result', { success: true, project_name: authority.projectName, folder_id: 'urn:adsk.wipprod:fs.folder:test-new-folder' }),
    readback: write('readback', { success: true, tool: 'fusion_data.search_by_hub', query: authority.folderName,
      matches: [{ type: 'Folder', id: 'urn:adsk.wipprod:fs.folder:test-new-folder', name: authority.folderName, projectName: authority.projectName }] }) };
  write('proof', proof);
  return { file, write, authority, proof, inspect: owner => savedDestinationApproval(file('authority'), file('proof'), owner || 'original-owner') };
}

test('FAKE approval: original owner and exact new destination do not issue save permission', t => {
  const f = fixture(t), result = f.inspect();
  assert.equal(result.folderId, f.proof.folderId); assert.equal(result.projectName, f.authority.projectName);
  assert.equal(result.nativeProjectId, null); assert.equal(result.grantIssued, false);
  assert.equal(result.existingDataChangesAllowed, false); assert.equal(result.retention, 'keep-for-user-inspection');
  assert.equal(result.evidence.length, 5);
});

for (const [name, mutate] of [
  ['foreign owner', f => { f.authority.ownerClientId = 'foreign'; f.write('authority', f.authority); }],
  ['membership instead of privacy confirmation', f => { f.authority.privacyEvidence = 'ADMINISTRATOR'; f.write('authority', f.authority); }],
  ['existing user folder', f => { f.authority.folderName = 'UserDesigns'; f.write('authority', f.authority); }],
  ['changed receipt bytes', f => { fs.appendFileSync(f.file('result'), ' '); }],
  ['foreign folder', f => { f.proof.folderId = 'urn:adsk.wipprod:fs.folder:foreign'; f.write('proof', f.proof); }],
  ['foreign project', f => { f.proof.projectId = 'urn:adsk.workspace:foreign'; f.write('proof', f.proof); }],
  ['deletion retention', f => { f.proof.retention = 'delete-after-test'; f.write('proof', f.proof); }],
]) test('FAKE approval refuses ' + name, t => {
  const f = fixture(t); mutate(f); assert.throws(() => f.inspect(), { code: 'SAVED_DESTINATION_SCOPE_INVALID' });
});
