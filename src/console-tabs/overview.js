'use strict';

const OPEN = new Set(['queued', 'running', 'sending', 'needs_reconciliation', 'unknown']);
const words = {
  en: { saved: 'Snapshot', unresolved: 'Unresolved', sending: 'Sending', history: 'History identities', presence: 'Presence not established', open: 'Open in snapshot', finished: 'Recent finishes', events: 'Recent log entries', hostMissing: 'Host measurements unavailable', sdk: 'Physical SDK activity: no observation', savedDocument: 'Document (saved)', retained: 'Project / retained window', instance: 'Instance counters', outcome: 'Recorded outcome', emptyOpen: 'No open records in snapshot', emptyHistory: 'No finished records in retained window', emptyAgents: 'No identities in retained window', emptyLogs: 'No entries in retained window', transport: 'Transport only', cad: 'CAD validation not established', observed: 'Observed process + heartbeat', limited: 'Limited', unavailable: 'Unavailable', details: 'Sources and limits' },
  pl: { saved: 'Migawka', unresolved: 'Nierozstrzygnięte', sending: 'Wysyłane', history: 'Tożsamości w historii', presence: 'Obecność niepotwierdzona', open: 'Otwarte w migawce', finished: 'Ostatnio zakończone', events: 'Ostatnie wpisy logów', hostMissing: 'Pomiary hosta niedostępne', sdk: 'Fizyczna aktywność SDK: brak obserwacji', savedDocument: 'Dokument (zapis)', retained: 'Projekt / okno retencji', instance: 'Liczniki instancji', outcome: 'Zapisany wynik', emptyOpen: 'Brak otwartych rekordów w migawce', emptyHistory: 'Brak zakończonych w oknie retencji', emptyAgents: 'Brak tożsamości w oknie retencji', emptyLogs: 'Brak wpisów w oknie retencji', transport: 'Tylko transport', cad: 'Walidacja CAD niepotwierdzona', observed: 'Potwierdzony proces + heartbeat', limited: 'Ograniczone', unavailable: 'Niedostępne', details: 'Źródła i ograniczenia' },
};
const time = value => {
  if (value === null || value === undefined || value === '') return -Infinity;
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) ? result : -Infinity;
};
const byId = (a, b) => String(a.id).localeCompare(String(b.id));
function selectOverview(snapshot) {
  const operations = Array.isArray(snapshot.operations) ? snapshot.operations : null;
  const rank = row => ['needs_reconciliation', 'unknown'].includes(row.state) ? 0 : ['running', 'sending'].includes(row.state) ? 1 : 2;
  const open = operations && operations.filter(row => OPEN.has(row.state)).sort((a, b) => {
    const group = rank(a) - rank(b);
    if (group) return group;
    if (a.state === 'queued' && b.state === 'queued' && Number.isFinite(a.order) && Number.isFinite(b.order)) return a.order - b.order || byId(a, b);
    const left = time(a.startedAt ?? a.submittedAt), right = time(b.startedAt ?? b.submittedAt);
    return (left === right ? 0 : left < right ? -1 : 1) || byId(a, b);
  });
  const history = operations && operations.filter(row => !OPEN.has(row.state)).sort((a, b) => {
    const left = time(a.finishedAt), right = time(b.finishedAt);
    return (left === right ? 0 : left > right ? -1 : 1) || byId(a, b);
  });
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents.slice().sort((a, b) => Number(b.presence === 'observed') - Number(a.presence === 'observed') || byId(a, b)) : null;
  const allLogs = Array.isArray(snapshot.logs) ? [...new Map(snapshot.logs.map(row => [row.id, row])).values()].reverse() : null;
  const logs = allLogs && allLogs.filter(row => !['heartbeat', 'job_progress'].includes(row.event));
  return { open, history, agents, logs, allLogs, counts: operations && {
    running: operations.filter(row => row.state === 'running').length,
    queued: operations.filter(row => row.state === 'queued').length,
    sending: operations.filter(row => row.state === 'sending').length,
    unresolved: operations.filter(row => ['needs_reconciliation', 'unknown'].includes(row.state)).length,
  } };
}

function render(ctx) {
  const { ui, rect: r, state, focus = 0 } = ctx;
  const s = state.frozenSnapshot || ctx.snapshot || {};
  const d = selectOverview(s), W = words[ctx.language === 'pl' ? 'pl' : 'en'];
  const filtered = Array.isArray(ctx.rows) ? selectOverview({ ...s, operations: ctx.rows }) : d;
  const unknown = ui.L('unknown'), count = rows => rows === null ? unknown : ui.number(rows.length);
  const n = value => Number.isFinite(value) ? ui.number(value) : unknown;
  const status = value => ui.statusText(value);
  const viewports = state.overviewPanels ||= {};
  const viewport = id => viewports[id] ||= { offset: 0, selectedId: null, follow: false };
  const navigation = (tab, scope, id) => ({ type: 'navigate', tab, ...(id === undefined ? {} : { id }), ...(scope ? { filters: { scope } } : {}) });
  const destination = [ { type: 'key', key: 'b' }, navigation(4), navigation(4), navigation(1, 'all'), navigation(2, 'all'), navigation(2, 'history'), navigation(3, 'all') ];
  const ids = ['overview-broker', 'overview-fusion', 'overview-host', 'overview-agents', 'overview-recent', 'overview-history', 'overview-events'];
  const titles = [ctx.language === 'pl' ? 'Bieżący stan' : 'Current state', 'Fusion', ui.L('resources'), ui.L('agentList'), W.open, W.finished, W.events];
  const counter = d.counts ? `${ui.L('active')}: ${n(d.counts.running)} · ${ui.L('waiting')}: ${n(d.counts.queued)} · ${W.sending}: ${n(d.counts.sending)} · ${W.unresolved}: ${n(d.counts.unresolved)}` : ui.L('sourceUnavailable');
  const retention = s.retention || {}, broker = s.broker || {}, fusion = s.fusion || {};
  const sourceTime = `${W.saved}: ${ui.date(s.observedAt)}`;
  const brokerFields = [
    { label: ui.L('state'), value: s.mode === 'direct' ? ui.L('unused') : status(s.available === false ? 'UNKNOWN' : broker.state), tone: ui.tone(s.available === false ? 'unknown' : broker.state) },
    { label: broker.online === true ? W.instance : ui.L('retained'), value: s.mode === 'direct' ? ui.L('queuedNA') : broker.online === true ? `${ui.L('active')}: ${n(broker.activeOperations)} · ${ui.L('waiting')}: ${n(broker.queued)}` : `${count(d.history)} ${ui.L('records')} · ${ui.L('scopeProject')}` },
    { label: W.unresolved, value: broker.unresolved === undefined ? unknown : broker.unresolved ? ctx.language === 'pl' ? 'tak' : 'yes' : ctx.language === 'pl' ? 'nie' : 'no', tone: broker.unresolved ? 'warning' : 'muted' },
    { label: ui.L('controls'), value: ui.L(s.capabilities?.brokerControl ? 'enabled' : 'readOnly') },
    { label: W.saved, value: ui.date(s.observedAt) },
  ];
  const fusionFields = [
    { label: ui.L('connectivity'), value: status(fusion.connectivity), tone: ui.tone(fusion.connectivity) },
    { label: 'SDK', value: ui.L('noObservation') },
    { label: W.savedDocument, value: fusion.document },
    { label: ui.L('version'), value: fusion.version },
    { label: W.saved, value: ui.date(fusion.observedAt) },
    { label: ui.L('source'), value: fusion.source, full: true },
  ];
  const host = s.host || s.system?.host;
  const hostFields = host ? [
    { label: ui.L('host'), value: host.hostname },
    { label: 'CPU', value: Number.isFinite(host.cpuPercent) ? ui.number(Math.round(host.cpuPercent * 10) / 10) + '%' : ui.L('unknown') },
    { label: 'RAM', value: ui.bytes(host.ramUsedBytes) + ' / ' + ui.bytes(host.ramTotalBytes) },
    { label: ui.L('load'), value: Array.isArray(host.load) ? host.load.map(value => ui.number(Math.round(value * 100) / 100)).join(' / ') : null },
    { label: ui.L('updated'), value: ui.age(s.system?.readAt) },
  ] : [{ label: ui.L('host'), value: W.hostMissing, full: true }];
  const presenceSummary = require('../console-client-identity').presenceSummary(s, ui);
  const agentSummary = d.agents === null ? ui.L('sourceUnavailable') : `${presenceSummary} · ${W.history}: ${n(d.agents.filter(a => a.source === 'job-history').length)}`;
  const result = row => `${status(row.state)} · ${row.outcomeScope === 'transport' ? W.transport : W.outcome}`;
  const taskText = row => `${row.id} · ${result(row)} · ${row.description || row.label || row.kind || unknown}`;
  const agentText = row => `${row.id} · ${row.source === 'job-history' ? ui.L('historyOnly') : status(row.presence)} · ${ui.L('heartbeat')}: ${ui.date(row.lastSeen)}`;
  const logText = row => `${ui.date(row.timestamp)} · ${status(row.level)} · ${row.message || unknown}`;
  const summary = [
    `${status(s.mode)} · ${s.mode === 'direct' ? ui.L('unused') : status(broker.state)} · ${s.available === false || broker.lastKnown ? ui.L('lastKnown') : W.saved}`,
    `${ui.L('connectivity')}: ${status(fusion.connectivity)} · SDK: ${ui.L('noObservation')}`,
    host ? `CPU ${Number.isFinite(host.cpuPercent) ? ui.number(Math.round(host.cpuPercent * 10) / 10) + '%' : unknown} · RAM ${ui.bytes(host.ramUsedBytes)} / ${ui.bytes(host.ramTotalBytes)}` : W.hostMissing, agentSummary, counter,
    `${W.retained}: ${count(d.history)}${retention.terminalTruncated ? ' · ' + W.limited : ''}`,
    `${W.retained}: ${count(d.logs)}${retention.logWindowTruncated ? ' · ' + W.limited : ''}`,
  ];
  function section(index, area, rows, format, emptyTitle, lines) {
    if (area.height < 1 || area.width < 4) return;
    const id = ids[index], vp = viewport(id);
    ui.panels.push({ id, ...area, focus: index, kind: index === 6 ? 'logs' : 'details' });
    ui.badge(area.x, area.y, `${titles[index]} · ${summary[index]}`, { width: area.width, active: focus === index, action: destination[index] });
    if (area.height === 1) return;
    const body = { ...area, y: area.y + 1, height: area.height - 1 };
    if (rows === null) { ui.scroll(id, body, ui.wrap(ui.L('sourceUnavailable'), body.width), vp, { kind: 'details', focus: index }); return; }
    if (rows && !rows.length) { ui.scroll(id, body, ui.wrap(emptyTitle, body.width), vp, { kind: 'details', focus: index }); return; }
    const content = rows ? rows.map(row => ({ text: format(row), fg: ui.tone(row.state || row.presence || row.level) })) : lines;
    ui.scroll(id, body, content || [], vp, { kind: 'details', focus: index });
    if (rows) rows.slice(vp.offset, vp.offset + body.height).forEach((row, i) => {
      const scope = index === 3 ? row.presence === 'observed' ? 'current' : 'history' : index === 4 ? 'open' : index === 5 ? 'history' : 'all';
      ui.hit({ x: body.x, y: body.y + i, width: Math.max(1, body.width - 2), height: 1 }, navigation(index === 3 ? 1 : index === 6 ? 3 : 2, scope, row.id));
    });
  }
  function fields(index, area, values) {
    if (index === 2 && host && area.height >= 7) {
      const inside = ui.panel(ids[index], area, titles[index], { focus: index, focused: focus === index, badge: host.hostname });
      const speed = value => !Number.isFinite(value) ? unknown : value < 1024 ? ui.number(Math.round(value)) + ' B/s' : ui.number(Math.round(value / 1024 * 10) / 10) + ' KiB/s';
      for (const [row, name, ratio, value] of [
        [0, 'CPU', Number.isFinite(host.cpuPercent) ? host.cpuPercent / 100 : null, Number.isFinite(host.cpuPercent) ? ui.number(Math.round(host.cpuPercent * 10) / 10) + '%' : unknown],
        [1, 'RAM', host.ramTotalBytes > 0 ? host.ramUsedBytes / host.ramTotalBytes : null, ui.bytes(host.ramUsedBytes) + ' / ' + ui.bytes(host.ramTotalBytes)],
        [2, 'Swap', host.swapTotalBytes > 0 ? host.swapUsedBytes / host.swapTotalBytes : null, host.swapTotalBytes === 0 ? ui.bytes(0) : ui.bytes(host.swapUsedBytes) + ' / ' + ui.bytes(host.swapTotalBytes)],
        [3, ctx.language === 'pl' ? 'Dysk' : 'Disk', host.disk?.totalBytes > 0 ? host.disk.usedBytes / host.disk.totalBytes : null, ui.bytes(host.disk?.usedBytes) + ' / ' + ui.bytes(host.disk?.totalBytes)],
      ]) {
        if (row >= inside.height - 1) break;
        ui.put(inside.x, inside.y + row, name, 5, 'muted');
        ui.bar({ x: inside.x + 6, y: inside.y + row, width: inside.width - 6, height: 1 }, ratio, { value, fg: ratio > 0.85 ? 'warning' : 'success' });
      }
      if (inside.height > 5) ui.put(inside.x, inside.y + 4, `${ctx.language === 'pl' ? 'Sieć' : 'Net'}: ↓ ${speed(host.network?.rxBytesPerSecond)}  ↑ ${speed(host.network?.txBytesPerSecond)}`, inside.width, 'accent');
      if (inside.height > 6) ui.put(inside.x, inside.y + 5, 'Load: ' + (host.load?.map(value => ui.number(Math.round(value * 100) / 100)).join(' / ') || unknown), inside.width, 'muted');
      if (inside.height > 7) ui.put(inside.x, inside.y + 6, `${ui.L('uptime')}: ${Number.isFinite(host.uptimeSeconds) ? ui.duration(host.uptimeSeconds * 1000) : unknown} · PID: ${n(host.processCount)}`, inside.width, 'muted');
      ui.put(inside.x, inside.y + inside.height - 1, ui.L('host') + ' · ' + ui.age(s.system?.readAt), inside.width, 'muted');
    } else ui.fields(ids[index], area, titles[index], values, viewport(ids[index]), { focus: index, focused: focus === index });
    ui.hit({ x: area.x + 2, y: area.y, width: Math.max(1, area.width - 4), height: 1 }, destination[index]);
  }
  function table(index, area, rows, kind, extra = {}) {
    const logs = index === 6, agents = index === 3;
    const columns = logs ? [
      { key: 'timestamp', label: ui.L('time'), width: 12, value: row => row.timestamp ? ui.date(row.timestamp).slice(11, 23) : '—' },
      { key: 'level', label: ui.L('level'), width: 7, value: row => status(row.level), tone: row => ui.tone(row.level) },
      { key: 'message', label: ui.L('message'), min: 12, flex: true },
      { key: 'component', label: ui.L('source'), width: 18, optional: true, priority: 2 },
    ] : agents ? [
      { key: 'id', label: ui.L('identity'), min: 12, flex: true },
      { key: 'presence', label: ui.L('presence'), width: 18, value: row => row.source === 'job-history' ? ui.L('historyOnly') : status(row.presence), tone: row => ui.tone(row.presence) },
    ] : [
      { key: 'id', label: s.mode === 'broker' ? '#' : 'ID', width: 8, value: row => Number.isFinite(row.order) ? ui.number(row.order) : String(row.id).slice(0, 8), tone: 'accent' },
      { key: 'state', label: ui.L('state'), width: 16, value: row => status(row.state), tone: row => ui.tone(row.state) },
      { key: 'clientId', label: ui.L('client'), width: 16, optional: true, priority: 3, tone: 'accent' },
      { key: 'document', label: ui.L('documentOrScript'), width: r.width >= 190 ? 30 : 18, optional: true, priority: 4,
        value: row => require('../console-document').documentLabel(row) },
      { key: 'label', label: ctx.language === 'pl' ? 'Polecenie / skrypt' : 'Command / script', min: 20, flex: true, value: row => (row.outcomeScope === 'transport' ? W.transport + ' · ' : '') + (row.description || row.label || row.kind || unknown) },
      { key: 'elapsed', label: ctx.language === 'pl' ? 'Łącznie' : 'Elapsed', width: 9, optional: true, priority: 5, align: 'right', value: row => Number.isFinite(row.startedAt) && Number.isFinite(row.finishedAt) && row.finishedAt >= row.startedAt ? ui.duration(row.finishedAt - row.startedAt) : null },
    ];
    ui.table(ids[index], area, rows, columns, { state: viewport(ids[index]), title: titles[index], focus: index, focused: focus === index, kind, toolbar: false, badge: `${W.retained}: ${count(rows)}`, emptyTitle: [null, null, null, W.emptyAgents, W.emptyOpen, W.emptyHistory, W.emptyLogs][index], emptyHint: rows === null ? ui.L('missingHint') : W.retained, ...extra });
    ui.hit({ x: area.x + 2, y: area.y + 1, width: Math.max(1, area.width - 4), height: 1 }, destination[index]);
  }
  if (r.width < 4 || r.height < 7) return;
  const area = (x, y, width, height) => ({ x: r.x + x, y: r.y + y, width, height });
  const wide = r.width >= 138 && r.height >= 34;
  if (wide) {
    const top = 11, bottom = Math.min(12, Math.max(8, Math.floor(r.height * 0.26))), middle = r.height - top - bottom - 2;
    const first = Math.floor((r.width - 2) * 0.43), second = Math.floor((r.width - 2) * 0.27), third = r.width - first - second - 2;
    fields(0, area(0, 0, first, top), [...brokerFields, { label: ui.L('open'), value: count(d.open) },
      { label: ctx.language === 'pl' ? 'Ostatni zapis' : 'Latest record', value: d.history?.[0] ? status(d.history[0].state) : unknown, tone: ui.tone(d.history?.[0]?.state) }]);
    fields(2, area(first + 1, 0, second, top), hostFields);
    ui.fields('overview-fusion', area(first + second + 2, 0, third, top), ctx.language === 'pl' ? 'Broker / klienci / Fusion' : 'Broker / clients / Fusion', [
      { label: ui.L('broker'), value: status(s.available === false ? 'UNKNOWN' : broker.state), tone: ui.tone(broker.state) },
      { label: ui.L('agents'), value: presenceSummary, tone: d.agents?.some(agent => agent.presence === 'observed') && s.available !== false ? 'success' : 'muted' },
      { label: ui.L('history'), value: d.agents === null ? unknown : n(d.agents.filter(agent => agent.presence !== 'observed').length) }, { label: 'Fusion', value: status(fusion.connectivity) },
      { label: ui.L('document'), value: fusion.document }, { label: ui.L('version'), value: fusion.version },
      { label: ui.L('observation'), value: ui.age(fusion.observedAt) },
    ], viewport('overview-fusion'), { focus: 1, focused: focus === 1 });
    const left = Math.floor((r.width - 1) * 0.72), right = r.width - left - 1;
    const recent = Array.isArray(ctx.rows) ? ctx.rows : !Array.isArray(s.operations) ? null : [...(d.open || []), ...(d.history || [])];
    table(4, area(0, top + 1, left, middle), recent, 'tasks', { title: ctx.language === 'pl' ? 'Lista zadań · ostatnie' : 'Recent task list', badge: `${ui.L('open')}: ${count(d.open)} · ${ui.L('history')}: ${count(d.history)}` });
    table(3, area(left + 1, top + 1, right, middle), d.agents, 'agents');
    const y = top + middle + 2, eventWidth = Math.floor((r.width - 1) * 0.65);
    table(6, area(0, y, eventWidth, bottom), d.logs && d.logs.slice(0, 10), 'logs', { title: ctx.language === 'pl' ? 'Ostatnie zdarzenia' : 'Recent events', sourceCount: d.logs?.length });
    const observations = d.allLogs && d.allLogs.filter(row => row.event === 'heartbeat').slice(0, 8);
    const inner = ui.panel('overview-observer', area(eventWidth + 1, y, r.width - eventWidth - 1, bottom), ctx.language === 'pl' ? 'Logi · obserwator' : 'Observer logs', { focus: 7, focused: focus === 7 });
    ui.scroll('overview-observer', inner, observations?.map(row => ({ text: `${row.timestamp ? ui.date(row.timestamp).slice(11, 19) : '—'}  ${require('../console-log-presentation').logMessage(row, ctx.language)}`, fg: 'muted' })) || [ui.L('noData')], viewport('overview-observer'), { kind: 'details', focus: 7 });
    return;
  }
  if (r.width >= 108 && r.height >= 24) {
    const half = Math.floor((r.width - 1) / 2);
    fields(0, area(0, 0, half, 7), brokerFields);
    fields(1, area(half + 1, 0, r.width - half - 1, 7), fusionFields);
    fields(2, area(0, 7, half, 4), hostFields);
    section(3, area(half + 1, 7, r.width - half - 1, 4), d.agents, agentText, W.emptyAgents);
    table(4, area(0, 11, r.width, 6), filtered.open, 'tasks');
    section(5, area(0, 17, r.width, 3), filtered.history, taskText, W.emptyHistory);
    section(6, area(0, 20, r.width, Math.min(6, r.height - 20)), d.logs, logText, W.emptyLogs);
    return;
  }
  const heights = r.height >= 18 ? [3, 2, 1, 2, 4, 2, 4] : [1, 1, 1, 1, 1, 1, 1];
  const lines = [
    ui.kvLines([{ label: W.instance, value: `${ui.L('active')}: ${n(broker.activeOperations)} · ${ui.L('waiting')}: ${n(broker.queued)}` }, { label: W.saved, value: ui.date(s.observedAt) }, ...brokerFields.slice(2)], r.width - 2),
    ui.wrap(`${W.savedDocument}: ${fusion.document || unknown} · ${ui.L('source')}: ${fusion.source || unknown} · ${ui.date(fusion.observedAt)}`, r.width - 2),
    [], [], [], [], [],
  ];
  let y = 0;
  heights.forEach((height, index) => {
    section(index, area(0, y, r.width, height), [undefined, undefined, undefined, d.agents, filtered.open, filtered.history, d.logs][index], [null, null, null, agentText, taskText, taskText, logText][index], [null, null, null, W.emptyAgents, W.emptyOpen, W.emptyHistory, W.emptyLogs][index], lines[index]);
    y += height;
  });
}
module.exports = { render, selectOverview };
