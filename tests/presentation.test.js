const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateCad } = require('../src/cad');

const catalog = require('../src/catalog/presentation.json');
const manual = require('../src/manual/presentation.json');

test('GM30 presentation catalog and manual cover the same operations with audited contracts', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.equal(typeof entry.summary, 'string', operation);
    assert.ok(Array.isArray(entry.required), operation);
    assert.ok(entry.example && typeof entry.example === 'object', operation);
    assert.equal(typeof entry.readOnly, 'boolean', operation);
    assert.ok(Array.isArray(entry.limitations), operation);
    const m = manual[operation];
    assert.ok(m, `Unfinished command: ${operation}`);
    assert.ok(m.sections.some(s => /Return Contract/i.test(s.title)), operation);
    assert.ok(m.audit.sources.length, operation);
    assert.ok(m.audit.verified.length, operation);
    assert.ok(m.audit.tests.length, operation);
    assert.deepEqual(m.audit.gaps, [], operation);
    assert.ok(m.examples.length, operation);
    for (const example of m.examples) {
      assert.equal(typeof example.label, 'string');
      assert.ok(example.requires.length > 0, operation);
      assert.ok(example.output.length > 0, operation);
      assert.doesNotThrow(() => validateCad(operation, example.data), `${operation}: ${example.label}`);
    }
  }
});

test('GM30 test evidence files exist', () => {
  const seen = new Set();
  for (const entry of Object.values(manual)) {
    for (const evidence of entry.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      seen.add(file);
      assert.ok(fs.existsSync(file), `missing test evidence ${file}`);
    }
  }
});
