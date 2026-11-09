'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLogs, parseLog } = require('../src/console-logs');
const { readTaskEvents, eventsFor, createTaskEventReader } = require('../src/console-task-events');
const { ConsoleModel } = require('../src/console-controller');
const { correlate } = require('../src/console-details');
const { identityCounts } = require('../src/console-client-identity');
const { label } = require('../src/console-labels');
const { clientKind, presenceText } = require('../src/console-client-identity');
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const directory = path.join(project, '.cad/logs'); fs.mkdirSync(directory, { recursive: true });
  return { project, directory };
}
test('selected old task loads its own hourly archive after global tail has moved on', t => {
  const { project, directory } = fixture(t);
  const task = { id: 'old-task', requestId: 'old-request', state: 'succeeded', submittedAt: Date.parse('2026-10-20T15:06:34Z'), finishedAt: Date.parse('2026-10-20T15:06:36Z') };
  fs.writeFileSync(path.join(directory, 'fmcad.log'), '2026-10-20T20:00:00Z INFO heartbeat unrelated\n'.repeat(30));
  const archive = path.join(directory, 'fmcad-2026-10-20_15.log');
  fs.writeFileSync(archive, [
    '2026-10-20T15:06:34Z INFO job_running job=old-task',
    '2026-10-20T15:06:35Z INFO job_sending job=old-task',
    '2026-10-20T15:06:36Z INFO job_succeeded job=old-task',
    '2026-10-20T15:06:36Z INFO client_finished request_id=old-request',
    '2026-10-20T15:06:36Z INFO job_succeeded job=another-task request=old-request', '',
  ].join('\n'));
  const before = fs.statSync(archive).mtimeMs, logs = readLogs(project, {}, 10, 512).logs;
  assert.equal(logs.some(log => log.taskId === task.id), false);
  const archived = readTaskEvents(project, task);
  assert.equal(archived.logs.length, 4); assert.equal(archived.limited, false);
  const snapshot = { logs, operations: [task], taskEvents: archived };
  assert.equal(eventsFor(snapshot, task).length, 4);
  assert.equal(correlate(task, snapshot).events.length, 4);
  const model = new ConsoleModel(); model.update(snapshot);
  assert.equal(model.related('logs', task, snapshot), true);
  assert.equal(model.rows().length, 4);
  assert.equal(fs.statSync(archive).mtimeMs, before);
});
test('task-hour selection spans boundaries, does not scan unrelated hours, and caches bounded reads', t => {
  const { project, directory } = fixture(t);
  const task = { id: 'task', submittedAt: Date.parse('2026-10-20T14:59:59Z'), finishedAt: Date.parse('2026-10-20T15:00:01Z') };
  for (const hour of ['13', '14', '15', '16']) fs.writeFileSync(path.join(directory, `fmcad-2026-10-20_${hour}.log`), `2026-10-20T${hour}:00:00Z INFO stage taskId=task\n`);
  const read = createTaskEventReader(project), result = read(task);
  assert.equal(result.logs.length, 2); assert.equal(result.sources.length, 2);
  assert.equal(read(task), result);
});
test('request-only events correlate but missing IDs and contradictory task IDs never join', () => {
  const task = { id: 'task', requestId: 'request' };
  const logs = [parseLog('2026-10-20T15:00:00Z INFO stage request_id=request'),
    parseLog('2026-10-20T15:00:00Z INFO stage task_id=task'),
    parseLog('2026-10-20T15:00:00Z INFO stage taskId=other requestId=request'),
    parseLog('2026-10-20T15:00:00Z INFO heartbeat none')].map((row, i) => ({ ...row, id: String(i) }));
  assert.deepEqual(eventsFor({ logs }, task).map(row => row.id), ['0', '1']);
  assert.deepEqual(eventsFor({ logs }, {}), []);
});
test('same event in tail and archive is not duplicated even after a tail epoch resync', () => {
  const row = { id: 'dev:ino:birth:1:10', taskId: 'task', sourceFile: 'fmcad.log', timestamp: '2026-10-20T15:00:00Z', message: 'stage' };
  assert.equal(eventsFor({ logs: [row], taskEvents: { taskId: 'task', logs: [{ ...row, id: 'dev:ino:birth:0:10' }] } }, { id: 'task' }).length, 1);
});
test('archive lookup bounds bytes and reports unavailable files without replay or broker startup', t => {
  const { project, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'fmcad.log'), 'x'.repeat(2 * 1024 * 1024));
  const result = readTaskEvents(project, { id: 'task' });
  assert.equal(result.limited, true); assert.ok(result.bytesRead <= 4 * 1024 * 1024);
  assert.deepEqual(result.logs, []);
  assert.equal(fs.existsSync(path.join(project, 'broker.lock')), false);
});
test('historical clients are not counted as unknown heartbeat signals or zero measured online', () => {
  const agents = [{ id: 'mcp-stdio:one', presence: 'unknown', source: 'job-history' }, { id: 'opencode:two', presence: 'unknown', source: 'job-history' }];
  assert.deepEqual(identityCounts(agents, true), { current: null, history: 2, total: 2, untracked: 2, unknown: 0 });
  const ui = { language: 'en', L: key => label(key, 'en') };
  assert.equal(presenceText(agents[0], ui), 'History only');
  assert.equal(clientKind(agents[0].id), 'MCP stdio'); assert.equal(clientKind(agents[1].id), 'OpenCode');
  assert.equal(clientKind('cli:PC:kamil'), 'CLI');
  const model = new ConsoleModel(); model.tab = 1; model.update({ agents, operations: [] });
  model.state.filters = { scope: 'all', clientKind: 'OpenCode' };
  assert.deepEqual(model.rows().map(row => row.id), ['opencode:two']);
  const live = identityCounts([...agents, { id: 'direct', presence: 'observed', source: 'direct-process-heartbeat' }], true);
  assert.equal(live.current, 1); assert.equal(live.untracked, 2);
});
