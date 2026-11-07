'use strict';

// Live integration tests for GM-01 (definitions and durable recipes).
//
// `definition inspect`/`definition expand` are local, read-only commands: they
// compile scoped definitions without a document or backend, so those tests run
// without --doc and need no clear(). Native `batch run` / `definition
// instantiate` / replay-refusal tests use the coordinator-provided document.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () {
  if (!hasDoc()) return;
  clear();
});
afterEach(function () {
  if (!hasDoc()) return;
  clear();
});

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm01-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('gm01: G01-01 definition expand isolates nested scope and binds named inputs', () => {
  const data = {
    formatVersion: 1, runId: 'scope',
    definitions: {
      leaf: {
        inputs: ['part'],
        operations: [
          { id: 'seed', operation: 'sketch.create', component: { $input: 'part' }, data: { name: 'Section', plane: 'XY' } },
        ],
        outputs: { sketch: { $ref: 'seed.result.sketch' } },
      },
    },
    operations: [
      { id: 'comp', operation: 'component.create', data: { name: 'Owner' } },
      { id: 'one', use: 'leaf', inputs: { part: { $ref: 'comp.result.component' } } },
    ],
    outputs: { sketch: { $ref: 'one.outputs.sketch' } },
  };
  const out = fmcad(['definition', 'expand', '--data', JSON.stringify(data)]);
  assert.equal(out.success, true, JSON.stringify(out.errors));
  assert.equal(out.status, 'pass');
  assert.equal(out.operations.length, 2);
  assert.equal(out.plan.steps, 2);
  assert.equal(out.operations[1].operation, 'sketch.create');
  assert.deepEqual(out.operations[1].component, { $ref: 'comp.result.component' });
  assert.ok(out.exports.sketch, 'expected a named exported sketch reference');
});

test('gm01: G01-02 definition expand expands finite repeat/forEach with lexical locals', () => {
  const data = {
    formatVersion: 1, runId: 'loops',
    operations: [
      { id: 'outer', repeat: 2, as: 'outerItem', index: 'outerIndex', operations: [
        { id: 'inner', forEach: [{ name: 'X' }], operations: [
          { id: 'read', operation: 'entity.list', data: { kind: 'body' }, component: { $local: 'item.name' } },
        ], outputs: { value: { $local: 'outerIndex' } } },
      ], outputs: { row: { $ref: 'inner.outputs' } } },
      { id: 'empty', repeat: 0, operations: [{ id: 'read', operation: 'entity.list', data: {} }] },
    ],
    outputs: { empty: { $ref: 'empty.outputs' }, rows: { $ref: 'outer.outputs' } },
  };
  const out = fmcad(['definition', 'expand', '--data', JSON.stringify(data)]);
  assert.equal(out.success, true, JSON.stringify(out.errors));
  assert.deepEqual(out.exports.empty, []);
  assert.deepEqual(out.exports.rows, [{ row: [{ value: 0 }] }, { row: [{ value: 1 }] }]);
  assert.deepEqual(out.operations.map((s) => s.component), ['X', 'X']);
});

test('gm01: G01-03 definition inspect reports the full step/scope/mutation plan', () => {
  const out = fmcad(['definition', 'inspect', '--file', 'tests/fixtures/gm01-native.json']);
  assert.equal(out.success, true, JSON.stringify(out.errors));
  assert.equal(out.status, 'pass');
  assert.equal(out.operations.length, 8);
  assert.equal(out.plan.steps, 8);
  assert.equal(out.plan.mutations, 8);
  assert.ok(out.plan.nodes >= 8, 'expected a visited-node count in the plan');
  assert.ok(Array.isArray(out.plan.scopes), 'expected per-step scope paths');
});

test('gm01: G01-04 definition inspect validates durable recipe bindings cover every use', () => {
  const out = fmcad(['definition', 'inspect', '--file', 'tests/fixtures/gm01-native.json']);
  assert.equal(out.success, true, JSON.stringify(out.errors));
  assert.equal(out.recipe.bindings.length, 2);
  for (const binding of out.recipe.bindings) {
    assert.ok(binding.target.$ref, 'expected a resolved target $ref');
    assert.equal(binding.role, 'AlongDistance');
    assert.match(binding.target.$ref, /^scope_/);
  }
});

test('gm01: G01-05 definition inspect refuses cycles and unbound refs', () => {
  const cycle = {
    formatVersion: 1,
    definitions: { self: { operations: [{ id: 'c', use: 'self', inputs: {} }] } },
    operations: [{ id: 'root', use: 'self', inputs: {} }],
  };
  assert.throws(() => fmcad(['definition', 'inspect', '--data', JSON.stringify(cycle)]), /cycle/i);
  const unbound = { formatVersion: 1, operations: [{ id: 'a', use: 'missing', inputs: {} }] };
  assert.throws(() => fmcad(['definition', 'inspect', '--data', JSON.stringify(unbound)]), /Unknown definition/i);
});

test('gm01: G01-06 batch run --json returns the full report contract (hash, steps, outputs)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const data = { runId: 'gm01-summary', operations: [
    { id: 'comp', operation: 'component.create', data: { name: 'GM01_Batch' } },
  ] };
  const report = fmcad(['batch', 'run', '--doc', doc, '--data', JSON.stringify(data), '--report-path', dir]);
  assert.equal(report.success, true, JSON.stringify(report));
  assert.equal(report.operation, 'batch.run');
  assert.match(report.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, 'success');
  assert.ok(report.steps[0].output, 'expected a retained per-step output');
});

test('gm01: G01-07 batch summary reads the latest report and selects a 1-based step', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const data = { runId: 'gm01-summary', operations: [
    { id: 'comp', operation: 'component.create', data: { name: 'GM01_Batch' } },
    { id: 'sketch', operation: 'sketch.create', data: { name: 'GM01_BatchSketch', plane: 'XY' } },
  ] };
  fmcad(['batch', 'run', '--doc', doc, '--data', JSON.stringify(data), '--report-path', dir]);
  const summary = fmcad(['batch', 'summary', '--report-path', dir, '--step', '1']);
  assert.equal(summary.historical, true);
  assert.equal(summary.modelValidated, false);
  assert.equal(summary.success, true);
  assert.equal(summary.steps.length, 1);
  assert.equal(summary.steps[0].step, 1);
  assert.equal(summary.steps[0].id, 'comp');
  assert.equal(summary.steps[0].status, 'success');
});

test('gm01: G01-10 definition instantiate runs the same definition twice with different parameters', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const data = {
    formatVersion: 1, runId: 'gm01-twice',
    parameters: { heightA: '10 mm', heightB: '15 mm' },
    definitions: {
      cylinder: {
        revision: '1',
        parameters: { name: 'Cylinder', height: '10 mm', radius: '5 mm', center: ['0 mm', '0 mm', '0 mm'] },
        operations: [
          { id: 'part', operation: 'component.create', data: { name: { $param: 'name' } } },
          { id: 'section', operation: 'sketch.create', component: { $ref: 'part.result.component' }, data: { name: 'Section', plane: 'XY' } },
          { id: 'circle', operation: 'sketch.geometry', component: { $ref: 'part.result.component' }, data: { sketch: { $ref: 'section.result.sketch' }, geometry: [{ type: 'circle', name: 'rim', center: { $param: 'center' }, radius: { $param: 'radius' } }] } },
          { id: 'solid', operation: 'model.extrude', component: { $ref: 'part.result.component' }, data: { name: 'Solid', profile: { kind: 'profile', sketch: { $ref: 'section.result.sketch' } }, distance: { $param: 'height' }, operation: 'newBody' } },
        ],
        outputs: { feature: { $ref: 'solid.result.feature' }, body: { $ref: 'solid.result.bodies.0' } },
      },
    },
    operations: [
      { id: 'first', use: 'cylinder', parameters: { name: 'GM01_A', height: { $param: 'heightA' } } },
      { id: 'second', use: 'cylinder', parameters: { name: 'GM01_B', height: { $param: 'heightB' }, radius: '7 mm', center: ['30 mm', '0 mm', '0 mm'] } },
    ],
    outputs: { first: { $ref: 'first.outputs.body' }, second: { $ref: 'second.outputs.body' } },
  };
  const report = fmcad(['definition', 'instantiate', '--doc', doc, '--data', JSON.stringify(data), '--report-path', dir]);
  assert.equal(report.success, true, JSON.stringify(report));
  assert.equal(report.operation, 'definition.instantiate');
  assert.equal(report.steps.length, 8);
  assert.ok(report.steps.every((s) => s.status === 'success'), JSON.stringify(report.steps));
  assert.ok(report.exports.first, 'expected first body ref');
  assert.ok(report.exports.second, 'expected second body ref');
  // First cylinder is r=5 mm, h=10 mm (250*pi mm^3); second is r=7 mm, h=15 mm
  // (735*pi mm^3). Volume readback is documented in C_todo G01-10; the two
  // resolved bodies differ because radius/center are overridden per use.
  assert.notDeepEqual(report.exports.first, report.exports.second);
});

test('gm01: G01-11 partial failure after a seed is recorded and replay is refused', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  // The second step references a field the first step does not export, so it
  // fails at runtime after the seed has already mutated the document.
  const data = { runId: 'gm01-partial', operations: [
    { id: 'comp', operation: 'component.create', data: { name: 'GM01_Partial' } },
    { id: 'bad', operation: 'entity.inspect', data: { ref: { $ref: 'comp.result.componentx' } } },
  ] };
  assert.throws(
    () => fmcad(['definition', 'instantiate', '--doc', doc, '--data', JSON.stringify(data), '--report-path', dir]),
    /Unresolved reference/i,
  );
  // The partial report is durable and an uncertain replay is refused.
  const files = fs.readdirSync(dir).filter((name) => /^\d{8}\.json$/.test(name)).sort();
  assert.ok(files.length, 'expected a persisted partial report');
  const report = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.steps[0].status, 'success');
  assert.equal(report.steps[1].status, 'failed');
  assert.throws(
    () => fmcad(['definition', 'instantiate', '--doc', doc, '--data', JSON.stringify(data), '--report-path', dir]),
    /no automatic retry/i,
  );
});
