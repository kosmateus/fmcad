'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fmcad, docName, skipLive } = require('../../integration/helper');
const { ownedLease } = require('../../../dist/tests/scenarios/legacy-handoff');
test('owned child CLI preserves original receipts', (t) => {
  if (skipLive(t)) return;
  const scope = ownedLease();
  const result = fmcad(['document', 'status', '--doc', docName()]);
  assert.equal(result.success, true);
  assert.equal(result.result.creationId, scope.document.creationId);
  assert.equal(result.result.fileId, scope.document.file.fileId);
  assert.equal(result.result.projectId, scope.document.file.projectId);
  assert.equal(result.result.folderId, scope.document.file.folderId);
  assert.throws(() => fmcad(['document', 'status', '--doc', 'Foreign']), /Foreign legacy CLI pin/);
  assert.throws(() => fmcad(['shape', 'box', '--doc', docName(), '--data', JSON.stringify({ name: 'Invalid', width: -1, depth: '2 mm', height: '3 mm' })]), /width|length|unit|dimension/);
});
