'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { queueDirectory } = require('./queue-connection');
const { readJson, priorProcessAlive } = require('./queue-instance');
const { redactDiagnostic, formatJsonError } = require('./diagnostics');
const { baseSnapshot: base, ConsoleReadStore, projectContains, classifyPresence, id, projectConsoleOperation } = require('./dist/core');

const text = (value, cfg = {}) => redactDiagnostic(String(value), cfg).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))|[\x00-\x1f\x7f-\x9f]/g, '');
const readers = require('./dist/node-adapters/console/snapshots').createSnapshotReaders({ base, contains: projectContains,
  presence: (observedAtMs, now, alive) => classifyPresence({ version: 1, clientId: id('client', 'direct'),
    instanceId: id('instance', 'direct'), pid: 0, birth: null, observedAtMs, closed: false }, now, alive) });

function operation(job, cfg = {}) {
  const result = projectConsoleOperation(job, value => text(value, cfg));
  if (job.description || job.request?.description) result.description = text(job.description || job.request.description, cfg);
  if (job.request?.kind === 'command' && Array.isArray(job.request.argv)) {
    const { rest } = require('./cli').parseFlags(job.request.argv);
    const entry = require('./commands').findCommand(rest);
    result.label = entry?.key || 'command';
    if (entry?.kind === 'run') {
      let scriptPath;
      for (let i = 1; i < rest.length; i++) {
        if (Object.hasOwn(entry.flags, rest[i])) { if (entry.flags[rest[i]] === 'value') i++; continue; }
        if (rest[i] === '--') { i++; if (rest[i]) scriptPath = rest[i]; break; }
        if (!rest[i].startsWith('-')) { scriptPath = rest[i]; break; }
      }
      if (scriptPath) result.script = text(path.basename(scriptPath), cfg);
      if (scriptPath && (path.isAbsolute(scriptPath) || scriptPath.includes('/') || scriptPath.includes('\\'))) {
        const resolved = path.resolve(job.request.cwd, scriptPath);
        result.sourcePath = text(resolved, cfg);
        const input = job.request.inputFiles?.find(item => typeof item.path === 'string' && path.resolve(job.request.cwd, item.path) === resolved);
        if (input && /^[a-f0-9]{64}$/i.test(input.sha256 || '')) result.sourceHash = input.sha256;
      }
      if (result.script) result.label = 'run ' + result.script;
    }
    const index = rest.indexOf('--doc');
    if (index >= 0 && typeof rest[index + 1] === 'string') result.document = text(rest[index + 1], cfg);
  }
  return result;
}

function brokerSnapshot(project, { dir = queueDirectory(), now = Date.now, alive = priorProcessAlive, cfg = {} } = {}) {
  return readers.brokerSnapshot(project, { dir, now, alive, readJson, operation: job => operation(job, cfg), clients: project => {
    const presence = require('./client-presence').readClientPresence(project, { now, alive });
    return { ...presence, clients: presence.clients.map(client => ({ ...client, id: text(client.id, cfg) })) };
  } });
}

function directSnapshot(project, { now = Date.now, alive = priorProcessAlive, cfg = {} } = {}) {
  return readers.directSnapshot(project, { now, alive, readJson, operation: job => operation(job, cfg) });
}

class ConsoleStore extends ConsoleReadStore {
  constructor(mode, project, { historyLimit = 500, logLimit = 2000 } = {}) {
    super(mode, project, historyLimit, logLimit, Date.now());
  }
  unavailable(error) {
    return super.unavailable(text(error instanceof SyntaxError ? formatJsonError(error) : error.message));
  }
}

function createAdapter({ project, cfg, ...options }) {
  const mode = cfg.routing === 'queue' ? 'broker' : cfg.routing === 'direct' ? 'direct' : 'unknown';
  const store = new ConsoleStore(mode, project);
  const collector = require('./console-system-data').createCollector();
  const logTracker = new Map();
  const adapter = { store, read() {
    let snapshot;
    try {
      if (!project || mode === 'unknown') throw new Error('Select a project and a known routing configuration');
      snapshot = mode === 'broker' ? brokerSnapshot(project, { ...options, cfg }) : directSnapshot(project, { ...options, cfg });
    } catch (error) { snapshot = store.unavailable(error); snapshot.readAt = Date.now(); }
    if (project) {
      try {
        const logs = require('./console-logs').readLogs(project, cfg, 2000, 256 * 1024, logTracker);
        snapshot.logs = logs.logs; snapshot.logSources = logs.sources; snapshot.logsResynced = logs.resynced;
        snapshot.retention = { ...snapshot.retention, logWindowTruncated: logs.truncated, logFilesRead: logs.sources.length, logBytesRead: logs.bytesRead };
      }
      catch { snapshot.logs = store.value.logs; snapshot.logWarning = 'Log source unavailable'; }
      if (mode === 'broker') {
        try {
          const file = path.join(options.dir || queueDirectory(), 'instance.json');
          const identity = readJson(file);
          snapshot.fusion = { connectivity: 'unknown', source: 'last-broker-identity', observedAt: fs.statSync(file).mtimeMs,
            document: identity.instance?.documents?.find(doc => doc.isActive)?.name || null, version: identity.instance?.version || null };
        } catch { /* No SDK observation is available. */ }
      }
    }
    snapshot.system = collector.read(snapshot);
    snapshot.host = snapshot.system.host;
    return store.replace(snapshot);
  } };
  adapter.observation = require('./dist/node-adapters/console/read-port').createConsoleReadPort(() => adapter.read(), options.now || Date.now);
  return adapter;
}

module.exports = { ConsoleStore, createAdapter, brokerSnapshot, directSnapshot };
