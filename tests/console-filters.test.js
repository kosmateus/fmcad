'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeFilters } = require('../src/console-filters');
const { ConsoleModel } = require('../src/console-controller');
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
