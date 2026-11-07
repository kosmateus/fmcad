const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { catalog, validateCad } = require('../src/cad');
const { validateBatch } = require('../src/batch');

const shapeLibrary = require('../src/catalog/shapes-library.json');
const gear = require('../src/catalog/gear.json');
const shapeManual = require('../src/manual/shapes-library.json');
const gearManual = require('../src/manual/gear.json');

test('GM10/GM11 descriptors are registered in the shared catalog and covered by manuals', () => {
  for (const operation of [...Object.keys(shapeLibrary), ...Object.keys(gear)]) {
    assert.ok(catalog[operation], `catalog missing ${operation}`);
  }
  assert.deepEqual(Object.keys(shapeManual).sort(), Object.keys(shapeLibrary).sort());
  assert.deepEqual(Object.keys(gearManual).sort(), Object.keys(gear).sort());
  assert.equal(shapeLibrary['shape.slot'], undefined);
  assert.equal(Object.keys(shapeLibrary).length, 5);
  assert.equal(Object.keys(gear).length, 2);
});

test('every GM10/GM11 example validates and registers exactly one non-Node Python handler', () => {
  for (const [operation, entry] of Object.entries({ ...shapeLibrary, ...gear })) {
    assert.equal(entry.readOnly, false || operation === 'gear.pair-check');
    validateCad(operation, entry.example);
    const result = validateBatch({ runId: 'gm10-11', operations: [{ id: 's', operation, data: entry.example }] }, catalog);
    assert.equal(result.success, true, JSON.stringify(result.errors));
  }
  assert.equal(catalog['gear.pair-check'].readOnly, true);
  assert.equal(catalog['gear.pair-check'].envelope, true);
});

test('GM10/GM11 Python recipes reproduce offline', () => {
  for (const file of ['tests/shapes_gm10_test.py', 'tests/gear_test.py']) {
    const result = spawnSync('python3', ['-B', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
