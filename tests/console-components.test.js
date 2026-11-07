'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('terminal-kit');
const { createUI } = require('../src/console-ui');
const { pointerAction, hitTest } = require('../src/console-pointer');
const { ConsoleModel } = require('../src/console-controller');
test('shared tables paint complete row backgrounds and allocate columns within their viewport', () => {
  for (const Class of [kit.ScreenBuffer, kit.ScreenBufferHD]) {
    const buffer = new Class({ width: 100, height: 30 });
    const ui = createUI({ buffer, prefs: {}, language: 'pl' });
    const state = { selectedId: 'a', filters: {}, offset: 0 };
    const table = ui.table('tasks', { x: 1, y: 1, width: 70, height: 20 }, [{ id: 'a', state: 'running', label: '^rCel' }], [
      { key: 'id', label: 'ID', width: 8 }, { key: 'state', label: 'Stan', width: 14 }, { key: 'label', label: 'Cel', flex: true, min: 20 },
    ], { state, title: 'Zadania', kind: 'tasks' });
    assert.ok(table.columns.every(col => col.x + col.width <= table.width));
    const row = ui.hits.find(hit => hit.type === 'row');
    assert.deepEqual(buffer.get({ x: row.x, y: row.y }).attr.bgColor, buffer.get({ x: row.x + row.width - 2, y: row.y }).attr.bgColor);
    assert.ok(ui.hits.some(hit => hit.type === 'key' && hit.key === '/'));
  }
});
test('mouse wheel, thumb drag, stable ID selection, double click and modal hit isolation', () => {
  const buffer = new kit.ScreenBuffer({ width: 100, height: 30 });
  const ui = createUI({ buffer, prefs: {}, language: 'en' });
  const state = { selectedId: '99', follow: true, filters: {} };
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'row ' + i }));
  ui.table('logs', { x: 1, y: 1, width: 70, height: 20 }, rows, [{ key: 'text', label: 'Message', flex: true, min: 20 }], { state, kind: 'logs' });
  const viewport = ui.hits.find(hit => hit.type === 'viewport');
  const pointer = {};
  pointerAction('MOUSE_WHEEL_UP', { x: viewport.x + 1, y: viewport.y + 1 }, ui, pointer);
  assert.equal(state.follow, false);
  const bar = ui.hits.find(hit => hit.type === 'scrollbar');
  pointerAction('MOUSE_LEFT_BUTTON_PRESSED', { x: bar.x + 1, y: bar.y + bar.thumbStart + 1 }, ui, pointer);
  pointerAction('MOUSE_MOTION', { x: bar.x + 1, y: bar.y + 1 }, ui, pointer);
  assert.equal(state.offset, 0);
  pointerAction('MOUSE_LEFT_BUTTON_RELEASED', { x: 1, y: 1 }, ui, pointer);
  const row = ui.hits.find(hit => hit.type === 'row');
  assert.equal(pointerAction('MOUSE_LEFT_BUTTON_PRESSED', { x: row.x + 1, y: row.y + 1 }, ui, pointer, { now: 100 }).type, 'select');
  assert.equal(pointerAction('MOUSE_LEFT_BUTTON_PRESSED', { x: row.x + 1, y: row.y + 1 }, ui, pointer, { now: 200 }).type, 'open-details');
  assert.equal(hitTest(ui, row.x, row.y, true), undefined);
});
test('agent correlations never join missing IDs and task log drilldown does not require an agent field', () => {
  const model = new ConsoleModel(); model.update({ agents: [{ id: 'A' }, { id: 'B' }], operations: [{ id: 'op', clientId: 'A', state: 'running' }],
    logs: [{ id: 'log', taskId: 'op', message: 'event' }] });
  assert.equal(model.source('agents')[1].operations.length, 0);
  model.related('logs', model.snapshot.operations[0]); assert.equal(model.rows().length, 1);
});
