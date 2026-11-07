const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateBatch, runBatch, readBatchSummary, definitionInspect } = require('../src/batch');
const { catalog } = require('../src/cad');
const { main } = require('../src/cli');

function fixture() {
  return {
    formatVersion: 1, runId: 'scoped', maxExpansion: 100,
    definitions: {
      leaf: { parameters: { name: 'default' }, inputs: ['part'], operations: [
        { id: 'seed', operation: 'sketch.create', component: { $input: 'part' },
          data: { name: { $param: 'name' }, plane: 'XY' }, onExisting: 'reuse' },
      ], outputs: { sketch: { $ref: 'seed.result.sketch' } } },
      pair: { inputs: ['part'], parameters: { names: ['A', 'B'] }, operations: [
        { id: 'rows', forEach: { $param: 'names' }, operations: [
          { id: 'part', use: 'leaf', inputs: { part: { $input: 'part' } }, parameters: { name: { $local: 'item' } } },
        ], outputs: { sketch: { $ref: 'part.outputs.sketch' } } },
      ], outputs: { sketches: { $ref: 'rows.outputs' } } },
    },
    operations: [
      { id: 'component', operation: 'component.create', data: { name: 'Owner' }, onExisting: 'reuse' },
      { id: 'one', use: 'pair', inputs: { part: { $ref: 'component.result.component' } } },
      { id: 'two', use: 'pair', inputs: { part: { $ref: 'component.result.component' } }, parameters: { names: ['C', 'D'] } },
      { id: 'inspect', operation: 'sketch.inspect', data: { sketch: { $ref: 'two.outputs.sketches.1.sketch' } }, onExisting: 'reuse' },
    ], outputs: { first: { $ref: 'one.outputs.sketches.0.sketch' }, secondToken: { $ref: 'two.outputs.sketches.1.sketch.token' } },
  };
}

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gm01-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('nested definitions compile to isolated IDs, explicit caller refs and exposed outputs', () => {
  const data = fixture(), original = structuredClone(data);
  const result = definitionInspect(data, catalog);
  assert.equal(result.success, true, JSON.stringify(result.errors));
  assert.deepEqual(data, original);
  assert.equal(result.plan.steps, 6);
  assert.equal(new Set(result.operations.map(s => s.id)).size, 6);
  assert.deepEqual(result.operations.slice(1, 5).map(s => s.data.name), ['A', 'B', 'C', 'D']);
  for (const step of result.operations.slice(1, 5)) assert.deepEqual(step.component, { $ref: 'component.result.component' });
  assert.deepEqual(result.operations[5].data.sketch, { $ref: result.operations[4].id + '.result.sketch' });
  assert.deepEqual(result.exports.secondToken, { $ref: result.operations[4].id + '.result.sketch.token' });
});

test('nested repeat/forEach preserve lexical locals and allow finite zero loops', () => {
  const data = { formatVersion: 1, runId: 'loops', operations: [
    { id: 'outer', repeat: 2, as: 'outerItem', index: 'outerIndex', operations: [
      { id: 'inner', forEach: [{ name: 'X' }], operations: [
        { id: 'read', operation: 'entity.list', data: { kind: 'body' }, component: { $local: 'item.name' } },
      ], outputs: { value: { $local: 'outerIndex' } } },
    ], outputs: { row: { $ref: 'inner.outputs' } } },
    { id: 'empty', repeat: 0, operations: [{ id: 'read', operation: 'entity.list', data: {} }] },
  ], outputs: { empty: { $ref: 'empty.outputs' }, rows: { $ref: 'outer.outputs' } } };
  const result = validateBatch(data, catalog);
  assert.equal(result.success, true, JSON.stringify(result.errors));
  assert.deepEqual(result.exports, { empty: [], rows: [{ row: [{ value: 0 }] }, { row: [{ value: 1 }] }] });
  assert.deepEqual(result.operations.map(s => s.component), ['X', 'X']);
});

test('cycles, cross-scope leaks, unbound inputs, collisions and expansion bombs fail offline', () => {
  const cases = [
    [d => { d.definitions.leaf.operations.push({ id: 'cycle', use: 'pair', inputs: { part: 'x' } }); }, /cycle/],
    [d => { d.operations[3].data.sketch = { $ref: 'seed.result.sketch' }; }, /cross-scope/],
    [d => { d.operations[1].inputs = {}; }, /inputs/],
    [d => { d.operations[1].parameters = { typo: 1 }; }, /Unknown parameter/],
    [d => { d.operations[2].id = 'one'; }, /Duplicate/],
    [d => { d.maxExpansion = 5; }, /limit|bounded/],
    [d => { d.definitions.pair.operations[0].forEach = 1e100; }, /bounded/],
    [d => { d.operations[3].data.sketch = { $ref: 'two.outputs.secret' }; }, /Unexposed/],
    [d => { d.definitions.leaf.operations[0].data.name = { $local: 'item' }; }, /Unbound local/],
    [d => { d.definitions.leaf.operations[0].data.name = { $param: 'name', extra: true }; }, /sole key/],
    [d => { d.operations[1].repeat = 1; }, /Unknown use field/],
    [d => { d.outputs.first = { $ref: 'one.outputs.sketches.constructor' }; }, /Invalid reference/],
    [d => { d.inputs = { escape: { $ref: 'scope_3_one_4_rows_1_0_4_part_4_seed.result.sketch' } }; }, /literal JSON/],
    [d => { d.parameters = null; }, /parameter/],
    [d => { d.maxExpansion = null; }, /maxExpansion/],
    [d => { d.definitions.pair.inputs = null; }, /inputs/],
    [d => { d.definitions.pair.outputs = null; }, /output/],
  ];
  for (const [mutate, error] of cases) {
    const data = fixture(); mutate(data);
    const result = validateBatch(data, catalog);
    assert.equal(result.success, false);
    assert.match(result.errors.join(';'), error);
  }
});

test('large repeated literals hit the copied-JSON memory budget before execution', () => {
  const result = validateBatch({ formatVersion: 1, runId: 'memory', parameters: { name: 'x'.repeat(1024 * 1024) },
    operations: [{ id: 'rows', repeat: 32, operations: [
      { id: 'create', operation: 'component.create', data: { name: { $param: 'name' } } },
    ] }] }, catalog);
  assert.equal(result.success, false);
  assert.match(result.errors.join(';'), /memory budget/);
});

test('existing runner persists expanded progress, exports, summary and refuses uncertain replay', async t => {
  const data = fixture(); data.reportPath = path.join(await directory(t), 'success');
  const calls = [];
  const execute = async (_client, operation, input, context) => {
    calls.push({ operation, input, context });
    if (operation === 'component.create') return { success: true, result: { component: { token: 'owner' } } };
    if (operation === 'sketch.create') {
      assert.deepEqual(context.component, { token: 'owner' });
      return { success: true, result: { sketch: { token: input.name } } };
    }
    assert.deepEqual(input.sketch, { token: 'D' });
    return { success: true, result: { count: 1 } };
  };
  const report = await runBatch(null, data, { doc: 'Model' }, execute, catalog);
  assert.equal(report.success, true);
  assert.deepEqual(report.exports, { first: { token: 'A' }, secondToken: 'D' });
  assert.equal(calls.length, 6);
  assert.equal((await readBatchSummary({ reportPath: data.reportPath, step: 6 })).steps[0].result.count, 1);
  assert.equal((await runBatch(null, data, { doc: 'Model' }, () => assert.fail('no replay'), catalog)).replayed, true);
  data.reportPath = path.join(await directory(t), 'failed');
  let n = 0;
  const failed = await runBatch(null, data, { doc: 'Model' }, async (...args) => {
    if (++n === 3) throw new Error('uncertain after seed');
    return execute(...args);
  }, catalog);
  assert.deepEqual(failed.steps.map(s => s.status), ['success', 'success', 'unknown', 'skipped', 'skipped', 'skipped']);
  assert.equal((await readBatchSummary({ reportPath: data.reportPath })).success, false);
  await assert.rejects(runBatch(null, data, { doc: 'Model' }, () => assert.fail('no retry'), catalog), /no automatic retry/);
});

test('inspect/expand CLI routes need no document, configuration, backend or file writes', async () => {
  for (const operation of ['inspect', 'expand']) {
    let stdout = '', stderr = '';
    const code = await main(['definition', operation, '--data', JSON.stringify(fixture()), '--time-budget-ms', '500', '--json'], {
      loadConfig: () => assert.fail('config'), McpClient: class { constructor() { assert.fail('backend'); } },
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, setExitCode: () => {},
    });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).operations.length, 6);
    assert.equal(JSON.parse(stdout).plan.timeBudgetMs, 500);
  }
});

test('regeneration bindings cover every use and reject structural or partial updates', () => {
  const data = { runId: 'bound', parameters: { height: '10 mm' }, recipe: { id: 'bound', bindings: [
    { parameter: 'height', input: 'distance', target: { $ref: 'solid.result.feature' }, role: 'AlongDistance' },
  ] }, operations: [
    { id: 'solid', operation: 'model.extrude', data: { profile: 'profile', distance: { $param: 'height' } } },
  ] };
  assert.equal(validateBatch(data, catalog).success, true);
  data.operations.push({ id: 'other', operation: 'model.extrude', data: { profile: 'p', distance: { $param: 'height' } } });
  assert.match(validateBatch(data, catalog).errors.join(';'), /Incomplete/);
  data.recipe.bindings.push({ ...data.recipe.bindings[0], target: { $ref: 'other.result.feature' } });
  assert.equal(validateBatch(data, catalog).success, true);
  data.operations[0].component = { $param: 'height' };
  assert.match(validateBatch(data, catalog).errors.join(';'), /structural/);
});

test('published native fixture has complete bindings and shared runner records recipe lifecycle', async t => {
  const data = require('./fixtures/gm01-native.json');
  const validation = validateBatch(data, catalog);
  assert.equal(validation.success, true, JSON.stringify(validation.errors));
  assert.equal(validation.operations.length, 8);
  const calls = [];
  const reportPath = path.join(await directory(t), 'native-double');
  const execute = async (_client, operation, payload) => {
    calls.push({ operation, payload });
    if (operation === 'definition.recipe') return { success: true, result: { sourceHash: payload.sourceHash, revision: 1 } };
    if (operation === 'component.create') return { success: true, result: { component: payload.name }, created: [] };
    if (operation === 'sketch.create') return { success: true, result: { sketch: 'sketch' }, created: [] };
    if (operation === 'sketch.geometry') return { success: true, result: {}, created: [] };
    return { success: true, result: { feature: { token: 'feature-' + calls.length }, bodies: [{ token: 'body-' + calls.length }] }, created: [{ token: 'feature-' + calls.length }] };
  };
  const report = await runBatch(null, { ...data, reportPath }, { doc: 'Model', docFileId: 'file' }, execute, catalog);
  assert.equal(report.success, true, JSON.stringify(report.error));
  assert.equal(calls[0].payload.action, 'begin');
  assert.equal(calls.at(-1).payload.action, 'complete');
  assert.equal(calls.at(-1).payload.created.length, 2);
  assert.equal(calls.at(-1).payload.bindings[0].target.token, 'feature-5');
  assert.equal((await readBatchSummary({ reportPath })).success, true);
});

test('recipe lifecycle failure is durable, summarized and never replayed', async t => {
  const data = { ...require('./fixtures/gm01-native.json'), reportPath: await directory(t) };
  const result = await runBatch(null, data, { doc: 'Model' }, async () => { throw new Error('recipe begin failed'); }, catalog);
  assert.equal(result.success, false);
  assert.equal(result.status, 'unknown');
  assert.ok(result.steps.every(s => s.status === 'skipped'));
  const summary = await readBatchSummary({ reportPath: data.reportPath });
  assert.match(summary.error.message, /recipe begin failed/);
  await assert.rejects(runBatch(null, data, { doc: 'Model' }, () => assert.fail('replay'), catalog), /no automatic retry/);
});

test('scheduling budget retains a completed call and refuses further submission or replay', async t => {
  const data = { runId: 'budget', reportPath: await directory(t), timeBudgetMs: 1000, operations: [
    { id: 'seed', operation: 'entity.list', data: { kind: 'body' }, onExisting: 'reuse' },
    { id: 'next', operation: 'entity.list', data: { kind: 'body' }, onExisting: 'reuse' },
  ] };
  let clock = 0, calls = 0;
  t.mock.method(performance, 'now', () => clock);
  const result = await runBatch(null, data, { doc: 'Model' }, async () => {
    calls++; clock = 1001;
    return { success: true, result: { count: 3 } };
  }, catalog);
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.elapsedMs, 1001);
  assert.deepEqual(result.steps.map(s => s.status), ['success', 'skipped']);
  assert.equal(result.steps[0].output.result.count, 3);
  assert.equal((await readBatchSummary({ reportPath: data.reportPath })).error.code, 'FMCAD_BATCH_BUDGET_EXHAUSTED');
  await assert.rejects(runBatch(null, data, { doc: 'Model' }, () => assert.fail(), catalog), /no automatic retry/);
  for (const timeBudgetMs of [null, false, 0, -1, 0.5, '100']) {
    assert.equal(validateBatch({ ...data, timeBudgetMs }, catalog).success, false);
  }
  assert.equal(validateBatch(fixture(), catalog).plan.timeBudgetMs, 180000);
});
