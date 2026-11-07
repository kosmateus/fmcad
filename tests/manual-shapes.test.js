const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { validateCad } = require('../src/cad');
const { validateBatch, resolveReferences } = require('../src/batch');
const catalog = require('../src/catalog/shapes.json');
const manual = require('../src/manual/shapes.json');

test('all 13 shape manuals cover catalog and examples pass existing outer validators', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(manual).length, 13);
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(entry.sections.some(s => s.title.startsWith('Return Contract')), operation);
    assert.deepEqual(entry.audit.gaps, []);
    assert.ok(entry.audit.sources.length && entry.audit.verified.length && entry.audit.tests.length);
    for (const example of entry.examples) {
      assert.ok(example.requires && example.output && example.label);
      validateCad(operation, example.data);
      const result = validateBatch({ runId: 'manual', operations: [{ id: 's', operation, data: example.data }] }, catalog);
      assert.equal(result.success, true, JSON.stringify(result.errors));
    }
  }
});

test('recipe output wiring distinguishes final pattern and seed; dotted keys are not traversable', () => {
  const seed = { token: 'test-only-seed', kind: 'feature' };
  const result = { b: { result: { seed: { feature: seed } } } };
  assert.deepEqual(resolveReferences({ entities: [{ $ref: 'b.result.seed.feature' }] }, result), { entities: [seed] });
  assert.throws(() => resolveReferences({ $ref: 'r.result.refs.route0.fit0' },
    { r: { result: { refs: { 'route0.fit0': seed } } } }), /Unresolved reference/);
});

test('shape manual examples, conditional returns and documented defects reproduce offline', () => {
  const result = spawnSync('python3', ['-B', 'tests/manual_shapes_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
