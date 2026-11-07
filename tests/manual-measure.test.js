const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const manual = require('../src/manual/measure.json');
const catalog = require('../src/catalog/measure.json');
const { validateCad } = require('../src/cad');
const { resolveReferences } = require('../src/batch');
const { failedOutcome } = require('../src/outcome');

test('measure manual covers every operation and all examples pass existing outer validator', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(entry.sections.some(section => section.title.endsWith('Return Contract')), operation);
    for (const section of entry.sections) assert.ok(section.title && section.text, operation);
    assert.ok(entry.examples.length, operation);
    for (const example of entry.examples) {
      assert.ok(example.label && example.requires && example.output, operation);
      validateCad(operation, example.data);
      assert.doesNotMatch(JSON.stringify(example.data), /TOKEN_FROM|token-placeholder|\"token\":/);
      for (const check of example.data.checks || (operation === 'check' ? [example.data] : [])) {
        validateCad('check', check);
        validateCad(check.measurement.operation, check.measurement.data);
      }
    }
    for (const key of ['sources', 'verified', 'tests', 'gaps', 'bugs']) assert.ok(Array.isArray(entry.audit[key]), operation);
    assert.equal(entry.audit.gaps.length, 0, operation);
  }
});

test('measure snapshot and selected-geometry wiring uses actual result nesting', () => {
  const snapshot = { schema: 'fmcad.measure.snapshot.v1', document: { name: 'Offline' } };
  const face = { kind: 'face', token: 'offline-fixture-only' };
  const results = { baseline: { result: snapshot }, face: { result: face } };
  assert.deepEqual(resolveReferences({ before: { $ref: 'baseline.result' } }, results), { before: snapshot });
  assert.deepEqual(resolveReferences({ measurement: { operation: 'measure.diameter', data: { ref: { $ref: 'face.result' } } } }, results),
    { measurement: { operation: 'measure.diameter', data: { ref: face } } });
});

test('failed report and sampled motion evidence make legacy success envelopes fail', () => {
  for (const [operation, result] of [['report', { checkOutcome: 'fail', status: { acceptance: 'notEvaluated' } }],
    ['assembly.motion_check', { sampledPassed: false }]]) {
    assert.equal(failedOutcome({ success: true, operation, result }), true);
  }
});

test('all measure manual examples execute actual handlers using offline fixtures, not Fusion', () => {
  const out = spawnSync('python3', ['-B', path.join(__dirname, 'manual_measure_test.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
