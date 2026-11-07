const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad } = require('../src/cad');
const { validateBatch } = require('../src/batch');
const catalog = require('../src/catalog/io.json');
const manual = require('../src/manual/io.json');
const { parseCadInput } = require('../src/cad-input');
const { detail } = require('../src/help');

test('mesh tolerance accepts direct CLI and JSON payloads and appears in help', () => {
  const data = { path: 'C:/cad-output/part.stl', units: 'mm', surfaceDeviation: '0.005 mm' };
  const direct = parseCadInput(['--path', data.path, '--units', 'mm', '--surface-deviation', '0.005 mm'], catalog['export.mesh'].inputs);
  assert.deepEqual(direct.data, data);
  assert.deepEqual(parseCadInput(['--data', JSON.stringify(data)], catalog['export.mesh'].inputs).data, data);
  assert.doesNotThrow(() => validateCad('export.mesh', data));
  assert.throws(() => validateCad('export.step', data), /Unknown CAD inputs/);
  assert.throws(() => parseCadInput(['--surface-deviation', '0.005 mm'], catalog['export.parts'].inputs), /Unknown CAD option/);
  assert.match(detail('export', 'mesh'), /--surface-deviation/);
  assert.match(detail('export', 'mesh'), /surfaceDeviationCm/);
});

test('io manual covers every exact operation with audited contracts', () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(manual).length, 28);
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(entry.sections.some(section => section.title === 'Return Contract'), operation);
    for (const section of entry.sections) {
      assert.equal(typeof section.title, 'string');
      assert.equal(typeof section.text, 'string');
      assert.ok(section.text.length > 0);
    }
    assert.ok(entry.audit.sources.some(source => source.startsWith('assets/cad/io.py:')));
    for (const key of ['sources', 'verified', 'tests', 'gaps', 'bugs']) {
      assert.ok(Array.isArray(entry.audit[key]));
    }
    assert.deepEqual(entry.audit.gaps, []);
    assert.ok(entry.examples.length > 0);
  }
});

test('all io examples pass existing outer validators and ordered reference syntax', () => {
  // Handler fixtures in manual_io_test.py resolve and execute these nested inputs.
  for (const [operation, entry] of Object.entries(manual)) {
    for (const example of entry.examples) {
      assert.equal(typeof example.label, 'string');
      assert.ok(example.requires.length > 0);
      assert.ok(example.output.length > 0);
      assert.doesNotThrow(() => validateCad(operation, example.data), operation);
      const refs = new Set();
      function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (value.$ref) refs.add(value.$ref.split('.')[0]);
        Object.values(value).forEach(visit);
      }
      visit(example.data);
      const operations = [...refs].map(id => ({ id, operation: 'camera.save', data: {} }));
      operations.push({ id: 'example', operation, data: example.data });
      const result = validateBatch({ runId: 'manual-io', operations }, catalog);
      assert.equal(result.success, true, `${operation}: ${result.errors.join(', ')}`);
    }
  }
});
