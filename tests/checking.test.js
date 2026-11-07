const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['check.set', 'evidence.package', 'evidence.check', 'deliver'];

test('GM37 check/evidence operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM37 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['check.set', { ...catalog['check.set'].example, unsupportedReviewFlag: true }],
    ['check.set', {}],
    ['evidence.package', { ...catalog['evidence.package'].example, bogus: 1 }],
    ['evidence.check', { ...catalog['evidence.check'].example, bogus: 1 }],
    ['deliver', { ...catalog.deliver.example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM37 native handoff bundles the checking module without re-registering check/report', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('check.set', catalog['check.set'].example, { doc: 'GM37' });
  assert.ok(script.includes('def _check_set'));
  assert.ok(script.includes("'check.set': _check_set"));
  assert.ok(script.includes("'deliver': _deliver"));
  assert.ok(script.includes("'evidence.check': _evidence_check"));
});
