const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['clearance.grid', 'motion.envelope'];

test('GM19 interference operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation !== 'clearance.grid');
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM19 rejects unknown top-level inputs before SDK dispatch', () => {
  for (const operation of operations) {
    assert.throws(() => validateCad(operation, { ...catalog[operation].example, bogus: 1 }), /Unknown CAD inputs/);
  }
});

test('GM19 native handoff bundles the interference module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('clearance.grid', catalog['clearance.grid'].example, { doc: 'GM19' });
  assert.ok(script.includes('def _grid_pairs'));
  assert.ok(script.includes("'clearance.grid': clearance_grid"));
  assert.ok(script.includes("'motion.envelope': motion_envelope"));
});

test('GM19 Python recipes reproduce offline', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('python3', ['-B', 'tests/interference_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
