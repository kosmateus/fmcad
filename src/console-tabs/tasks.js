'use strict';

const words = {
  en: {
    operations: 'Operations', unresolved: 'Unresolved / unrecognized', scope: 'Available project records',
    matches: 'Filter results', purpose: 'Purpose / operation', transport: 'Transport response',
    transportTime: 'Recorded transport duration', recordedTime: 'Recorded execution duration',
    cadUnknown: 'CAD success is not established by a transport response', actions: 'Scope / actions',
    all: 'All', open: 'Open', history: 'History', logs: 'Task logs', requestLogs: 'Request logs',
    retention: 'Retained window; completeness is not guaranteed', truncated: 'Terminal records omitted',
    sessions: 'Direct sessions read', sessionsCut: 'Older direct sessions omitted', limit: 'Configured timeout',
    unavailable: 'Operation source unavailable', empty: 'No operations in this scope',
    sourceState: 'Source observation', snapshot: 'Snapshot read', raw: 'Source state',
    sequence: 'Sequence', revision: 'Revision', outcome: 'Execution outcome', code: 'Result code',
    activeWait: 'Active waiting / pause duration', notMeasured: 'Not reported by this source',
    ordering: 'List order is not a scheduling prediction', filters: 'Active filters', none: 'None',
    stale: 'Last-known records; current execution is unconfirmed', details: 'Task details',
    related: 'Task events · latest 20 matches', noDescription: 'No purpose supplied',
    archive: 'Latest buffer + task-hour archives', archiveBadge: 'incl. archives', noRecordedEvents: 'No matching events in the searched task logs', archiveLimit: 'Archive search limited; some events may be outside the scanned data',
    full: 'Full details', yes: 'Yes', no: 'No', mutation: 'May have mutated', refresh: 'Context refresh required',
    documentHint: 'Document / script: recorded Fusion target, otherwise py · source script. [p] opens available source.',
  },
  pl: {
    operations: 'Operacje', unresolved: 'Nierozstrzygnięte / nierozpoznane', scope: 'Dostępne rekordy projektu',
    matches: 'Wyniki filtrów', purpose: 'Cel / operacja', transport: 'Odpowiedź transportu',
    transportTime: 'Zapisany czas transportu', recordedTime: 'Zapisany czas wykonania',
    cadUnknown: 'Odpowiedź transportu nie potwierdza sukcesu CAD', actions: 'Zakres / akcje',
    all: 'Wszystkie', open: 'Otwarte', history: 'Historia', logs: 'Logi zadania', requestLogs: 'Logi żądania',
    retention: 'Okno retencji; kompletność nie jest gwarantowana', truncated: 'Pominięte rekordy zakończone',
    sessions: 'Odczytane sesje direct', sessionsCut: 'Pominięto starsze sesje direct', limit: 'Skonfigurowany timeout',
    unavailable: 'Źródło operacji niedostępne', empty: 'Brak operacji w tym zakresie',
    sourceState: 'Obserwacja źródła', snapshot: 'Odczyt migawki', raw: 'Stan źródłowy',
    sequence: 'Sekwencja', revision: 'Rewizja', outcome: 'Wynik wykonania', code: 'Kod wyniku',
    activeWait: 'Aktywne oczekiwanie / pauzy', notMeasured: 'Źródło nie raportuje tej wartości',
    ordering: 'Kolejność listy nie jest prognozą wykonania', filters: 'Aktywne filtry', none: 'Brak',
    stale: 'Rekordy ostatnio znane; bieżące wykonanie niepotwierdzone', details: 'Szczegóły zadania',
    related: 'Zdarzenia zadania · ostatnie 20 trafień', noDescription: 'Nie podano celu',
    archive: 'Najnowszy bufor + archiwa z godzin zadania', archiveBadge: 'z archiwami', noRecordedEvents: 'Brak pasujących zdarzeń w przeszukanych logach zadania', archiveLimit: 'Ograniczony odczyt archiwów; część zdarzeń może być poza przeszukanymi danymi',
    full: 'Pełne szczegóły', yes: 'Tak', no: 'Nie', mutation: 'Możliwa zmiana modelu', refresh: 'Wymagane odświeżenie kontekstu',
    documentHint: 'Dokument / skrypt: zapisany cel Fusion, a przy jego braku py · skrypt źródłowy. [p] otwiera dostępne źródło.',
  },
};
const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'completed']);
function group(row) {
  if (row.state === 'queued') return 'waiting';
  if (['running', 'sending'].includes(row.state)) return 'active';
  return terminalStates.has(row.state) ? 'history' : 'unresolved';
}
function counts(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.reduce((out, row) => { out[group(row)]++; return out; }, { active: 0, waiting: 0, unresolved: 0, history: 0 });
}
function scopedRows(rows, scope) {
  if (!Array.isArray(rows)) return null;
  return rows.filter(row => scope === 'open' ? group(row) !== 'history' : scope === 'history' ? group(row) === 'history' : true);
}
function correlatedEvents(logs, row) {
  if (!Array.isArray(logs)) return null;
  return logs.filter(log => require('../console-task-events').matches(log, row)).slice(-20);
}
function timestamp(value) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function recordedDuration(row) {
  const start = timestamp(row.startedAt), end = timestamp(row.finishedAt);
  return start !== null && end !== null && end >= start ? end - start : null;
}
function taskFields(row, snapshot, ui, T) {
  const transport = snapshot.mode === 'direct' || row.outcomeScope === 'transport';
  const elapsed = recordedDuration(row);
  const fields = [
    { label: T('purpose'), value: row.description || T('noDescription'), full: true },
    { label: ui.L('operation'), value: row.label || row.kind },
    { label: ui.L('state'), value: ui.statusText(row.state), tone: ui.tone(row.state) },
    { label: T('code'), value: row.code },
    ...(row.exitCode !== undefined ? [{ label: 'Exit code', value: row.exitCode }] : []),
    ...(transport ? [{ label: ui.L('result'), value: ui.L('transportResult'), tone: 'warning' },
      { label: 'CAD', value: T('cadUnknown'), full: true }, { label: 'HTTP', value: row.httpStatus }] : []),
    ...require('../console-document').documentFields(row, ui), { label: 'ID', value: row.id, full: true },
    ...['requestId', 'clientId', 'sessionId', 'sequenceId'].map(key => ({ label: key, value: row[key] })),
    { label: T('revision'), value: row.revision },
    ...[['submittedAt', 'received'], ['startedAt', 'started'], ['finishedAt', 'finished']]
      .map(([key, label]) => ({ label: ui.L(label), value: ui.date(row[key]) })),
    { label: T(transport ? 'transportTime' : 'recordedTime'), value: elapsed === null ? null : ui.duration(elapsed) },
    { label: T('limit'), value: Number.isFinite(row.timeoutMs) && row.timeoutMs >= 0 ? ui.duration(row.timeoutMs) : null },
    { label: T('activeWait'), value: T('notMeasured') },
    { label: T('outcome'), value: ui.statusText(row.executionOutcome) },
  ];
  for (const [key, name] of [['mayHaveMutated', 'mutation'], ['contextRefreshRequired', 'refresh']]) {
    if (typeof row[key] === 'boolean') fields.push({ label: T(name), value: T(row[key] ? 'yes' : 'no') });
  }
  return fields.concat([{ label: ui.L('source'), value: snapshot.source },
    { label: ui.L('fullPath'), value: snapshot.project, full: true },
    { label: T('sourceState'), value: ui.date(snapshot.observedAt) },
    { label: T('snapshot'), value: ui.date(snapshot.readAt) },
    ...(snapshot.reason ? [{ label: ui.L('sourceReason'), value: snapshot.reason, full: true }] : [])]);
}
function render(ctx) {
  const { ui, snapshot, state, rect: r } = ctx;
  const T = key => words[ctx.language === 'pl' ? 'pl' : 'en'][key];
  if (r.width < 40 || r.height < 9) { ui.empty(r, T('operations'), ui.L('resize')); return; }
  const source = Array.isArray(snapshot.operations) ? snapshot.operations : null;
  const rows = source === null ? null : ctx.rows;
  const scope = state.filters?.scope || 'all', scoped = scopedRows(source, scope), totals = counts(scoped);
  const selectedId = typeof ctx.selected === 'string' ? ctx.selected : ctx.selected?.id ?? state.selectedId;
  const selected = source?.find(row => row.id === selectedId);
  const status = row => snapshot.mode === 'direct' && row.state === 'completed' ? T('transport') : ui.statusText(row.state);
  const focused = focus => ctx.focus === focus;
  const box = (x, y, width, height) => ({ x, y, width, height });
  const scopeTitle = T(['open', 'history'].includes(scope) ? scope : 'all');
  const summary = area => {
    const inner = ui.panel('tasks-summary', area, T('scope') + ' · ' + scopeTitle, { focus: 1, focused: focused(1) });
    const labels = [ui.L('active'), ui.L('waiting'), T('unresolved'), ui.L('retained')];
    const keys = ['active', 'waiting', 'unresolved', 'history'];
    const width = Math.floor(inner.width / 4);
    labels.forEach((label, index) => ui.metric(box(inner.x + index * width, inner.y, width, 2), label,
      totals ? ui.number(totals[keys[index]]) : '—', { fg: index === 2 ? 'warning' : 'accent', action: { type: 'key', key: 'f' } }));
    if (inner.height > 2) ui.text(box(inner.x, inner.y + 2, inner.width, 1),
      `${T('matches')}: ${Array.isArray(rows) ? ui.number(rows.length) : '—'} / ${scoped ? ui.number(scoped.length) : '—'} · ${T('retention')}`, { fg: 'muted' });
    if (inner.height > 3) actions(box(inner.x, inner.y + 3, inner.width, 1));
  };
  const actions = area => {
    const items = [['open', { type: 'filter', field: 'scope', value: 'open' }], ['history', { type: 'filter', field: 'scope', value: 'history' }],
      ['all', { type: 'filter', field: 'scope', value: 'all' }]];
    let x = area.x;
    for (const [name, action] of items) {
      if (x + 13 > area.x + area.width) break;
      ui.badge(x, area.y, T(name), { width: 12, active: scope === name, action }); x += 13;
    }
    for (const [key, name] of [['r', 'refresh'], ['e', 'export']]) {
      if (x + 13 > area.x + area.width) break;
      ui.badge(x, area.y, '[' + key + '] ' + ui.L(name), { width: 12, action: { type: 'key', key } }); x += 13;
    }
  };
  const columns = [
    { key: 'id', label: 'ID', width: 12, value: row => ui.middle(row.id, 12) },
    { key: 'state', label: ui.L('state'), width: snapshot.mode === 'direct' ? 21 : 18, value: status, tone: row => ui.tone(row.state) },
    { key: 'client', label: ui.L('client'), width: 18, optional: true, priority: 2, value: row => row.clientId || row.sessionId },
    { key: 'document', label: ui.L('documentOrScript'), width: 32, optional: true, priority: 3,
      value: row => require('../console-document').documentLabel(row) },
    { key: 'purpose', label: T('purpose'), min: 16, flex: true, value: row => row.description || row.label || row.kind, sort: 'name' },
    { key: 'startedAt', label: ui.L(scope === 'history' ? 'finished' : 'started') + ' UTC', width: 17, optional: true, priority: 4,
      value: row => { const value = scope === 'history' ? row.finishedAt : row.startedAt; return value == null ? null : ui.date(value).slice(11, 23); }, sort: 'time' },
  ];
  const list = area => ui.table('tasks-list', area, rows, columns, { state, title: snapshot.mode === 'direct' ? T('operations') : ui.L('tasks'),
    kind: 'tasks', focus: 0, focused: focused(0), sourceCount: scoped?.length, badge: snapshot.available === false ? ui.L('lastKnown') : undefined,
    emptyTitle: rows === null ? T('unavailable') : source?.length ? ui.L('noMatches') : T('empty'),
    emptyHint: rows === null ? snapshot.reason || ui.L('missingHint') : ui.L('clearFilters') });
  const details = area => {
    const viewport = ctx.detailState || (state.taskDetails ||= { offset: 0 });
    if (viewport.taskId !== selected.id) { viewport.taskId = selected.id; viewport.offset = 0; }
    ui.fields('tasks-details', { ...area, height: area.height - 1 }, T('details'), taskFields(selected, snapshot, ui, T), viewport,
      { focus: 2, focused: focused(2) });
    const y = area.y + area.height - 1, width = Math.min(22, area.width);
    ui.badge(area.x, y, T('full'), { width, action: { type: 'details', row: selected, kind: 'tasks' } });
    if (area.width >= width + 23) ui.badge(area.x + width + 1, y, T('logs'), { width: 22,
      action: { type: 'navigate', tab: 3, filters: { scope: 'all', task: selected.id, ...(selected.requestId ? { request: selected.requestId } : {}) } } });
    if (selected.sourcePath && area.width >= width + 38) ui.badge(area.x + width + 24, y, 'p ' + ui.L('code'),
      { width: area.width - width - 24 - (area.width >= width + 65 ? 19 : 0), action: { type: 'key', key: 'p' } });
    if (area.width >= width + 65) ui.badge(area.x + area.width - 18, y, ctx.language === 'pl' ? 'y Odpowiedź' : 'y Response',
      { width: 18, action: { type: 'key', key: 'y' } });
  };
  const events = area => {
    const logs = require('../console-task-events').eventsFor(snapshot, selected)?.slice(-20) ?? null, view = state.taskEvents ||= { offset: 0, follow: false };
    const archive = snapshot.taskEvents?.taskId === selected.id ? snapshot.taskEvents : null;
    if (view.taskId !== selected.id) { view.taskId = selected.id; view.offset = Math.max(0, (logs?.length || 0) - Math.max(1, area.height - 5)); }
    ui.table('tasks-events', area, logs, [
      { key: 'timestamp', label: ui.L('time'), width: 19, optional: true, priority: 1, value: row => ui.date(row.timestamp) },
      { key: 'level', label: ui.L('level'), width: 5, tone: row => ui.tone(row.level) },
      { key: 'message', label: ui.L('message'), min: 10, flex: true },
    ], { state: view, title: T('related'), kind: 'logs', toolbar: false, focus: 3, focused: focused(3),
      badge: archive?.logs.length ? `${logs?.length || 0} · ${T('archiveBadge')}` : undefined,
      emptyTitle: logs === null ? ui.L('sourceUnavailable') : T('noRecordedEvents'),
      emptyHint: archive?.error || (archive?.limited ? T('archiveLimit') : archive ? T('archive') : snapshot.logWarning || ui.L('partial')) });
  };
  if (r.width >= 190 && r.height >= 30 && selected) {
    const bottom = Math.max(11, Math.floor(r.height * 0.4)), top = r.height - bottom - 1;
    const left = Math.floor(r.width * 0.73), side = box(r.x + left + 1, r.y, r.width - left - 1, top);
    list(box(r.x, r.y, left, top)); summary({ ...side, height: 7 });
    const labels = { scope: ui.L('scope'), state: ui.L('state'), agent: ui.L('client'), document: ui.L('document'), task: 'Task ID', request: 'Request ID' };
    const filters = Object.entries(state.filters || {}).filter(([, value]) => value).map(([key, value]) => ({ label: labels[key] || key, value: key === 'scope' ? ui.L(value) : value }));
    ui.fields('tasks-context', box(side.x, side.y + 7, side.width, side.height - 7), T('actions'), [
      { label: T('filters'), value: state.search || T('none') }, ...filters,
      { label: T('truncated'), value: snapshot.retention?.terminalTruncated },
      ...(snapshot.mode === 'direct' ? [{ label: T('sessions'), value: snapshot.retention?.sessionsRead },
        { label: T('sessionsCut'), value: snapshot.retention?.sessionsTruncated == null ? null : T(snapshot.retention.sessionsTruncated ? 'yes' : 'no') }] : []),
      { label: ui.L('sourceReason'), value: snapshot.reason || T('ordering'), full: true },
      { label: ui.L('documentOrScript'), value: T('documentHint'), full: true },
    ], state.taskContext ||= { offset: 0 }, { focus: 4, focused: focused(4) });
    const half = Math.floor((r.width - 1) / 2), y = r.y + top + 1;
    details(box(r.x, y, half, bottom)); events(box(r.x + half + 1, y, r.width - half - 1, bottom));
  } else {
    const compact = ctx.profile === 'compact' || r.height < 22, header = ctx.profile === 'wide' ? 7 : 5;
    summary(box(r.x, r.y, r.width, header));
    const y = r.y + header, height = r.height - header;
    if (r.width >= 125 && height >= 20 && selected) {
      const left = Math.floor(r.width * 0.63), right = r.width - left - 1;
      list(box(r.x, y, left, height));
      const detailHeight = height >= 26 ? height - 9 : height;
      details(box(r.x + left + 1, y, right, detailHeight));
      if (height >= 26) events(box(r.x + left + 1, y + detailHeight + 1, right, 8));
    } else if (!compact && height >= 17 && selected) {
      list(box(r.x, y, r.width, height - 9)); details(box(r.x, y + height - 8, r.width, 8));
    } else list(box(r.x, y, r.width, height));
  }
}
module.exports = { render, group, counts, scopedRows, correlatedEvents, recordedDuration, taskFields };
