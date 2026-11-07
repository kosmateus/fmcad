'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('terminal-kit');
const { createUI } = require('../src/console-ui');
const { describe, correlate, refresh } = require('../src/console-details');
const { ConsoleModel } = require('../src/console-controller');
const chrome = require('../src/console-chrome');
const { pointerAction } = require('../src/console-pointer');
const makeUI = (width = 100, height = 30, language = 'en') => createUI({ buffer: new kit.ScreenBuffer({ width, height }), prefs: {}, language });
test('details distinguish absent, false and zero and scope direct results to transport', () => {
  const ui = makeUI();
  assert.doesNotThrow(() => describe(null, ui));
  const detail = describe({ id: 'op', state: 'completed', exitCode: 0, mayHaveMutated: false }, ui, { mode: 'direct' });
  assert.equal(detail.fields.find(field => field.label === 'Process exit code').value, 0);
  assert.equal(detail.fields.find(field => field.label === 'May have mutated').value, 'No');
  assert.match(detail.fields.find(field => field.label === 'Result scope').value, /Transport only/);
  assert.ok(!detail.fields.some(field => field.group?.startsWith('Related operations')));
});
test('column fields preserve long labels, paths, false and zero without truncation', () => {
  const ui = makeUI();
  const label = 'LongCorrelationIdentifier'.repeat(3), value = '/directory/'.repeat(15);
  const lines = ui.kvLines([{ label, value }, { label: 'False', value: false }, { label: 'Zero', value: 0 },
    { label: 'Missing', value: null }, { label: 'Message', value, block: true }], 60, { columns: true, labelWidth: 18 });
  const columns = lines.filter(line => line.spans);
  assert.equal(columns.map(line => line.spans[0].text).join('').startsWith(label), true);
  assert.equal(columns.map(line => line.spans[1].text).join('').startsWith(value), true);
  assert.ok(columns.some(line => line.spans[1].text === 'false'));
  assert.ok(columns.some(line => line.spans[1].text === '0'));
  assert.ok(columns.some(line => line.spans[1].text === ui.L('unknown')));
  assert.equal(lines.filter(line => line.text && line.text !== 'Message').map(line => line.text).join(''), value);
});
test('correlation excludes absent IDs and modal drilldowns select only matching retained IDs', () => {
  const model = new ConsoleModel();
  model.update({ agents: [{ id: 'a' }, { id: 'b' }], operations: [{ id: 'op', clientId: 'a', requestId: 'req' }, { id: 'other' }],
    logs: [{ id: 'event', requestId: 'req' }, { id: 'unrelated' }] });
  assert.deepEqual(correlate({ id: 'b', operations: [] }, model.snapshot).events, []);
  assert.equal(model.related('tasks', { id: 'unrelated', level: 'INFO' }, model.snapshot), false);
  assert.equal(model.related('logs', model.snapshot.operations[0], model.snapshot), true);
  assert.deepEqual(model.rows().map(row => row.id), ['event']);
  assert.equal(model.related('agents', model.snapshot.operations[0], model.snapshot), true);
  assert.deepEqual(model.rows().map(row => row.id), ['a']);
});
test('refresh pins the inspected ID through filtering, retention loss and frozen snapshots', () => {
  const model = new ConsoleModel(); model.tab = 2;
  const initial = { id: 'op', state: 'running', description: 'original' };
  model.update({ operations: [initial], logs: [] });
  const modal = { id: 'op', rowType: 'tasks', row: structuredClone(initial) };
  model.state.filters = { scope: 'open' };
  model.update({ operations: [{ ...initial, state: 'completed' }], logs: [] }); refresh(modal, model);
  assert.equal(modal.row.state, 'completed'); assert.equal(modal.outsideFilter, true);
  model.update({ operations: [], logs: [] }); refresh(modal, model);
  assert.equal(modal.missing, true); assert.equal(modal.row.description, 'original');
  model.update({ operations: null, available: false }); refresh(modal, model);
  assert.equal(modal.missing, false); assert.equal(modal.contextSnapshot.available, false);
  modal.frozen = true; const before = structuredClone(modal);
  model.update({ operations: [{ id: 'op', description: 'new' }] }); refresh(modal, model);
  assert.deepEqual(modal, before);
});
test('rich modal scroll and action hit regions work at supported sizes in both languages', () => {
  for (const [width, height] of [[80, 24], [110, 30], [200, 50]]) for (const language of ['en', 'pl']) {
    const ui = makeUI(width, height, language);
    const row = { id: 'op', state: 'running', clientId: 'a', description: 'long purpose '.repeat(200), sourcePath: '/tmp/source.py' };
    const modal = { kind: 'details', row, contextSnapshot: { operations: [row], agents: [{ id: 'a' }], logs: [{ id: 'e', taskId: 'op' }] } };
    chrome.modal(ui, modal);
    const viewport = ui.hits.find(hit => hit.type === 'viewport');
    assert.ok(viewport.total > viewport.visible);
    pointerAction('MOUSE_WHEEL_DOWN', { x: viewport.x + 1, y: viewport.y + 1 }, ui, {}, { modal: true });
    assert.ok(modal.viewport.offset > 0);
    assert.ok(ui.hits.some(hit => hit.layer === 'modal' && hit.key === 'g'));
    assert.ok(ui.hits.every(hit => hit.x >= 0 && hit.y >= 0 && hit.x + hit.width <= width && hit.y + hit.height <= height));
  }
});
