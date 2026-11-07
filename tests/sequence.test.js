const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, catalog } = require('../src/cad');

const operations = ['assembly.sequence', 'service.path-check', 'tool.access', 'fixture.access'];

test('GM27 sequence/service/tool/fixture operations are catalog reachable with envelope and readOnly', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM27 rejects malformed payloads before SDK dispatch', () => {
  const cases = [
    ['assembly.sequence', { ...catalog['assembly.sequence'].example, unsupportedReviewFlag: true }],
    ['assembly.sequence', {}],
    ['service.path-check', { ...catalog['service.path-check'].example, bogus: 1 }],
    ['tool.access', { ...catalog['tool.access'].example, bogus: 1 }],
    ['fixture.access', { ...catalog['fixture.access'].example, bogus: 1 }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM27 native handoff bundles the sequence module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('assembly.sequence', catalog['assembly.sequence'].example, { doc: 'GM27' });
  assert.ok(script.includes('def assembly_sequence'));
  assert.ok(script.includes("'assembly.sequence': assembly_sequence"));
  assert.ok(script.includes("'service.path-check': service_path_check"));
  assert.ok(script.includes("'tool.access': tool_access"));
  assert.ok(script.includes("'fixture.access': fixture_access"));
});
