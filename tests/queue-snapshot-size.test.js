'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapter } = require('../src/console-data');
const { readJson } = require('../src/queue-instance');
const { migrateProjectResponses } = require('../src/queue-response-migration');

test('retained queue history above the per-record 16 MiB limit remains readable by console and migration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-snapshot-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), dir = path.join(root, 'queue');
  fs.mkdirSync(project); fs.mkdirSync(dir);
  const jobs = {};
  const code = '# retained user script\n' + '#'.repeat(9000);
  for (let i = 0; i < 2000; i++) jobs['job-' + i] = { id: 'job-' + i, state: 'succeeded', clientId: 'history',
    code: 'EXECUTION_COMPLETE', finishedAt: i, request: { kind: 'rpc', cwd: project,
      payload: { method: 'tools/call', params: { name: 'execute_python', arguments: { code, persistent: false } } } } };
  const snapshot = path.join(dir, 'queue-state.json');
  fs.writeFileSync(snapshot, JSON.stringify({ version: 1, paused: false, revision: 2000, active: null, blocked: null, jobs }));
  assert.ok(fs.statSync(snapshot).size > 16 * 1024 * 1024);
  assert.throws(() => readJson(snapshot), { code: 'CORRUPT_STATE' }, 'Unrelated protocol records retain their default bound');
  const value = createAdapter({ project, dir, cfg: { routing: 'queue' } }).read();
  assert.equal(value.available, true, JSON.stringify({ reason: value.reason }));
  assert.equal(value.broker.state, 'STOPPED');
  assert.ok(value.operations.length > 0);
  assert.doesNotThrow(() => migrateProjectResponses({ dir, project, apply: false }),
    'Stopped-broker maintenance must read the same retained history as QueueState');
});
