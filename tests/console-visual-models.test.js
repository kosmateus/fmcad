'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const kit = require('terminal-kit');
const { ConsoleModel } = require('../src/console-controller');
const { render } = require('../src/console-view');
const { readLogs } = require('../src/console-logs');
const tasks = require('../src/console-tabs/tasks');
const logs = require('../src/console-tabs/logs');
test('unrecognized outcomes stay unresolved; direct completion stays a transport result', () => {
  assert.equal(tasks.group({ state: 'future-state' }), 'unresolved');
  assert.deepEqual(tasks.counts([{ state: 'running' }, { state: 'queued' }, { state: 'unknown' }, { state: 'completed', outcomeScope: 'transport' }]),
    { active: 1, waiting: 1, unresolved: 1, history: 1 });
  assert.equal(tasks.recordedDuration({ startedAt: 10, finishedAt: 5 }), null);
  assert.equal(logs.windowStats([{ level: 'INFO', timestamp: 'not-a-time' }]).invalid, 1);
});
test('navigation holds the viewport order; passive mode promotes new work and focus is per tab', () => {
  const model = new ConsoleModel(); assert.equal(model.focus, 4);
  model.tab = 2; assert.equal(model.focus, 0); model.focus = 2;
  model.update({ operations: [{ id: 'old', state: 'succeeded', finishedAt: 10 }] }); model.rows();
  model.update({ operations: [{ id: 'old', state: 'succeeded', finishedAt: 10 }, { id: 'new', state: 'running', startedAt: 20 }] });
  assert.equal(model.rows()[0].id, 'new');
  model.navigate(1, 1); const selected = model.state.selectedId;
  model.update({ operations: [...model.snapshot.operations, { id: 'newer', state: 'queued', submittedAt: 30 }] });
  assert.equal(model.rows()[0].id, 'new'); assert.equal(model.state.selectedId, selected);
  model.tab = 0; assert.equal(model.focus, 4); model.tab = 2; assert.equal(model.focus, 2);
});
test('retained log archives share a bounded budget and truncation does not reuse record identity', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'console-log-window-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const folder = path.join(project, '.cad/logs'); fs.mkdirSync(folder, { recursive: true });
  const current = path.join(folder, 'fmcad.log'), archive = path.join(folder, 'fmcad-2026-10-20_16.log');
  fs.writeFileSync(archive, '2026-10-20T16:00:00Z WARN job_failed job=earlier code=FAILED\n');
  fs.writeFileSync(current, '2026-10-20T17:00:00Z INFO heartbeat broker_process=absent\n');
  const tracker = new Map(), first = readLogs(project, {}, 2000, 1024, tracker);
  assert.equal(first.logs.length, 2); assert.ok(first.bytesRead <= 1024);
  assert.deepEqual(readLogs(project, {}, 2000, 1024, tracker).logs.map(row => row.id), first.logs.map(row => row.id));
  const previous = first.logs.at(-1).id;
  fs.writeFileSync(current, 'different\n');
  const reset = readLogs(project, {}, 2000, 1024, tracker);
  assert.equal(reset.resynced, true); assert.notEqual(reset.logs.at(-1).id, previous);
  const tiny = readLogs(project, {}, 1, 64, tracker); assert.ok(tiny.logs.length <= 1); assert.ok(tiny.bytesRead <= 64);
});
test('view panels and mouse regions fit realistic and minimum terminal sizes', () => {
  for (const [width, height] of [[80, 24], [110, 30], [140, 40], [200, 52], [270, 75]]) {
    for (let tab = 0; tab < 5; tab++) {
      const model = new ConsoleModel(); model.tab = tab;
      model.update({ mode: 'broker', project: '/fixture/Project', available: true, broker: { state: 'STOPPED', online: false },
        capabilities: { monitor: true, brokerControl: false }, operations: [{ id: 'fixture-job', state: 'failed', label: 'run fixture.py', order: 1 }],
        agents: [{ id: 'fixture-client', presence: 'unknown', source: 'job-history' }],
        logs: [{ id: 'fixture-log', timestamp: '2026-10-20T16:00:00Z', level: 'WARN', component: 'fixture', message: 'Fixture event' }], fusion: {}, retention: {} });
      const buffer = new kit.ScreenBufferHD({ width, height }); buffer.draw = () => {};
      const view = render({ model, buffer, prefs: { color: 'auto', frames: 'unicode' }, language: 'pl', modal: null });
      for (const panel of view.panels) assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= width && panel.y + panel.height <= height - 2,
        `${width}x${height} tab ${tab}: ${panel.id}`);
      for (const hit of view.hits) assert.ok(hit.x >= 0 && hit.y >= 0 && hit.x + hit.width <= width && hit.y + hit.height <= height,
        `${width}x${height} tab ${tab}: ${hit.type}`);
    }
  }
});
