const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['measure.draft', 'measure.wall-map', 'undercut.check',
  'manufacturing.zone', 'manufacturing.check'];

test('GM31 manufacturing operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM31 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['measure.draft', { ...catalog['measure.draft'].example, unsupportedReviewFlag: true }],
    ['measure.draft', { pullDirections: catalog['measure.draft'].example.pullDirections }],
    ['measure.wall-map', { ...catalog['measure.wall-map'].example, bogus: 1 }],
    ['undercut.check', { ...catalog['undercut.check'].example, bogus: 1 }],
    ['manufacturing.zone', { ...catalog['manufacturing.zone'].example, bogus: 1 }],
    ['manufacturing.check', { ...catalog['manufacturing.check'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM31 native handoff bundles the dfm module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('measure.draft', catalog['measure.draft'].example, { doc: 'GM31' });
  assert.ok(script.includes('def _measure_draft'));
  assert.ok(script.includes("'measure.draft': _measure_draft"));
  assert.ok(script.includes("'undercut.check': _undercut_check"));
  assert.ok(script.includes("'manufacturing.check': _manufacturing_check"));
});
