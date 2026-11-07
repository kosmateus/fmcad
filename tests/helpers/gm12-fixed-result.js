'use strict';

const assert = require('node:assert/strict');

const pendingStates = new Set(['started', 'running', 'pending', 'needs_reconciliation']);
const queuedStates = new Set(['queued', 'preparing', 'running', 'sending', 'needs_reconciliation']);

function isExecutionUnknown(value, root = true) {
  if (!value || typeof value !== 'object') return false;
  if (value.executionOutcome === 'unknown' || value.completed === false ||
      pendingStates.has(value.status) || queuedStates.has(value.state) ||
      (root && (value.status === 'unknown' || value.state === 'unknown'))) return true;
  return Object.entries(value).some(([key, nested]) =>
    !(key === 'status' && nested === 'unknown') && isExecutionUnknown(nested, false));
}

function assertFixedMethodResults(payload, operations, creationId) {
  assert.deepEqual(payload.operations, operations, 'Fixed-run operation list differs.');
  assert.ok(payload.results && typeof payload.results === 'object', 'Fixed-run result map is missing.');
  assert.deepEqual(Object.keys(payload.results).sort(), [...operations].sort(),
    'Fixed-run output is missing or added a method result.');
  for (const operation of operations) {
    const result = payload.results[operation];
    assert.ok(result && typeof result === 'object', operation + ' returned no method result.');
    assert.equal(result.operation, operation, operation + ' returned a mismatched operation identity.');
    assert.equal(result.status, 'pass', operation + ' did not return a passing method result.');
    assert.equal(result.success, true, operation + ' did not return method success.');
    assert.equal(result.documentIdentity?.creationId, creationId,
      operation + ' did not identify the exact owner scratch.');
  }
}

module.exports = { isExecutionUnknown, assertFixedMethodResults };
