'use strict';
// Synthetic owner/destination metadata only; no cloud or Fusion connection.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function fixture(t, repo) {
  const api = require(repo + '/src/queue-instance');
  const { fileHash } = require(repo + '/src/queue-atomic-migration-files');
  const { openIsolatedEpoch } = require(repo + '/src/queue-isolated-epoch');
  const { grantSavedFirstSave } = require(repo + '/src/queue-saved-first-save');
  const root = fs.mkdtempSync('/tmp/opencode/first-save-scope-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = require('./dead-epoch-successor.cjs')(root, repo);
  const state = openIsolatedEpoch(f.dir, { recover: false }); state.installEpoch(f.pointer, f.identity, f.initialization);
  const clients = { [f.clientId]: state.epoch.ownerTokenHash, native: api.hash('native-first-save-token') };
  function write(name, value) { const file = path.join(root, name + '.json'); api.durable(file, value, true); return { path: file, sha256: fileHash(file).sha256 }; }
  const authority = { version: 1, purpose: 'new-saved-native-fixtures-in-user-confirmed-private-project',
    ownerClientId: f.clientId, privacyEvidence: 'explicit user confirmation in current conversation; not inferred from membership',
    projectName: 'PRIVATE', projectId: 'urn:adsk.workspace:test-project', projectUrl: 'https://example.test/project',
    hubId: 'hub', region: 'US', folderName: 'FMCAD_NATIVE_20261105_123456ab',
    scope: 'one separate new folder and only new qualification files; retain for user inspection; no existing-data or permission changes' };
  const authorityRef = write('authority', authority), folderId = 'urn:adsk.wipprod:fs.folder:new-test-folder';
  const proofRef = write('folder-proof', { version: 1, status: 'new-authorized-folder-created-once-and-read-back',
    projectName: authority.projectName, projectId: authority.projectId, folderName: authority.folderName, folderId,
    dataFilesCreated: 0, retention: 'Keep new qualification files for user inspection; no deletion or existing-data/permission changes.',
    authority: authorityRef, creationIntent: write('intent', { operation: 'fusion_data.create_folder',
      project_name: authority.projectName, project_url: authority.projectUrl, hub_id: authority.hubId,
      region: authority.region, folder_name: authority.folderName }),
    creationResult: write('created', { success: true, project_name: authority.projectName, folder_id: folderId }),
    readback: write('observed', { success: true, tool: 'fusion_data.search_by_hub', query: authority.folderName,
      matches: [{ type: 'Folder', id: folderId, name: authority.folderName, projectName: authority.projectName }] }) });
  const p = { dir: f.dir, state, buildHash: api.buildHash(), clients: () => clients,
    assertControl: control => require('node:assert/strict').deepEqual(control, { fake: true }), fence() {} };
  const message = { action: 'grant-saved-first-save', control: { fake: true }, epochId: state.epoch.epochId,
    grantClientId: 'native', requestId: 'owner-first-save-grant', saveRequestId: 'one-exact-first-save',
    authorityFile: authorityRef.path, folderProofFile: proofRef.path };
  const native = require('./saved-native-destination.cjs')({ ...f, base: root, state }, repo, authorityRef.path, proofRef.path);
  function request(changes = {}) {
    const payload = { version: 1, kind: 'cad', operation: 'document.save_as', doc: state.epoch.document.name,
      docId: state.epoch.document.creationId, data: { name: state.epoch.document.name, project: authority.projectName,
        folder: authority.folderName, expectedProjectId: native.nativeDestination.nativeProjectId, expectedFolderId: folderId, confirm: true }, ...changes };
    return { kind: 'command', clientId: 'native', requestId: message.saveRequestId, inputFiles: [], payload,
      argv: require(repo + '/src/cad-service').policyArguments(payload) };
  }
  return { ...f, base: root, state, p, clients, message, request, readinessJob: native.job,
    nativeDestination: native.nativeDestination, grant: () => grantSavedFirstSave(p, message, f.clientId) };
};
