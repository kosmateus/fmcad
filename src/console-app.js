'use strict';
const kit = require('terminal-kit');
const { preferences, locale, t, savePreferences } = require('./i18n');
const { createAdapter } = require('./console-data');
const { ConsoleModel, BrokerControl, exportRows } = require('./console-controller');
const { resolveProject } = require('./console-project');
const { render } = require('./console-view');
const { pointerAction, scrollViewport } = require('./console-pointer');

function launchConsole({ project, config, stdin, stdout, loadConfig, signals, cwd }) {
  const ownedEvents = ['exit', 'beforeExit', 'asyncExit', 'SIGWINCH'];
  const before = new Map(ownedEvents.map(event => [event, new Set(process.listeners(event))]));
  const beforeResize = new Set(stdout.listeners?.('resize') || []);
  const term = kit.createTerminal({ stdin, stdout, stderr: stdout, generic: process.env.TERM || 'xterm' });
  const added = ownedEvents.flatMap(event => process.listeners(event).filter(listener => !before.get(event).has(listener)).map(listener => [event, listener]));
  const resizeListeners = (stdout.listeners?.('resize') || []).filter(listener => !beforeResize.has(listener));
  const wasRaw = stdin.isRaw;
  let prefs = preferences(), language = locale(prefs), cfg = {}, adapter, taskEventReader, buffer, ended = false, timer, noticeTimer;
  let modal = project ? null : { kind: 'project', input: '', prompt: t('pathPrompt', {}, language) };
  let message = prefs.warning ? t('preferenceWarning', {}, language) : '', detailScroll = 0, pendingControl = false;
  const model = new ConsoleModel(), control = new BrokerControl();
  const pointer = {}; let presentation = { hits: [], panels: [] }, redrawNotice = () => {};
  const tr = (key, params) => t(key, params, language);
  function notice(value) {
    message = value; clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { message = ''; if (!ended) redrawNotice(); }, 4000);
    noticeTimer.unref();
  }
  const configure = () => {
    try { cfg = loadConfig(config ? { config } : {}).cfg; }
    catch (error) {
      // A legacy direct config may still point at historical, read-only
      // observations. Never use it for execution or broker control.
      cfg = error.code === 'UNSUPPORTED_ROUTING' ? { routing: 'direct' } : {};
      notice(error.message);
    }
    adapter = createAdapter({ project, cfg });
    taskEventReader = project ? require('./console-task-events').createTaskEventReader(project, cfg) : null;
  };
  configure();
  return new Promise((resolve, reject) => {
    function cleanup(error) {
      if (ended) return; ended = true; clearInterval(timer); clearTimeout(noticeTimer);
      term.removeListener('key', key); term.removeListener('resize', resized); term.removeListener('mouse', mouse);
      signals.removeListener('SIGINT', quit); signals.removeListener('SIGTERM', quit);
      for (const [event, listener] of added) process.removeListener(event, listener);
      for (const listener of resizeListeners) stdout.removeListener('resize', listener);
      try { term.grabInput(false); if (wasRaw && stdin.setRawMode) stdin.setRawMode(true); term.styleReset(); term.hideCursor(false); term.fullscreen(false); }
      catch (restoreError) { error ||= restoreError; }
      term.shutdown = true;
      if (pendingControl) stdout.write(tr('uncertain') + '\n');
      else if (model.snapshot.broker?.gateClosed) stdout.write(tr('exitPaused') + '\n');
      error ? reject(error) : resolve(0);
    }
    const quit = () => cleanup();
    function redraw() {
      if (ended) return;
      try {
        if (taskEventReader) {
          const detail = modal?.kind === 'details' && modal.rowType === 'tasks' ? modal : null;
          const snapshot = detail ? detail.contextSnapshot : model.viewSnapshot();
          const client = model.name === 'agents' ? model.selected() : null;
          const at = op => { const value = op.finishedAt ?? op.startedAt ?? op.submittedAt; return typeof value === 'number' ? value : Date.parse(value) || 0; };
          const latest = client?.operations?.reduce((latest, op) => !latest || at(op) > at(latest) ? op : latest, null);
          const row = detail?.row || (model.name === 'tasks' ? model.selected() : latest);
          if (row && snapshot && !detail?.frozen && !model.state.frozenSnapshot) {
            snapshot.taskEvents = taskEventReader(row);
            model.snapshot.taskEvents = snapshot.taskEvents;
          }
        }
        const width = Math.max(1, Number.isFinite(term.width) && term.width || stdout.columns || 80);
        const height = Math.max(1, Number.isFinite(term.height) && term.height || stdout.rows || 24);
        const rgb = render.supportsTrueColor === true && prefs.color !== 'off' && !Object.hasOwn(process.env, 'NO_COLOR') &&
          (term.support.trueColor || /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION);
        const BufferClass = rgb ? kit.ScreenBufferHD : kit.ScreenBuffer;
        if (!buffer || buffer.width !== width || buffer.height !== height || buffer.constructor !== BufferClass) buffer = new BufferClass({ dst: term, width, height });
        presentation = render({ model, term, buffer, prefs, language, modal, message, detailScroll }) || { hits: [], panels: [] };
      } catch (error) { cleanup(error); }
    }
    redrawNotice = redraw;
    function resized() { pointer.drag = null; redraw(); }
    function read() {
      const taskEvents = model.snapshot.taskEvents;
      model.update(adapter.read());
      if (taskEvents) model.snapshot.taskEvents = taskEvents;
      if (modal?.kind === 'details') require('./console-details').refresh(modal, model);
      redraw();
    }
    function fields(kind, rows) { modal = { kind, fields: rows, index: 0 }; }
    function openFilters() {
      const state = model.state;
      const source = model.source() || [];
      const options = key => ['', ...new Set(source.map(row => row[key]).filter(Boolean))];
      const rows = [{ key: 'scope', label: tr('scope'), options: model.name === 'agents' ? ['current', 'history', 'all'] : model.name === 'tasks' ? ['open', 'history', 'all'] : ['all'] }];
      if (model.name === 'agents') rows.push({ key: 'clientKind', label: language === 'pl' ? 'Rodzaj klienta (prefiks ID)' : 'Client kind (ID prefix)', options: options('clientKind') },
        ...(source.some(row => row.source !== 'job-history') ? [{ key: 'presence', label: tr('presence'), options: options('presence') }] : []),
        { key: 'work', label: tr('work'), options: options('work') });
      else if (['logs', 'system'].includes(model.name)) rows.push({ key: 'level', label: 'INFO,WARN,ERROR,DEBUG,TRACE,OTHER' }, { key: 'component', label: tr('source'), options: options('component') }, { key: 'task', label: 'taskId' });
      else rows.push({ key: 'state', label: tr('state'), options: options('state') },
        { key: 'document', label: require('./console-labels').label('documentOrScript', language) });
      rows.push({ key: 'agent', label: tr('agents') }, { key: 'since', label: 'ISO since' }, { key: 'until', label: 'ISO until' });
      rows.push({ key: 'reset', label: tr('reset'), options: ['no', 'yes'] });
      fields('filters', rows.map(row => ({ ...row, value: state.filters[row.key] || row.options?.[0] || '' })));
    }
    function settings() {
      fields('settings', [
        { key: 'language', label: tr('language') + ` (${locale({ language: 'auto' })} → ${language})`, value: prefs.language, options: ['auto', 'en', 'pl'] },
        { key: 'color', label: tr('color'), value: prefs.color, options: ['auto', 'off'] },
        { key: 'frames', label: tr('frames'), value: prefs.frames, options: ['unicode', 'ascii'] },
      ]);
    }
    async function broker() {
      modal = { kind: 'broker', confirm: false, info: tr('loading') }; redraw();
      if (model.snapshot.mode === 'direct') { modal.info = tr('directPause'); return; }
      if (!model.snapshot.available || !model.snapshot.capabilities?.brokerControl) { modal.info = tr('unsupported'); return; }
      const current = modal;
      try {
        const value = await control.read(); if (modal !== current) return;
        current.control = value; current.info = tr(value.phase === 'RUNNING' ? 'pause' : 'resume');
      } catch (error) { if (modal === current) current.error = tr('unconfirmed') + '\n' + error.message; }
    }
    function applyFields() {
      const values = Object.fromEntries(modal.fields.map(field => [field.key, field.value]));
      if (modal.kind === 'settings') {
        prefs = { ...prefs, ...values }; language = locale(prefs);
        try { savePreferences(values); notice(tr('saved')); }
        catch (error) { notice(tr('notSaved', { reason: error.message })); }
      } else if (modal.kind === 'filters') {
        if (values.reset === 'yes') model.resetFilters();
        else {
          for (const key of ['since', 'until']) if (values[key] && !Number.isFinite(Date.parse(values[key]))) throw new Error('Invalid ISO timestamp: ' + key);
          delete values.reset; model.state.filters = values;
        }
        model.refreshOrder();
      } else if (modal.kind === 'sort') { model.state.sort = values.sort; model.refreshOrder(); }
      modal = null;
    }
    async function modalKey(name, data) {
      if (name === 'ESCAPE') { pointer.drag = null; modal = null; return; }
      const m = modal;
      if (m.kind === 'details' && name === 'p') { await showSource(m.row); return; }
      if (m.kind === 'details' && name === 'y') { await showResponse(m.row); return; }
      if (m.kind === 'response' && ['TAB', 'SHIFT_TAB'].includes(name)) {
        const count = m.result?.outputs.length || 0;
        if (count) { m.index = (m.index + (name === 'TAB' ? 1 : count - 1)) % count; m.viewport = { offset: 0 }; m.horizontal = 0; m.lineCache = null; }
        return;
      }
      if (m.kind === 'response' && ['LEFT', 'RIGHT'].includes(name)) {
        m.horizontal = Math.max(0, (m.horizontal || 0) + (name === 'LEFT' ? -8 : 8)); m.lineCache = null; return;
      }
      if (m.kind === 'source' && ['LEFT', 'RIGHT', 'i'].includes(name)) {
        if (name === 'i') m.showMetadata = !m.showMetadata;
        else m.horizontal = Math.max(0, (m.horizontal || 0) + (name === 'LEFT' ? -8 : 8));
        m.lineCache = null; return;
      }
      if (['details', 'help', 'text', 'source', 'response'].includes(m.kind)) {
        m.viewport ||= { offset: m.scroll || 0 };
        if (['UP', 'PAGE_UP', 'DOWN', 'PAGE_DOWN', 'HOME', 'END'].includes(name)) {
          const viewport = presentation.hits.find(hit => hit.type === 'viewport' && hit.layer === 'modal');
          if (viewport) scrollViewport(viewport, name === 'HOME' ? 0 : name === 'END' ? viewport.total :
            (m.viewport.offset || 0) + (['UP', 'PAGE_UP'].includes(name) ? -1 : 1) * (name.startsWith('PAGE') ? viewport.visible : 1));
        }
        if (m.kind === 'details' && ['t', 'g', 'a'].includes(name)) {
          if (model.related(({ t: 'tasks', g: 'logs', a: 'agents' })[name], m.row, m.contextSnapshot)) modal = null;
          else notice(tr('noResults'));
        }
        return;
      }
      if (m.kind === 'broker') {
        if (m.busy) return;
        if (name === 'TAB' || name === 'SHIFT_TAB' || name === 'LEFT' || name === 'RIGHT') m.confirm = !m.confirm;
        if (name === 'ENTER') {
          if (!m.confirm) { modal = null; return; }
          if (!m.control || !['RUNNING', 'PAUSED'].includes(m.control.phase)) return;
          m.busy = true; pendingControl = true; m.info = tr('pending'); redraw();
          try { await control.set(m.control.phase === 'RUNNING'); if (modal === m) modal = null; read(); }
          catch (error) {
            if (modal === m) { m.confirm = false; m.error = tr(error.code === 'STATE_CONFLICT' ? 'unconfirmed' : 'uncertain') + '\n' + error.message; m.control = control.current; }
          } finally { m.busy = false; pendingControl = false; }
        }
        return;
      }
      if (m.fields) {
        const count = m.fields.length + 2;
        if (['TAB', 'DOWN', 'SHIFT_TAB', 'UP'].includes(name)) m.index = (m.index + (['SHIFT_TAB', 'UP'].includes(name) ? count - 1 : 1)) % count;
        else if (name === 'ENTER') {
          if (m.index === m.fields.length) { try { applyFields(); } catch (error) { notice(error.message); } }
          else if (m.index === m.fields.length + 1) modal = null;
          else m.index++;
        } else {
          const field = m.fields[m.index]; if (!field) return;
          if (field.options && ['LEFT', 'RIGHT', 'SPACE'].includes(name)) {
            const direction = name === 'LEFT' ? field.options.length - 1 : 1;
            field.value = field.options[(field.options.indexOf(field.value) + direction) % field.options.length];
          } else if (!field.options && name === 'BACKSPACE') field.value = Array.from(field.value).slice(0, -1).join('');
          else if (!field.options && data?.isCharacter) field.value += name;
        }
        return;
      }
      if (m.kind === 'export' && m.overwrite) {
        if (name === 'y') { m.overwrite = false; m.confirmOverwrite = true; return modalKey('ENTER'); }
        return;
      }
      if (name === 'BACKSPACE') { m.input = Array.from(m.input).slice(0, -1).join(''); m.confirmOverwrite = false; }
      else if (name === 'TAB' && m.kind === 'export') m.format = m.format === 'text' ? 'jsonl' : 'text';
      else if (name === 'ENTER') {
        try {
          if (m.kind === 'project') {
            project = resolveProject({ project: m.input || cwd, cwd }); configure();
            for (const state of Object.values(model.states)) { state.filters = { scope: 'all' }; state.selectedId = null; state.frozen = null; state.frozenSnapshot = null; state.order = []; }
            modal = null; read();
          } else if (m.kind === 'search') { model.state.search = m.input; model.refreshOrder(); modal = null; }
          else if (m.kind === 'export') {
            try {
              const count = exportRows(m.input, m.rows, { format: m.format, overwrite: !!m.confirmOverwrite, retention: m.retention });
              notice(tr('exported', { count, path: m.input })); modal = null;
            } catch (error) {
              if (error.code === 'EEXIST') { m.overwrite = true; m.prompt = tr('overwrite'); } else throw error;
            }
          }
        } catch (error) { m.error = error.message; }
      } else if (data?.isCharacter) { m.input += name; m.confirmOverwrite = false; }
    }
    function showDetails(row) {
      if (!row) return;
      modal = { kind: 'details', id: row.id, row: structuredClone(row), scroll: 0, frozenView: model.name,
        rowType: ({ log: 'logs', agent: 'agents', task: 'tasks' })[require('./console-details').kindOf(row)],
        contextSnapshot: structuredClone(model.viewSnapshot()), frozen: !!model.state.frozenSnapshot };
      require('./console-details').refresh(modal, model);
    }
    async function showSource(override) {
      const viewport = presentation.hits.find(hit => hit.type === 'viewport' && hit.focus === model.focus && hit.rows);
      let row = override || viewport?.rows.find(row => row.id === viewport.state.selectedId) || (['tasks', 'logs'].includes(model.name) ? model.selected() : null);
      if (row?.taskId && !row.sourcePath) row = (modal?.contextSnapshot || model.viewSnapshot()).operations?.find(item => item.id === row.taskId);
      if (!row?.sourcePath) { notice(require('./console-labels').label('sourceMissing', language)); return; }
      const current = modal = { kind: 'source', sourceRow: row, busy: true, viewport: { offset: 0 }, horizontal: 0 };
      redraw();
      const preview = await require('./console-source').openSource(row);
      if (ended || modal !== current) return;
      current.preview = preview; current.busy = false; redraw();
    }
    async function showResponse(override) {
      const snapshot = structuredClone(modal?.contextSnapshot || model.viewSnapshot());
      const viewport = presentation.hits.find(hit => hit.type === 'viewport' && hit.focus === model.focus && hit.rows);
      let row = override || viewport?.rows.find(row => row.id === viewport.state.selectedId) || model.selected();
      if (row?.taskId) row = snapshot.operations?.find(item => item.id === row.taskId);
      if (!row || !snapshot.operations?.some(item => item.id === row.id)) { notice(tr('noResults')); return; }
      const current = modal = { kind: 'response', row, busy: true, index: 0, viewport: { offset: 0 }, horizontal: 0 };
      redraw();
      const result = await require('./console-response').openResponse(row, snapshot, { cfg });
      if (ended || modal !== current) return;
      current.result = result; current.busy = false; redraw();
    }
    async function intent(action) {
      if (!action) return;
      if (action.focus !== undefined) model.focus = action.focus;
      if (action.type === 'tab') model.tab = action.tab;
      else if (action.type === 'key') await key(action.key);
      else if (action.type === 'related-records') {
        if (!model.related(action.kind, action.row, model.viewSnapshot())) notice(tr('noResults'));
      }
      else if (action.type === 'response-stream' && modal?.kind === 'response') {
        modal.index = action.index; modal.viewport = { offset: 0 }; modal.horizontal = 0; modal.lineCache = null;
      }
      else if (action.type === 'sort') { model.state.sort = action.sort; model.refreshOrder(); }
      else if (action.type === 'open-details' || action.type === 'details') showDetails(action.row);
      else if (action.type === 'filter') { model.state.filters[action.field] = action.value; model.refreshOrder(); }
      else if (action.type === 'navigate') {
        model.tab = action.tab; model.focus = 0;
        if (action.filters) model.state.filters = { scope: 'all', ...action.filters };
        model.refreshOrder();
        if (action.id) { model.state.selectedId = action.id; model.state.follow = false; model.state.navigating = true; }
      } else if (action.type === 'modal-field' && modal?.fields) {
        modal.index = action.index;
        if (action.cycle) await modalKey('RIGHT');
      } else if (action.type === 'modal-button' && modal) {
        if (action.button === 'cancel') await modalKey('ESCAPE');
        else {
          if (modal.fields) modal.index = modal.fields.length;
          if (action.button === 'confirm') modal.confirm = true;
          await modalKey('ENTER');
        }
      } else if (action.type === 'system-action') {
        if (action.action === 'refresh') read();
        else if (action.action === 'broker') await broker();
        else if (action.action === 'project') await key('c');
        else if (action.action === 'settings') settings();
        else modal = { kind: 'help', scroll: 0, customText: action.reason || tr('unsupported') };
      }
      redraw();
    }
    async function mouse(name, data) {
      try {
        if (['source', 'response'].includes(modal?.kind) && data.shift && ['MOUSE_WHEEL_UP', 'MOUSE_WHEEL_DOWN'].includes(name)) {
          await modalKey(name === 'MOUSE_WHEEL_UP' ? 'LEFT' : 'RIGHT'); redraw(); return;
        }
        await intent(pointerAction(name, data, presentation, pointer, { modal: !!modal }));
      }
      catch (error) { notice(error.message); redraw(); }
    }
    async function key(name, matches, data) {
      try {
        if (name === 'CTRL_C') return cleanup();
        if (name === 'q' && modal && !Object.hasOwn(modal, 'input') && !modal.fields) return cleanup();
        if (modal && ((term.width || 80) < 80 || (term.height || 24) < 24) && name !== 'ESCAPE') return;
        if (modal) { await modalKey(name, data); redraw(); return; }
        if (name === 'q') return cleanup();
        if (/^[1-5]$/.test(name)) { model.tab = Number(name) - 1; detailScroll = 0; }
        else if (name === 'TAB' || name === 'SHIFT_TAB') {
          const focus = [...new Set(presentation.panels.filter(panel => panel.focus !== undefined).map(panel => panel.focus))];
          if (focus.length) model.focus = focus[(focus.indexOf(model.focus) + (name === 'TAB' ? 1 : focus.length - 1) + focus.length) % focus.length];
        }
        else if (['?', 'F1'].includes(name)) modal = { kind: 'help', scroll: 0 };
        else if (name === ',') settings();
        else if (name === 'b') await broker();
        else if (name === 'c' && model.name === 'system') modal = { kind: 'project', input: '', prompt: tr('pathPrompt') };
        else if (name === 'r') { model.refreshOrder(); read(); }
        else if (name === 'v') { model.section++; }
        else if (name === 'SPACE') model.freeze();
        else if (name === '/') modal = { kind: 'search', input: model.state.search, prompt: tr('search') };
         else if (name === 'f') openFilters();
         else if (name === 'x') { model.resetFilters(); notice(require('./console-labels').label('filtersCleared', language)); }
         else if (name === 'p') await showSource();
         else if (name === 'y' && model.name === 'tasks') await showResponse();
        else if (name === 'o' && model.name !== 'logs') fields('sort', [{ key: 'sort', label: tr('sort'), value: model.state.sort, options: ['default', 'name', 'time'] }]);
        else if (name === 'l' && model.name === 'logs') { model.state.follow = !model.state.follow; model.state.newCount = 0; }
        else if (name === 'e' && ['agents', 'tasks', 'logs'].includes(model.name)) modal = {
          kind: 'export', input: '', format: 'jsonl', rows: structuredClone(model.rows() || []), retention: model.viewSnapshot().retention, prompt: tr('exportPrompt') };
        else if (name === 'ENTER') {
          const viewport = presentation.hits.find(hit => hit.type === 'viewport' && hit.focus === model.focus && hit.rows);
          const selected = viewport?.rows.find(row => row.id === viewport.state.selectedId) || model.selected();
          const panel = presentation.panels.find(panel => panel.focus === model.focus);
          const content = presentation.hits.find(hit => hit.type === 'viewport' && hit.focus === model.focus && hit.lines);
          if (model.name === 'overview' && panel?.id === 'overview-broker') await broker();
          else if (model.name === 'overview' && ['overview-fusion', 'overview-host'].includes(panel?.id)) await intent({ type: 'navigate', tab: 4 });
          else if (model.name === 'overview' && panel?.id === 'overview-agents') await intent({ type: 'navigate', tab: 1, id: selected?.id, filters: { scope: 'all' } });
          else if (model.name === 'overview' && ['overview-open', 'overview-recent', 'overview-history'].includes(panel?.id)) await intent({ type: 'navigate', tab: 2, id: selected?.id, filters: { scope: panel.id === 'overview-recent' ? 'all' : panel.id === 'overview-open' ? 'open' : 'history' } });
          else if (model.name === 'overview' && panel?.id === 'overview-events') await intent({ type: 'navigate', tab: 3, id: selected?.id, filters: { scope: 'all' } });
          else if (content) modal = { kind: 'text', title: panel?.title || tr('details'), customText: content.lines.map(line => typeof line === 'string' ? line : line.text || line.spans?.map(span => span.text).join('  ') || '').join('\n') };
          else if (selected) showDetails(selected);
        } else if (['UP', 'DOWN', 'PAGE_UP', 'PAGE_DOWN', 'HOME', 'END'].includes(name)) {
          const viewport = [...presentation.hits].reverse().find(hit => hit.type === 'viewport' && hit.focus === model.focus && hit.layer !== 'modal');
          if (viewport?.rows?.length) {
            viewport.state.navigating = true;
            const index = Math.max(0, viewport.rows.findIndex(row => row.id === viewport.state.selectedId));
            const next = name === 'HOME' ? 0 : name === 'END' ? viewport.rows.length - 1 :
              index + (['UP', 'PAGE_UP'].includes(name) ? -1 : 1) * (name.startsWith('PAGE') ? viewport.visible : 1);
            viewport.state.selectedId = viewport.rows[Math.max(0, Math.min(viewport.rows.length - 1, next))].id;
            if (viewport.kind === 'logs') viewport.state.follow = name === 'END';
          } else if (viewport) scrollViewport(viewport, name === 'HOME' ? 0 : name === 'END' ? viewport.total :
            (viewport.state.offset || 0) + (['UP', 'PAGE_UP'].includes(name) ? -1 : 1) * (name.startsWith('PAGE') ? viewport.visible : 1));
          else model.navigate(name === 'HOME' ? 'home' : name === 'END' ? 'end' : ['UP', 'PAGE_UP'].includes(name) ? -1 : 1,
            name.startsWith('PAGE') ? Math.max(1, (term.height || 24) - 10) : 1);
        }
        redraw();
      } catch (error) { notice(error.message); redraw(); }
    }
    try {
      term.fullscreen(true); term.hideCursor(); term.grabInput({ mouse: 'drag' });
      term.on('key', key); term.on('resize', resized); term.on('mouse', mouse); signals.once('SIGINT', quit); signals.once('SIGTERM', quit);
      read(); timer = setInterval(read, 2000);
    } catch (error) { cleanup(error); }
  });
}
module.exports = { launchConsole };
