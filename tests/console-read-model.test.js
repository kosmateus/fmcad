'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('pure read model loads with no terminal, Node effects, processes, files or SDK imports', () => {
  const original = Module._load;
  try {
    for (const file of Object.keys(require.cache)) if (file.includes('/packages/core/dist/')) delete require.cache[file];
    Module._load = function(name, ...args) {
      if (!name.startsWith('.') && !name.startsWith('/')) throw new Error('Forbidden dependency: ' + name);
      return original.call(this, name, ...args);
    };
    const model = require('../packages/core/dist');
    assert.equal(model.sourceHashMismatch('a'.repeat(64), 'b'.repeat(64)), true);
    assert.equal(model.projectContains('/project', '/project-other'), false);
  } finally { Module._load = original; }
});
const model = require('../packages/core/dist');

test('projection preserves explicit null, false and zero without copying request secrets', () => {
  const row = model.projectConsoleOperation({ id: 'task', mayHaveMutated: null, userScriptSubmitted: false,
    startedAt: 0, exitCode: 0, details: { executionOutcome: null }, request: { token: 'secret' } });
  assert.equal(row.mayHaveMutated, null);
  assert.equal(row.userScriptSubmitted, false);
  assert.equal(row.startedAt, 0);
  assert.equal(row.exitCode, 0);
  assert.equal(row.executionOutcome, null);
  assert.equal(Object.hasOwn(row, 'request'), false);
  assert.equal(Object.hasOwn(row, 'finishedAt'), false);
});

test('retention keeps active/unknown and direct history, with isolated copies and explicit omissions', () => {
  const input = { mode: 'direct', operations: [{ id: 'run', state: 'running' }, { id: 'unknown', state: 'unknown' },
    { id: 'old', state: 'completed', finishedAt: 0 }, { id: 'recent', state: 'completed', finishedAt: 10 }], logs: [{ id: 'a' }, { id: 'b' }] };
  const retained = model.retainSnapshot(input, 1, 1);
  assert.deepEqual(retained.operations.map(row => row.id), ['run', 'unknown', 'recent']);
  assert.equal(retained.retention.terminalTruncated, 1);
  assert.equal(retained.logs[0].id, 'b');
  retained.operations[0].state = 'failed';
  assert.equal(input.operations[0].state, 'running');
  assert.deepEqual(model.retainSnapshot(input, 0, 0).logs, []);
  assert.throws(() => model.retainSnapshot(input, -1));
  assert.equal(model.retainSnapshot({ operations: null, logs: null }).operations, null);
});

test('correlations require nonempty IDs and reject contradictory task/request links', () => {
  const snapshot = { operations: [{ id: 'task', requestId: 'request', clientId: 'client' }, { id: 'other' }], agents: [{ id: 'client' }, { id: '' }],
    logs: [{ id: 'yes', requestId: 'request' }, { id: 'no', requestId: 'request', taskId: 'other' }, { id: 'empty', requestId: '', taskId: '' }] };
  assert.deepEqual(model.correlate(snapshot.operations[0], snapshot).events.map(row => row.id), ['yes']);
  assert.deepEqual(model.correlate({ id: '', presence: 'unknown' }, snapshot).operations, []);
  assert.deepEqual(model.correlate({ id: 'log', level: 'INFO', taskId: 'other', requestId: 'request' }, snapshot).operations.map(row => row.id), ['other']);
  assert.deepEqual(model.eventsFor(snapshot, { id: ' ', requestId: ' ' }), []);
});

test('archived task events remain readable after global tail retention and deduplicate across epochs', () => {
  const log = { id: 'device:inode:0:64', sourceFile: '.cad/logs/old.log', timestamp: 0, message: 'job=task', taskId: 'task' };
  const snapshot = { logs: [{ id: 'device:inode:2:64', ...log }], taskEvents: { taskId: 'task', logs: [log] } };
  snapshot.logs[0].id = 'device:inode:2:64';
  assert.equal(model.eventsFor(snapshot, { id: 'task' }).length, 1);
  assert.equal(model.eventsFor({ logs: [], taskEvents: snapshot.taskEvents }, { id: 'task' }).length, 1);
  assert.equal(model.eventsFor({ logs: null }, { id: 'task' }), null);
  assert.deepEqual(model.eventsFor({ logs: null, taskEvents: { taskId: 'task', logs: [] } }, { id: 'task' }), []);
});

test('selectors distinguish missing from zero and history never creates live presence', () => {
  const snapshot = { agents: [{ id: 'cli:one', presence: 'unknown', source: 'job-history' }], operations: [
    { id: 'a', state: 'completed', finishedAt: 0, document: 'Part' }, { id: 'b', state: 'running' }] };
  const state = { filters: { scope: 'history', since: '1970-01-01T00:00:00Z' }, search: '', sort: 'time', order: [] };
  assert.deepEqual(model.selectConsoleRows('tasks', model.consoleSource('tasks', snapshot), state).map(row => row.id), ['a']);
  assert.equal(model.selectConsoleRows('tasks', null, state), null);
  const agents = model.consoleSource('agents', snapshot);
  assert.equal(agents[0].presence, 'unknown');
  assert.equal(agents[0].clientKind, 'CLI');
  assert.deepEqual(model.selectConsoleRows('agents', agents, { ...state, filters: { scope: 'current' } }), []);
});

test('source hash comparison is explicit unknown/match/mismatch; response authority is scoped', () => {
  assert.equal(model.sourceHashMismatch(null, 'a'.repeat(64)), null);
  assert.equal(model.sourceHashMismatch('A'.repeat(64), 'a'.repeat(64)), false);
  assert.equal(model.sourceHashMismatch('a'.repeat(64), 'b'.repeat(64)), true);
  const snapshot = { mode: 'broker', operations: [{ id: 'task' }] };
  assert.equal(model.responseTaskError({ id: 'task' }, snapshot), null);
  assert.equal(model.responseTaskError({ id: 'task' }, snapshot, null), 'TASK_NO_LONGER_RETAINED');
  assert.equal(model.responseTaskError({ id: '../x' }, snapshot), 'TASK_NOT_IN_SNAPSHOT');
  assert.equal(model.responseTaskError({ id: 'task' }, { ...snapshot, mode: 'direct' }), 'DIRECT_RESPONSE_NOT_RETAINED');
  const text = '{"nil":null,"no":false,"zero":0}';
  assert.equal(model.jsonLines(text).flat().map(span => span.text).join(''), text);
});

test('control intents accept only fresh authoritative observations and preserve generation zero', () => {
  const value = { instanceId: 'broker', generation: 0 };
  for (const status of ['missing', 'error', 'stale']) assert.throws(() => model.controlIntent(true, 'req', { status, value, observedAt: 0 }));
  assert.deepEqual(model.controlIntent(true, 'req', { status: 'available', value, observedAt: 0 }), {
    method: 'pause', control: { requestId: 'req', instanceId: 'broker', expectedGeneration: 0 } });
  assert.throws(() => model.controlIntent(false, 'req', { status: 'available', value: { ...value, generation: -1 }, observedAt: 0 }));
});
