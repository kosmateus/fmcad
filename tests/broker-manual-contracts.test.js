'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { descriptors } = require('../src/queue-cli');
const { manuals } = require('../src/broker-manual');

for (const action of Object.keys(descriptors)) test('offline queue help has an explicit return contract: ' + action, () => {
  const sections = manuals['queue ' + action]?.sections;
  const contract = sections?.find(section => section.title === 'Return Contract')?.text;
  assert.equal(typeof contract, 'string', action + ' return contract is missing');
  assert.ok(contract.trim().length > 30, action + ' return contract must describe its actual receipt/output');
  assert.doesNotMatch(contract, /\bundefined\b/);
});

test('offline owner scratch help separates metadata permission from SDK and validation', () => {
  const text = action => manuals['queue ' + action].sections.find(section => section.title === 'Return Contract').text;
  assert.match(text('successor-epoch'), /metadata|SDK0/i);
  assert.match(text('authorize-closed-successor'), /same live|same Fusion/i);
  assert.match(text('grant-native-fixture'), /manifest|source\/build/i);
  assert.match(text('observe-successor'), /unknown|historical/i);
});

test('built CLI prints owner return contracts offline without configuration, broker or user-state writes', t => {
  const fs = require('node:fs'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync('/tmp/opencode/queue-help-contracts-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const action of ['successor-epoch', 'observe-successor', 'authorize-closed-successor', 'grant-native-fixture']) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/fmcad.js'), 'help', 'queue', action], {
      encoding: 'utf8',
      env: { ...process.env, FMCAD_CONFIG: path.join(root, 'missing-config.json'), XDG_STATE_HOME: root },
    });
    assert.equal(result.status, 0, action + ': ' + (result.stderr || String(result.error)));
    assert.match(result.stdout, /Return Contract:/);
    assert.doesNotMatch(result.stdout, /\bundefined\b/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});
