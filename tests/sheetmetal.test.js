const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['sheet.bends', 'sheet.form', 'sheet.flat'];

test('GM32 sheet-metal operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM32 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['sheet.bends', { ...catalog['sheet.bends'].example, unsupportedReviewFlag: true }],
    ['sheet.bends', { segments: catalog['sheet.bends'].example.segments }],
    ['sheet.form', { ...catalog['sheet.form'].example, bogus: 1 }],
    ['sheet.flat', { ...catalog['sheet.flat'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM32 native handoff bundles the sheetmetal module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('sheet.form', catalog['sheet.form'].example, { doc: 'GM32' });
  assert.ok(script.includes('def _sheet_form'));
  assert.ok(script.includes("'sheet.form': _sheet_form"));
  assert.ok(script.includes("'sheet.flat': _sheet_flat"));
});
