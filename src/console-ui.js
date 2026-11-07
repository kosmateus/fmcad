'use strict';
const kit = require('terminal-kit');
const { painter, clip, middle, pad, wrap } = require('./console-theme');
const { label } = require('./console-labels');
const { en, t, duration, number } = require('./i18n');

function createUI({ buffer, prefs = {}, language = 'en', now = Date.now() }) {
  const paint = painter(buffer, prefs), hits = [], panels = [];
  const L = (key, params) => label(key, language, params);
  const glyph = prefs.frames === 'ascii' ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', thumb: '#', track: '|', arrow: '>' }
    : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', thumb: '█', track: '│', arrow: '›' };
  const hit = (rect, action) => { if (rect.width > 0 && rect.height > 0) hits.push({ ...rect, ...action }); };
  const phases = { STOPPED: L('stopped'), UNKNOWN: L('unconfirmed'), RUNNING: language === 'pl' ? 'Pracuje' : 'Running',
    PAUSED: language === 'pl' ? 'Pauza' : 'Paused', PAUSING: language === 'pl' ? 'Wstrzymywanie' : 'Pausing',
    RESUMING: language === 'pl' ? 'Wznawianie' : 'Resuming', RECOVERY_BLOCKED: language === 'pl' ? 'Uzgodnienie wymagane' : 'Recovery blocked' };
  const statusText = value => phases[value] || (en['state_' + value] ? t('state_' + value, {}, language) : value === null || value === undefined || value === '' ? L('unknown') : String(value));
  const tone = state => ['running', 'sending'].includes(state) ? 'accent' : ['succeeded', 'completed', 'connected', 'observed', 'RUNNING'].includes(state) ? 'success'
    : ['failed', 'error', 'ERROR', 'RECOVERY_BLOCKED'].includes(state) ? 'danger'
      : ['queued', 'sending', 'needs_reconciliation', 'unknown', 'WARN', 'PAUSED', 'PAUSING', 'RESUMING', 'STOPPED', 'expired'].includes(state) ? 'warning' : state === 'INFO' ? 'accent' : 'muted';
  const date = value => {
    if (value === null || value === undefined || value === '') return L('unknown');
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : L('unknown');
  };
  const age = value => Number.isFinite(typeof value === 'number' ? value : Date.parse(value))
    ? duration(Math.max(0, now - (typeof value === 'number' ? value : Date.parse(value))), language) : L('unknown');
  const bytes = value => !Number.isFinite(value) ? L('unknown') : number(Math.round(value / 1073741824 * 10) / 10, language) + ' GiB';
  function panel(id, r, title, { focused = false, badge, focus, kind } = {}) {
    const { x, y, width: w, height: h } = r;
    panels.push({ id, ...r, focus, kind, title });
    paint.fill(x, y, w, h, 'background');
    paint.fill(x + 1, y + 1, w - 2, h - 2, 'surface');
    const border = focused ? 'accent' : 'border';
    paint.put(x, y, glyph.tl + glyph.h.repeat(Math.max(0, w - 2)) + glyph.tr, w, border, 'background');
    for (let row = 1; row < h - 1; row++) {
      paint.put(x, y + row, glyph.v, 1, border, 'background'); paint.put(x + w - 1, y + row, glyph.v, 1, border, 'background');
    }
    paint.put(x, y + h - 1, glyph.bl + glyph.h.repeat(Math.max(0, w - 2)) + glyph.br, w, border, 'background');
    const tag = badge === undefined ? '' : ` ${badge} `;
    paint.put(x + 2, y + 1, title.toLocaleUpperCase(language), Math.max(1, w - 5 - kit.stringWidth(tag)), 'accent', 'surface', { bold: true });
    if (tag && w > kit.stringWidth(tag) + 10) paint.put(x + w - kit.stringWidth(tag) - 2, y + 1, tag, kit.stringWidth(tag), 'muted');
    hit(r, { type: 'panel', panelId: id, focus, kind });
    return { x: x + 2, y: y + 2, width: Math.max(1, w - 4), height: Math.max(1, h - 3) };
  }
  function text(r, value, { fg = 'text', bg = 'surface', bold = false, align = 'left' } = {}) {
    paint.put(r.x, r.y, align === 'right' ? pad(value, r.width, true) : value, r.width, fg, bg, { bold });
  }
  function rule(r, y = r.y, title) {
    paint.put(r.x, y, glyph.h.repeat(r.width), r.width, 'border');
    if (title) paint.put(r.x + 1, y, ' ' + title + ' ', r.width - 2, 'muted');
  }
  function badge(x, y, value, { fg = 'accent', active = false, width, action, layer = 'view', disabled = false } = {}) {
    width ||= kit.stringWidth(value) + 2;
    const bg = active && !paint.mono ? 'accent' : 'raised';
    paint.put(x, y, pad(' ' + value + ' ', width), width, active && !paint.mono ? 'background' : disabled ? 'muted' : fg, bg,
      { bold: active, ...(active && paint.mono ? { inverse: true } : {}) });
    if (action && !disabled) hit({ x, y, width, height: 1 }, { ...action, layer });
    return width;
  }
  function empty(r, title, hint, { unavailable = false } = {}) {
    const width = Math.min(r.width - 2, 72), lines = wrap(hint || '', width);
    const y = r.y + Math.min(3, Math.max(0, Math.floor((r.height - lines.length - 2) / 3)));
    paint.put(r.x + 1, y, (unavailable ? '? ' : '— ') + title, r.width - 2, unavailable ? 'warning' : 'muted', 'surface', { bold: true });
    for (let i = 0; i < lines.length && y + i + 2 < r.y + r.height; i++) paint.put(r.x + 3, y + i + 2, lines[i], r.width - 4, 'muted');
  }
  function scrollbar(id, r, state, total, visible, { kind, focus, layer = 'view' } = {}) {
    if (total <= visible || r.height < 2) return;
    const max = Math.max(0, total - visible), thumb = Math.max(1, Math.floor(r.height * visible / total));
    const offset = Math.max(0, Math.min(max, state.offset || 0));
    const start = max ? Math.round((r.height - thumb) * offset / max) : 0;
    for (let i = 0; i < r.height; i++) paint.put(r.x, r.y + i, i >= start && i < start + thumb ? glyph.thumb : glyph.track, 1, i >= start && i < start + thumb ? 'accent' : 'border');
    hit(r, { type: 'scrollbar', viewportId: id, state, total, visible, kind, focus, thumbStart: start, thumbSize: thumb, layer });
  }
  function scroll(id, r, lines, state, options = {}) {
    state.offset = Math.max(0, Math.min(Math.max(0, lines.length - r.height), state.offset || 0));
    const width = r.width - (lines.length > r.height ? 2 : 0);
    for (let i = 0; i < r.height; i++) {
      const line = lines[state.offset + i]; if (!line) continue;
      if (typeof line === 'string') paint.put(r.x, r.y + i, line, width);
      else if (line.spans) for (const span of line.spans) paint.put(r.x + (span.x || 0), r.y + i, span.text, span.width || width - (span.x || 0), span.fg || 'text', 'surface', { bold: !!span.bold });
      else paint.put(r.x, r.y + i, line.text || '', width, line.fg || 'text', 'surface', { bold: !!line.bold });
    }
    hit(r, { type: 'viewport', viewportId: id, state, lines, total: lines.length, visible: r.height, ...options });
    scrollbar(id, { x: r.x + r.width - 1, y: r.y, width: 1, height: r.height }, state, lines.length, r.height, options);
  }
  function kvLines(fields, width, options = {}) {
    const lines = [], labelWidth = Math.max(1, Math.min(width - 3, options.labelWidth || Math.max(8, Math.min(22, Math.floor(width * 0.34)))));
    for (const field of fields) {
      if (field.group) { if (lines.length) lines.push(''); lines.push({ text: field.group.toLocaleUpperCase(language), fg: 'accent', bold: true }); continue; }
      const value = field.value === null || field.value === undefined || field.value === '' ? L('unknown') : String(field.value);
      if (field.block || field.full && kit.stringWidth(value) > width - labelWidth - 2) {
        lines.push(...wrap(field.label, width).map(text => ({ text, fg: 'muted' })));
        lines.push(...wrap(value, width).map(text => ({ text, fg: field.tone || 'text' })));
      } else {
        const content = wrap(value, Math.max(1, width - labelWidth - 2));
        const labels = options.columns ? wrap(field.label, labelWidth) : [field.label];
        for (let index = 0; index < Math.max(labels.length, content.length); index++) lines.push({ spans: [
          { text: labels[index] || '', width: labelWidth, fg: 'muted' },
          { x: labelWidth + 2, text: content[index] || '', width: width - labelWidth - 2, fg: field.tone || 'text' },
        ] });
      }
    }
    return lines;
  }
  function fields(id, r, title, values, state = {}, options = {}) {
    const area = panel(id, r, title, options);
    scroll(id, area, kvLines(values, Math.max(1, area.width - 2)), state, { kind: 'details', focus: options.focus, layer: options.layer });
    return area;
  }
  function allocate(columns, width) {
    const active = columns.map(column => ({ ...column, width: column.width || column.min || 10 }));
    const used = () => active.reduce((sum, column) => sum + column.width, 0) + Math.max(0, active.length - 1);
    while (used() > width) {
      const optional = active.filter(column => column.optional).sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
      if (!optional) break;
      active.splice(active.indexOf(optional), 1);
    }
    const flex = active.find(column => column.flex) || active.at(-1);
    if (flex) flex.width = Math.max(1, flex.width + width - used());
    let x = 0; return active.map(column => { const value = { ...column, x }; x += column.width + 1; return value; });
  }
  function toolbar(r, state, { sortable = true, source = false, sourceAvailable = false } = {}) {
    const count = require('./console-filters').activeFilters(state).length;
    const controls = r.width >= 32 ? [{ text: 'f ' + L('filters') + (count ? ' · ' + count : ''), width: count ? 16 : 12, key: 'f', active: count > 0 }] : [];
    if (sortable && r.width >= 70) controls.push({ text: 'o ' + L('sort'), width: 15, key: 'o' });
    if (source && r.width >= 100) controls.push({ text: 'p ' + L('code'), width: 12, key: 'p', disabled: !sourceAvailable });
    const queryWidth = Math.max(16, r.width - controls.reduce((sum, item) => sum + item.width + 1, 0));
    badge(r.x, r.y, '/ ' + (state.search || L('searchHint')), { width: queryWidth, fg: state.search ? 'text' : 'muted', action: { type: 'key', key: '/' } });
    let x = r.x + queryWidth + 1;
    for (const item of controls) { badge(x, r.y, item.text, { width: item.width, active: item.active, disabled: item.disabled, action: { type: 'key', key: item.key } }); x += item.width + 1; }
  }
  function table(id, r, rows, columns, { state = {}, title, focus, focused = false, kind = 'tasks', toolbar: showToolbar = true,
    emptyTitle, emptyHint, badge: tag, maxRows, sourceCount } = {}) {
    const area = panel(id, r, title || L(kind), { focused, focus, kind, badge: tag ?? (rows ? number(rows.length, language) : '—') });
    const tools = showToolbar && area.height >= 8 ? 2 : 0;
    if (tools) toolbar(area, state, { sortable: kind !== 'logs', source: kind === 'tasks' && rows?.some(row => row.sourcePath),
      sourceAvailable: !!rows?.find(row => row.id === state.selectedId)?.sourcePath });
    const headY = area.y + tools, bodyY = headY + 1, footerY = area.y + area.height - 1;
    const visible = Math.max(1, Math.min(maxRows || Infinity, footerY - bodyY));
    const availableWidth = area.width - 2, cols = allocate(columns, availableWidth);
    paint.fill(area.x, headY, area.width, 1, 'raised');
    for (const col of cols) {
      const caption = col.label.toLocaleUpperCase(language) + (col.sort && state.sort === col.sort ? col.sort === 'name' ? ' ↑' : ' ↓' : '');
      paint.put(area.x + col.x, headY, pad(caption, col.width, col.align === 'right'), col.width, 'accent', 'raised', { bold: true });
      if (col.x) paint.put(area.x + col.x - 1, headY, glyph.v, 1, 'border', 'raised');
      if (col.sort) hit({ x: area.x + col.x, y: headY, width: col.width, height: 1 }, { type: 'sort', sort: col.sort });
    }
    if (!rows || !rows.length) {
      empty({ x: area.x, y: bodyY, width: area.width, height: Math.max(1, footerY - bodyY) }, emptyTitle || L(rows ? 'noMatches' : 'noData'), emptyHint || L(rows ? 'clearFilters' : 'missingHint'), { unavailable: !rows });
      paint.put(area.x, footerY, L(rows ? 'partial' : 'sourceUnavailable'), area.width, 'muted');
      return { ...area, visible, rows: [] };
    }
    if (!rows.some(row => row.id === state.selectedId)) state.selectedId = rows[Math.min(state.lastSelectedIndex || 0, rows.length - 1)].id;
    if (state.follow && !state.frozen) state.offset = Math.max(0, rows.length - visible);
    if (state.renderedSelection !== state.selectedId) {
      const selected = rows.findIndex(row => row.id === state.selectedId);
      if (selected >= 0) {
        if (selected < (state.offset || 0)) state.offset = selected;
        if (selected >= (state.offset || 0) + visible) state.offset = selected - visible + 1;
      }
      state.renderedSelection = state.selectedId;
    }
    state.offset = Math.max(0, Math.min(Math.max(0, rows.length - visible), state.offset || 0));
    rows.slice(state.offset, state.offset + visible).forEach((row, index) => {
      const selected = row.id === state.selectedId && focused;
      const bg = selected ? 'selected' : index % 2 ? 'alternate' : 'surface';
      paint.fill(area.x, bodyY + index, area.width, 1, bg);
      for (const col of cols) {
        const value = col.value ? col.value(row) : col.key === 'message' ? require('./console-log-presentation').logMessage(row, language) : row[col.key];
        const fg = typeof col.tone === 'function' ? col.tone(row) : col.tone || 'text';
        paint.put(area.x + col.x, bodyY + index, pad(value ?? '—', col.width, col.align === 'right'), col.width, fg, bg,
          { ...(selected && paint.mono ? { inverse: true } : {}), bold: selected && col.key === 'state' });
      }
      hit({ x: area.x, y: bodyY + index, width: area.width - 1, height: 1 }, { type: 'row', id: row.id, row, state, kind, panelId: id, focus });
    });
    const total = sourceCount ?? rows.length;
    state.lastSelectedIndex = Math.max(0, rows.findIndex(row => row.id === state.selectedId));
    paint.put(area.x, footerY, `${state.offset + 1}–${Math.min(rows.length, state.offset + visible)} / ${rows.length}   ·   ${L('buffer')}: ${total}`, area.width, 'muted');
    hit({ x: area.x, y: bodyY, width: area.width, height: visible }, { type: 'viewport', viewportId: id, state, rows, total: rows.length, visible, kind, focus });
    // Row targets take priority over the enclosing viewport.
    const viewport = hits.pop(); hits.splice(Math.max(0, hits.length - Math.min(visible, rows.length - state.offset)), 0, viewport);
    scrollbar(id, { x: area.x + area.width - 1, y: bodyY, width: 1, height: visible }, state, rows.length, visible, { kind, focus });
    return { ...area, visible, rows, columns: cols };
  }
  function metric(r, name, value, { fg = 'accent', hint, action } = {}) {
    paint.fill(r.x, r.y, r.width, r.height, 'raised');
    paint.put(r.x + 1, r.y, name, r.width - 2, 'muted', 'raised');
    paint.put(r.x + 1, r.y + Math.min(1, r.height - 1), value ?? '—', r.width - 2, fg, 'raised', { bold: true });
    if (hint && r.height > 2) paint.put(r.x + 1, r.y + 2, hint, r.width - 2, 'muted', 'raised');
    if (action) hit(r, action);
  }
  function bar(r, ratio, { fg = 'success', value } = {}) {
    const width = Math.max(1, Math.min(12, r.width - 2)), known = Number.isFinite(ratio);
    const filled = known ? Math.round(Math.max(0, Math.min(1, ratio)) * width) : 0;
    paint.put(r.x, r.y, '[', 1, 'muted');
    for (let i = 0; i < width; i++) paint.put(r.x + i + 1, r.y, prefs.frames === 'ascii' ? i < filled ? '|' : ':' : i < filled ? '▎' : '│', 1, i < filled ? fg : 'meterEmpty');
    paint.put(r.x + width + 1, r.y, ']', 1, 'muted');
    if (value) paint.put(r.x + width + 3, r.y, value, r.width - width - 3, 'text');
  }
  return { ...paint, buffer, prefs, language, now, L, glyph, hits, panels, hit, panel, text, rule, badge, empty, scroll, scrollbar, fields, kvLines,
    table, toolbar, metric, bar, clip, middle, pad, wrap, statusText, tone, date, age, bytes, number: value => number(value, language), duration: value => duration(value, language) };
}
module.exports = { createUI };
