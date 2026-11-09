'use strict';

const { isAtomicObservationCandidate, atomicInvocationProjection } = require('./atomic-workflow-observation');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

// Only the authenticated broker derives this typed request. No client-supplied
// payload, report path, identity override or original command argv is accepted.
function observationRequest(message, clientId, target, control, scope) {
  if (Object.keys(message).some(key => !['action', 'auth', 'jobId', 'requestId', 'control'].includes(key)) ||
      !identifier(message.jobId) || !identifier(message.requestId))
    fail('INVALID_REQUEST', 'Atomic observation requires jobId and a stable requestId only');
  if (!target || target.clientId !== clientId) fail('NOT_OWNER', 'Only the original authenticated job owner may observe this atomic holder');
  const fence = message.control;
  if (!fence || Object.keys(fence).sort().join(',') !== 'buildHash,contextEpoch,generation,instanceId')
    fail('INVALID_REQUEST', 'Atomic observation requires the complete current broker control fence');
  if (fence.instanceId !== control.instanceId) fail('INSTANCE_CHANGED', 'Broker owner changed before atomic observation');
  if (fence.buildHash !== control.buildHash) fail('BUILD_CHANGED', 'Broker build changed before atomic observation');
  if (fence.generation !== control.generation || fence.contextEpoch !== control.contextEpoch)
    fail('STATE_CONFLICT', 'Broker pause/reset context changed before atomic observation');
  if (!isAtomicObservationCandidate(target, target.request?.buildHash, scope))
    fail('WORKFLOW_TYPE_NOT_ALLOWED', 'Atomic observation is restricted to the exact approved unresolved holder');
  const original = atomicInvocationProjection(target, scope).invocation;
  const invocation = {
    version: 1, kind: 'cad', operation: 'batch.reconcile',
    data: { reportPath: scope.reportPath, operations: [], blockedJobId: target.id,
      commandId: scope.commandId, sessionNonce: scope.sessionNonce },
    doc: original.doc, docId: original.docId, docFileId: original.docFileId ?? null,
    component: original.component ?? null, projectId: original.projectId ?? null, preview: false,
  };
  return {
    kind: 'command', requestId: message.requestId, clientId,
    backend: target.request.backend, buildHash: control.buildHash, timeoutMs: 30000,
    argv: ['cad', 'batch', 'reconcile', '--doc', original.doc, '--doc-id', original.docId],
    cwd: target.request.cwd,
    clientContext: { clientId, requestId: message.requestId, projectDirectory: target.request.cwd,
      doc: original.doc, docId: original.docId },
    payload: { version: 1, kind: 'cad-command', invocation, output: { json: false, summary: false } },
  };
}

async function observeAtomic(client, { jobId, requestId, buildHash }) {
  if (!identifier(jobId) || !identifier(requestId))
    fail('INVALID_REQUEST', 'observe-atomic requires --job and an explicit stable --request-id');
  const status = await client.call('queue-summary');
  if (status.features?.atomicWorkflowObserve !== true)
    fail('ATOMIC_OBSERVATION_UNSUPPORTED', 'Installed broker has no owner-bound atomic observation control; no job submitted');
  const control = status.control;
  if (!control || control.buildHash !== buildHash)
    fail('BUILD_CHANGED', 'CLI and broker must use the same approved observer build; no job submitted');
  return client.call('observe-atomic', { jobId, requestId, control: {
    instanceId: control.instanceId, buildHash: control.buildHash,
    generation: control.generation, contextEpoch: control.contextEpoch,
  } });
}

module.exports = { observationRequest, observeAtomic };
