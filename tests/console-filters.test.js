'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('terminal-kit');
const { activeFilters } = require('../src/console-filters');
const { ConsoleModel } = require('../src/console-controller');
const { render } = require('../src/console-renderer');
const { pointerAction } = require('../src/console-pointer');
test('active filters include search and navigation constraints but exclude default and empty fields', () => {
  assert.deepEqual(activeFilters({ filters: { scope: 'all', state: '', ids: [], since: null }, search: '' }), []);
  assert.deepEqual(activeFilters({ filters: { scope: 'history', ids: ['one'], agent: 'client' }, search: 'name' }).map(item => item.key), ['scope', 'ids', 'agent', 'search']);
});
test('reset clears all current-view filters/search without changing other views, sorting or freeze', () => {
  const model = new ConsoleModel(); model.tab = 2;
  model.update({ operations: [{ id: 'one', state: 'succeeded', label: 'fixture' }, { id: 'two', state: 'failed', label: 'other' }] });
  model.state.filters = { scope: 'history', ids: ['one'], agent: 'missing' }; model.state.search = 'fixture';
  model.state.sort = 'time'; model.states.logs.search = 'keep';
  assert.equal(model.rows().length, 0);
  model.freeze(); const frozen = model.state.frozenSnapshot;
  model.resetFilters();
  assert.equal(model.rows().length, 2); assert.deepEqual(model.state.filters, { scope: 'all' });
  assert.equal(model.state.search, ''); assert.equal(model.state.sort, 'time');
  assert.equal(model.state.frozenSnapshot, frozen); assert.equal(model.states.logs.search, 'keep');
});
test('all views expose a visible clickable reset while filtered at supported sizes', () => {
  for (const [width, height] of [[80, 24], [110, 30], [222, 58]]) for (const language of ['en', 'pl']) for (let tab = 0; tab < 5; tab++) {
    const model = new ConsoleModel(); model.tab = tab;
    model.update({ mode: 'broker', project: '/fixture', available: true, broker: { state: 'STOPPED' },
      operations: [{ id: 'job', state: 'succeeded', label: 'fixture' }], agents: [], logs: [], fusion: {}, capabilities: {}, retention: {} });
    model.state.filters = { scope: 'history', ids: ['job'] }; model.state.search = 'fixture';
    const buffer = new kit.ScreenBuffer({ width, height }); buffer.draw = () => {};
    const view = render({ model, buffer, prefs: {}, language });
    const reset = view.hits.find(hit => hit.type === 'key' && hit.key === 'x');
    assert.ok(reset, `tab ${tab}, ${width}x${height}`);
    assert.ok(reset.x >= 0 && reset.x + reset.width <= width);
    const footer = Array.from({ length: width }, (_, x) => buffer.get({ x, y: height - 2 }).char).join('');
    assert.ok(footer.includes(language === 'pl' ? 'Filtry (3)' : 'Filters (3)'), footer);
    assert.equal(pointerAction('MOUSE_LEFT_BUTTON_PRESSED', { x: reset.x + 1, y: reset.y + 1 }, view, {}).key, 'x');
    model.resetFilters();
    const cleared = render({ model, buffer, prefs: {}, language });
    assert.equal(cleared.hits.some(hit => hit.type === 'key' && hit.key === 'x'), false);
  }
});
