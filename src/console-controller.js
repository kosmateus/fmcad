'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sanitize } = require('./console-logs');
const { consoleSource, selectConsoleRows, openOperation: open } = require('./dist/core');
const views = ['overview', 'agents', 'tasks', 'logs', 'system'];
function viewState(name) { return { search: '', filters: { scope: 'all' },
  sort: 'default', selectedId: null, offset: 0, order: [], frozen: null, follow: name === 'logs', newCount: 0 }; }
class ConsoleModel {
  constructor() { this.tab = 0; this.section = 0; this.states = Object.fromEntries(views.map(name => [name, viewState(name)])); this.states.overview.focus = 4; this.snapshot = {}; }
  get name() { return views[this.tab]; }
  get state() { return this.states[this.name]; }
  get focus() { return this.state.focus ?? 0; }
  set focus(value) { this.state.focus = value; }
  viewSnapshot(name = this.name) { return this.states[name].frozenSnapshot || this.snapshot; }
  update(snapshot) {
    this.snapshot = snapshot;
    for (const name of views) {
      const state = this.states[name];
      const current = this.source(name, snapshot) || [];
      const before = new Set(state.lastIds || []);
      const added = current.filter(row => !before.has(row.id)).length;
      if (name === 'logs' && snapshot.logsResynced) state.newCount = 0;
      else if (state.lastIds && (state.frozenSnapshot || !state.follow)) state.newCount += added;
      state.lastIds = current.map(row => row.id);
    }
  }
  source(name = this.name, snapshot = this.snapshot) {
    return consoleSource(name, snapshot, this.states.logs.filters);
  }
  rows(name = this.name) {
    const state = this.states[name];
    const source = this.source(name, state.frozenSnapshot || this.snapshot);
    if (!source) return null;
    const rows = selectConsoleRows(name, source, state,
      row => require('./console-log-presentation').logMessage(row, this.language || 'en'));
    if (name !== 'logs') {
      state.order = rows.map(row => row.id);
      if (!state.navigating) state.selectedId = rows[0]?.id || null;
    }
    if (name === 'logs' && state.follow && !state.frozen) state.selectedId = rows.at(-1)?.id || null;
    if (!rows.some(row => row.id === state.selectedId)) state.selectedId = rows[Math.min(state.lastIndex || 0, rows.length - 1)]?.id || null;
    state.lastIndex = Math.max(0, rows.findIndex(row => row.id === state.selectedId));
    return rows;
  }
  refreshOrder() { this.state.order = []; this.state.newCount = 0; this.state.navigating = false; }
  resetFilters() { this.state.filters = { scope: 'all' }; this.state.search = ''; this.refreshOrder(); }
  navigate(delta, page = 10) {
    const rows = this.rows() || []; const state = this.state;
    state.navigating = true;
    let index = Math.max(0, rows.findIndex(row => row.id === state.selectedId));
    if (this.name === 'logs') state.follow = false;
    index = delta === 'home' ? 0 : delta === 'end' ? rows.length - 1 : index + delta * page;
    index = Math.max(0, Math.min(rows.length - 1, index)); state.selectedId = rows[index]?.id || null;
    if (delta === 'end' && this.name === 'logs') { state.follow = true; state.newCount = 0; }
  }
  freeze() {
    const state = this.state, source = this.source(); if (!source && !['overview', 'system'].includes(this.name)) return;
    state.navigating = true;
    if (state.frozenSnapshot) { state.frozen = null; state.frozenSnapshot = null; }
    else { state.frozen = source === null || source === undefined ? null : structuredClone(source); state.frozenSnapshot = structuredClone(this.snapshot); }
    state.newCount = 0;
  }
  selected() { return (this.rows() || []).find(row => row.id === this.state.selectedId); }
  related(kind, row, snapshot) {
    if (snapshot || kind === 'agents') {
      const related = require('./console-details').correlate(row, snapshot || this.viewSnapshot());
      const matches = related[kind === 'tasks' ? 'operations' : kind === 'logs' ? 'events' : 'agents'];
      if (!matches?.length) return false;
      this.tab = views.indexOf(kind);
      const state = this.state;
      state.frozen = null; state.frozenSnapshot = null;
      state.filters = { scope: 'all', ids: matches.map(item => item.id) };
      state.search = ''; state.order = []; state.navigating = true;
      state.selectedId = matches[0].id; state.follow = false;
      return true;
    }
    const agentRow = Array.isArray(row.operations);
    const correlation = kind === 'logs' && !agentRow && row.state ? { task: row.id, ...(row.requestId ? { request: row.requestId } : {}) }
      : kind === 'tasks' && row.level ? row.taskId ? { task: row.taskId } : row.requestId ? { request: row.requestId } : row.agentId ? { agent: row.agentId } : null : null;
    const agent = row.clientId || row.sessionId || (row.operations ? row.id : null);
    if (!correlation && !agent) return false;
    this.tab = kind === 'tasks' ? 2 : 3; const state = this.state;
    state.filters = { scope: 'all', ...(correlation || { agent }) };
    state.order = []; state.search = '';
    state.navigating = false;
    return true;
  }
}
function exportRows(file, rows, { format = 'jsonl', overwrite = false, retention = {} } = {}) {
  const snapshot = structuredClone(rows);
  const data = format === 'text' ? '# Retention: ' + JSON.stringify(retention) + '\n' + snapshot.map(row => sanitize(JSON.stringify(row))).join('\n') + '\n'
    : [JSON.stringify({ type: 'retention', ...retention }), ...snapshot.map(row => JSON.stringify(row))].join('\n') + '\n';
  const fd = fs.openSync(path.resolve(file), overwrite ? 'w' : 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return snapshot.length;
}
const { BrokerObservation } = require('./dist/node-adapters/control-center/broker-observation');
class BrokerControl extends BrokerObservation {
  constructor(factory = () => new (require('./queue-client').QueueClient)('console:' + process.pid + ':' + randomUUID())) { super(factory); }
}

module.exports = { ConsoleModel, BrokerControl, exportRows, views, open };
