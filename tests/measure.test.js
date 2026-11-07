const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/catalog/measure.json');

test('measurement catalog documents every input and read-only boundary', () => {
  assert.equal(Object.keys(catalog).length, 28);
  for (const [key, entry] of Object.entries(catalog).filter(([, entry]) => !entry.internalOnly)) {
    assert.ok(entry.summary, key);
    assert.ok(Array.isArray(entry.required), key);
    assert.ok(entry.limitations.length, key);
    assert.equal(entry.readOnly, key !== 'parameter.test', key);
    for (const input of entry.required) {
      assert.ok(Object.hasOwn(entry.example, input), `${key}: missing example input ${input}`);
      assert.ok(entry.inputs[input], `${key}: undocumented input ${input}`);
    }
    for (const input of Object.keys(entry.example)) assert.ok(entry.inputs[input], `${key}: ${input}`);
  }
});

test('measurement Python compiles in actual core/model bundle order without writing pyc', () => {
  const base = path.join(__dirname, '../assets/cad');
  const source = ['core.py', 'measure.py', 'model.py'].map(name => fs.readFileSync(path.join(base, name), 'utf8')).join('\n');
  const result = spawnSync('python3', ['-B', '-c', 'import sys; compile(sys.stdin.read(), "cad-bundle", "exec")'], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('measurement offline mathematical and failure-restoration stubs pass (not kernel verification)', () => {
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'measure_test.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
