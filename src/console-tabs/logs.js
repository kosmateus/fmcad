'use strict';

const words = {
  en: {
    stream: 'Log stream', facets: 'Levels / components', statistics: 'Window statistics',
    bufferScope: 'Counts: project retained buffer', order: 'File order; newest appended entries below',
    results: 'Filtered entries', buffer: 'Retained entries', first: 'Earliest confirmed time',
    last: 'Latest confirmed time', invalid: 'Missing / unconfirmed time', event: 'Event',
    task: 'Task', agent: 'Agent', request: 'Request', record: 'Entry ID',
    truncated: 'Window truncated', bounded: 'Retained window; completeness unknown',
    stale: 'Log read failed; retained data', frozen: 'Frozen snapshot', refreshed: 'Snapshot read',
    timeNote: 'UTC for explicit-zone timestamps; original value preserved below',
    original: 'Original timestamp', sourceNote: 'Log file path is not supplied by the adapter',
    noMatch: 'No entries match these filters', empty: 'The log source is empty',
    reset: 'Change filters [f]', on: 'on', off: 'off', allLevels: 'All levels',
    allComponents: 'All components', share: 'Level counts: filtered entries',
    unavailable: 'Log source unavailable', notCad: 'Log level does not establish CAD success',
    activeFilters: 'Active filters', filterHint: 'Level / component counts ignore view filters',
  },
  pl: {
    stream: 'Strumień logów', facets: 'Poziomy / komponenty', statistics: 'Statystyki okna',
    bufferScope: 'Liczniki: bufor retencji projektu', order: 'Kolejność pliku; dopisane wpisy na dole',
    results: 'Wpisy po filtrach', buffer: 'Zachowane wpisy', first: 'Najwcześniejszy potwierdzony czas',
    last: 'Najpóźniejszy potwierdzony czas', invalid: 'Brak / niepotwierdzony czas', event: 'Zdarzenie',
    task: 'Zadanie', agent: 'Agent', request: 'Żądanie', record: 'ID wpisu',
    truncated: 'Okno obcięte', bounded: 'Okno retencji; pełność nieznana',
    stale: 'Błąd odczytu logów; dane zachowane', frozen: 'Zamrożona migawka', refreshed: 'Odczyt migawki',
    timeNote: 'UTC dla czasu ze strefą; oryginalna wartość poniżej',
    original: 'Oryginalny czas', sourceNote: 'Adapter nie podaje ścieżki pliku logów',
    noMatch: 'Żaden wpis nie pasuje do filtrów', empty: 'Źródło logów jest puste',
    reset: 'Zmień filtry [f]', on: 'wł.', off: 'wył.', allLevels: 'Wszystkie poziomy',
    allComponents: 'Wszystkie komponenty', share: 'Liczniki poziomów: wyniki filtrów',
    unavailable: 'Źródło logów niedostępne', notCad: 'Poziom logu nie potwierdza sukcesu CAD',
    activeFilters: 'Aktywne filtry', filterHint: 'Liczniki poziomów / komponentów bez filtrów widoku',
  },
};
const levels = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'OTHER'];

function eventTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowStats(rows) {
  if (!Array.isArray(rows)) return null;
  const counts = new Map(levels.map(level => [level, 0]));
  let first = null, last = null, invalid = 0;
  for (const row of rows) {
    const level = row.level || 'OTHER';
    counts.set(level, (counts.get(level) || 0) + 1);
    const time = eventTime(row.timestamp);
    if (time === null) invalid++;
    else { first = first === null ? time : Math.min(first, time); last = last === null ? time : Math.max(last, time); }
  }
  return { total: rows.length, counts, first, last, invalid };
}

function facets(rows, tr) {
  if (!Array.isArray(rows)) return null;
  const counts = windowStats(rows).counts, components = new Map();
  for (const row of rows) {
    if (typeof row.component === 'string' && row.component) components.set(row.component, (components.get(row.component) || 0) + 1);
  }
  return [
    { text: tr('bufferScope') },
    { text: tr('allLevels'), field: 'level', value: '', count: rows.length },
    ...[...counts].map(([value, count]) => ({ text: value, field: 'level', value, count })),
    { text: tr('allComponents'), field: 'component', value: '', count: rows.length },
    ...[...components].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ text: value, field: 'component', value, count })),
  ];
}

function filterSummary(state, ui, tr) {
  const active = Object.entries(state.filters || {}).filter(([key, value]) => value && !(key === 'scope' && value === 'all'));
  const labels = { level: ui.L('level'), component: ui.L('source'), task: tr('task'), agent: tr('agent'), request: tr('request') };
  return active.length ? active.map(([key, value]) => `${labels[key] || key}: ${value}`).join(' · ') : ui.L('all');
}

function entryFields(row, ui, tr) {
  if (!row) return [{ label: ui.L('details'), value: ui.L('noSelection'), full: true }];
  const time = eventTime(row.timestamp);
  return [
    { label: ui.L('time'), value: time === null ? ui.L('unknown') : ui.date(time) },
    { label: tr('original'), value: row.timestamp, full: true },
    { label: ui.L('level'), value: ui.statusText(row.level), tone: ui.tone(row.level) },
    { label: ui.L('source'), value: row.component, full: true },
    ...[['event', 'event'], ['taskId', 'task'], ['agentId', 'agent'], ['requestId', 'request']]
      .filter(([key]) => row[key] !== null && row[key] !== undefined && row[key] !== '')
      .map(([key, label]) => ({ label: tr(label), value: row[key], full: true })),
    { label: ui.L('message'), value: row.message, full: true },
    { label: tr('record'), value: row.id, full: true },
    { label: ui.L('sourceReason'), value: row.sourceFile || tr('sourceNote'), full: true },
    { label: ui.L('result'), value: tr('notCad'), full: true },
    { label: ui.L('time'), value: tr('timeNote'), full: true },
  ];
}

function renderFacets(ctx, rect, source, tr) {
  const { ui, state, focus } = ctx;
  const area = ui.panel('logs-filters', rect, tr('facets'), { focus: 2, focused: focus === 2, kind: 'filters' });
  const items = facets(source, tr);
  if (!items) { ui.empty(area, tr('unavailable'), ui.L('missingHint'), { unavailable: true }); return; }
  state.logsFacets ||= { offset: 0 };
  ui.scroll('logs-filters', area, items.map(item => ({ text: item.text, fg: item.field ? 'text' : 'muted' })), state.logsFacets, { focus: 2, kind: 'filters' });
  items.slice(state.logsFacets.offset, state.logsFacets.offset + area.height).forEach((item, index) => {
    if (!item.field) return;
    const active = item.value ? (state.filters || {})[item.field] === item.value : !(state.filters || {})[item.field];
    const suffix = ' ' + ui.number(item.count), width = Math.max(1, area.width - 2);
    ui.badge(area.x, area.y + index, ui.clip(item.text, Math.max(1, width - suffix.length - 2)) + suffix,
      { width, active, fg: item.field === 'level' ? ui.tone(item.value) : 'accent', action: { type: 'filter', field: item.field, value: item.value } });
  });
}

function render(ctx) {
  const { ui, state, rect, focus, selected } = ctx;
  const tr = key => words[ctx.language === 'pl' ? 'pl' : 'en'][key];
  const snapshot = state.frozenSnapshot || ctx.snapshot || {};
  const source = Object.hasOwn(ctx, 'sourceRows') ? ctx.sourceRows : Array.isArray(state.frozen) ? state.frozen : Array.isArray(snapshot.logs) ? snapshot.logs : null;
  const rows = source === null ? null : Array.isArray(ctx.rows) ? ctx.rows : null;
  if (rect.width < 32 || rect.height < 8) { ui.text(rect, ui.L('resize'), { fg: 'warning' }); return; }
  let x = rect.x;
  const control = (text, width, action, active = false) => {
    ui.badge(x, rect.y, text, { width, action, active }); x += width + 1;
  };
  control('/ ' + (state.search || ui.L('search')), Math.max(18, rect.width - 56), { type: 'key', key: '/' });
  const filterCount = require('../console-filters').activeFilters(state).length;
  control('f ' + ui.L('filters') + (filterCount ? ' · ' + filterCount : ''), 13, { type: 'key', key: 'f' }, filterCount > 0);
  control('l ' + ui.L('follow'), 12, { type: 'key', key: 'l' }, !!state.follow);
  control(ui.L('freeze'), 12, { type: 'key', key: 'SPACE' }, !!state.frozenSnapshot);
  control('e ' + ui.L('export'), 12, { type: 'key', key: 'e' });
  const warning = snapshot.logWarning ? tr('stale') : source === null ? tr('unavailable') : snapshot.retention?.logWindowTruncated ? tr('truncated') : tr('bounded');
  ui.text({ ...rect, y: rect.y + 1, height: 1 }, `${warning} · ${filterSummary(state, ui, tr)}`, { fg: snapshot.logWarning || source === null ? 'warning' : 'muted' });
  const body = { ...rect, y: rect.y + 2, height: rect.height - 2 };
  const wide = rect.width >= 136 && body.height >= 26;
  const rich = rect.width >= 198 && body.height >= 30;
  const leftWidth = wide ? rich ? 28 : 24 : 0;
  const rightWidth = wide ? rich ? Math.min(50, Math.floor(rect.width * 0.23)) : 38 : 0;
  const stream = { ...body, x: body.x + (wide ? leftWidth + 1 : 0), width: body.width - (wide ? leftWidth + rightWidth + 2 : 0) };
  const columns = [
    { key: 'timestamp', label: ui.L('time') + ' UTC', width: 12, value: row => { const time = eventTime(row.timestamp); return time === null ? '—' : new Date(time).toISOString().slice(11, 23); } },
    { key: 'level', label: ui.L('level'), width: 5, value: row => ui.statusText(row.level), tone: row => ui.tone(row.level) },
    { key: 'component', label: ui.L('source'), width: rich ? 20 : 14, optional: true, priority: 1 },
    ...(rich && source?.some(row => row.agentId) ? [{ key: 'agentId', label: tr('agent'), width: 18, optional: true, priority: 2 }] : []),
    { key: 'message', label: ui.L('message'), min: 30, flex: true },
  ];
  ui.table('logs-stream', stream, rows, columns, { state, title: tr('stream'), kind: 'logs', toolbar: false,
    focus: 0, focused: focus === 0, sourceCount: source?.length,
    emptyTitle: source === null ? tr('unavailable') : source.length ? tr('noMatch') : tr('empty'),
    emptyHint: source === null ? ui.L('missingHint') : source.length ? tr('reset') : tr('order') });
  if (!wide) return;
  renderFacets(ctx, { ...body, width: leftWidth }, source, tr);
  const right = { ...body, x: body.x + body.width - rightWidth, width: rightWidth };
  const statsHeight = rich ? 15 : 11, detailHeight = body.height - statsHeight - 2;
  const actions = selected ? [{ text: ui.L('details'), action: { type: 'details', row: selected, kind: 'logs' } }] : [];
  if (selected?.taskId) actions.push({ text: tr('task'), action: { type: 'navigate', tab: 2, id: selected.taskId, filters: { scope: 'all', task: selected.taskId } } });
  const agent = selected?.agentId && snapshot.agents?.find(item => item.id === selected.agentId || item.sessionId === selected.agentId);
  if (agent) actions.push({ text: tr('agent'), action: { type: 'navigate', tab: 1, id: agent.id, filters: { scope: 'all', agent: selected.agentId } } });
  const actionWidth = Math.floor((right.width - 2) / Math.max(1, actions.length));
  actions.forEach((item, index) => ui.badge(right.x + index * (actionWidth + 1), right.y, item.text, { width: actionWidth, action: item.action }));
  const detailsViewport = ctx.detailState || (state.logsDetails ||= { offset: 0 });
  if (detailsViewport.identity !== selected?.id) { detailsViewport.identity = selected?.id; detailsViewport.offset = 0; }
  ui.fields('logs-details', { ...right, y: right.y + 1, height: detailHeight }, ui.L('details'), entryFields(selected, ui, tr),
    detailsViewport, { focus: 1, focused: focus === 1 });
  const stats = windowStats(rows);
  const fields = [
    { label: tr('results'), value: stats ? ui.number(stats.total) : null },
    { label: tr('buffer'), value: source ? ui.number(source.length) : null },
    { label: ui.L('scope'), value: ui.L('totalsScope'), full: true },
    { label: tr('activeFilters'), value: filterSummary(state, ui, tr), full: true },
    { group: tr('share') },
    ...(stats ? [...stats.counts].map(([level, count]) => ({ label: ui.statusText(level), value: `${ui.number(count)} / ${ui.number(stats.total)}`, tone: ui.tone(level) })) : []),
    { label: tr('first'), value: stats?.first === null || !stats ? null : ui.date(stats.first), full: true },
    { label: tr('last'), value: stats?.last === null || !stats ? null : ui.date(stats.last), full: true },
    { label: tr('invalid'), value: stats?.invalid },
    { label: tr('refreshed'), value: ui.date(snapshot.readAt), full: true },
    { label: ui.L('state'), value: warning, tone: snapshot.logWarning ? 'warning' : 'muted', full: true },
    { label: ui.L('sourceReason'), value: snapshot.logWarning || tr('sourceNote'), full: true },
    { label: ui.L('follow'), value: state.follow ? tr('on') : tr('off') },
    { label: ui.L('freeze'), value: state.frozenSnapshot ? tr('frozen') : tr('off') },
    { label: ui.L('source'), value: tr('filterHint'), full: true },
    { label: ui.L('time'), value: tr('order'), full: true },
  ];
  const area = ui.panel('logs-statistics', { ...right, y: right.y + detailHeight + 2, height: statsHeight }, tr('statistics'), { focus: 3, focused: focus === 3 });
  const lines = [{ text: `${tr('results')}: ${stats?.total ?? '—'} / ${source?.length ?? '—'}`, fg: 'muted' }, ''];
  if (stats) for (const [level, count] of stats.counts) {
    const size = Math.max(3, Math.min(12, area.width - 20)), fill = stats.total ? Math.round(count / stats.total * size) : 0;
    lines.push({ spans: [{ text: level, width: 6, fg: ui.tone(level) },
      { x: 7, text: '▰'.repeat(fill) + '·'.repeat(size - fill), width: size, fg: ui.tone(level) },
      { x: 8 + size, text: ui.pad(ui.number(count), 5, true), width: 5, fg: ui.tone(level) },
      { x: 14 + size, text: stats.total ? Math.round(count / stats.total * 100) + '%' : '—', width: 5, fg: 'muted' }] });
  }
  const recent = (rows || []).filter(row => { const at = eventTime(row.timestamp); return at !== null && at >= ui.now - 60000 && at <= ui.now; }).length;
  lines.push('', { text: (ctx.language === 'pl' ? 'Z bufora / ostatnie 60 s: ' : 'Retained / last 60 s: ') + (stats ? recent : '—'), fg: 'muted' },
    { text: warning, fg: snapshot.retention?.logWindowTruncated ? 'warning' : 'muted' },
    ...ui.kvLines(fields.slice(10), area.width - 2));
  ui.scroll('logs-statistics', area, lines, state.logsStatistics ||= { offset: 0 }, { kind: 'details', focus: 3 });
}

module.exports = { render, eventTime, windowStats, facets, entryFields, filterSummary };
