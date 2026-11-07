const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['mount.create', 'mount.check', 'fastener.stack', 'fastener.check',
  'fastener.schedule', 'bearing.stack-check', 'shaft.interface', 'retention.bayonet',
  'snap.define', 'snap.evaluate', 'shape.hose_barb'];

test('GM16 fastener operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM16 rejects invalid fastener payloads before SDK dispatch', () => {
  const cases = [
    ['mount.create', { ...catalog['mount.create'].example, scheme: 'bolt-circle' }],
    ['mount.check', { ...catalog['mount.check'].example, holes: [] }],
    ['fastener.stack', { ...catalog['fastener.stack'].example, screw: { length: '16 mm' } }],
    ['fastener.check', { ...catalog['fastener.check'].example, stack: [] }],
    ['fastener.schedule', { ...catalog['fastener.schedule'].example, fasteners: [] }],
    ['shaft.interface', { ...catalog['shaft.interface'].example, shaft: { type: 'hex', d: '6 mm' } }],
    ['snap.evaluate', { ...catalog['snap.evaluate'].example, material: { name: 'ABS', modulus: 2.1 } }],
    ['shape.hose_barb', { ...catalog['shape.hose_barb'].example, barbs: [] }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM16 native handoff bundles the fastener module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('snap.evaluate', catalog['snap.evaluate'].example, { doc: 'GM16' });
  assert.ok(script.includes('def _snap_evaluate'));
  assert.ok(script.includes("'snap.evaluate': _snap_evaluate"));
});
