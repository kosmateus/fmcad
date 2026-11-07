'use strict';
function activeFilters(state) {
  return [...Object.entries(state.filters || {}).filter(([key, value]) => value && !(key === 'scope' && value === 'all') &&
    (!Array.isArray(value) || value.length)).map(([key, value]) => ({ key, value })),
    ...(state.search ? [{ key: 'search', value: state.search }] : [])];
}
function filterSummary(state, ui) {
  const labels = { scope: ui.L('scope'), search: ui.L('search'), state: ui.L('state'), agent: ui.L('client'),
    document: ui.L('documentOrScript'), level: ui.L('level'), component: ui.L('source'), presence: ui.L('presence'), work: ui.L('work'),
    clientKind: ui.language === 'pl' ? 'Rodzaj klienta' : 'Client kind', task: 'Task ID', request: 'Request ID',
    since: ui.language === 'pl' ? 'Od' : 'Since', until: ui.language === 'pl' ? 'Do' : 'Until' };
  return activeFilters(state).map(({ key, value }) => key === 'ids' ? `${ui.L('records')}: ${value.length}`
    : `${labels[key] || key}: ${key === 'scope' ? ui.L(value) : value}`).join(' · ');
}
module.exports = { activeFilters, filterSummary };
