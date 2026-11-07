const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateBatch, runBatch, definitionInspect } = require('../src/batch');
const { catalog } = require('../src/cad');

// A fully specified fit stack that resolves to status "pass" (gap 4.6..5.2 mm vs 4 mm).
const fitStack = () => ({
  schemaVersion: 1, identity: { model: 'fixture', revision: '1' }, frame: 'datum:A',
  assumptions: ['Independent bounded dimensions in a common datum.'],
  terms: [{ id: 'gap', sign: 1, nominal: '5 mm', minus: '0.4 mm', plus: '0.2 mm' }],
  minimum: '4 mm',
});

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-local-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('offline validation accepts local engineering operations and counts them read-only', () => {
  const data = {
    formatVersion: 1, runId: 'local',
    operations: [
      { id: 'stack', operation: 'fit.stack', data: fitStack() },
      { id: 'sketch', operation: 'sketch.create', data: { name: 's', plane: 'XY' } },
    ],
    outputs: { minimum: { $ref: 'stack.result.minimum' } },
  };
  const result = validateBatch(data, catalog);
  assert.equal(result.success, true, JSON.stringify(result.errors));
  assert.equal(result.plan.mutations, 1, 'local computation is not a mutation');
  assert.deepEqual(result.plan.steps, 2);
  // Unknown local methods still fail like unknown CAD operations.
  const unknown = { runId: 'bad', operations: [{ id: 'x', operation: 'fit.nope', data: {} }] };
  assert.match(validateBatch(unknown, catalog).errors.join(';'), /non-CAD/);
});

test('a definition step runs a local computation in-process and captures named results', async (t) => {
  const data = {
    formatVersion: 1, runId: 'local', reportPath: path.join(await directory(t), 'run'),
    operations: [
      { id: 'stack', operation: 'fit.stack', data: fitStack() },
      { id: 'sketch', operation: 'sketch.create', data: { name: { $ref: 'stack.status' }, plane: 'XY' } },
    ],
    outputs: { minimum: { $ref: 'stack.result.minimum' }, status: { $ref: 'stack.status' } },
  };
  const calls = [];
  const report = await runBatch(null, data, { doc: 'Model' }, async (_client, operation, payload) => {
    calls.push({ operation, payload });
    assert.equal(operation, 'sketch.create', 'local step never reaches the executor');
    assert.equal(payload.name, 'pass');
    return { success: true, result: { sketch: { token: 's' } }, created: [] };
  }, catalog);
  assert.equal(report.success, true, JSON.stringify({ status: report.status, error: report.error, steps: report.steps.map(s => ({ id: s.id, status: s.status, error: s.error })) }));
  assert.equal(calls.length, 1);
  assert.equal(report.steps[0].mutationStatus, 'none');
  assert.equal(report.steps[0].output.status, 'pass');
  assert.deepEqual(report.exports.minimum, { value: 0.0046, unit: 'm' });
  assert.equal(report.steps[0].output.result.sensitivity.ranking[0].id, 'gap');
  assert.equal(report.exports.status, 'pass');
});

test('local steps feed mass-system outputs into a later CAD step via $ref', async (t) => {
  const massSystem = () => ({
    schemaVersion: 1, identity: { model: 'fixture', revision: '1' }, frame: 'datum:A',
    assumptions: ['Rigid items in a common datum.'],
    items: [
      { id: 'body', mass: '2 kg', cg: { x: '0 m', y: '0 m', z: '0 m' }, placement: { x: '0 m', y: '0 m', z: '0 m' }, inertia: { ixx: '1 kg*m2', iyy: '1 kg*m2', izz: '1 kg*m2', ixy: '0 kg*m2', ixz: '0 kg*m2', iyz: '0 kg*m2' } },
    ],
    maximumMass: '3 kg',
  });
  const data = {
    runId: 'mass', reportPath: path.join(await directory(t), 'run'),
    operations: [
      { id: 'mass', operation: 'mass.system', data: massSystem() },
      { id: 'name', operation: 'component.create', data: { name: { $ref: 'mass.status' } } },
    ],
  };
  const report = await runBatch(null, data, { doc: 'Model' }, async (_client, operation, payload) => {
    assert.equal(operation, 'component.create');
    assert.equal(payload.name, 'pass');
    return { success: true, result: { component: { token: 'c' } }, created: [] };
  }, catalog);
  assert.equal(report.success, true, JSON.stringify({ status: report.status, error: report.error, steps: report.steps.map(s => ({ id: s.id, status: s.status, error: s.error })) }));
  assert.deepEqual(report.steps[0].output.result.mass, { value: 2, unit: 'kg' });
});

test('definition inspect/expand accept local leaf steps without a document or backend', () => {
  const data = {
    formatVersion: 1, runId: 'inspect',
    operations: [{ id: 'stack', operation: 'fit.stack', data: fitStack() }],
  };
  const result = definitionInspect(data, catalog);
  assert.equal(result.success, true, JSON.stringify(result.errors));
  assert.equal(result.plan.steps, 1);
  assert.equal(result.plan.mutations, 0);
});
