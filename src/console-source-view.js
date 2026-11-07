'use strict';
const path = require('node:path');
const { sourceLines } = require('./console-source');
function render(ui, modal) {
  const pl = ui.language === 'pl', preview = modal.preview;
  const width = Math.min(144, ui.buffer.width - 4), height = ui.buffer.height - 4;
  const rect = { x: Math.floor((ui.buffer.width - width) / 2), y: 2, width, height };
  ui.hit({ x: 0, y: 0, width: ui.buffer.width, height: ui.buffer.height }, { type: 'noop', layer: 'modal' });
  ui.fill(rect.x + 1, rect.y + 1, width, height, 'background');
  const area = ui.panel('source-modal', rect, (pl ? 'Kod skryptu' : 'Script source') + ' · ' + path.basename(modal.sourceRow.sourcePath), { focused: true });
  const sourcePath = preview?.path || modal.sourceRow.sourcePath;
  ui.put(area.x, area.y, ui.middle(sourcePath, area.width), area.width, 'muted');
  const status = modal.busy ? ui.L('loading') : preview?.formatter.applied
    ? pl ? 'Sformatowana kopia w pamięci · Black + Pygments · plik pozostaje bez zmian' : 'Formatted memory copy · Black + Pygments · file unchanged'
    : pl ? 'Oryginalna kopia w pamięci · tylko odczyt' : 'Original memory copy · read only';
  ui.put(area.x, area.y + 1, status, area.width, preview?.formatter.applied ? 'accent' : 'muted');
  const mismatch = preview?.changedSinceRun === true;
  const note = mismatch ? pl ? 'Bieżący plik różni się od zarejestrowanego przy uruchomieniu.' : 'Current file differs from its recorded run hash.'
    : preview?.changedSinceRun === false ? pl ? 'Hash pliku źródłowego zgodny z zapisem uruchomienia; bez wstrzykniętych argumentów.' : 'Source hash matches the run record; injected arguments are not applied.'
      : pl ? 'Podgląd bieżącego pliku źródłowego, nie payloadu wysłanego do Fusion.' : 'Preview of the current source file, not the payload submitted to Fusion.';
  ui.put(area.x, area.y + 2, note, area.width - 24, mismatch ? 'warning' : 'muted');
  ui.badge(area.x + area.width - 23, area.y + 2, '[i] ' + (pl ? 'Ścieżka / hash' : 'Path / hash'), { width: 23, active: !!modal.showMetadata,
    layer: 'modal', action: { type: 'key', key: 'i' } });
  ui.rule(area, area.y + 3);
  const content = { ...area, y: area.y + 4, height: area.height - 6 };
  modal.viewport ||= { offset: 0 }; modal.horizontal ||= 0;
  if (!preview || preview.original === null) ui.empty(content, modal.busy ? ui.L('loading') : pl ? 'Nie można otworzyć pliku' : 'Cannot open source',
    preview?.formatter.error || sourcePath, { unavailable: !modal.busy });
  else {
    const key = `${content.width}:${modal.horizontal}:${!!modal.showMetadata}`;
    if (modal.lineCache?.key !== key) {
      const metadata = modal.showMetadata ? [...ui.kvLines([
        { label: pl ? 'Pełna ścieżka' : 'Full path', value: sourcePath, full: true },
        { label: 'SHA-256', value: preview.sha256, full: true },
        { label: pl ? 'Hash uruchomienia' : 'Recorded hash', value: preview.expectedSha256, full: true },
      ], content.width - 2), ''] : [];
      modal.lineCache = { key, lines: [...metadata, ...sourceLines(preview, content.width - 2, modal.horizontal)] };
    }
    ui.scroll('source-code', content, modal.lineCache.lines, modal.viewport, { kind: 'code', layer: 'modal' });
  }
  const bottom = area.y + area.height - 1;
  if (preview?.formatter.error && preview.original !== null) ui.put(area.x, bottom - 1, preview.formatter.error, area.width, 'warning');
  else ui.put(area.x, bottom - 1, `${pl ? 'Wiersze' : 'Lines'}: ${preview?.lines.length ?? '—'}   ${pl ? 'Kolumna' : 'Column'}: ${modal.horizontal + 1}`, area.width, 'muted');
  const help = pl ? '[↑↓ PgUp PgDn] pionowo   [← →] poziomo   [i] metadane   [Esc] zamknij' : '[↑↓ PgUp PgDn] vertical   [← →] horizontal   [i] metadata   [Esc] close';
  ui.put(area.x, bottom, help, area.width, 'accent');
  ui.hit({ x: area.x + area.width - 15, y: bottom, width: 15, height: 1 }, { type: 'modal-button', button: 'cancel', layer: 'modal' });
}
module.exports = { render };
