'use strict';

const words = {
  en: {
    current: 'Online (known)', history: 'History', all: 'All', unknown: 'Unconfirmed signals',
    untracked: 'History only', noSignals: 'Client presence is not tracked by broker history; online count unavailable.',
    transportKind: 'Client kind (ID)', mcpNote: 'MCP stdio = a server process identity, not a separate AI agent. Restarts create new IDs.',
    retained: 'Project / retained identities', open: 'Open', unresolved: 'Unresolved',
      work: 'Work in retained data', evidence: 'Evidence / retention', stale: 'Source unavailable; retained observations',
    noLive: 'Job history does not confirm current presence.', noOpen: 'No open records',
    noAgents: 'No identities in this scope', signal: 'Signal age', tasks: 'Tasks', logs: 'Logs',
    details: 'Details', system: 'System', operation: 'Operation', transport: 'Transport only; CAD outcome unconfirmed',
    unavailable: 'Not reported', freshness: 'Signal freshness', old: 'Older than 15 s; not proof of disconnection',
    fresh: 'Within 15 s', sourceTime: 'Source observation', terminal: 'Terminal records retained',
    sessions: 'Session files read', omitted: 'Terminal records omitted', truncated: 'Session window truncated',
    logWindow: 'Log window truncated', retainedLogs: 'Events / buffer + latest task archive',
    noOperations: 'Operation source unavailable', logMissing: 'Log source unavailable', noEvents: 'No correlated events in retained buffer',
    identityNote: 'Identity is a client/session observation, not an identified person or LLM.',
    missingMetrics: 'Client kind is derived from the ID prefix; client RAM and concurrency are not reported.',
    transportLink: 'Transport connection', noSelection: 'Select an identity to inspect its evidence.',
  },
  pl: {
    current: 'Online potw.', history: 'Historia', all: 'Wszystkie', unknown: 'Niepotw. sygnały',
    untracked: 'Tylko historia', noSignals: 'Historia brokera nie śledzi obecności klientów; liczba online jest niedostępna.',
    transportKind: 'Rodzaj klienta (ID)', mcpNote: 'MCP stdio = tożsamość procesu serwera, nie osobny agent AI. Restarty tworzą nowe ID.',
    retained: 'Projekt / tożsamości w retencji', open: 'Otwarte', unresolved: 'Nierozstrzygnięte',
    work: 'Praca w dostępnych danych', evidence: 'Źródła / retencja', stale: 'Źródło niedostępne; zachowane obserwacje',
    noLive: 'Historia zadań nie potwierdza bieżącej obecności.', noOpen: 'Brak otwartych',
    noAgents: 'Brak tożsamości w tym zakresie', signal: 'Wiek sygnału', tasks: 'Zadania', logs: 'Logi',
    details: 'Szczegóły', system: 'System', operation: 'Operacja', transport: 'Tylko transport; wynik CAD niepotwierdzony',
    unavailable: 'Nie raportowano', freshness: 'Aktualność sygnału', old: 'Starszy niż 15 s; nie dowodzi rozłączenia',
    fresh: 'Do 15 s', sourceTime: 'Obserwacja źródła', terminal: 'Zachowane rekordy terminalne',
    sessions: 'Odczytane pliki sesji', omitted: 'Pominięte rekordy terminalne', truncated: 'Ucięte okno sesji',
    logWindow: 'Ucięte okno logów', retainedLogs: 'Zdarzenia / bufor + archiwum ostatniego zadania',
    noOperations: 'Źródło operacji niedostępne', logMissing: 'Źródło logów niedostępne', noEvents: 'Brak powiązanych zdarzeń w buforze',
    identityNote: 'Tożsamość to obserwacja klienta/sesji, nie zidentyfikowana osoba ani LLM.',
    missingMetrics: 'Rodzaj klienta wynika z prefiksu ID; RAM klienta i równoległość nie są raportowane.',
    transportLink: 'Połączenie transportowe', noSelection: 'Wybierz tożsamość, aby sprawdzić jej źródła.',
  },
};
const openStates = ['running', 'sending', 'queued', 'needs_reconciliation', 'unknown'];
const nonempty = value => typeof value === 'string' && value.length > 0;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
function operationsFor(agent, operations) {
  if (!Array.isArray(operations)) return null;
  return [...new Map(operations.filter(op =>
    nonempty(op.clientId) && nonempty(agent.id) && op.clientId === agent.id ||
    nonempty(op.sessionId) && nonempty(agent.sessionId) && op.sessionId === agent.sessionId
  ).map(op => [op.id, op])).values()];
}
function workCounts(operations) {
  if (!Array.isArray(operations)) return null;
  const counts = Object.fromEntries(openStates.map(state => [state, 0]));
  for (const op of operations) if (openStates.includes(op.state)) counts[op.state]++;
  counts.open = openStates.reduce((sum, state) => sum + counts[state], 0);
  counts.unresolved = counts.unknown + counts.needs_reconciliation;
  counts.terminal = operations.length - counts.open;
  return counts;
}
function correlatedEvents(agent, operations, logs) {
  if (!Array.isArray(logs)) return null;
  const identities = new Set([agent.id, agent.sessionId].filter(nonempty));
  const tasks = new Set((operations || []).map(op => op.id).filter(nonempty));
  const requests = new Set((operations || []).map(op => op.requestId).filter(nonempty));
  return [...new Map(logs.filter(log => identities.has(log.agentId) || tasks.has(log.taskId) || requests.has(log.requestId))
    .map(log => [log.id, log])).values()].slice(-20);
}
function identityCounts(agents, available) {
  if (!Array.isArray(agents)) return null;
  const current = agents.filter(agent => available !== false && agent.presence === 'observed').length;
  return { current: agents.every(agent => agent.source === 'job-history') ? null : current, history: agents.length - current, total: agents.length,
    untracked: agents.filter(agent => agent.source === 'job-history').length,
    unknown: agents.filter(agent => agent.source !== 'job-history' && (available === false || !agent.presence || agent.presence === 'unknown')).length };
}
function render(ctx) {
  const { ui, snapshot: s, state, rect: r, language, focus } = ctx;
  const T = key => (words[language] || words.en)[key];
  if (r.width < 30 || r.height < 12) { ui.empty(r, ui.L('agentList'), ui.L('resize')); return; }
  const enrich = agent => {
    const operations = operationsFor(agent, s.operations);
    return { ...agent, operations, counts: workCounts(operations) };
  };
  const rows = Array.isArray(ctx.rows) ? ctx.rows.map(enrich) : null;
  const selectedId = typeof ctx.selected === 'string' ? ctx.selected : ctx.selected?.id || state.selectedId;
  const selected = rows?.find(row => row.id === selectedId);
  const counts = identityCounts(s.agents, s.available);
  const value = number => number === null || number === undefined ? ui.L('unknown') : ui.number(number);
  const presence = row => s.available === false ? 'unknown' : row.presence || 'unknown';
  const work = row => !row.counts ? ui.L('unknown') : row.counts.open ?
    ['running', 'sending', 'queued'].filter(key => row.counts[key]).map(key => `${ui.statusText(key)} ${value(row.counts[key])}`)
      .concat(row.counts.unresolved ? [`${T('unresolved')} ${value(row.counts.unresolved)}`] : []).join('; ') : T('noOpen');
  let x = r.x;
  for (const scope of ['current', 'history', 'all']) {
    const count = counts?.[scope === 'all' ? 'total' : scope];
    const width = Math.min(18, Math.floor((r.width - 28) / 3));
    ui.badge(x, r.y, `${T(scope)} ${scope === 'current' && count === null ? '—' : value(count)}`, { width, active: state.filters?.scope === scope,
      action: { type: 'filter', field: 'scope', value: scope } });
    x += width + 1;
  }
  for (const [key, label] of [['/', '/'], ['f', 'f'], ['o', 'o']]) {
    if (x + 5 > r.x + r.width) break;
    const count = key === 'f' ? require('../console-filters').activeFilters(state).length : 0;
    x += ui.badge(x, r.y, label + (count ? ' ' + count : ''), { width: 5, active: count > 0, action: { type: 'key', key } }) + 1;
  }
  ui.text({ x: r.x, y: r.y + 1, width: r.width, height: 1 },
    counts?.current === null ? T('noSignals') : `${T('retained')} · ${T('unknown')}: ${value(counts?.unknown)} / ${value(counts?.total)}`, { fg: 'muted' });
  const body = { x: r.x, y: r.y + 3, width: r.width, height: r.height - 3 };
  const wide = ctx.profile === 'wide' && body.width >= 130 && body.height >= 24;
  const rail = ctx.extraWide && wide ? 31 : 0;
  const main = { ...body, x: body.x + rail, width: body.width - rail };
  const tableWidth = wide ? Math.floor((main.width - 1) * 0.61) : main.width;
  const tableHeight = wide ? main.height : Math.max(7, main.height - (ctx.profile === 'compact' ? 7 : 9));
  const tableRect = { ...main, width: tableWidth, height: tableHeight };
  ui.table('agents-list', tableRect, rows, [
    { key: 'id', label: ui.L('identity'), min: 19, flex: true, sort: 'name' },
    { key: 'clientKind', label: T('transportKind'), width: 18, optional: true, priority: 2,
      value: row => require('../console-client-identity').clientKind(row.id) },
    { key: 'presence', label: ui.L('presence'), width: wide ? 20 : 15,
      value: row => require('../console-client-identity').presenceText({ ...row, presence: presence(row) }, ui), tone: row => row.source === 'job-history' ? 'muted' : ui.tone(presence(row)) },
    { key: 'work', label: ui.L('work'), width: wide ? 24 : 19, value: work },
    ...(rows?.some(row => row.lastSeen != null) ? [{ key: 'lastSeen', label: T('signal'), width: 12, optional: true, priority: 2, value: row => row.lastSeen == null ? ui.L('unknown') : ui.age(row.lastSeen), sort: 'time' }] : []),
    { key: 'open', label: T('open'), width: 8, optional: true, priority: 1, align: 'right', value: row => value(row.counts?.open) },
  ], { state, title: ui.L('agentList'), kind: 'agents', focus: 0, focused: focus === 0, badge: s.available === false ? ui.L('lastKnown') : undefined,
    toolbar: false, sourceCount: counts?.total, emptyTitle: rows === null ? ui.L('noData') : T('noAgents'),
    emptyHint: s.available === false ? s.reason || T('stale') : s.mode === 'broker' ? T('noLive') : ui.L('noCurrentHint') });
  const details = wide ? { x: main.x + tableWidth + 1, y: main.y, width: main.width - tableWidth - 1, height: main.height }
    : { x: main.x, y: main.y + tableHeight, width: main.width, height: main.height - tableHeight };
  let bx = details.x;
  const buttons = selected ? [
    [T('details'), { type: 'details', row: selected, kind: 'agents' }],
    [T('tasks'), { type: 'related-records', kind: 'tasks', row: selected }],
    [T('logs'), { type: 'related-records', kind: 'logs', row: selected }],
  ] : [];
  buttons.push([T('system'), { type: 'navigate', tab: 4 }]);
  for (const [label, action] of buttons) {
    const width = Math.min(12, details.x + details.width - bx);
    if (width < 5) break;
    bx += ui.badge(bx, details.y, label, { width, action }) + 1;
  }
  const evidence = [
    { label: ui.L('mode'), value: s.mode }, { label: ui.L('presenceSource'), value: s.source },
    { label: ui.L('updated'), value: ui.date(s.readAt) }, { label: T('sourceTime'), value: ui.date(s.observedAt) },
    { label: ui.L('sourceReason'), value: s.reason || (s.available === true ? ui.L('observed') : ui.L('unknown')), full: true },
    ...[['sessionsRead', 'sessions'], ['terminalTruncated', 'omitted'], ['sessionsTruncated', 'truncated'], ['logWindowTruncated', 'logWindow']]
      .filter(([key]) => s.retention?.[key] !== undefined).map(([key, label]) => ({ label: T(label), value: String(s.retention[key]) })),
    ...(s.logWarning ? [{ label: ui.L('sourceReason'), value: s.logWarning, full: true }] : []),
    ...(s.clientPresence ? [
      { label: language === 'pl' ? 'Pliki obecności klientów' : 'Client heartbeat files', value: s.clientPresence.filesRead },
      { label: language === 'pl' ? 'Pominięte pliki obecności' : 'Omitted heartbeat files', value: s.clientPresence.filesOmitted },
      { label: language === 'pl' ? 'Błędy odczytu obecności' : 'Heartbeat read errors', value: s.clientPresence.errors },
    ] : []),
  ];
  const fields = selected ? [
    { label: 'ID', value: selected.id, full: true }, { label: T('transportKind'), value: require('../console-client-identity').clientKind(selected.id) },
    { label: ui.L('presence'), value: require('../console-client-identity').presenceText({ ...selected, presence: presence(selected) }, ui), tone: ui.tone(presence(selected)) },
    ...(selected.source === 'job-history' ? [{ label: ui.L('sourceReason'), value: T('noSignals'), full: true }] : []),
    ...(selected.id?.startsWith('mcp-stdio:') ? [{ label: 'MCP stdio', value: T('mcpNote'), full: true }] : []),
    { label: ui.L('work'), value: work(selected), full: true }, { label: ui.L('presenceSource'), value: selected.source },
    { label: ui.L('heartbeat'), value: ui.date(selected.lastSeen) },
    ...(selected.lastSeen != null && selected.source?.endsWith('process-heartbeat') ? [{ label: T('freshness'), value: Number.isFinite(timestamp(selected.lastSeen)) && ui.now - timestamp(selected.lastSeen) >= 0 && ui.now - timestamp(selected.lastSeen) <= 15000 ? T('fresh') : T('old') }] : []),
    ...(selected.pid ? [{ label: 'PID', value: selected.pid }, { label: ctx.language === 'pl' ? 'Procesy o tym ID' : 'Processes with this ID', value: selected.processCount ?? 1 }] : []),
    { label: 'Session ID', value: selected.sessionId || T('unavailable') }, { label: ui.L('fullPath'), value: s.project, full: true },
    { label: T('transportLink'), value: ui.L('unknown') }, { label: ui.L('identity'), value: T('identityNote'), full: true },
    { label: ui.L('resources'), value: T('missingMetrics'), full: true },
    { group: T('work') }, { label: T('open'), value: value(selected.counts?.open) },
    { label: T('unresolved'), value: value(selected.counts?.unresolved) }, { label: T('terminal'), value: value(selected.counts?.terminal) },
  ] : [{ label: T('details'), value: T('noSelection'), full: true }];
  if (selected) {
    if (!selected.operations) fields.push({ label: ui.L('source'), value: T('noOperations') });
    for (const op of [...(selected.operations || [])].sort((a, b) => Number(openStates.includes(b.state)) - Number(openStates.includes(a.state)))) {
      fields.push({ group: T('operation') }, { label: 'ID', value: op.id, full: true },
        { label: ui.L('state'), value: ui.statusText(op.state), tone: op.outcomeScope === 'transport' ? 'muted' : ui.tone(op.state) },
        { label: ui.L('purpose'), value: op.description || ui.L('noDescription'), full: true },
        { label: ui.L('operation'), value: op.label || op.kind }, ...require('../console-document').documentFields(op, ui),
        { label: ui.L('started'), value: ui.date(op.startedAt) }, { label: ui.L('finished'), value: ui.date(op.finishedAt) });
      if (op.outcomeScope === 'transport') fields.push({ label: ui.L('result'), value: T('transport'), full: true }, { label: 'HTTP', value: op.httpStatus });
    }
    const logs = correlatedEvents(selected, selected.operations, s.taskEvents?.logs?.length ? [...(s.logs || []), ...s.taskEvents.logs] : s.logs);
    fields.push({ group: T('retainedLogs') });
    if (!logs?.length) fields.push({ label: ui.L('source'), value: logs === null ? T('logMissing') : T('noEvents'), full: true });
    for (const log of logs || []) fields.push({ label: `${ui.date(log.timestamp)} · ${ui.statusText(log.level)}`, value: `${log.component || ''} ${log.message || ''}`, tone: ui.tone(log.level), full: true });
  }
  if (!rail) fields.push({ group: T('evidence') }, ...evidence);
  const viewport = ctx.detailState || (state.agentDetails ||= { offset: 0 });
  if (viewport.identity !== selectedId) { viewport.identity = selectedId; viewport.offset = 0; }
  ui.fields('agents-details', { ...details, y: details.y + 1, height: details.height - 1 }, T('details'), fields, viewport, { focus: 1, focused: focus === 1 });
  if (rail) {
    const width = rail - 1, top = Math.min(8, body.height), hostHeight = Math.min(10, Math.max(0, body.height - top - 8));
    ui.fields('agents-counts', { ...body, width, height: top }, ui.L('state'), [
      { label: T('current'), value: counts?.current === null ? '—' : value(counts?.current) }, { label: T('history'), value: value(counts?.history) },
      { label: T('untracked'), value: value(counts?.untracked) }, { label: ui.L('all'), value: value(counts?.total) },
    ], state.agentCounts ||= { offset: 0 }, { focus: 2, focused: focus === 2 });
    if (hostHeight >= 6) {
      const host = s.host || {}, area = ui.panel('agents-host', { x: body.x, y: body.y + top + 1, width, height: hostHeight }, ui.L('resources'), { focus: 3, focused: focus === 3 });
      ui.put(area.x, area.y, 'CPU', 5, 'muted');
      ui.bar({ ...area, x: area.x + 5, width: area.width - 5, height: 1 }, Number.isFinite(host.cpuPercent) ? host.cpuPercent / 100 : null,
        { value: Number.isFinite(host.cpuPercent) ? ui.number(Math.round(host.cpuPercent * 10) / 10) + '%' : ui.L('unknown') });
      ui.put(area.x, area.y + 1, 'RAM', 5, 'muted');
      ui.bar({ ...area, x: area.x + 5, y: area.y + 1, width: area.width - 5, height: 1 }, host.ramTotalBytes > 0 ? host.ramUsedBytes / host.ramTotalBytes : null, { value: ui.bytes(host.ramUsedBytes) });
      ui.scroll('agents-host-values', { ...area, y: area.y + 3, height: Math.max(1, area.height - 3) }, ui.kvLines([
        { label: ui.L('host'), value: host.hostname }, { label: 'RAM', value: ui.bytes(host.ramUsedBytes) + ' / ' + ui.bytes(host.ramTotalBytes) },
        { label: 'Load', value: host.load?.map(value => ui.number(Math.round(value * 100) / 100)).join(' / ') },
      ], area.width - 2), state.agentHost ||= { offset: 0 }, { kind: 'details', focus: 3 });
    }
    const y = body.y + top + 1 + (hostHeight >= 6 ? hostHeight + 1 : 0);
    ui.fields('agents-evidence', { x: body.x, y, width, height: body.y + body.height - y }, T('evidence'), evidence,
      state.agentEvidence ||= { offset: 0 }, { focus: 4, focused: focus === 4 });
  }
}
module.exports = { render, operationsFor, workCounts, correlatedEvents, identityCounts };
