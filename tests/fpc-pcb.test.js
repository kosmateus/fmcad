const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['fpc.fold', 'fpc.flatten', 'pcb.mechanical-exchange', 'pcb.check',
  'port.define', 'connector.mate-check', 'pack.cross-section', 'keepout.check'];

test('GM26 fpc/pcb/connector operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM26 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['fpc.fold', { ...catalog['fpc.fold'].example, unsupportedReviewFlag: true }],
    ['pcb.mechanical-exchange', { ...catalog['pcb.mechanical-exchange'].example, bogus: 1 }],
    ['connector.mate-check', { ...catalog['connector.mate-check'].example, bogus: 1 }],
    ['pack.cross-section', { ...catalog['pack.cross-section'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM26 native handoff bundles the fpc_pcb module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('fpc.fold', catalog['fpc.fold'].example, { doc: 'GM26' });
  assert.ok(script.includes('def _fold_walk'));
  assert.ok(script.includes("'fpc.fold': fpc_fold"));
});
