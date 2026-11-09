'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson } = require('./queue-instance');
const { fileHash, directory } = require('./queue-atomic-migration-files');
const fail = message => { throw Object.assign(new Error(message), { code: 'EPOCH_LINEAGE_INVALID' }); };
const read = file => readJson(file, 256 * 1024 * 1024);
const digest = value => require('./dist/core/application/cad/json').hash(value);
const reference = file => ({ path: file, sha256: fileHash(file).sha256 });

function verified(entry, expectedPath) {
  if (!entry || entry.path !== expectedPath || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
      !path.isAbsolute(entry.path) || fs.realpathSync(entry.path) !== entry.path ||
      fileHash(entry.path).sha256 !== entry.sha256) fail('Retired epoch evidence changed or escaped its namespace');
  directory(path.dirname(entry.path));
  return read(entry.path);
}

function grantReferences(root) {
  return fs.readdirSync(root).filter(name => /^access-[a-f0-9]{64}\.json$/.test(name)).sort()
    .map(name => reference(path.join(root, name)));
}

// This snapshot is written only into a new owner-authenticated transaction. Old
// epoch stores and artifacts are referenced in place, never rewritten/settled.
function predecessorSnapshot(root, audit, publish = false) {
  const pointerFile = path.join(root, 'isolated-admission-epoch.json');
  const bytes = fs.readFileSync(pointerFile), pointer = JSON.parse(bytes);
  if (pointer.root !== path.join(root, 'admission-epochs', pointer.epochId || '')) fail('Invalid predecessor namespace');
  const archived = path.join(audit, 'predecessor-pointer.json');
  if (publish) {
    directory(audit);
    if (!fs.existsSync(archived)) {
      fs.copyFileSync(pointerFile, archived, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(archived, 0o600);
      const fd = fs.openSync(archived, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(audit, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    if (fileHash(archived).sha256 !== hash(bytes)) fail('The original pointer archive differs');
  }
  return {
    pointer: { path: archived, sha256: hash(bytes) },
    epochId: pointer.epochId,
    state: reference(path.join(pointer.root, 'queue-state.json')),
    identity: reference(path.join(pointer.root, 'instance.json')),
    grants: grantReferences(pointer.root),
    rootState: reference(path.join(root, 'queue-state.json')),
    rootIdentity: reference(path.join(root, 'instance.json')),
    qualification: [pointer.qualificationReceipt, ...pointer.qualificationEvidence],
  };
}

function successionAuthority(root, entry) {
  if (!entry || !path.isAbsolute(entry.path || '')) fail('Missing credential-bound succession authority');
  if (path.dirname(path.dirname(entry.path)) !== path.join(root, 'epoch-successions') ||
      !/^[a-f0-9]{64}$/.test(path.basename(path.dirname(entry.path))) || path.basename(entry.path) !== 'authority.json' ||
      fs.realpathSync(entry.path) !== entry.path) fail('Succession authority escaped its owner journal');
  const initial = read(entry.path);
  const audit = path.join(root, 'epoch-successions', hash(initial.requestId || ''));
  const authority = verified(entry, path.join(audit, 'authority.json'));
  const closedSuccessor = authority.kind === 'owner-authenticated-closed-epoch-successor';
  if (authority.version !== 1 || (!closedSuccessor && authority.kind !== 'owner-authenticated-dead-epoch-successor') ||
      typeof authority.clientId !== 'string' || !authority.clientId ||
      !/^[a-f0-9]{64}$/.test(authority.ownerTokenHash || '') ||
      !/^[a-f0-9]{40}$/.test(authority.sourceCommit || '') || !/^[a-f0-9]{64}$/.test(authority.buildHash || '') ||
      authority.previousBrokerTerminated !== !closedSuccessor || authority.previousProcessTerminated !== !closedSuccessor ||
      authority.permission !== 'one-proven-new-document-only' || authority.historicalOutcome !== 'unknown')
    fail('Invalid owner-bound dead-process authority');
  const snapshot = authority.predecessor;
  if (!snapshot || !/^[a-f0-9-]{36}$/.test(snapshot.epochId || '')) fail('Missing exact predecessor');
  const pointer = verified(snapshot.pointer, path.join(audit, 'predecessor-pointer.json'));
  const epochRoot = path.join(root, 'admission-epochs', snapshot.epochId);
  if (pointer.root !== epochRoot || pointer.epochId !== snapshot.epochId ||
      pointer.ownerClientId !== authority.clientId || pointer.ownerTokenHash !== authority.ownerTokenHash ||
      pointer.document?.fileId !== null || authority.previousBuildHash !== verified(snapshot.identity, path.join(epochRoot, 'instance.json')).buildHash)
    fail('Succession authority differs from the original owner or epoch');
  const state = verified(snapshot.state, path.join(epochRoot, 'queue-state.json'));
  verified(snapshot.rootState, path.join(root, 'queue-state.json'));
  verified(snapshot.rootIdentity, path.join(root, 'instance.json'));
  if (snapshot.rootState.sha256 !== pointer.historicalSnapshotHash || snapshot.rootIdentity.sha256 !== pointer.historicalIdentityHash ||
      digest(snapshot.grants) !== digest(grantReferences(epochRoot)) ||
      digest(snapshot.qualification) !== digest([pointer.qualificationReceipt, ...pointer.qualificationEvidence]))
    fail('Predecessor history, grants or qualification changed');
  for (const proof of snapshot.qualification) verified(proof, proof.path);
  if (closedSuccessor) {
    require('./queue-closed-epoch-proof').closedEpochProof(root, pointer, authority.closedEpochProof);
    if (authority.expectedProcess?.pid !== pointer.currentInstance.pid ||
        authority.expectedProcess?.birth !== pointer.currentInstance.birth)
      fail('A closed-epoch successor must retain the exact living Fusion process');
  }
  const qualified = verified(authority.qualification, path.join(audit, 'installed-qualification.json'));
  if (qualified.passed !== true || qualified.productionAdmission !== true || qualified.liveSdkRequestsSent !== 0 ||
      qualified.sourceCommit !== authority.sourceCommit || qualified.buildHash !== authority.buildHash ||
      qualified.deadEpochSuccessorReadQualified !== true || qualified.deadEpochSuccessorRestoreQualified !== true ||
      (closedSuccessor && qualified.closedEpochSuccessorQualified !== true))
    fail('Successor runtime has no pinned installed production-checker qualification');
  return { authority, audit, pointer, state, identity: read(snapshot.identity.path) };
}

function epochLineage(root, pointer) {
  const result = [], seen = new Set([pointer.epochId]);
  let current = pointer;
  while (current.succession !== undefined) {
    if (result.length >= 32) fail('Epoch lineage bound exceeded');
    const previous = successionAuthority(root, current.succession);
    if (seen.has(previous.pointer.epochId) || current.ownerClientId !== previous.authority.clientId ||
        current.ownerTokenHash !== previous.authority.ownerTokenHash ||
        current.historicalSnapshotHash !== previous.pointer.historicalSnapshotHash ||
        current.historicalIdentityHash !== previous.pointer.historicalIdentityHash ||
        current.qualificationReceipt?.path !== path.join(previous.audit, 'isolated-scratch-qualification', 'result.json'))
      fail('Epoch lineage is cyclic or does not bind the new qualification');
    seen.add(previous.pointer.epochId);
    result.push(previous);
    current = previous.pointer;
  }
  if (current.qualificationReceipt?.path !== path.join(root, 'isolated-scratch-qualification', 'result.json'))
    fail('Epoch lineage has no original qualified genesis');
  return result;
}

function epochControlDirectory(root, pointer) {
  if (!pointer?.succession) return root;
  return successionAuthority(root, pointer.succession).audit;
}

module.exports = { predecessorSnapshot, successionAuthority, epochLineage, epochControlDirectory, reference };
