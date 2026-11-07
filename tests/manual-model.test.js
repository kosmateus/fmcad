const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { validateCad } = require('../src/cad');
const { validateBatch, resolveReferences } = require('../src/batch');
const catalog = require('../src/catalog/model.json');
const manual = require('../src/manual/model.json');

test('all 30 model manuals cover catalog and examples pass existing outer validators', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(manual).length, 30);
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(entry.sections.some(s => s.title === 'Return Contract'), operation);
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

test('manual output wiring uses actual envelope result and array path syntax', () => {
  const ref = { token: 'test-only-token', kind: 'SketchCircle' };
  assert.deepEqual(resolveReferences({ entities: [{ $ref: 'g.result.refs.rim' }] },
    { g: { success: true, result: { refs: { rim: ref } } } }), { entities: [ref] });
  const path = { kind: 'path', curves: [ref], chain: 'none' };
  assert.deepEqual(resolveReferences({ path: { $ref: 'p.result.path' } },
    { p: { success: true, result: { path } } }), { path });
});

test('model manual examples and owner-guard finding reproduce in handler stubs', () => {
  const result = spawnSync('python3', ['-B', 'tests/manual_model_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
