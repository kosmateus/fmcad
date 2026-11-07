'use strict';
const { createUI } = require('./console-ui');
const chrome = require('./console-chrome');
const views = Object.fromEntries(['overview', 'agents', 'tasks', 'logs', 'system'].map(name => [name, require('./console-tabs/' + name)]));
function render(options) {
  const { model, buffer, prefs, language, modal, message } = options;
  model.language = language;
  const ui = createUI({ buffer, prefs, language });
  const rect = chrome.header(ui, model);
  if (rect) {
    const state = model.state;
    const originalSnapshot = model.viewSnapshot ? model.viewSnapshot() : model.snapshot;
    let snapshot = originalSnapshot.reasonCode === 'BROKER_STOPPED' ? { ...originalSnapshot, reason: ui.L('brokerOffline') } : originalSnapshot;
    if (state.frozenSnapshot) snapshot = { ...snapshot, capabilities: model.snapshot.capabilities,
      broker: model.snapshot.available === false ? { ...model.snapshot.broker, state: 'UNKNOWN', online: null, activeOperations: null, queued: null, unresolved: undefined } : model.snapshot.broker };
    const rows = model.name === 'system' ? null : model.rows();
    const selected = rows?.find(row => row.id === state.selectedId);
    state.detailViewport ||= { offset: 0 };
    const profile = buffer.width >= 140 && buffer.height >= 40 ? 'wide' : buffer.width >= 110 && buffer.height >= 30 ? 'standard' : 'compact';
    views[model.name].render({ ui, model, snapshot, state, rows, sourceRows: model.source(model.name, originalSnapshot), selected, rect, profile,
      extraWide: buffer.width >= 180 && buffer.height >= 45, detailState: state.detailViewport,
      language, now: ui.now, focus: model.focus, events: snapshot.logs });
    chrome.footer(ui, model, message);
    if (modal) chrome.modal(ui, modal);
  }
  buffer.draw({ delta: true });
  return { hits: ui.hits, panels: ui.panels, rect };
}
render.supportsTrueColor = true;
module.exports = { render };
