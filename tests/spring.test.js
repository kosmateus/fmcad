const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, executeCad, catalog } = require('../src/cad');
const { contracts, localInvocation } = require('../src/catalog');

const operations = ['curve.helix', 'shape.spring', 'spring.evaluate', 'spring.configure'];

test('GM12 spring operations are catalog reachable with schemaVersion 1 and frame component', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation.startsWith('spring.'));
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test('GM12 recipe and engineering operations require Fusion Python, not a local/offline result', () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    const contract = contracts[operation];
    assert.equal(contract.service.kind, 'python', operation);
    assert.equal(contract.requirements.sdk, 'required', operation);
    assert.equal(contract.requirements.document, true, operation);
    assert.equal(localInvocation({ operation, data: entry.example, preview: false }), false, operation);
  }
});

test('GM12 shape.helix generation example validates', () => {
  assert.ok(validateCad('shape.helix', catalog['shape.helix'].example));
});

test('GM12 rejects contradictory helix and spring payloads before SDK dispatch', () => {
  const cases = [
    ['curve.helix', { ...catalog['curve.helix'].example, pitch: '5 mm', height: '46 mm' }],
    ['curve.helix', { ...catalog['curve.helix'].example, schemaVersion: 2 }],
    ['curve.helix', { schemaVersion: 1, frame: 'component', radius: '4 mm' }],
    ['spring.evaluate', { ...catalog['spring.evaluate'].example, compressedLength: '17 mm', deflection: '18 mm' }],
    ['spring.evaluate', { ...catalog['spring.evaluate'].example, activeCoils: 'six' }],
  ];
  for (const [operation, data] of cases) assert.throws(() => validateCad(operation, data), undefined, `${operation}: ${JSON.stringify(data)}`);
});

test('GM12 blocked native helix lifts the envelope and fails', async () => {
  const client = { callTool: async () => ({ text: 'FMCAD_RESULT ' + JSON.stringify({
    success: true, operation: 'curve.helix', result: { schemaVersion: 1, status: 'blocked', warnings: ['native path unavailable'] } }) }) };
  const out = await executeCad(client, 'curve.helix', catalog['curve.helix'].example, { doc: 'GM12' });
  assert.equal(out.success, false);
  assert.equal(out.status, 'blocked');
});

test('GM12 native handoff bundles the spring module', () => {
  const { buildCadScript } = require('../src/cad');
  const script = buildCadScript('spring.evaluate', catalog['spring.evaluate'].example, { doc: 'GM12' });
  assert.ok(script.includes('def _helix_parameters'));
  assert.ok(script.includes("'spring.evaluate': spring_evaluate"));
});
