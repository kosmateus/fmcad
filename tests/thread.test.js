const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['thread.catalog', 'thread.custom-profile', 'thread.pair-check'];

test('GM13 thread operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM13 model.thread recipe extension validates and keeps tabular mode', () => {
  assert.ok(validateCad('model.thread', catalog['model.thread'].example));
  assert.ok(validateCad('model.thread', { faces: ['f'], internal: false, profile: { majorDiameter: '10 mm', pitch: '1.5 mm', starts: 2, hand: 'right' } }));
});

test('GM13 rejects invalid thread payloads before SDK dispatch', () => {
  const cases = [
    ['thread.custom-profile', { ...catalog['thread.custom-profile'].example, minorDiameter: '8 mm', pitchDiameter: '9 mm' }],
    ['thread.custom-profile', { ...catalog['thread.custom-profile'].example, schemaVersion: 2 }],
    ['thread.pair-check', { ...catalog['thread.pair-check'].example, internal: null }],
    ['thread.catalog', { ...catalog['thread.catalog'].example, system: 'unified' }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM13 native handoff bundles the thread module and preserves native ThreadInfo', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('thread.custom-profile', catalog['thread.custom-profile'].example, { doc: 'GM13' });
  assert.ok(script.includes('def _thread_profile'));
  assert.ok(script.includes("'model.thread'] = thread_feature"));
});
