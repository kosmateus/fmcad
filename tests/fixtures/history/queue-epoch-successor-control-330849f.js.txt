'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson, idle } = require('./queue-instance');
const { exclusive, fileHash } = require('./queue-atomic-migration-files');
const { reference, epochLineage } = require('./queue-epoch-lineage');
const { assertCurrentPredecessor } = require('./queue-epoch-successor');
const { createRecoveryAudit, auditSummary } = require('./queue-atomic-recovery-audit');
const { createScratchControl } = require('./queue-scratch-control');
const same = require('node:util').isDeepStrictEqual;
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const read = file => readJson(file, 256 * 1024 * 1024);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function createSuccessorControl(p) {
  const checked = assertCurrentPredecessor(p.dir, p.authority, { allowPublished: true });
  const a = checked.authority, audit = checked.audit, predecessor = checked.pointer;
  const oldIntent = read(path.join(path.dirname(predecessor.qualificationReceipt.path), 'intent.json'));
  const identity = oldIntent.identity;
  if (!identity?.resolvedIdentity?.creationId || !/^fmcad_atomic_[a-f0-9]{32}$/.test(identity.commandId || ''))
    fail('EPOCH_SUCCESSOR_IDENTITY_UNAVAILABLE', 'The original qualified historical audit identity is required');
  const scope = { originalInstance: predecessor.originalInstance, currentInstance: null, epochPrerequisite: null };
  const observedFile = path.join(audit, 'observed-current.json');
  const observationKind = a.kind === 'owner-authenticated-closed-epoch-successor'
    ? 'closed-epoch-current-observation' : 'dead-epoch-current-observation';
  const observationDirectory = path.join(audit, observationKind);
  function assertOwner(target, observer, clientId) {
    if (clientId !== a.clientId || p.clients()[clientId] !== a.ownerTokenHash ||
        target !== predecessor.quarantinedJobIds[0] || observer !== predecessor.quarantinedJobIds[1])
      fail('NOT_OWNER', 'Only the original credential-bound owner and exact quarantined lineage may authorize a new scratch');
  }
  function fence(_value, inFlight) {
    assertCurrentPredecessor(p.dir, p.authority, { allowPublished: true });
    p.fenceRuntime(inFlight);
  }
  function receipt(record) {
    const value = read(record.receipt);
    if (value.terminal !== true || value.outcome !== 'succeeded' ||
        Object.keys(record.binding).some(key => !same(value[key], record.binding[key])) ||
        value.instance?.pid !== a.expectedProcess.pid || value.instance?.birth !== a.expectedProcess.birth ||
        (record.instance?.version !== undefined && value.instance.version !== record.instance.version) ||
        typeof value.instance.version !== 'string' || !value.instance.version || !idle(value.instance))
      fail('EPOCH_SUCCESSOR_RECEIPT_MISMATCH', 'Current facts need an exact terminal source/build/request receipt from the selected idle process');
    return value;
  }
  function safeSummary(result) {
    const summary = auditSummary({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(result.summary) }] } }, identity);
    if (summary.ui?.idle !== true || summary.modulePresent !== false || summary.commandDefinition?.status !== 'absent')
      fail('EPOCH_SUCCESSOR_FACTS_UNSAFE', 'Current instance must be idle without a surviving original holder/definition');
    return summary;
  }
  function currentProof() {
    if (!fs.existsSync(observedFile)) return null;
    const value = read(observedFile);
    if (value.kind !== 'owner-bound-successor-current-facts' || !same(value.authority, p.authority) ||
        value.currentInstance?.pid !== a.expectedProcess.pid || value.currentInstance?.birth !== a.expectedProcess.birth ||
        value.historicalOutcome !== 'unknown' || value.sdkRequestsSent !== 1 || value.transportComplete !== true)
      fail('EPOCH_SUCCESSOR_FACTS_CHANGED', 'Current-facts proof differs from the owner successor authority');
    for (const entry of Object.values(value.files))
      if (fileHash(entry.path).sha256 !== entry.sha256) fail('EPOCH_SUCCESSOR_FACTS_CHANGED', 'Current-facts evidence changed');
    const result = read(value.files.result.path), intent = read(value.files.intent.path), start = read(value.files.start.path);
    const physical = receipt(start);
    if (result.status !== 'complete' || result.sdkRequestsSent !== 1 || result.clientId !== a.clientId ||
        result.requestId !== a.requestId + ':observe' || !same(intent.binding.expectedProcess, a.expectedProcess) ||
        !same(physical.instance, value.currentInstance) || start.pythonCheck?.status !== 'passed')
      fail('EPOCH_SUCCESSOR_FACTS_CHANGED', 'Current-facts result/checker/process binding changed');
    safeSummary(result);
    return { files: value.files, clientId: a.clientId, currentInstance: value.currentInstance,
      originalInstance: predecessor.originalInstance, hash: canonicalHash(value.files), historicalOutcome: 'unknown' };
  }
  function refreshScope() {
    const proof = currentProof();
    scope.currentInstance = proof?.currentInstance || null;
    scope.epochPrerequisite = proof;
    return proof;
  }
  const ports = { ...p.ports, assertOwner, fence, remoteReceipt: receipt };
  const observation = createRecoveryAudit({ ...ports, kind: observationKind, jobDirectory: () => audit,
    sendScript: p.sendAuditScript,
    async inspect(message, clientId) {
      if (message.requestId !== a.requestId + ':observe') fail('INVALID_REQUEST', 'Only the original successor observation request ID is allowed');
      p.assertControl(message.control);
      fence(null, false);
      return { identity, instance: a.expectedProcess, binding: { purpose: 'atomic-recovery-audit-v1', clientId,
        expectedProcess: a.expectedProcess, successorAuthorityHash: p.authority.sha256 } };
    },
    async publishComplete(result, _prior, resultFile) {
      if (result.status !== 'complete' || result.sdkRequestsSent !== 1) fail('EPOCH_SUCCESSOR_FACTS_UNSAFE', 'Actual current observation is required');
      safeSummary(result);
      const startFile = path.join(observationDirectory, 'start.json'), start = read(startFile), physical = receipt(start);
      if (start.pythonCheck?.status !== 'passed') fail('EPOCH_SUCCESSOR_UNQUALIFIED', 'Current observation was not production-checked');
      exclusive(observedFile, { kind: 'owner-bound-successor-current-facts', authority: p.authority,
        currentInstance: physical.instance, sdkRequestsSent: 1, transportComplete: true, historicalOutcome: 'unknown',
        files: { authority: p.authority, result: reference(resultFile), intent: reference(path.join(observationDirectory, 'intent.json')),
          start: reference(startFile), wire: reference(path.join(observationDirectory, 'wire.json')), remote: reference(start.receipt) } });
      refreshScope();
      return { currentInstance: scope.currentInstance, admission: 'one-proven-new-document-only', historicalOutcome: 'unknown' };
    },
  });
  refreshScope();
  const priorDocuments = [predecessor, ...epochLineage(p.dir, predecessor).map(row => row.pointer)].map(pointer => pointer.document.creationId);
  const creation = createScratchControl({ ...p, scope, creationRoot: audit,
    successor: { authority: p.authority, sourceCommit: a.sourceCommit, forbiddenIds: priorDocuments,
      matches(epoch) { return same(epoch, predecessor); } },
    auditPorts: { ...ports, sendScript: p.sendScratchScript,
      async inspect(message) {
        if (message.requestId !== a.requestId + ':create') fail('INVALID_REQUEST', 'Only the original successor creation request ID is allowed');
        p.assertControl(message.control);
        if (!refreshScope()) fail('EPOCH_AUDIT_REQUIRED', 'A known completed current observation is required before scratch creation');
        fence(null, false);
        return { identity, instance: scope.currentInstance, binding: { purpose: 'atomic-recovery-audit-v1',
          clientId: a.clientId, targetJobId: predecessor.quarantinedJobIds[0], observationJobId: predecessor.quarantinedJobIds[1],
          control: message.control, currentInstance: scope.currentInstance, historicalInstance: predecessor.originalInstance,
          historicalProcessState: 'terminated', successorAuthorityHash: p.authority.sha256 } };
      },
    },
  });
  return {
    observe: (message, clientId) => observation.handle(message, clientId),
    create: (message, clientId) => { refreshScope(); return creation.create(message, clientId); },
    ownsCreation: requestId => requestId === a.requestId + ':create',
    metadata: () => ({ requestId: a.requestId, expectedProcess: a.expectedProcess,
      predecessorEpochId: predecessor.epochId, currentFactsAvailable: fs.existsSync(observedFile),
      observationRequestId: a.requestId + ':observe', creationRequestId: a.requestId + ':create',
      historicalOutcome: 'unknown' }),
  };
}

module.exports = { createSuccessorControl };
