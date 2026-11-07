'use strict';
const present = value => typeof value === 'string' && value.trim().length > 0;
function sourceName(row) {
  if (present(row?.sourcePath)) return row.sourcePath.split(/[\\/]/).at(-1);
  if (present(row?.script)) return row.script.split(/[\\/]/).at(-1);
  return typeof row?.label === 'string' ? row.label.match(/^run (.+)$/)?.[1]?.split(/[\\/]/).at(-1) || null : null;
}
function documentLabel(row) {
  if (present(row?.document)) return row.document;
  const script = sourceName(row);
  return script ? 'py · ' + script : null;
}
function documentFields(row, ui) {
  const value = documentLabel(row);
  return [{ label: ui.L('documentOrScript'), value, full: true }, ...(value ? [{ label: ui.L('documentSource'),
    value: ui.L(present(row?.document) ? 'recordedDocument' : 'scriptDocumentFallback'), full: true, tone: 'muted' }] : [])];
}
module.exports = { sourceName, documentLabel, documentFields };
