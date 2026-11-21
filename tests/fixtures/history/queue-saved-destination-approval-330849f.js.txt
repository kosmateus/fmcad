'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./queue-instance');
const { fileHash } = require('./queue-atomic-migration-files');
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_DESTINATION_SCOPE_INVALID' }); };

// This validates explicit owner approval and destination evidence, not a modeling
// grant or permission to save an existing/recovered document.
function savedDestinationApproval(authorityFile, folderProofFile, ownerClientId) {
  function read(file, expectedHash) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file ||
        !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
      fail('Canonical regular approval/evidence file required');
    const sha256 = fileHash(file).sha256;
    if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== sha256))
      fail('Approval or destination evidence hash changed');
    return { reference: { path: file, sha256 }, value: readJson(file, 1024 * 1024) };
  }
  function reference(ref) {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) fail('Hashed destination evidence required');
    return read(ref.path, ref.sha256);
  }
  const authority = read(authorityFile), proof = read(folderProofFile), a = authority.value, p = proof.value;
  if (a.version !== 1 || a.purpose !== 'new-saved-native-fixtures-in-user-confirmed-private-project' ||
      !ownerClientId || a.ownerClientId !== ownerClientId ||
      a.privacyEvidence !== 'explicit user confirmation in current conversation; not inferred from membership' ||
      typeof a.projectName !== 'string' || !a.projectName.trim() ||
      typeof a.projectId !== 'string' || !a.projectId.startsWith('urn:adsk.workspace:') ||
      typeof a.hubId !== 'string' || !a.hubId || !['US', 'IND', 'DEU'].includes(a.region) ||
      typeof a.projectUrl !== 'string' || !a.projectUrl.startsWith('https://') ||
      !/^FMCAD_NATIVE_\d{8}_[a-f0-9]{8}$/.test(a.folderName || '') ||
      a.scope !== 'one separate new folder and only new qualification files; retain for user inspection; no existing-data or permission changes')
    fail('Explicit original-owner private-project and new-files-only approval required');
  if (p.version !== 1 || p.status !== 'new-authorized-folder-created-once-and-read-back' ||
      p.projectName !== a.projectName || p.projectId !== a.projectId || p.folderName !== a.folderName ||
      typeof p.folderId !== 'string' || !p.folderId.startsWith('urn:adsk.wipprod:fs.folder:') ||
      p.authority?.path !== authority.reference.path || p.authority?.sha256 !== authority.reference.sha256 ||
      p.dataFilesCreated !== 0 ||
      p.retention !== 'Keep new qualification files for user inspection; no deletion or existing-data/permission changes.')
    fail('Exact newly created destination and preserved retention scope required');
  const intent = reference(p.creationIntent), created = reference(p.creationResult), observed = reference(p.readback);
  const i = intent.value, c = created.value, o = observed.value;
  if (i.operation !== 'fusion_data.create_folder' || i.project_name !== a.projectName || i.project_url !== a.projectUrl ||
      i.hub_id !== a.hubId || i.region !== a.region || i.folder_name !== a.folderName ||
      c.success !== true || c.project_name !== a.projectName || c.folder_id !== p.folderId ||
      o.success !== true || o.tool !== 'fusion_data.search_by_hub' || o.query !== a.folderName ||
      !Array.isArray(o.matches) || o.matches.length !== 1 || o.matches[0].type !== 'Folder' ||
      o.matches[0].id !== p.folderId || o.matches[0].name !== a.folderName || o.matches[0].projectName !== a.projectName)
    fail('Folder creation and independent readback must match the exact approved destination');
  return { version: 1, purpose: 'validated-new-saved-fixture-destination', ownerClientId,
    cloudProjectId: a.projectId, projectName: a.projectName, projectUrl: a.projectUrl,
    hubId: a.hubId, region: a.region, folderName: a.folderName, folderId: p.folderId,
    // SDK DataProject.id is a separately observed identity, not an alias guessed
    // from a Manufacturing Data API workspace ID.
    nativeProjectId: null, grantIssued: false, existingDataChangesAllowed: false,
    retention: 'keep-for-user-inspection',
    evidence: [authority.reference, proof.reference, intent.reference, created.reference, observed.reference] };
}

module.exports = { savedDestinationApproval };
