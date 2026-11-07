const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const manual = require('../src/manual/core.json');
const catalog = require('../src/catalog/core.json');
const { validateCad } = require('../src/cad');
const { resolveReferences } = require('../src/batch');

test('core manual covers every operation and examples pass existing outer validator', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(manual)) {
    for (const section of entry.sections) assert.ok(section.title && section.text, operation);
    assert.ok(entry.examples.length, operation);
    for (const example of entry.examples) {
      assert.ok(example.label && example.requires && example.output, operation);
      validateCad(operation, example.data);
      assert.doesNotMatch(JSON.stringify(example.data), /TOKEN_FROM|token-placeholder|\"token\":/);
    }
    for (const key of ['sources', 'verified', 'tests', 'gaps', 'bugs']) assert.ok(Array.isArray(entry.audit[key]), operation);
  }
});

test('core documented result paths resolve through real batch reference helper', () => {
  const ref = { kind: 'body', name: 'BodyA', token: 'offline-fixture-only' };
  const results = { bodies: { result: { entities: [ref] } }, mount: { result: { ref } }, selected: { result: { selections: [{ entity: ref }] } } };
  for (const reference of ['bodies.result.entities.0', 'mount.result.ref', 'selected.result.selections.0.entity']) {
    assert.deepEqual(resolveReferences({ ref: { $ref: reference } }, results), { ref });
  }
  assert.throws(() => resolveReferences({ ref: { $ref: 'bodies.result.entities.0.ref' } }, results), /Unresolved/);
});

test('all core manual examples execute actual handlers using offline fixtures, not Fusion', () => {
  const out = spawnSync('python3', ['-B', path.join(__dirname, 'manual_core_test.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
