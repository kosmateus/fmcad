'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson, sameInstance } = require('./queue-instance');
const { fileHash, directory } = require('./queue-atomic-migration-files');
const { auditSummary } = require('./queue-atomic-recovery-audit');
const fail = message => { throw Object.assign(new Error(message), { code: 'EPOCH_AUDIT_PREREQUISITE_INVALID' }); };
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);

// Every byte in this closed set is pinned by the separately qualified migration
// approval. No caller may substitute an audit-result path or claim audit success.
function epochAuditPrerequisite(value, dir, approval, scope) {
  if (!value || Object.keys(value).sort().join(',') !== 'auditIntent,auditResult,auditStart,auditWire,migrationComplete,remoteReceipt')
    fail('Complete immutable current audit and migration evidence is required');
  const auditDir = path.join(dir, 'jobs', scope.jobId, 'atomic-recovery-audit');
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'path,sha256' || !path.isAbsolute(entry.path || '') ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || fileHash(entry.path).sha256 !== entry.sha256)
      fail('Pinned current audit evidence changed');
    directory(path.dirname(entry.path));
    if (fs.realpathSync(entry.path) !== entry.path) fail('Current audit evidence must not traverse symlinks');
    if (name !== 'migrationComplete' && path.dirname(entry.path) !== auditDir) fail('Current audit evidence escaped its exact job directory');
  }
  for (const [name, filename] of Object.entries({ auditIntent: 'intent.json', auditResult: 'result.json', auditStart: 'start.json', auditWire: 'wire.json' }))
    if (value[name].path !== path.join(auditDir, filename)) fail('Current audit evidence path was substituted');
  const read = entry => readJson(entry.path, 256 * 1024 * 1024);
  const complete = read(value.migrationComplete), intent = read(value.auditIntent), result = read(value.auditResult),
    start = read(value.auditStart), wire = read(value.auditWire), remote = read(value.remoteReceipt);
  if (value.migrationComplete.path !== path.join(dir, 'atomic-migrations', hash(complete.requestId || ''), 'complete.json') ||
      complete.kind !== 'atomic-owner-migration' || complete.jobId !== scope.jobId ||
      complete.purpose !== 'atomic-recovery-process-loss-audit-upgrade-v1' || complete.gateClosed !== true ||
      complete.unresolved !== true || complete.sdkRequestsSent !== 0 || complete.nativeOutcome !== 'unknown' ||
      complete.currentModelingAdmission !== 'blocked' || !sameInstance(complete.currentAuditInstance, approval.currentInstance))
    fail('A completed process-loss audit-only migration for this current process is required');
  const b = intent.binding, key = intent.key;
  if (!b || !key || result.kind !== 'atomic-recovery-audit' || result.status !== 'complete' ||
      result.jobId !== scope.jobId || result.observationJobId !== scope.observationJobId ||
      result.clientId !== key.clientId || result.requestId !== key.requestId ||
      b.targetJobId !== scope.jobId || b.observationJobId !== scope.observationJobId || b.clientId !== key.clientId ||
      b.purpose !== 'atomic-recovery-audit-v1' || b.auditBuildHash !== complete.observerBuildHash ||
      result.sdkRequestsSent !== 1 || result.endpointVerified !== true || result.currentModelingAdmission !== 'blocked' ||
      result.nativeOutcome !== 'unknown' || result.modelValidation !== 'not_performed' || result.rollbackVerification !== 'not_performed' ||
      !sameInstance(result.currentInstance, approval.currentInstance) || !sameInstance(b.currentInstance, approval.currentInstance) ||
      result.historicalProcessState !== 'terminated') fail('Actual durable successful current audit facts are required');
  const summary = auditSummary({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(result.summary) }] } }, intent.identity);
  if (summary.ui?.idle !== true || summary.modulePresent !== false || summary.commandDefinition?.status !== 'absent')
    fail('The current instance must be idle with no surviving original holder or command definition');
  const record = start.binding, payload = wire.outgoing;
  if (!record || start.receipt !== value.remoteReceipt.path || start.pythonCheck?.status !== 'passed' ||
      record.purpose !== 'atomic-recovery-audit-v1' || record.jobId !== scope.jobId ||
      record.buildHash !== complete.observerBuildHash || record.auditBindingHash !== canonicalHash(b) ||
      record.requestHash === undefined || record.sourceHash === undefined ||
      !sameInstance(record.auditExpectedInstance, approval.currentInstance) || !sameInstance(start.instance, approval.currentInstance) ||
      remote.terminal !== true || remote.outcome !== 'succeeded' || !sameInstance(remote.instance, approval.currentInstance) ||
      !['jobId', 'rpcId', 'requestHash', 'sourceHash', 'buildHash', 'purpose', 'auditBindingHash', 'pythonOriginHash']
        .every(k => remote[k] === record[k]) || payload?.id !== 'fmcad:' + record.rpcId ||
      !wire.artifact || wire.artifact.context?.origin?.artifactHash !== record.pythonOriginHash ||
      start.originArtifactHash !== record.pythonOriginHash || payload?.method !== 'tools/call' ||
      payload.params?.name !== 'execute_python' || payload.params.arguments?.persistent !== false)
    fail('The current audit lacks its real checker, exact final wire and successful process-bound physical receipt');
  require('./python').bindPythonArtifactManifest(payload.params.arguments.code, wire.artifact);
  return { files: value, clientId: key.clientId, departingBuildHash: complete.observerBuildHash,
    previousOwner: complete.owner, currentInstance: approval.currentInstance, originalInstance: result.historicalInstance,
    identity: intent.identity, documentFacts: summary.document,
    hash: canonicalHash(value), historicalOutcome: 'unknown' };
}

function epochPrerequisiteStillCurrent(value) {
  try { return Object.values(value.files).every(entry => fileHash(entry.path).sha256 === entry.sha256); }
  catch { return false; }
}

function inheritedClosedPause({ initial, current, intent, upgrade, clientId, dir, authorization }) {
  if (!authorization || !epochPrerequisiteStillCurrent(authorization) ||
      authorization.clientId !== clientId || intent.binding.clientId !== clientId ||
      JSON.stringify(initial.state) !== JSON.stringify(current.state) || JSON.stringify(initial.owner) !== JSON.stringify(current.owner) ||
      JSON.stringify(initial.identity) !== JSON.stringify(current.identity)) fail('Inherited pause history/owner changed');
  const preceding = readJson(upgrade.previousComplete.path), requestId = preceding.requestId + ':pause';
  const proof = readJson(path.join(dir, 'lifecycle-control-' + hash(requestId) + '.json'));
  const b = proof.binding, r = proof.result, c = current.status.control;
  if (!b || !r || proof.status !== 'completed' || b.action !== 'pause' || b.clientId !== clientId ||
      b.requestId !== requestId || b.instanceId !== preceding.previousOwner.nonce || b.buildHash !== preceding.originalBuildHash ||
      r.requestId !== requestId || r.instanceId !== b.instanceId || r.buildHash !== b.buildHash ||
      r.gateClosed !== true || r.activeOperations !== 0 || r.activeIds?.length ||
      r.generation !== c.generation || r.contextEpoch !== c.contextEpoch || b.expectedGeneration !== c.generation - 1 ||
      current.state.controlRequests?.[requestId]?.paused !== true ||
      current.state.controlRequests[requestId].generation !== c.generation || !current.state.paused || !current.status.paused ||
      c.gateClosed !== true || c.activeOperations !== 0 || c.activeIds?.length || current.state.lease || current.status.lease ||
      c.instanceId !== current.owner.nonce || c.generation !== current.state.controlGeneration ||
      c.contextEpoch !== current.state.contextEpoch || current.status.stopping)
    fail('No exact authenticated continuously inherited closed-pause proof');
  return { version: 1, kind: 'owner-bound-existing-closed-pause-adoption', requestId: intent.binding.requestId,
    clientId, migrationNonce: intent.nonce, sourcePauseRequestId: requestId, stateHash: hash(JSON.stringify(current.state)),
    prerequisiteHash: authorization.hash, publicPauseSent: false, sdkRequestsSent: 0 };
}

function inheritedEpochPause(args) { return inheritedClosedPause({ ...args, authorization: args.upgrade.epochPrerequisite }); }
function inheritedAuditResponsePause(args) {
  const proof = args.upgrade.auditResponseRecovery;
  return inheritedClosedPause({ ...args, authorization: proof && { files: proof.files, clientId: proof.key.clientId, hash: proof.evidenceHash } });
}

module.exports = { epochAuditPrerequisite, epochPrerequisiteStillCurrent, inheritedEpochPause, inheritedAuditResponsePause };
