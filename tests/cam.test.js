const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['cam.profile', 'cam.evaluate', 'cam.cycle-check'];

test('GM14 cam operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM14 rejects invalid cam payloads before SDK dispatch', () => {
  const cases = [
    ['cam.profile', { ...catalog['cam.profile'].example, rise: 'halfCosine' }],
    ['cam.profile', { ...catalog['cam.profile'].example, schemaVersion: 2 }],
    ['cam.evaluate', { ...catalog['cam.evaluate'].example, minimumCurvatureRadius: 5 }],
    ['cam.evaluate', { ...catalog['cam.evaluate'].example, maximumPressureAngle: 12 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM14 native handoff bundles the cam module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('cam.profile', catalog['cam.profile'].example, { doc: 'GM14' });
  assert.ok(script.includes('def _cam_compute'));
  assert.ok(script.includes("'cam.profile': cam_profile"));
});
