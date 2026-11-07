const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const readOnly = { 'pose.list': true };
const operations = ['pose.save', 'pose.apply', 'pose.list', 'pose.delete', 'pose.evaluate'];

test('GM18 pose operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, readOnly[operation] === true, operation);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM18 rejects unknown top-level inputs before SDK dispatch', () => {
  for (const operation of operations) {
    assert.throws(() => validateCad(operation, { ...catalog[operation].example, bogus: 1 }), /Unknown CAD inputs/);
  }
});

test('GM18 native handoff bundles the pose module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('pose.save', catalog['pose.save'].example, { doc: 'GM18' });
  assert.ok(script.includes('_POSE_SCHEMA'));
  assert.ok(script.includes("'pose.save': pose_save"));
});

test('GM18 Python recipes reproduce offline', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('python3', ['-B', 'tests/pose_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
