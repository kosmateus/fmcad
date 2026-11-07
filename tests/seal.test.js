const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['shape.o_ring', 'seal.gland', 'seal.profile', 'seal.evaluate', 'dock.sequence-check'];

test('GM15 seal operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation !== 'shape.o_ring');
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM15 rejects invalid seal payloads before SDK dispatch', () => {
  const cases = [
    ['shape.o_ring', { ...catalog['shape.o_ring'].example, cs: 5 }],
    ['seal.gland', { ...catalog['seal.gland'].example, oRing: '10 mm' }],
    ['seal.profile', { ...catalog['seal.profile'].example, layout: 'washer' }],
    ['seal.evaluate', { ...catalog['seal.evaluate'].example, gland: '1.6 mm' }],
    ['dock.sequence-check', { schemaVersion: 1, frame: 'component', connect: [] }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM15 native handoff bundles the seal module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('dock.sequence-check', catalog['dock.sequence-check'].example, { doc: 'GM15' });
  assert.ok(script.includes('def _dock_sequence'));
  assert.ok(script.includes("'dock.sequence-check': _dock_sequence"));
});
