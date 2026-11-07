const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['route.create3d', 'route.inspect', 'route.cut-list', 'route.motion-states'];

test('GM25 route operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM25 rejects malformed route payloads before SDK dispatch', () => {
  const cases = [
    ['route.create3d', { ...catalog['route.create3d'].example, unsupportedReviewFlag: true }],
    ['route.inspect', { bogus: 1 }],
    ['route.cut-list', { ...catalog['route.cut-list'].example, bogus: 1 }],
    ['route.motion-states', { bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM25 native handoff bundles the route3d module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('route.create3d', catalog['route.create3d'].example, { doc: 'GM25' });
  assert.ok(script.includes('def _sample_centerline'));
  assert.ok(script.includes("'route.create3d': route_create3d"));
});
