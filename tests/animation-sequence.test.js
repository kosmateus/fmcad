const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateCad } = require('../src/cad');

const catalog = require('../src/catalog/animation-sequence.json');
const manual = require('../src/manual/animation-sequence.json');

test('GM36 animation sequence/export catalog and manual cover the same operations', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.equal(typeof entry.summary, 'string', operation);
    assert.ok(Array.isArray(entry.required), operation);
    assert.ok(entry.example && typeof entry.example === 'object', operation);
    assert.equal(typeof entry.readOnly, 'boolean', operation);
    assert.equal(entry.envelope, true, operation);
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

test('GM36 animation handlers bundle into the CAD script without overwriting animation.*', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('animation.sequence', catalog['animation.sequence'].example, { doc: 'GM36' });
  assert.ok(script.includes('def animation_sequence'));
  assert.ok(script.includes('def animation_export'));
  assert.ok(script.includes("'animation.sequence': animation_sequence"));
  assert.ok(script.includes("'animation.export': animation_export"));
});

test('GM36 animation test evidence files exist', () => {
  const seen = new Set();
  for (const entry of Object.values(manual)) {
    for (const evidence of entry.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      seen.add(file);
      assert.ok(fs.existsSync(file), `missing test evidence ${file}`);
    }
  }
});
