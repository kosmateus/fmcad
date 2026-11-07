const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['optics.frustum', 'optics.coverage', 'optics.occlusion', 'sensor.alignment-check'];

test('GM28 optics/sensor operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM28 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['optics.frustum', { ...catalog['optics.frustum'].example, unsupportedReviewFlag: true }],
    ['optics.frustum', { pupil: catalog['optics.frustum'].example.pupil }],
    ['optics.coverage', { ...catalog['optics.coverage'].example, bogus: 1 }],
    ['optics.occlusion', { ...catalog['optics.occlusion'].example, bogus: 1 }],
    ['sensor.alignment-check', { ...catalog['sensor.alignment-check'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM28 native handoff bundles the optics module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('optics.frustum', catalog['optics.frustum'].example, { doc: 'GM28' });
  assert.ok(script.includes('def optics_frustum'));
  assert.ok(script.includes("'optics.frustum': optics_frustum"));
  assert.ok(script.includes("'optics.coverage': optics_coverage"));
  assert.ok(script.includes("'optics.occlusion': optics_occlusion"));
  assert.ok(script.includes("'sensor.alignment-check': sensor_alignment_check"));
});
