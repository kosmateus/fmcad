const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['marking.create', 'marking.check'];

test('GM34 marking operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM34 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['marking.create', { ...catalog['marking.create'].example, unsupportedReviewFlag: true }],
    ['marking.create', {}],
    ['marking.check', { ...catalog['marking.check'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM34 native handoff bundles the marking module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('marking.create', catalog['marking.create'].example, { doc: 'GM34' });
  assert.ok(script.includes('def _marking_create'));
  assert.ok(script.includes("'marking.create': _marking_create"));
  assert.ok(script.includes("'marking.check': _marking_check"));
});
