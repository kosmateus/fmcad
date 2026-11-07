'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('FAKE precision fixture separates stage evidence and stops after unproven restore', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'drive_precision_fixture_test.py')],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
