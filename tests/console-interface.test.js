'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsoleModel, BrokerControl, exportRows } = require('../src/console-controller');
const { readLogs } = require('../src/console-logs');
const i18n = require('../src/i18n');
const { parseInvocation } = require('../src/invocation');
const { QueueState } = require('../src/queue-state');
const { createTelemetry } = require('../src/direct-telemetry');
const { commands } = require('../src/commands');
const { detail, globalHelp } = require('../src/help');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('locale precedence, fallback, concurrent-safe preferences and all command help remain offline in EN/PL', async t => {
  const dir = fixture(t), file = path.join(dir, 'config.json');
  const previous = process.env.FMCAD_CONFIG; process.env.FMCAD_CONFIG = file;
  t.after(() => { if (previous === undefined) delete process.env.FMCAD_CONFIG; else process.env.FMCAD_CONFIG = previous; });
  assert.equal(i18n.detected({ LANG: 'pl_PL.UTF-8' }), 'pl');
  assert.equal(i18n.detected({ LC_ALL: 'C.UTF-8', LANG: 'pl_PL.UTF-8' }), 'en');
  assert.equal(i18n.detected({ LANG: 'de_DE' }), 'en');
  assert.equal(i18n.locale({ language: 'pl' }, { LANG: 'en_US' }), 'pl');
  fs.writeFileSync(file, JSON.stringify({ backend: 'addin', custom: 123 }));
  for (const language of ['en', 'pl']) {
    i18n.savePreferences({ language }, file);
    assert.equal(i18n.locale(), language);
    for (const entry of commands) {
      const text = detail(...entry.key.split(' '));
      assert.ok(text.includes(entry.key), entry.key);
      assert.ok(text.includes('--purpose'), entry.key);
      assert.match(text, language === 'pl' ? /Użycie:/ : /Usage:/);
      let cliHelp = '';
      const code = await require('../src/cli').main([...entry.key.split(' '), '--purpose', 'Cel pomocy', '--help'], {
        stdout: { write: value => { cliHelp += value; } }, stderr: { write: value => assert.fail(value) },
        loadConfig() { assert.fail('Help must not load connection config'); }, setExitCode() {},
      });
      assert.equal(code, 0, entry.key); assert.ok(cliHelp.includes('--purpose'), entry.key);
    }
    assert.ok(globalHelp().includes('console'));
    let bridgeHelp = '';
    require('../src/mcp-stdio').startStdio(['--help'], { stdout: { write: text => { bridgeHelp += text; } },
      loadConfig() { throw new Error('Help must not initialize services'); } });
    assert.match(bridgeHelp, language === 'pl' ? /Użycie:/ : /Usage:/);
  }
  assert.equal(JSON.parse(fs.readFileSync(file)).custom, 123);
  assert.equal(JSON.parse(fs.readFileSync(file)).backend, 'addin');
  fs.writeFileSync(file + '.console-lock', 'busy');
  assert.throws(() => i18n.savePreferences({ color: 'off' }, file), { code: 'EEXIST' });
  assert.equal(i18n.t('missing-key', {}, 'pl'), 'Komunikat niedostępny');
  fs.unlinkSync(file + '.console-lock'); i18n.savePreferences({ language: 'auto' }, file);
  assert.equal(i18n.locale(i18n.preferences(file), { LANG: 'pl_PL' }), 'pl');
});
test('purpose parser handles Unicode, empty, duplicate, limits and child separator without stealing operation description', () => {
  assert.deepEqual(parseInvocation(['--purpose', '  Sprawdź ściany  ', 'stats']), { argv: ['stats'], description: 'Sprawdź ściany' });
  assert.deepEqual(parseInvocation(['stats', '--purpose', '']), { argv: ['stats'], description: undefined });
  assert.deepEqual(parseInvocation(['queue', 'exec', '--', 'run', '--purpose', 'child']), { argv: ['queue', 'exec', '--', 'run', '--purpose', 'child'], description: undefined });
  assert.deepEqual(parseInvocation(['material', 'edit', '--description', 'native']), { argv: ['material', 'edit', '--description', 'native'], description: undefined });
  for (const argv of [['--purpose'], ['--purpose', '\n'], ['--purpose', 'a'.repeat(1001)], ['--purpose', 'a', '--purpose', 'b']]) assert.throws(() => parseInvocation(argv));
});
test('purpose survives broker pause, result/reopen/dedup and direct transport history', async t => {
  const dir = fixture(t), state = new QueueState(path.join(dir, 'queue'));
  const request = { requestId: 'r', clientId: 'a', kind: 'rpc', payload: {}, timeoutMs: 1000, description: 'Sprawdź średnicę' };
  const job = state.submit(request); state.pause(true); state.pause(false); state.next(); state.finish(job.id);
  const reopened = new QueueState(path.join(dir, 'queue'));
  assert.equal(reopened.status(job.id).description, request.description);
  assert.equal(reopened.submit({ ...request, description: 'different purpose' }).id, job.id);
  const producer = createTelemetry({ cwd: dir });
  const invocation = require('../src/dist/core').createInvocationContext({ clientId: 'cli:test', requestId: 'request:test',
    jobId: 'job:test', projectId: 'project:test', documentId: 'document:test', instanceId: 'instance:test',
    source: 'cli', purpose: request.description });
  await producer.track({ method: 'tools/call' }, async () => ({ status: 200 }), invocation);
  assert.equal(JSON.parse(fs.readFileSync(producer.file)).operations[0].description, request.description);
});
test('view selection, filtering, log following, freeze and correlated drilldown are stable', () => {
  const model = new ConsoleModel(); model.tab = 2;
  const a = { id: 'a', state: 'running', label: 'run', description: 'Polskie ściany', clientId: 'agent' };
  model.update({ operations: [a], agents: [], logs: [] });
  model.state.search = 'ściany'; assert.equal(model.rows().length, 1); model.freeze();
  model.update({ operations: [{ ...a, state: 'completed' }, { id: 'b', state: 'queued' }], logs: [{ id: '1', message: 'one' }] });
  assert.equal(model.rows()[0].state, 'running'); assert.equal(model.state.newCount, 1);
  model.freeze(); model.state.search = ''; model.state.filters.scope = 'all'; assert.equal(model.rows().length, 2);
  model.tab = 3; model.rows(); model.navigate(-1, 1); assert.equal(model.state.follow, false);
  model.update({ operations: [a], logs: [{ id: '1', message: 'one' }, { id: '2', message: 'two' }] });
  assert.equal(model.state.selectedId, '1'); assert.equal(model.state.newCount, 1);
  model.navigate('end'); assert.equal(model.rows().at(-1).id, model.state.selectedId);
  model.related('logs', a); assert.equal(model.state.filters.task, 'a');
});
test('bounded tail sanitizes controls and secrets, export is consistent and overwrite explicit', t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, '.cad/logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cad/logs/fmcad.log'), '2026-10-20T12:00:00Z INFO broker job=abc Bearer TOKEN\x1b[31mred\x1b[0m\n');
  const result = readLogs(dir); assert.equal(result.logs[0].taskId, 'abc');
  assert.doesNotMatch(JSON.stringify(result), /TOKEN|\u001b/);
  const file = path.join(dir, 'export.jsonl');
  exportRows(file, result.logs, { retention: { partial: true } });
  assert.match(fs.readFileSync(file, 'utf8'), /retention/);
  assert.throws(() => exportRows(file, result.logs), { code: 'EEXIST' });
  assert.equal(exportRows(file, [], { overwrite: true }), 0);
  fs.appendFileSync(path.join(dir, '.cad/logs/fmcad.log'), '2026-10-20T12:00:01Z INFO job_running job=next\n');
  const observed = readLogs(dir).logs.at(-1);
  assert.equal(observed.event, 'job_running'); assert.equal(observed.component, 'project-log');
  assert.match(observed.message, /job_running/);
});
test('broker controls use read-only registration, optimistic fences and never replay uncertain requests', async () => {
  let calls = [], registrations = [], fail = false;
  const broker = new BrokerControl(() => ({ register: async options => registrations.push(options), call: async (action, values) => {
    calls.push({ action, values });
    if (action === 'control-status') return { instanceId: 'i', generation: 2, phase: 'RUNNING' };
    if (fail) throw new Error('uncertain');
    return { phase: 'PAUSING' };
  } }));
  await broker.read(); await broker.set(true);
  assert.equal(registrations[0].autoStart, false);
  assert.equal(calls[1].action, 'control-status');
  assert.equal(calls[2].values.control.expectedGeneration, 2);
  fail = true; await broker.read(); await assert.rejects(broker.set(true));
  assert.equal(calls.filter(call => call.action === 'pause').length, 2);
  assert.equal(calls.at(-1).action, 'control-status');
});
