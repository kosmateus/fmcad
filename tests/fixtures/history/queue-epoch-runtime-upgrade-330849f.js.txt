'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson, durable, priorProcessAlive, sameInstance } = require('./queue-instance');
const { exclusive, fileHash } = require('./queue-atomic-migration-files');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => hash(JSON.stringify(value));

function assertEpochFence(snapshot, approval, { paused = false, initial } = {}) {
  const { state, pointer, identity, owner, control } = snapshot;
  if (approval.version !== 1 ||
      pointer.kind !== 'isolated-fresh-scratch-epoch' || pointer.epochId !== approval.epochId ||
      pointer.ownerClientId !== approval.clientId || pointer.ownerTokenHash !== snapshot.ownerTokenHash ||
      !equal(pointer.document, approval.document) || pointer.document.fileId !== null ||
      !sameInstance(pointer.currentInstance, approval.currentInstance) ||
      identity.buildHash !== approval.previousBuildHash || !sameInstance(identity.instance, approval.currentInstance) ||
      snapshot.pointerHash !== approval.pointerHash || snapshot.rootStateHash !== pointer.historicalSnapshotHash ||
      snapshot.rootIdentityHash !== pointer.historicalIdentityHash || snapshot.closed || snapshot.cleanupIntent ||
      snapshot.pending || state.active || state.blocked || state.localUnknown || state.controlBlocked || state.lease ||
      control.activeOperations !== 0 || control.activeIds?.length || control.instanceId !== owner.nonce ||
      control.buildHash !== approval.previousBuildHash || control.generation !== (state.controlGeneration || 0) ||
      control.contextEpoch !== (state.contextEpoch || 0) || (paused && (!state.paused || control.gateClosed !== true)) ||
      snapshot.selectedLive !== true || snapshot.historicalDead !== true || snapshot.brokerLive !== true)
    fail('EPOCH_UPGRADE_FENCE_CHANGED', 'Exact owner, epoch, historical hashes, process, no-lease and zero-active fences required');
  if (initial && (!equal(state.jobs, initial.state.jobs) || !equal(pointer, initial.pointer) ||
      !equal(identity, initial.identity) || !equal(owner, initial.owner) ||
      snapshot.grantsHash !== initial.grantsHash || snapshot.evidenceHash !== initial.evidenceHash))
    fail('EPOCH_UPGRADE_HISTORY_CHANGED', 'Jobs, grants, new scratch proof or original identity changed');
}

function assertEpochUpgrade(snapshot, approval, options) {
  if (approval.purpose !== 'quiescent-isolated-epoch-checker-upgrade-v1')
    fail('EPOCH_UPGRADE_FENCE_CHANGED', 'The historical checker repair purpose is required');
  assertEpochFence(snapshot, approval, options);
  const jobs = Object.values(snapshot.state.jobs);
  if (!Array.isArray(approval.rejectedJobIds) || approval.rejectedJobIds.length !== 2 || jobs.length !== 2 ||
      jobs.some(job => !approval.rejectedJobIds.includes(job.id) || job.state !== 'failed' ||
        job.code !== 'PYTHON_CHECK_REJECTED' || job.physicalTurns || job.dispatch?.rpcCount || job.sequenceId ||
        job.details?.executionOutcome !== 'not_started' || job.details.mayHaveMutated !== false ||
        job.details.userScriptSubmitted !== false || job.details.sdkSettled !== true))
    fail('EPOCH_UPGRADE_REQUIRES_SDK0', 'Only the two exact terminal pre-dispatch checker rejections may be carried through this repair');
}

function assertSettledEpochUpgrade(snapshot, approval, options) {
  if (approval.purpose !== 'quiescent-settled-isolated-epoch-upgrade-v1' || approval.rejectedJobIds !== undefined ||
      !Array.isArray(approval.settledJobIds) || new Set(approval.settledJobIds).size !== approval.settledJobIds.length ||
      !approval.settledJobIds.length ||
      !equal(Object.keys(snapshot.state.jobs).sort(), [...approval.settledJobIds].sort()) ||
      !Array.isArray(snapshot.settledEvidence) || !snapshot.settledEvidence.length ||
      digest(snapshot.settledEvidence) !== approval.settledEvidenceHash)
    fail('EPOCH_UPGRADE_UNSETTLED', 'A distinct owner-approved exact settled job/evidence set is required');
  assertEpochFence(snapshot, approval, options);
  if (Object.values(snapshot.state.jobs).some(job => job.state !== 'succeeded' || job.details?.sdkSettled !== true))
    fail('EPOCH_UPGRADE_UNSETTLED', 'No unknown, failed or unsettled SDK job may use the successful live handoff');
}

// Small existing-epoch transaction. No SDK/process-signal port; old broker stops
// cooperatively through its authenticated lifecycle route. No historical copy.
function epochRuntimeUpgrade(p, assertSnapshot, settled) {
  return async () => {
    await p.authenticate(); await p.claim();
    try {
      const approval = await p.approve();
      const initial = p.read('initial') || await p.observe();
      if (!p.read('initial')) { assertSnapshot(initial, approval); p.publish('initial', initial); }
      if (p.read('complete')) { await p.release(p.read('complete')); return p.read('complete'); }
      let paused = p.read('paused');
      if (!paused) {
        const current = await p.observe(); assertSnapshot(current, approval, { initial });
        await p.pause(current); paused = await p.observe();
        assertSnapshot(paused, approval, { initial, paused: true }); p.publish('paused', paused);
      }
      if (!p.read('escrow')) p.publish('escrow', await p.escrow(paused));
      await p.verifyEscrow(p.read('escrow'));
      if (!p.read('stopped')) {
        await p.guardStartup(); // recovery.lock blocks other startup; old public stop remains supported.
        const stopping = p.read('stop-intent');
        if (!stopping) {
          const current = await p.observe(); assertSnapshot(current, approval, { initial, paused: true });
          if (!equal(current.state, paused.state)) fail('EPOCH_UPGRADE_HISTORY_CHANGED', 'Paused state changed before cooperative stop');
          p.publish('stop-intent', { owner: paused.owner });
          await p.stop(current);
        }
        // On uncertain stop never send it again: observe exact old PID/birth.
        await p.waitDead(paused.owner);
        await p.localFence(paused); p.publish('stopped', { owner: paused.owner });
      }
      if (!p.read('launch-intent')) await p.localFence(paused);
      if (!p.read('installed')) p.publish('installed', await p.install(approval));
      await p.verifyInstalled(approval);
      if (!p.read('identity')) {
        const identity = { ...paused.identity, buildHash: approval.buildHash, sourceCommit: approval.sourceCommit };
        await p.writeEpochIdentity(paused.identity, identity);
        p.publish('identity', { previous: paused.identity, current: identity });
      }
      if (!p.read('launch-intent')) p.publish('launch-intent', { buildHash: approval.buildHash });
      await p.start(approval); // Exclusive worker claim; live worker is observed, never duplicated.
      const after = await p.observeReady(approval);
      if (!equal(after.state, paused.state) || !equal(after.pointer, paused.pointer) ||
          after.grantsHash !== paused.grantsHash || after.evidenceHash !== paused.evidenceHash ||
          after.rootStateHash !== paused.rootStateHash || after.rootIdentityHash !== paused.rootIdentityHash ||
          !equal(after.identity, p.read('identity').current) || after.owner.nonce === paused.owner.nonce ||
          after.control.buildHash !== approval.buildHash || after.control.instanceId !== after.owner.nonce ||
          after.control.generation !== (after.state.controlGeneration || 0) ||
          after.control.contextEpoch !== (after.state.contextEpoch || 0) ||
          after.control.activeOperations !== 0 || after.control.activeIds?.length || !after.control.gateClosed ||
          after.selectedLive !== true || after.historicalDead !== true || after.brokerLive !== true)
        fail('EPOCH_UPGRADE_HANDOFF_UNPROVEN', 'Replacement did not preserve exact paused epoch, history, grants and live selected process');
      if (settled && digest(after.settledEvidence) !== approval.settledEvidenceHash)
        fail('EPOCH_UPGRADE_HANDOFF_UNPROVEN', 'Settled physical evidence changed during handoff');
      const complete = { version: 1, kind: settled ? 'quiescent-settled-isolated-epoch-runtime-upgrade' : 'quiescent-isolated-epoch-runtime-upgrade', requestId: approval.requestId,
        sourceCommit: approval.sourceCommit, qualification: approval.qualification,
        epochId: approval.epochId, document: approval.document, previousBuildHash: approval.previousBuildHash,
        buildHash: approval.buildHash, previousOwner: paused.owner, owner: after.owner,
        stateHash: digest(after.state), pointerHash: after.pointerHash, grantsHash: after.grantsHash,
        evidenceHash: after.evidenceHash, historicalOutcome: 'unknown', sdkRequestsSent: 0,
        modelValidation: 'not_performed', rollbackVerification: 'not_performed', gateClosed: true,
        localRejectedJobIds: approval.rejectedJobIds, grantScopeChanged: false };
      complete.operationalQueueBudget = approval.stateOptions;
      if (settled) {
        delete complete.localRejectedJobIds;
        complete.settledJobIds = approval.settledJobIds;
        complete.settledEvidenceHash = approval.settledEvidenceHash;
      }
      complete.publicReceipt = { kind: complete.kind, epochId: approval.epochId, document: approval.document,
        previousBuildHash: approval.previousBuildHash, sourceCommit: approval.sourceCommit, buildHash: approval.buildHash,
        rejectedJobIds: approval.rejectedJobIds, ownerClientId: approval.clientId, clientId: approval.granteeClientId,
         ownerTokenBound: true, sdkRequestsSent: 0, historicalOutcome: 'unknown', grantScopeChanged: false, gateClosed: true };
      if (settled) {
        delete complete.publicReceipt.rejectedJobIds;
        complete.publicReceipt.settledJobIds = approval.settledJobIds;
        complete.publicReceipt.settledEvidenceHash = approval.settledEvidenceHash;
      }
      p.publish('complete', complete); await p.release(complete); return complete;
    } finally { p.unclaim(); }
  };
}

const createEpochRuntimeUpgrade = p => epochRuntimeUpgrade(p, assertEpochUpgrade, false);
const createSettledEpochRuntimeUpgrade = p => epochRuntimeUpgrade(p, assertSettledEpochUpgrade, true);

function claimEpochRuntimeBroker(dir, marker, nonce, codeHash) {
  const guard = readJson(path.join(dir, 'recovery.lock'));
  if (guard.kind !== 'isolated-epoch-runtime-upgrade' || guard.nonce !== nonce ||
      path.dirname(guard.audit) !== path.join(dir, 'epoch-runtime-upgrades') || fs.realpathSync(guard.audit) !== guard.audit)
    fail('EPOCH_UPGRADE_GUARD_CHANGED', 'Original epoch-upgrade startup guard required');
  const read = stage => readJson(path.join(guard.audit, stage + '.json'), 256 * 1024 * 1024);
  const intent = read('intent'), paused = read('paused'), identity = read('identity');
  if (!equal(guard, { kind: 'isolated-epoch-runtime-upgrade', nonce: intent.nonce, audit: guard.audit, clientId: intent.approval.clientId }) ||
      !equal(readJson(path.join(dir, 'atomic-migration.lock')), guard) || !read('stopped') || !read('installed') || !read('launch-intent') ||
      intent.approval.buildHash !== codeHash || priorProcessAlive(paused.owner) !== false ||
      identity.current.buildHash !== codeHash || identity.current.sourceCommit !== intent.approval.sourceCommit ||
      paused.pointer.ownerClientId !== intent.approval.clientId ||
      readJson(path.join(dir, 'clients.json'))[intent.approval.clientId] !== intent.ownerTokenHash ||
      paused.pointer.ownerTokenHash !== intent.ownerTokenHash ||
      fs.existsSync(path.join(dir, 'broker.lock')) ||
      !equal(readJson(path.join(dir, 'isolated-admission-epoch.json')), paused.pointer) ||
      fileHash(path.join(dir, 'queue-state.json')).sha256 !== paused.rootStateHash ||
      fileHash(path.join(dir, 'instance.json')).sha256 !== paused.rootIdentityHash ||
      !equal(readJson(path.join(paused.pointer.root, 'queue-state.json'), 256 * 1024 * 1024), paused.state) ||
      !equal(readJson(path.join(paused.pointer.root, 'instance.json')), identity.current) ||
      priorProcessAlive(paused.pointer.currentInstance) !== true || priorProcessAlive(paused.pointer.originalInstance) !== false)
    fail('EPOCH_UPGRADE_CLAIM_UNPROVEN', 'Exact preserved epoch/state/identity/process and dead previous broker required');
  for (const entry of [...paused.pointer.qualificationEvidence, paused.pointer.qualificationReceipt, ...(intent.approval.ledgerReferences || [])])
    if (fileHash(entry.path).sha256 !== entry.sha256) fail('EPOCH_UPGRADE_CLAIM_UNPROVEN', 'Preserved scratch or rejected-attempt evidence changed');
  if (intent.approval.purpose === 'quiescent-settled-isolated-epoch-upgrade-v1') {
    assertSettledEpochUpgrade(paused, intent.approval, { paused: true });
    const evidence = require('./queue-settled-epoch-evidence').settledEpochEvidence(dir, paused.state, paused.pointer);
    if (digest(evidence) !== intent.approval.settledEvidenceHash || !equal(evidence, paused.settledEvidence))
      fail('EPOCH_UPGRADE_CLAIM_UNPROVEN', 'Settled physical evidence changed before broker claim');
    const release = read('cooperative-release');
    const releaseFile = path.join(dir, 'console-release-' + hash(intent.approval.requestId + ':pause-stop') + '.json');
    const receipt = readJson(releaseFile);
    if (release.path !== releaseFile || fileHash(releaseFile).sha256 !== release.sha256 || receipt.terminal !== true ||
        receipt.outcome !== 'released' || receipt.instanceId !== paused.owner.nonce || receipt.buildHash !== intent.approval.previousBuildHash ||
        receipt.requestId !== intent.approval.requestId + ':pause-stop' ||
        require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename }).installation !== intent.approval.candidateRoot)
      fail('EPOCH_UPGRADE_CLAIM_UNPROVEN', 'Successful bound cooperative release and exact immutable candidate root required');
  }
  const grants = fs.readdirSync(paused.pointer.root).filter(name => /^access-[a-f0-9]{64}\.json$/.test(name)).sort()
    .map(name => ({ name, ...fileHash(path.join(paused.pointer.root, name)) }));
  if (digest(grants) !== paused.grantsHash) fail('EPOCH_UPGRADE_CLAIM_UNPROVEN', 'Registered-client grants changed before startup');
  durable(path.join(dir, 'broker.lock'), marker, true);
  return paused.rootStateHash;
}

module.exports = { assertEpochUpgrade, assertSettledEpochUpgrade, createEpochRuntimeUpgrade, createSettledEpochRuntimeUpgrade, claimEpochRuntimeBroker };
