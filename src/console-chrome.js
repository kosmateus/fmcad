'use strict';
const path = require('node:path');
const kit = require('terminal-kit');
function banner(snapshot, ui) {
  if (snapshot.mode === 'direct') return { text: ui.L('directPause'), tone: 'muted' };
  if (snapshot.broker?.state === 'STOPPED') return { text: ui.L('brokerOffline'), tone: 'warning' };
  const key = { RUNNING: 'running', PAUSED: 'paused', PAUSING: 'pausing', RESUMING: 'resuming', RECOVERY_BLOCKED: 'blocked' }[snapshot.broker?.state];
  return { text: ui.L(snapshot.available && key ? key : 'unconfirmed'), tone: !key ? 'warning' : ui.tone(snapshot.broker?.state) };
}
function header(ui, model) {
  const { width: w, height: h } = ui.buffer, s = model.snapshot;
  const name = s.project ? path.basename(s.project) : ui.L('noContext');
  ui.put(1, 0, 'fmcad console', 14, 'accent', 'background', { bold: true });
  ui.put(16, 0, ui.glyph.v, 1, 'border', 'background');
  const right = `v${require('../package.json').version}   ${new Date(ui.now).toLocaleTimeString(ui.language, { hour12: false })}`;
  const rightWidth = w >= 110 ? kit.stringWidth(right) : 0;
  ui.put(18, 0, ui.middle(name, Math.max(1, w - 21 - rightWidth)), Math.max(1, w - 21 - rightWidth), 'accent', 'background', { bold: true });
  if (rightWidth) ui.put(w - rightWidth - 2, 0, right, rightWidth, 'muted', 'background');
  const phase = s.available === false ? 'UNKNOWN' : s.broker?.state;
  const broker = s.mode === 'direct' ? ui.L('unused') : phase === 'STOPPED' ? ui.L('stopped') : ui.statusText(phase || 'UNKNOWN');
  const mode = s.mode === 'direct' ? ui.L('direct') : s.mode === 'broker' ? 'broker' : ui.L('unknown');
  let x = 1;
  const parts = [[ui.L('mode') + ': ', mode, 'accent'], ['  ' + ui.L('broker') + ': ', broker, s.mode === 'direct' ? 'muted' : ui.tone(phase || 'unknown')],
    ['  Fusion: ', s.fusion?.connectivity === 'connected' ? 'connected' : ui.L('unknown'), s.fusion?.connectivity === 'connected' ? 'success' : 'muted']];
  for (const [prefix, value, tone] of parts) {
    if (x + kit.stringWidth(prefix + value) > w - 17) break;
    ui.put(x, 1, prefix, kit.stringWidth(prefix), 'muted', 'background'); x += kit.stringWidth(prefix);
    ui.put(x, 1, value, kit.stringWidth(value), tone, 'background'); x += kit.stringWidth(value);
  }
  if (w >= 160) ui.put(x + 3, 1, `${ui.L('updated')}: ${ui.age(s.readAt)}`, w - x - 21, 'muted', 'background');
  ui.badge(w - 15, 1, '[b] ' + ui.L('broker'), { width: 14, action: { type: 'key', key: 'b' } });
  if (w < 80 || h < 24) {
    ui.put(1, 3, banner(s, ui).text, w - 2, 'warning', 'background');
    ui.put(1, 5, ui.L('resize'), w - 2, 'accent', 'background', { bold: true });
    ui.put(1, h - 1, '[b] Broker    [?] ' + ui.L('help') + '    [q] ' + ui.L('quit'), w - 2, 'muted', 'background');
    return null;
  }
  ui.fill(1, 2, w - 2, 1, 'surface');
  x = 1;
  ['overview', 'agents', 'tasks', 'logs', 'system'].forEach((name, index) => {
    const title = `[${index + 1}] ${ui.L(name)}`;
    const width = Math.max(12, kit.stringWidth(title) + 4);
    ui.badge(x, 2, title, { width, active: model.tab === index, action: { type: 'tab', tab: index } });
    x += width + 1;
  });
  const notice = banner(s, ui);
  const normal = s.mode === 'direct' || s.available && s.broker?.state === 'RUNNING';
  ui.put(1, 3, ui.glyph.h.repeat(w - 2), w - 2, 'border', 'background');
  if (!normal) ui.put(2, 3, ' ' + notice.text + ' ', w - 4, notice.tone, 'background');
  else if (w >= 120 && s.project) ui.put(2, 3, ' ' + ui.middle(s.project, w - 8) + ' ', w - 4, 'muted', 'background');
  return { x: 1, y: 4, width: w - 2, height: h - 6 };
}
function footer(ui, model, message) {
  const { width: w, height: h } = ui.buffer, state = model.state, rows = model.name === 'system' ? null : model.rows();
  ui.fill(0, h - 2, w, 1, 'surface'); ui.fill(0, h - 1, w, 1, 'raised');
  const live = state.frozenSnapshot ? ui.L('frozen') : ui.L('live');
  let x = 1 + ui.badge(1, h - 2, live, { fg: state.frozenSnapshot ? 'warning' : 'success', width: kit.stringWidth(live) + 2, action: { type: 'key', key: 'SPACE' } }) + 1;
  if (model.name === 'logs') x += ui.badge(x, h - 2, state.follow ? ui.L('follow') : 'PAUSED SCROLL', { fg: state.follow ? 'accent' : 'muted', action: { type: 'key', key: 'l' } }) + 1;
  const counter = model.name === 'system' ? `${ui.L('updated')}: ${ui.age(model.snapshot.readAt)}`
    : rows ? `${ui.number(rows.length)} ${ui.L('records')}${state.newCount ? '  +' + state.newCount : ''}` : ui.L('noData');
  const counterWidth = kit.stringWidth(counter);
  const { activeFilters, filterSummary } = require('./console-filters'), active = activeFilters(state);
  const reset = `[x] ${ui.L('resetFilters')}`, resetWidth = active.length ? kit.stringWidth(reset) + 2 : 0;
  const resetX = w - counterWidth - resetWidth - 4;
  const filter = message || (active.length ? `${ui.L('filters')} (${active.length}): ${filterSummary(state, ui)}` : `${ui.L('scope')}: ${ui.L(state.filters.scope || 'all')}`);
  ui.put(x, h - 2, filter, Math.max(1, (active.length ? resetX - 1 : w - counterWidth - 4) - x), message ? 'accent' : active.length ? 'warning' : 'muted');
  if (active.length) ui.badge(resetX, h - 2, reset, { width: resetWidth, fg: 'warning', action: { type: 'key', key: 'x' } });
  ui.put(w - counterWidth - 2, h - 2, counter, counterWidth, state.newCount ? 'accent' : 'muted');
  const focusedRows = ui.hits.find(hit => hit.type === 'viewport' && hit.rows && hit.focus === model.focus);
  const sourceRow = focusedRows?.rows.find(row => row.id === focusedRows.state.selectedId) || (model.name === 'tasks' ? rows?.find(row => row.id === state.selectedId) : null);
  const actions = model.name === 'system' ? [['r', ui.L('refresh')], ['c', ui.L('changeProject')], ['b', ui.L('broker')], [',', ui.L('settings')]]
    : [['↑↓', ui.L('choose')], ['Enter', ui.L('details')], ...(model.name === 'tasks' ? [['y', ui.language === 'pl' ? 'Odpowiedź' : 'Response']] : []), ['/', ui.L('search')], ['f', ui.L('filters')],
      ...(model.name === 'logs' ? [['l', ui.L('follow')]] : [['o', ui.L('sort')]]),
      ...(sourceRow?.sourcePath ? [['p', ui.L('code')]] : []), ['e', ui.L('export')], ['Space', ui.L('freeze')]];
  const right = `[?] ${ui.L('help')}   [q] ${ui.L('quit')}`;
  const limit = w - kit.stringWidth(right) - 3;
  x = 1;
  for (const [key, text] of actions) {
    const item = `[${key}] ${text}`, width = kit.stringWidth(item);
    if (x + width > limit) break;
    ui.put(x, h - 1, '[' + key + ']', key.length + 2, 'accent', 'raised');
    ui.put(x + key.length + 3, h - 1, text, width - key.length - 3, 'muted', 'raised');
    if (key !== '↑↓') ui.hit({ x, y: h - 1, width, height: 1 }, { type: 'key', key: key === 'Space' ? 'SPACE' : key === 'Enter' ? 'ENTER' : key });
    x += width + 3;
  }
  const rx = w - kit.stringWidth(right) - 1;
  ui.put(rx, h - 1, right, kit.stringWidth(right), 'accent', 'raised');
  ui.hit({ x: rx, y: h - 1, width: kit.stringWidth(`[?] ${ui.L('help')}`), height: 1 }, { type: 'key', key: '?' });
  ui.hit({ x: w - kit.stringWidth(`[q] ${ui.L('quit')}`) - 1, y: h - 1, width: kit.stringWidth(`[q] ${ui.L('quit')}`), height: 1 }, { type: 'key', key: 'q' });
}
function detailFields(row, ui) {
  if (!row) return [{ label: ui.L('details'), value: ui.L('noSelection'), full: true }];
  if (row.level) return [{ label: ui.L('time'), value: ui.date(row.timestamp) }, { label: ui.L('level'), value: row.level, tone: ui.tone(row.level) },
    { label: ui.L('source'), value: row.component }, { label: ui.L('message'), value: row.message, full: true },
    ...['taskId', 'requestId', 'agentId'].filter(key => row[key]).map(key => ({ label: key, value: row[key] }))];
  if (Array.isArray(row.operations)) return [{ label: 'ID', value: row.id }, { label: ui.L('presence'), value: ui.statusText(row.presence), tone: ui.tone(row.presence) },
    { label: ui.L('work'), value: row.work }, { label: ui.L('presenceSource'), value: row.source }, { label: ui.L('heartbeat'), value: ui.date(row.lastSeen) },
    { group: ui.L('currentWork') }, ...row.operations.slice(0, 20).map(op => ({ label: ui.statusText(op.state), value: op.description || op.label || op.id, full: true }))];
  return [{ label: ui.L('state'), value: ui.statusText(row.state), tone: ui.tone(row.state) },
    { label: ui.L('purpose'), value: row.description || ui.L('noDescription'), full: true }, { label: ui.L('operation'), value: row.label || row.kind },
    { label: ui.L('document'), value: row.document }, { label: ui.L('client'), value: row.clientId || row.sessionId },
    { label: 'ID', value: row.id }, ...['requestId', 'sessionId', 'code'].filter(key => row[key]).map(key => ({ label: key, value: row[key] })),
    ...[['submittedAt', 'received'], ['startedAt', 'started'], ['finishedAt', 'finished']].filter(([key]) => row[key] !== undefined).map(([key, name]) => ({ label: ui.L(name), value: ui.date(row[key]) })),
    ...(row.outcomeScope === 'transport' ? [{ label: ui.L('result'), value: ui.L('transportResult'), tone: 'warning' }, { label: 'HTTP', value: row.httpStatus }] : [])];
}
function modal(ui, value) {
  if (value.kind === 'source') return require('./console-source-view').render(ui, value);
  if (value.kind === 'response') return require('./console-response-view').render(ui, value);
  if (value.kind === 'details') return require('./console-detail-view').render(ui, value);
  const { width: w, height: h } = ui.buffer;
  const mw = Math.min(76, w - 4), mx = Math.floor((w - mw) / 2), mh = Math.min(h - 4, value.fields ? value.fields.length + 7 : 20), my = Math.floor((h - mh) / 2);
  ui.hit({ x: 0, y: 0, width: w, height: h }, { type: 'noop', layer: 'modal' });
  ui.fill(mx + 1, my + 1, mw, mh, 'background');
  const area = ui.panel('modal', { x: mx, y: my, width: mw, height: mh }, value.title || ui.L(value.kind), { focused: true });
  const bottom = area.y + area.height - 1;
  if (value.fields) {
    const count = value.fields.length, visible = Math.max(1, area.height - 4);
    value.fieldOffset = Math.max(0, Math.min(Math.max(0, count - visible), value.fieldOffset || 0));
    if (value.index < count && value.index >= value.fieldOffset + visible) value.fieldOffset = value.index - visible + 1;
    if (value.index < value.fieldOffset) value.fieldOffset = value.index;
    value.fields.slice(value.fieldOffset, value.fieldOffset + visible).forEach((field, row) => {
      const index = row + value.fieldOffset, selected = value.index === index, labelWidth = Math.min(28, Math.floor(area.width * 0.4));
      ui.put(area.x, area.y + row, field.label, labelWidth, selected ? 'accent' : 'muted');
      const displayed = field.key === 'language' ? ({ auto: ui.L('auto'), en: 'English', pl: 'Polski' }[field.value]) : field.options && ['auto', 'off', 'unicode', 'ascii', 'current', 'history', 'open', 'all'].includes(field.value) ? ui.L(field.value) : field.value || '—';
      ui.badge(area.x + labelWidth + 1, area.y + row, displayed, { width: area.width - labelWidth - 1, active: selected,
        layer: 'modal', action: { type: 'modal-field', index } });
      if (field.options) ui.hit({ x: area.x + area.width - 3, y: area.y + row, width: 3, height: 1 }, { type: 'modal-field', index, cycle: true, layer: 'modal' });
    });
    ui.rule(area, bottom - 3);
    ui.badge(area.x, bottom - 2, ui.L('apply'), { active: value.index === count, layer: 'modal', action: { type: 'modal-button', button: 'apply' } });
    ui.badge(area.x + 20, bottom - 2, ui.L('cancel'), { active: value.index === count + 1, layer: 'modal', action: { type: 'modal-button', button: 'cancel' } });
    ui.put(area.x, bottom, ui.L('formKeys'), area.width, 'muted');
  } else if (value.kind === 'broker') {
    const fields = [{ label: ui.L('broker'), value: value.error || value.info, full: true },
      ...(value.control ? [{ label: ui.L('state'), value: value.control.phase, tone: ui.tone(value.control.phase) },
        { label: ui.L('scope'), value: ui.L('scopeInstance') }, { label: ui.L('active'), value: value.control.activeOperations },
        { label: 'instanceId', value: value.control.instanceId }, { label: 'generation', value: value.control.generation }] : [])];
    value.viewport ||= { offset: 0 };
    ui.scroll('broker-modal', { ...area, height: area.height - 4 }, ui.kvLines(fields, area.width - 2), value.viewport, { kind: 'details', layer: 'modal' });
    const enabled = value.control && ['RUNNING', 'PAUSED'].includes(value.control.phase) && !value.busy;
    ui.badge(area.x, bottom - 2, ui.L('confirmed'), { active: value.confirm, disabled: !enabled, layer: 'modal', action: { type: 'modal-button', button: 'confirm' } });
    ui.badge(area.x + 24, bottom - 2, ui.L('cancel'), { active: !value.confirm, layer: 'modal', action: { type: 'modal-button', button: 'cancel' } });
    ui.put(area.x, bottom, ui.L('confirmHint'), area.width, 'muted');
  } else if (value.kind === 'details' || value.kind === 'help' || value.kind === 'text') {
    value.viewport ||= { offset: value.scroll || 0 };
    const lines = value.kind === 'details' ? ui.kvLines(detailFields(value.row, ui), area.width - 2)
      : ui.wrap(value.customText || ui.L('shortcuts') + '\n\n' + ui.L('helpBody') + '\n\nMouse: click / double-click / wheel / scrollbar drag', area.width - 2);
    ui.scroll('modal-content', { ...area, height: area.height - 2 }, lines, value.viewport, { kind: 'details', layer: 'modal' });
    ui.put(area.x, bottom, '[Esc] ' + ui.L('cancel'), area.width, 'muted');
    ui.hit({ x: area.x, y: bottom, width: area.width, height: 1 }, { type: 'modal-button', button: 'cancel', layer: 'modal' });
  } else {
    const lines = ui.wrap(value.prompt || '', area.width);
    lines.slice(0, 4).forEach((text, i) => ui.put(area.x, area.y + i, text, area.width, 'muted'));
    const iy = area.y + Math.min(5, lines.length + 1);
    ui.badge(area.x, iy, (value.input || '') + '▏', { width: area.width, fg: 'text', layer: 'modal' });
    if (value.kind === 'export') ui.put(area.x, iy + 2, `${ui.L('export')}: ${value.rows.length} · ${value.format.toUpperCase()} · ${ui.L('partial')}`, area.width, 'muted');
    if (value.error) ui.put(area.x, bottom - 2, value.error, area.width, 'danger');
    ui.put(area.x, bottom, '[Enter] ' + ui.L('apply') + '     [Esc] ' + ui.L('cancel'), area.width, 'accent');
    ui.hit({ x: area.x, y: bottom, width: 20, height: 1 }, { type: 'modal-button', button: 'apply', layer: 'modal' });
    ui.hit({ x: area.x + 24, y: bottom, width: 20, height: 1 }, { type: 'modal-button', button: 'cancel', layer: 'modal' });
  }
}
module.exports = { header, footer, modal, banner, detailFields };
