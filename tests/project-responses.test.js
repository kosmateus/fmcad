'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { responsePath } = require('../src/queue-response-files');
const { migrateProjectResponses } = require('../src/queue-response-migration');
const { openResponse } = require('../src/console-response');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-responses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), dir = path.join(root, 'queue');
  fs.mkdirSync(path.join(project, '.cad/recipes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'jobs/task'), { recursive: true });
  const job = { id: 'task', state: 'succeeded', request: { cwd: path.join(project, '.cad/recipes') } };
  fs.writeFileSync(path.join(dir, 'queue-state.json'), JSON.stringify({ jobs: { task: job } }));
  return { root, project, dir, job };
}
test('new response writes go to project root even when invoked from a recipe subdirectory', t => {
  const f = fixture(t), file = responsePath(f.dir, f.job, 'stdout.txt', true);
  assert.equal(file, path.join(f.project, '.cad/results/task/stdout.txt'));
  fs.writeFileSync(file, 'result');
  assert.equal(responsePath(f.dir, f.job, 'stdout.txt'), file);
  assert.equal(fs.existsSync(path.join(f.dir, 'jobs/task/stdout.txt')), false);
  assert.throws(() => responsePath(f.dir, f.job, '../request.json'), /Invalid response/);
  assert.throws(() => responsePath(f.dir, { ...f.job, id: '../other' }, 'stdout.txt'), /Invalid task/);
});
test('legacy output remains readable until migrated and unscoped RPC has explicit compatibility', t => {
  const f = fixture(t), legacy = path.join(f.dir, 'jobs/task/stdout.txt');
  fs.writeFileSync(legacy, 'legacy');
  assert.equal(responsePath(f.dir, f.job, 'stdout.txt'), legacy);
  assert.equal(responsePath(f.dir, { id: 'task', request: {} }, 'rpc-result.json', true), path.join(f.dir, 'jobs/task/rpc-result.json'));
});
test('project result directories cannot redirect response writes through symlinks', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.project, '.cad/results'));
  assert.throws(() => responsePath(f.dir, f.job, 'stdout.txt', true), /regular directories/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('verified migration moves only terminal project outputs and does not rewrite queue state', async t => {
  const f = fixture(t), legacy = path.join(f.dir, 'jobs/task/stdout.txt'); fs.writeFileSync(legacy, '{"count":42}');
  const unknown = { id: 'unknown', state: 'needs_reconciliation', request: { cwd: f.project } };
  fs.mkdirSync(path.join(f.dir, 'jobs/unknown')); fs.writeFileSync(path.join(f.dir, 'jobs/unknown/stdout.txt'), 'pending');
  const stateFile = path.join(f.dir, 'queue-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ jobs: { task: f.job, unknown } }));
  const before = fs.readFileSync(stateFile);
  const preview = migrateProjectResponses({ ...f });
  assert.equal(preview.files.length, 1); assert.equal(preview.skippedNonterminal, 1);
  assert.equal(fs.existsSync(legacy), true); assert.equal(fs.existsSync(path.join(f.project, '.cad/results')), false);
  const result = migrateProjectResponses({ ...f, apply: true });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].bytes, 12);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(result.files[0].target, 'utf8'), '{"count":42}');
  assert.equal(fs.readFileSync(path.join(f.dir, 'jobs/unknown/stdout.txt'), 'utf8'), 'pending');
  assert.deepEqual(fs.readFileSync(stateFile), before);
  const response = await openResponse(f.job, { mode: 'broker', project: f.project, operations: [f.job] }, { dir: f.dir });
  assert.equal(response.error, null); assert.equal(response.outputs[0].path, result.files[0].target);
  assert.equal(JSON.parse(response.outputs[0].text).count, 42);
});
test('migration refuses an online broker and conflicting destination without deleting either copy', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'broker.lock'), '{}');
  assert.throws(() => migrateProjectResponses({ ...f, apply: true }), /Stop the broker/);
  fs.unlinkSync(path.join(f.dir, 'broker.lock'));
  const legacy = path.join(f.dir, 'jobs/task/stdout.txt'), target = responsePath(f.dir, f.job, 'stdout.txt', true);
  fs.writeFileSync(legacy, 'old'); fs.writeFileSync(target, 'user copy');
  assert.throws(() => migrateProjectResponses({ ...f, apply: true }), /Conflicting/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'old'); assert.equal(fs.readFileSync(target, 'utf8'), 'user copy');
});
test('phased local worker producer writes its actual stdout FD inside the project', async t => {
  const f = fixture(t), { PhasedWorkers } = require('../src/queue-phased');
  const worker = new PhasedWorkers({ dir: f.dir, cfg: {}, codeHash: 'fixture', properties: () => ({}),
    state: { status: () => ({ ...f.job, state: 'succeeded' }) }, onFault: error => { throw error; }, onUnknown: () => assert.fail('No SDK work expected'),
    spawnWorker: (_exe, _args, options) => {
      fs.writeSync(options.stdio[1], '{"local":true}\n');
      const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
    } });
  worker.startWorker({ ...f.job, timeoutMs: 5000, request: { ...f.job.request, argv: ['run', '--list'] } });
  await worker.workers.get(f.job.id).closed;
  assert.equal(fs.readFileSync(path.join(f.project, '.cad/results/task/stdout.txt'), 'utf8'), '{"local":true}\n');
  assert.equal(fs.existsSync(path.join(f.dir, 'jobs/task/stdout.txt')), false);
});
