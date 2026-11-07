'use strict';

const words = {
  en: {
    actions: 'Quick actions', panel: 'Console', broker: 'Broker process', cpu: 'CPU / whole host',
    processCpu: 'CPU / one logical CPU = 100%', ram: 'RAM / OS used', swap: 'Swap', disk: 'Project filesystem',
    network: 'Network / bytes per second', processes: 'Observed local PIDs', locks: 'Beads / Dolt locks',
    noLocks: 'No authoritative passive lock source; a LOCK file does not establish an active lock.',
    sample: 'Unavailable or awaiting a second sample', refresh: 'Refresh', project: 'Project', settings: 'Settings',
    restart: 'Restart', probe: 'Probe Fusion', logs: 'Project logs', unknown: 'Unknown', unused: 'Not used',
    read: 'Host sampled', retained: 'Project logs / retained window', source: 'Telemetry source',
    observation: 'Last saved SDK observation', connectivity: 'Fusion connectivity', mode: 'Routing',
    queue: 'Queued / broker instance', executing: 'Active operations / broker instance', unresolved: 'Unresolved execution',
    missingCapability: 'Unavailable unless the primary supplies an explicit action capability.',
    noCadClaim: 'Process presence and transport completion do not establish CAD success or Fusion inactivity.',
    processScope: 'Process CPU can exceed 100%; memory is RSS. Presence is not service health.',
    retention: 'Retention / project', terminal: 'Completed operations omitted', truncatedLogs: 'Log window truncated',
    sessions: 'Direct sessions read', frozen: 'Frozen snapshot read', birth: 'Broker marker birth',
  },
  pl: {
    actions: 'Szybkie akcje', panel: 'Konsola', broker: 'Proces brokera', cpu: 'CPU / cały host',
    processCpu: 'CPU / jeden logiczny CPU = 100%', ram: 'RAM / zajęte według OS', swap: 'Swap', dysk: 'System plików projektu',
    disk: 'System plików projektu', network: 'Sieć / bajty na sekundę', processes: 'Zaobserwowane lokalne PID', locks: 'Blokady Beads / Dolt',
    noLocks: 'Brak wiarygodnego pasywnego źródła blokad; plik LOCK nie dowodzi aktywnej blokady.',
    sample: 'Brak pomiaru lub oczekiwanie na drugą próbkę', refresh: 'Odśwież', project: 'Projekt', settings: 'Ustawienia',
    restart: 'Restart', probe: 'Sprawdź Fusion', logs: 'Logi projektu', unknown: 'Nieustalone', unused: 'Nieużywany',
    read: 'Próbka hosta', retained: 'Logi projektu / okno retencji', source: 'Źródło telemetrii',
    observation: 'Ostatnia zapisana obserwacja SDK', connectivity: 'Łączność Fusion', mode: 'Routing',
    queue: 'Oczekujące / instancja brokera', executing: 'Aktywne operacje / instancja brokera', unresolved: 'Nierozstrzygnięte wykonanie',
    missingCapability: 'Niedostępne bez jawnego uprawnienia akcji przekazanego przez primary.',
    noCadClaim: 'Obecność procesu i zakończenie transportu nie potwierdzają sukcesu CAD ani bezczynności Fusion.',
    processScope: 'CPU procesu może przekroczyć 100%; pamięć oznacza RSS. Obecność nie oznacza sprawności usługi.',
    retention: 'Retencja / projekt', terminal: 'Pominięte zakończone operacje', truncatedLogs: 'Obcięte okno logów',
    sessions: 'Odczytane sesje direct', frozen: 'Odczyt zamrożonej migawki', birth: 'Birth z markera brokera',
  },
};
const known = Number.isFinite;
const percent = (value, ui) => known(value) ? ui.number(Math.round(value * 10) / 10) + '%' : ui.statusText(null);
const ratio = (used, total) => known(used) && known(total) && total > 0 ? used / total : null;

function systemSummary(snapshot = {}) {
  const system = snapshot.system || {};
  return { hostname: system.host?.hostname ?? snapshot.host?.hostname ?? null,
    cpuPercent: system.host?.cpuPercent ?? snapshot.host?.cpuPercent ?? null,
    ramUsedBytes: system.host?.ramUsedBytes ?? snapshot.host?.ramUsedBytes ?? null,
    ramTotalBytes: system.host?.ramTotalBytes ?? snapshot.host?.ramTotalBytes ?? null,
    readAt: system.readAt ?? null, brokerAlive: system.broker?.alive ?? null,
    locksStatus: system.locks?.status ?? 'unknown', reason: snapshot.reason ?? null };
}

function selectEvents(snapshot = {}, state = {}) {
  if (!Array.isArray(snapshot.logs)) return null;
  const f = state.filters || {}, query = String(state.search || '').toLocaleLowerCase();
  const timestamp = row => typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
  return snapshot.logs.filter(row => {
    if (f.level && !f.level.split(',').includes(row.level) || f.component && f.component !== row.component) return false;
    if (f.agent && ![row.agentId, row.clientId, row.sessionId].includes(f.agent)) return false;
    if (f.task && row.taskId !== f.task || f.request && row.requestId !== f.request) return false;
    const at = timestamp(row);
    if (f.since && (!known(at) || at < Date.parse(f.since)) || f.until && (!known(at) || at > Date.parse(f.until))) return false;
    return !query || [row.message, row.component, row.level, row.taskId, row.requestId, row.agentId]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(query));
  }).map((row, index) => ({ row, index, at: timestamp(row) }))
    .sort((a, b) => known(a.at) && known(b.at) ? b.at - a.at || a.index - b.index
      : known(a.at) ? -1 : known(b.at) ? 1 : a.index - b.index).map(item => item.row);
}

function render(ctx) {
  const { ui, rect: r, state, focus } = ctx;
  if (r.width < 12 || r.height < 6) return;
  const s = state.frozenSnapshot || ctx.snapshot || {}, system = s.system || {}, host = system.host || s.host || {};
  const W = words[ctx.language === 'pl' ? 'pl' : 'en'], L = ui.L;
  const field = (label, value, full = false, tone) => ({ label, value, full, tone });
  const yesNo = value => value === true ? L('enabled') : value === false ? L('disabled') : ui.statusText(null);
  const bytesPair = (used, total) => ui.bytes(used) + ' / ' + ui.bytes(total);
  const seconds = value => known(value) ? ui.duration(value * 1000) : ui.statusText(null);
  const vp = id => { state.systemViewports ||= {}; return state.systemViewports[id] ||= { offset: 0 }; };
  const options = n => ({ focus: n, focused: focus === n });
  const processFields = [];
  for (const [key, title] of [['panel', W.panel], ['broker', W.broker]]) {
    const p = system[key] || {};
    const presence = key === 'panel' ? known(p.pid) ? 'observed' : 'unknown'
      : p.alive === true ? 'observed' : p.alive === false ? 'offline' : 'unknown';
    processFields.push({ group: title }, field(L('state'), key === 'broker' && s.mode === 'direct' ? W.unused : ui.statusText(presence), false, ui.tone(presence)),
      field('PID', p.pid), field(W.processCpu, percent(p.cpuPercent, ui)), field('RSS', ui.bytes(p.rssBytes)), field(L('uptime'), seconds(p.uptimeSeconds)));
  }
  processFields.push(field(L('sourceReason'), W.processScope, true), field(W.birth, system.broker?.birth));
  const resourceFields = [field(L('host'), host.hostname), field(W.ram, bytesPair(host.ramUsedBytes, host.ramTotalBytes)),
    field(W.swap, bytesPair(host.swapUsedBytes, host.swapTotalBytes)), field(W.disk, bytesPair(host.disk?.usedBytes, host.disk?.totalBytes)),
    field(L('fullPath'), host.disk?.path), field(W.network, host.network?.interface
      ? host.network.interface + '  RX ' + (known(host.network.rxBytesPerSecond) ? ui.number(Math.round(host.network.rxBytesPerSecond)) : ui.statusText(null))
        + '  TX ' + (known(host.network.txBytesPerSecond) ? ui.number(Math.round(host.network.txBytesPerSecond)) : ui.statusText(null)) : null),
    field(L('load'), Array.isArray(host.load) ? host.load.map(value => ui.number(value)).join(' / ') : null),
    field(W.processes, host.processCount), field(L('uptime'), seconds(host.uptimeSeconds)), field(W.read, ui.date(system.readAt))];
  const lockReason = !system.locks?.reason || system.locks.reason === 'NO_PASSIVE_LOCK_SOURCE' ? W.noLocks : system.locks.reason;
  const contextFields = [field(W.mode, s.mode), field(L('fullPath'), s.project, true),
    field(W.source, s.source), field(L('updated'), ui.date(s.readAt)), field(L('lastKnown'), ui.date(s.observedAt)),
    field(W.broker, ui.statusText(s.broker?.state), false, ui.tone(s.broker?.state)),
    field(W.executing, s.broker?.activeOperations), field(W.queue, s.mode === 'direct' ? W.unused : s.broker?.queued),
    field(W.unresolved, yesNo(s.broker?.unresolved)), field(W.connectivity, ui.statusText(s.fusion?.connectivity)),
    field(W.observation, ui.date(s.fusion?.observedAt)), field(W.source, s.fusion?.source), field(L('version'), s.fusion?.version),
    field(L('document'), s.fusion?.document), field(W.locks, ui.statusText(system.locks?.status)), field(L('sourceReason'), lockReason, true),
    field(L('sourceReason'), s.reason, true), field(L('sourceReason'), s.logWarning, true),
    field(W.retention, W.noCadClaim, true), field(W.terminal, s.retention?.terminalTruncated),
    field(W.truncatedLogs, yesNo(s.retention?.logWindowTruncated)), field(W.sessions, s.retention?.sessionsRead),
    field(L('controls'), W.missingCapability, true)];
  if (state.frozenSnapshot) contextFields.unshift(field(W.frozen, ui.date(s.readAt)));
  const compact = r.width < 100 || r.height < 22;
  const topHeight = Math.min(compact ? 7 : r.height >= 32 ? 14 : 11, Math.max(3, r.height - 10));
  const top = { ...r, height: topHeight };
  const three = r.width >= 135 && !compact;
  const columns = compact ? 1 : three ? 3 : 2, gap = columns > 1 ? 1 : 0;
  const columnWidth = Math.floor((r.width - gap * (columns - 1)) / columns);
  const column = index => ({ x: r.x + index * (columnWidth + gap), y: r.y,
    width: index === columns - 1 ? r.width - index * (columnWidth + gap) : columnWidth, height: topHeight });
  if (compact) {
    ui.fields('system-summary', top, L('resources') + ' / Fusion',
      [field(W.cpu, percent(host.cpuPercent, ui)), ...resourceFields, ...processFields, ...contextFields], vp('summary'), options(0));
  } else {
    const area = ui.panel('system-resources', column(0), L('resources'), options(0));
    const half = Math.floor((area.width - 1) / 2);
    ui.metric({ x: area.x, y: area.y, width: half, height: 2 }, W.cpu, percent(host.cpuPercent, ui), { hint: W.sample });
    ui.metric({ x: area.x + half + 1, y: area.y, width: area.width - half - 1, height: 2 }, W.ram,
      percent(ratio(host.ramUsedBytes, host.ramTotalBytes) === null ? null : ratio(host.ramUsedBytes, host.ramTotalBytes) * 100, ui));
    ui.bar({ x: area.x, y: area.y + 2, width: half, height: 1 }, known(host.cpuPercent) ? host.cpuPercent / 100 : null);
    ui.bar({ x: area.x + half + 1, y: area.y + 2, width: area.width - half - 1, height: 1 }, ratio(host.ramUsedBytes, host.ramTotalBytes));
    ui.scroll('system-resources', { ...area, y: area.y + 3, height: area.height - 3 },
      ui.kvLines(three ? resourceFields : [...resourceFields, ...processFields], area.width - 2), vp('resources'), { kind: 'details', focus: 0 });
    if (three) ui.fields('system-processes', column(1), L('processContext'), processFields, vp('processes'), options(1));
    ui.fields('system-context', column(columns - 1), L('fusionTelemetry'), contextFields, vp('context'), options(2));
  }
  const actionRect = { x: r.x, y: r.y + topHeight, width: r.width, height: 5 };
  const actionArea = ui.panel('system-actions', actionRect, W.actions, options(3));
  // Capabilities are current, even while the data view is frozen. Primary owns every execution path.
  const capabilities = ctx.model?.snapshot?.capabilities || ctx.snapshot?.capabilities || {};
  const actions = [
    [W.refresh, { type: 'key', key: 'r' }, true], [W.project, { type: 'key', key: 'c' }, true],
    ['Broker', { type: 'key', key: 'b' }, capabilities.brokerControl === true],
    [W.settings, { type: 'key', key: ',' }, true],
    [W.restart, { type: 'system-action', action: 'restart' }, capabilities.restart === true],
    [W.probe, { type: 'system-action', action: 'probe' }, capabilities.probe === true],
    [W.locks, { type: 'system-action', action: 'locks' }, capabilities.locks === true],
    [W.logs, { type: 'navigate', tab: 3, filters: { scope: 'all' } }, true],
  ];
  const actionWidth = Math.floor(actionArea.width / 4);
  actions.forEach(([title, action, enabled], index) => ui.badge(actionArea.x + index % 4 * actionWidth,
    actionArea.y + Math.floor(index / 4), title, { width: actionWidth - 1, action, disabled: !enabled }));
  const bottom = { x: r.x, y: actionRect.y + actionRect.height, width: r.width,
    height: r.y + r.height - actionRect.y - actionRect.height };
  if (bottom.height < 5) return;
  const events = selectEvents(s, state), sidebar = r.width >= 180 && bottom.height >= 9;
  const detailWidth = sidebar ? Math.min(64, Math.floor(r.width * 0.3)) : 0;
  const tableRect = { ...bottom, width: sidebar ? bottom.width - detailWidth - 1 : bottom.width };
  const columnsDef = [{ key: 'timestamp', label: L('time'), width: tableRect.width >= 110 ? 23 : 8,
    value: row => row.timestamp == null ? ui.statusText(null) : tableRect.width >= 110 ? ui.date(row.timestamp) : ui.date(row.timestamp).slice(11, 19) },
    { key: 'level', label: L('level'), width: 6, tone: row => ui.tone(row.level) },
    { key: 'component', label: W.source, width: 14, optional: true, priority: 1 },
    { key: 'message', label: L('message'), min: 10, flex: true }];
  ui.table('system-events', tableRect, events, columnsDef, { state, title: W.retained, kind: 'logs',
    ...options(4), toolbar: true, emptyTitle: L(events === null ? 'noData' : 'noLogs'),
    emptyHint: s.logWarning || L(events === null ? 'missingHint' : 'partial'), sourceCount: s.logs?.length });
  if (sidebar) {
    const selected = events?.find(row => row.id === state.selectedId);
    const fields = selected ? [field(L('time'), ui.date(selected.timestamp)), field(L('level'), ui.statusText(selected.level), false, ui.tone(selected.level)),
      field(W.source, selected.component), field(L('message'), selected.message, true),
      ...['taskId', 'requestId', 'agentId'].filter(key => selected[key]).map(key => field(key, selected[key]))]
      : [field(L('details'), L('noSelection'), true)];
    ui.fields('system-event-details', { x: bottom.x + bottom.width - detailWidth, y: bottom.y, width: detailWidth, height: bottom.height },
      L('details'), fields, ctx.detailState || vp('eventDetails'), options(5));
  }
}

module.exports = { render, selectEvents, systemSummary, ratio };
