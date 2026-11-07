const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runBatch, validateBatch, resolveReferences, expandDefinition, definitionInstantiate } = require('../src/batch');

const catalog = { 'test.create': { required: ['name'], inputs: { name: '', source: '' }, readOnly: false } };
const context = { doc: 'document-id', component: 'root', projectId: 'project-id', preview: false };
function request(reportPath) {
  return { runId: 'test', ...(reportPath ? { reportPath } : {}), operations: [
    { id: 'first', operation: 'test.create', data: { name: 'First' }, onExisting: 'reuse' },
    { id: 'second', operation: 'test.create', data: { name: 'Second', source: { $ref: 'first.result.feature' } }, onExisting: 'reuse' },
    { id: 'third', operation: 'test.create', data: { name: 'Third' }, onExisting: 'reuse' },
  ] };
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function latest(dir) {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return JSON.parse(await fs.readFile(path.join(dir, names.at(-1)), 'utf8'));
}
const output = (name) => ({ success: true, operation: 'test.create', result: { feature: { token: name } }, created: [{ token: name }] });

test('substitutes whole nested reference values, never interpolates strings or prototypes', () => {
  const results = { first: output('token') };
  assert.deepEqual(resolveReferences([{ $ref: 'first.result.feature' }, 'first.result.feature'], results), [{ token: 'token' }, 'first.result.feature']);
  assert.throws(() => resolveReferences({ $ref: 'first.result.missing' }, results), /Unresolved/);
  assert.throws(() => resolveReferences({ $ref: 'first.__proto__' }, results), /Invalid/);
  assert.throws(() => resolveReferences({ $ref: 'first.result', other: true }, results), /sole key/);
});

test('resolves canonical list indexes and preserves textual dictionary keys', () => {
  const results = { first: { result: { rows: [{ '0': 'text-key', values: ['zero', 'one'] }] } } };
  assert.equal(resolveReferences({ $ref: 'first.result.rows.0.values.1' }, results), 'one');
  assert.equal(resolveReferences({ $ref: 'first.result.rows.0.0' }, results), 'text-key');
  for (const reference of ['first.result.rows.00', 'first.result.rows.-1', 'first.result.rows.2', 'first.result.rows.9007199254740992']) {
    assert.throws(() => resolveReferences({ $ref: reference }, results), /array index/);
  }
});

test('offline validation rejects duplicate IDs, unknowns, missing fields, future refs and cycles', () => {
  const data = request();
  assert.equal(validateBatch(data, catalog).success, true);
  data.operations[2].id = 'first';
  assert.match(validateBatch(data, catalog).errors.join(' '), /Duplicate/);
  const cyclic = request();
  cyclic.operations[0].data.source = { $ref: 'second.result.feature' };
  assert.match(validateBatch(cyclic, catalog).errors.join(' '), /Future.*cycle/);
  const invalid = request();
  invalid.operations[0].data = { typo: true, source: { $ref: 'missing.result' } };
  invalid.operations[1].operation = 'missing';
  invalid.typo = true;
  const errors = validateBatch(invalid, catalog).errors.join(' ');
  for (const pattern of [/Unknown batch/, /Missing required/, /Unknown input/, /Unknown reference/, /non-CAD/]) assert.match(errors, pattern);
});

test('expectFail does not accept a failed check whose restore failed', async (t) => {
  const dir = await directory(t);
  const data = { ...request(path.join(dir, 'restore-failure')), atomic: false,
    operations: [{ id: 'check', operation: 'test.read', expectFail: true, data: {} }] };
  const readCatalog = { 'test.read': { required: [], inputs: {}, readOnly: true } };
  const report = await runBatch(null, data, context,
    async () => ({ success: true, status: 'fail', restored: false }), readCatalog);
  assert.equal(report.success, false);
  assert.equal(report.steps[0].status, 'failed');
});

test('preview and validation never call executor or create reports', async (t) => {
  const dir = path.join(await directory(t), 'absent');
  const execute = () => assert.fail('Must stay offline');
  for (const mode of ['preview', 'validate']) {
    const result = await runBatch(null, { ...request(dir), mode }, context, execute, catalog);
    assert.equal(result.success, true);
    assert.equal(result.mutated, false);
  }
  await runBatch(null, request(dir), { ...context, preview: true }, execute, catalog);
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
});

test('persists running before every call, retains real outputs and stops after timeout', async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const result = await runBatch(null, request(dir), context, async (_client, operation, data) => {
    const saved = await latest(dir);
    assert.equal(saved.steps[calls].status, 'running');
    assert.deepEqual(saved.steps[calls].request.data, data);
    calls++;
    if (calls === 2) {
      assert.deepEqual(data.source, { token: 'First' });
      throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    }
    return output(data.name);
  }, catalog);
  assert.equal(calls, 2);
  assert.deepEqual(result.steps.map((step) => step.status), ['success', 'unknown', 'skipped']);
  assert.deepEqual(result.steps[0].output, output('First'));
  assert.equal(result.steps[1].timeout, true);
  assert.equal(result.steps[1].mutationStatus, 'unknown');
  assert.deepEqual(await latest(dir), result);
  await assert.rejects(runBatch(null, request(dir), context, () => assert.fail('No retry'), catalog), /operator inspection/);
});

test('exact successful replay is offline and cross-document/request changes are refused', async (t) => {
  const dir = await directory(t);
  const data = request(dir);
  const first = await runBatch(null, data, context, async (_c, _o, d) => output(d.name), catalog);
  assert.equal(first.success, true);
  const replay = await runBatch(null, data, context, () => assert.fail('No replay calls'), catalog);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.steps, first.steps);
  for (const changed of [{ ...context, doc: 'other-doc' }, { ...context, component: 'other' }, { ...context, projectId: 'other' }]) {
    await assert.rejects(runBatch(null, data, changed, () => assert.fail(), catalog), /hash differs/);
  }
  data.operations[0].data.name = 'changed';
  await assert.rejects(runBatch(null, data, context, () => assert.fail(), catalog), /hash differs/);
});

test('caught diagnostics use existing client configuration while successful CAD output stays exact', async t => {
  const dir = await directory(t);
  const server = { url: 'http://localhost/mcp?token=url-secret', headers: { 'X-Custom': 'custom-secret' } };
  const successful = { ...output('custom-secret'), stdout: 'Authorization: Bearer successful-stdout\nżółć' };
  let calls = 0;
  const result = await runBatch({ server }, request(dir), context, async () => {
    if (++calls === 1) return successful;
    throw Object.assign(new Error(`timed out ${server.url} custom-secret Authorization: Bearer error-secret`),
      { code: 'custom-secret' });
  }, catalog);
  assert.equal(calls, 2);
  assert.equal(result.steps[1].timeout, true);
  assert.equal(result.steps[1].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result.steps[1].error), /url-secret|custom-secret|error-secret/);
  assert.deepEqual(result.steps[0].output, successful);
  assert.deepEqual(await latest(dir), result);
  await assert.rejects(runBatch({ server }, request(dir), context, () => assert.fail('no retry'), catalog), /no automatic retry/);
});

test('unsuccessful structured output is preserved and missing reference paths fail before call', async (t) => {
  const dir = await directory(t);
  const failed = { success: false, result: { partial: 'actual' }, created: [{ token: 'partial' }] };
  const result = await runBatch(null, request(dir), context, async () => failed, catalog);
  assert.deepEqual(result.steps[0].output, failed);
  assert.equal(result.steps[0].mutationStatus, 'unknown');
  assert.equal(result.steps[1].status, 'skipped');
  const dir2 = await directory(t);
  const unresolved = await runBatch(null, request(dir2), context, async () => ({ success: true, result: {} }), catalog);
  assert.equal(unresolved.steps[1].mutationStatus, 'not_started');
  assert.equal(unresolved.steps[2].status, 'skipped');
});

test('definitions substitute literals without executing code and reject missing parameters', async () => {
  const data = request();
  data.parameters = { name: 'process.exit(99)' };
  data.operations[0].data.name = { $param: 'name' };
  assert.equal(expandDefinition(data).operations[0].data.name, 'process.exit(99)');
  assert.deepEqual(data.operations[0].data.name, { $param: 'name' });
  const result = await definitionInstantiate(null, { ...data, mode: 'preview' }, context, () => assert.fail(), catalog);
  assert.equal(result.success, true);
  assert.equal(result.operation, 'definition.instantiate');
  delete data.parameters.name;
  assert.equal(validateBatch(data, catalog).success, false);
});

test('exclusive locks and incomplete running reports prevent concurrent calls and retries', async (t) => {
  const dir = await directory(t);
  let release;
  let entered;
  const wait = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const running = runBatch(null, request(dir), context, async () => { entered(); await blocked; return output('value'); }, catalog);
  await wait;
  await assert.rejects(runBatch(null, request(dir), context, () => assert.fail(), catalog), /locked/);
  const saved = await latest(dir);
  release();
  await running;
  const incomplete = await directory(t);
  await fs.writeFile(path.join(incomplete, '00000000.json'), JSON.stringify(saved));
  await assert.rejects(runBatch(null, request(incomplete), context, () => assert.fail(), catalog), /in-progress/);
});

test('catalog routes are node-only with accurate readOnly declarations', () => {
  const definitions = require('../src/catalog/batch.json');
  for (const [name, spec] of Object.entries(definitions)) {
    assert.equal(spec.nodeOnly, true);
    assert.equal(spec.readOnly, ['batch.validate', 'batch.preview', 'batch.summary', 'batch.reconcile'].includes(name));
  }
});
