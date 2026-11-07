'use strict';
const { describe } = require('./console-details');
function render(ui, modal) {
  const width = Math.min(124, ui.buffer.width - 4), height = Math.min(44, ui.buffer.height - 4);
  const rect = { x: Math.floor((ui.buffer.width - width) / 2), y: Math.floor((ui.buffer.height - height) / 2), width, height };
  const detail = describe(modal.row, ui, modal.contextSnapshot || {}, { missing: modal.missing, outsideFilter: modal.outsideFilter, frozen: modal.frozen });
  ui.hit({ x: 0, y: 0, width: ui.buffer.width, height: ui.buffer.height }, { type: 'noop', layer: 'modal' });
  ui.fill(rect.x + 1, rect.y + 1, rect.width, rect.height, 'background');
  const area = ui.panel('detail-modal', rect, detail.title, { focused: true, badge: modal.row?.state ? ui.statusText(modal.row.state) : modal.row?.level });
  const labelWidth = Math.min(28, Math.max(16, Math.floor(area.width * 0.3)));
  const content = { ...area, height: area.height - 3 };
  const lines = ui.kvLines(detail.fields, content.width - 2, { labelWidth, columns: true });
  modal.viewport ||= { offset: 0 };
  ui.scroll('detail-modal-content', content, lines, modal.viewport, { kind: 'details', layer: 'modal' });
  const row = area.y + area.height - 2;
  ui.rule(area, row - 1);
  const actions = [];
   if (detail.kind !== 'task' && detail.related.operations?.length) actions.push(['t', ui.L('tasks')]);
   if (detail.kind !== 'log' && detail.related.events?.length) actions.push(['g', ui.L('logs')]);
  if (detail.related.agents.length === 1 && detail.kind !== 'agent') actions.push(['a', ui.L('agents')]);
   if (modal.row?.sourcePath) actions.push(['p', ui.L('code')]);
   if (detail.kind === 'task') actions.push(['y', ui.language === 'pl' ? 'Odpowiedź' : 'Response']);
  let x = area.x;
  for (const [key, title] of actions) {
    const value = `[${key}] ${title}`, width = Math.max(12, value.length + 2);
    if (x + width > area.x + area.width - 15) break;
    ui.badge(x, row, value, { width, layer: 'modal', action: { type: 'key', key } }); x += width + 1;
  }
  ui.badge(area.x + area.width - 14, row, '[Esc] ' + ui.L('cancel'), { width: 14, layer: 'modal', action: { type: 'modal-button', button: 'cancel' } });
  const range = `${Math.min(lines.length, modal.viewport.offset + 1)}–${Math.min(lines.length, modal.viewport.offset + content.height)} / ${lines.length}`;
  ui.put(area.x, area.y + area.height - 1, `↑↓  PgUp/PgDn  Home/End    ${range}`, area.width, 'muted');
}
module.exports = { render };
