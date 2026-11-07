'use strict';
const { sourceLines } = require('./console-source');
function render(ui, modal) {
  const pl = ui.language === 'pl', result = modal.result;
  const width = Math.min(144, ui.buffer.width - 4), height = ui.buffer.height - 4;
  const rect = { x: Math.floor((ui.buffer.width - width) / 2), y: 2, width, height };
  ui.hit({ x: 0, y: 0, width: ui.buffer.width, height: ui.buffer.height }, { type: 'noop', layer: 'modal' });
  const area = ui.panel('response-modal', rect, (pl ? 'Zapisana odpowiedź · ' : 'Retained response · ') + modal.row.id, { focused: true });
  ui.put(area.x, area.y, pl ? 'Odczyt lokalnego zapisu zadania · bez ponownego wykonania · nie potwierdza walidacji CAD'
    : 'Local task output · no re-execution · does not establish CAD validation', area.width, 'muted');
  let x = area.x;
  (result?.outputs || []).forEach((output, index) => {
    const width = output.name.length + 4;
    ui.badge(x, area.y + 1, output.name, { width, active: index === modal.index, layer: 'modal', action: { type: 'response-stream', index } });
    x += width + 1;
  });
  ui.rule(area, area.y + 2);
  const content = { ...area, y: area.y + 3, height: area.height - 5 };
  const output = result?.outputs?.[modal.index || 0];
  const errors = {
    DIRECT_RESPONSE_NOT_RETAINED: pl ? 'Tryb direct nie zapisuje treści odpowiedzi w telemetrii.' : 'Direct telemetry does not retain response bodies.',
    NO_RETAINED_RESPONSE: pl ? 'Brak zachowanej odpowiedzi. Zadanie mogło nie dojść do wysłania lub pliki nie są już dostępne.' : 'No retained response. The task may not have reached dispatch, or output files are no longer available.',
    TASK_NO_LONGER_RETAINED: pl ? 'Zadanie nie znajduje się już w zapisie brokera.' : 'The task is no longer in the broker record.',
  };
  if (!output?.lines) ui.empty(content, modal.busy ? ui.L('loading') : pl ? 'Odpowiedź niedostępna' : 'Response unavailable',
    output?.error || errors[result?.error] || result?.error || ui.L('unknown'), { unavailable: !modal.busy });
  else {
    modal.viewport ||= { offset: 0 };
    const key = `${modal.index}:${content.width}:${modal.horizontal || 0}`;
    if (modal.lineCache?.key !== key) modal.lineCache = { key, lines: sourceLines(output, content.width - 2, modal.horizontal || 0) };
    ui.scroll('response-content', content, modal.lineCache.lines, modal.viewport, { kind: 'response', layer: 'modal' });
  }
  const bottom = area.y + area.height - 1;
  ui.put(area.x, bottom - 1, ui.middle(output?.path || '', area.width), area.width, 'muted');
  ui.put(area.x, bottom, pl ? '[Tab] strumień   [↑↓ PgUp PgDn] pionowo   [← →] poziomo   [Esc] zamknij'
    : '[Tab] stream   [↑↓ PgUp PgDn] vertical   [← →] horizontal   [Esc] close', area.width, 'accent');
  ui.hit({ x: area.x + area.width - 15, y: bottom, width: 15, height: 1 }, { type: 'modal-button', button: 'cancel', layer: 'modal' });
}
module.exports = { render };
