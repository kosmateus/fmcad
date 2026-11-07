'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workflowNonterminal, workflowOutputNonterminal } = require('../src/queue-instance');
const { failedOutcome } = require('../src/outcome');
const { cadCommandFailed } = require('../src/dist/core/application/cad/worker-command');

function pendingSave() {
  return { operation: 'document.save_as', accepted: true, pending: true, status: 'pending', targetObserved: true,
    current: { creationId: 'new-document-id', saved: true, modified: false, isComplete: false,
      fileId: 'observed-transitional-file-id', fileName: 'owned-name', projectId: 'project-id', folderId: 'folder-id' },
    target: { name: 'owned-name', projectId: 'project-id', folderId: 'folder-id' } };
}

test('accepted target-observed save awaiting cloud processing is not an unfinished native command', () => {
  const value = pendingSave();
  assert.equal(workflowNonterminal(value), false);
  const { operation, ...result } = value;
  const text = 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation, result });
  assert.equal(workflowOutputNonterminal({ content: [{ type: 'text', text: JSON.stringify({ success: true, stdout: text }) }] }), false);
});

test('accepted observed document.save_as pending status is a successful operation outcome, not cloud completion', () => {
  const result = pendingSave();
  delete result.operation;
  const output = {
    success: true,
    operation: 'document.save_as',
    document: 'owned-name',
    result,
  };
  assert.equal(failedOutcome(output), false);
  assert.equal(cadCommandFailed(output, 'document.save_as'), false);

  for (const mutate of [
    (value) => { value.success = false; },
    (value) => { value.status = 'failed'; },
    (value) => { value.error = 'rejected'; },
    (value) => { value.result.accepted = false; },
    (value) => { value.result.pending = false; },
    (value) => { value.result.targetObserved = false; },
    (value) => { value.result.current.fileName = 'foreign-name'; },
    (value) => { value.result.target.projectId = 'foreign-project'; },
  ]) {
    const invalid = structuredClone(output);
    mutate(invalid);
    assert.equal(failedOutcome(invalid), true, JSON.stringify(invalid));
  }
});

test('unaccepted/unobserved saves, foreign targets and explicit unknown native outcomes stay fenced', () => {
  for (const mutate of [
    value => { value.operation = 'batch.run'; },
    value => { value.accepted = null; },
    value => { value.targetObserved = false; },
    value => { value.current.saved = false; },
    value => { value.current.modified = true; },
    value => { value.current.creationId = null; },
    value => { value.current.fileId = null; },
    value => { value.current.fileName = 'another-file'; },
    value => { value.current.projectId = 'another-project'; },
    value => { value.current.folderId = 'another-folder'; },
    value => { value.target = {}; },
    value => { value.completed = false; },
    value => { value.outcome = 'unknown'; },
    value => { value.executionOutcome = 'unknown'; },
  ]) {
    const value = pendingSave(); mutate(value);
    assert.equal(workflowNonterminal(value), true, JSON.stringify(value));
  }
});
