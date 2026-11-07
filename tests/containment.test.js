const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['measure.contains', 'measure.corridor', 'measure.region'];

test('GM20 containment operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM20 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['measure.contains', { ...catalog['measure.contains'].example, unsupportedReviewFlag: true }],
    ['measure.contains', { points: catalog['measure.contains'].example.points }],
    ['measure.corridor', { ...catalog['measure.corridor'].example, bogus: 1 }],
    ['measure.region', { ...catalog['measure.region'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM20 native handoff bundles the containment module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('measure.contains', catalog['measure.contains'].example, { doc: 'GM20' });
  assert.ok(script.includes('def _region_signed_distance'));
  assert.ok(script.includes("'measure.contains': _measure_contains"));
  assert.ok(script.includes('target.pointContainment(pt)'));
  assert.ok(script.includes('PointInsidePointContainment'));
  assert.ok(!script.includes('manager.pointContainment('));
  assert.ok(!script.includes('PointContainment.InsidePointContainment'));
  assert.ok(script.includes('def _native_face_distance'));
});

test('GM20 canonical containment inventory packages the Fusion adapter implementation', () => {
  const { cadBundleManifest, cadBundleUnits } = require('../packages/node-adapters/dist/python/bundle');
  const manifest = cadBundleManifest.find(unit => unit.id === 'containment');
  assert.equal(manifest.path, 'runtime/python/fmcad/adapters/fusion/containment.py');
  const unit = cadBundleUnits(process.cwd()).find(candidate => candidate.id === 'containment');
  assert.equal(unit.filename, manifest.path);
  assert.ok(unit.source.includes('target.pointContainment(pt)'));
  assert.ok(!unit.source.includes('manager.pointContainment('));
});
