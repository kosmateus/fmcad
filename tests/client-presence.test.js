'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startClientPresence, readClientPresence } = require('../src/client-presence');
const { brokerSnapshot } = require('../src/console-data');
const { presenceSummary } = require('../src/console-client-identity');
const { label } = require('../src/console-labels');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(30); }
  assert.fail('Presence did not update within the test budget');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'p'); fs.mkdirSync(path.join(project, '.cad'), { recursive: true });
  return { root, project };
}
test('registered queue client publishes real process presence while idle and normal exit becomes offline', async t => {
  const { root, project } = fixture(t), state = path.join(root, 's'), dir = path.join(state, 'fmcad/queue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue-state.json'), JSON.stringify({ version: 1, paused: false, jobs: {
    old: { id: 'old', clientId: 'mcp-stdio:old', state: 'succeeded', request: { cwd: project } },
  } }));
  const actions = [];
  const server = net.createServer(socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk.toString(); if (!raw.includes('\n')) return;
      const message = JSON.parse(raw.split('\n')[0]); actions.push(message.action);
      socket.end(JSON.stringify({ ok: true, result: { id: 'fixture-job' } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(path.join(dir, 'broker.sock'), resolve));
  t.after(() => server.close());
  const code = `const {QueueClient}=require(${JSON.stringify(require.resolve('../src/queue-client'))});
    (async()=>{const c=new QueueClient('mcp-stdio:live');await c.register();
    await c.call('submit',{request:{kind:'rpc',cwd:process.cwd()}});console.log('READY');
    process.stdin.resume();process.stdin.once('data',()=>process.exit(0));})().catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', code], { cwd: project, env: { ...process.env, XDG_STATE_HOME: state }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  await until(() => stdout.includes('READY') || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr);
  const first = readClientPresence(project).clients[0];
  assert.equal(first.presence, 'observed'); assert.equal(first.pid, child.pid);
  assert.equal(first.source, 'queue-client-process-heartbeat');
  assert.deepEqual(actions, ['register', 'submit']);
  const snapshot = brokerSnapshot(project, { dir });
  assert.equal(snapshot.agents.find(agent => agent.id === 'mcp-stdio:live').presence, 'observed');
  assert.equal(snapshot.agents.find(agent => agent.id === 'mcp-stdio:old').source, 'job-history');
  const ui = { language: 'en', L: key => label(key, 'en') };
  assert.match(presenceSummary(snapshot, ui), /presence confirmed/);
  const stale = readClientPresence(project, { now: () => Date.now() + 20000 }).clients[0];
  assert.equal(stale.presence, 'unknown');
  await until(() => readClientPresence(project).clients[0]?.lastSeen > first.lastSeen);
  const exit = once(child, 'exit'); child.stdin.write('quit'); await exit;
  assert.equal(readClientPresence(project).clients[0].presence, 'offline');
  assert.deepEqual(actions, ['register', 'submit'], 'heartbeat must never send another queue or Fusion request');
});
test('presence files contain instance metadata and dispose only their own process record', async t => {
  const { project } = fixture(t);
  const one = startClientPresence('opencode:fixture', project, { intervalMs: 25 }); t.after(() => one.stop());
  assert.equal(require('../src/console-project').resolveProject({ project }), project);
  const two = startClientPresence('opencode:fixture', project, { intervalMs: 25 }); t.after(() => two.dispose());
  assert.notEqual(two, one);
  assert.notEqual(two.instanceId, one.instanceId);
  const value = JSON.parse(fs.readFileSync(one.file));
  assert.deepEqual(Object.keys(value).sort(), ['birth', 'clientId', 'closed', 'instanceId', 'observedAt', 'pid', 'project', 'version']);
  assert.equal(readClientPresence(project).clients[0].presence, 'observed');
  assert.equal(readClientPresence(project).clients[0].processCount, 2);
  one.dispose();
  const afterOne = readClientPresence(project).clients[0];
  assert.equal(afterOne.presence, 'observed');
  assert.equal(afterOne.processCount, 2);
  assert.equal(afterOne.observedProcesses, 1);
  two.stop();
  assert.equal(readClientPresence(project).clients[0].presence, 'offline');
});
test('PID birth mismatch, stale and future signals never confirm a client; bad files stay isolated', t => {
  const { project } = fixture(t), producer = startClientPresence('client', project); producer.stop();
  const value = JSON.parse(fs.readFileSync(producer.file)); value.closed = false; value.birth = 'wrong-process-birth';
  fs.writeFileSync(producer.file, JSON.stringify(value));
  assert.equal(readClientPresence(project).clients[0].presence, 'offline');
  assert.equal(readClientPresence(project, { alive: () => null }).clients[0].presence, 'unknown');
  assert.equal(readClientPresence(project, { alive: () => true, now: () => value.observedAt + 16000 }).clients[0].presence, 'unknown');
  assert.equal(readClientPresence(project, { alive: () => true, now: () => value.observedAt - 1 }).clients[0].presence, 'unknown');
  fs.writeFileSync(path.join(path.dirname(producer.file), 'a'.repeat(64) + '.json'), '{broken');
  const read = readClientPresence(project); assert.equal(read.errors, 1); assert.equal(read.clients.length, 1);
});
test('multiple processes sharing a client ID prefer a confirmed live signal over closed history', t => {
  const { project } = fixture(t), producer = startClientPresence('cli:shared', project); t.after(() => producer.stop());
  const value = JSON.parse(fs.readFileSync(producer.file));
  fs.writeFileSync(path.join(path.dirname(producer.file), 'b'.repeat(64) + '.json'), JSON.stringify({ ...value,
    instanceId: 'other-process-instance', closed: true, observedAt: value.observedAt + 1 }));
  const client = readClientPresence(project).clients[0];
  assert.equal(client.presence, 'observed'); assert.equal(client.processCount, 2); assert.equal(client.observedProcesses, 1);
});
test('history-only Overview does not imply a broken measured presence state', () => {
  const ui = { language: 'en', L: key => label(key, 'en') };
  assert.match(presenceSummary({ agents: [{ id: 'old', source: 'job-history', presence: 'unknown' }] }, ui), /history only/);
  assert.doesNotMatch(presenceSummary({ available: false, agents: [{ id: 'live', source: 'queue-client-process-heartbeat', presence: 'observed' }] }, ui), /presence confirmed/);
});

test('presence does not turn an unrelated caller working directory into a project', t => {
  const { root } = fixture(t);
  assert.throws(() => startClientPresence('client', root), /existing fmcad project/);
  assert.equal(fs.existsSync(path.join(root, '.cad')), false);
});

test('heartbeat write failure cannot fail or replay an accepted submit', async t => {
  const { root, project } = fixture(t), dir = path.join(root, 'q'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(project, '.cad/telemetry'), 'not a directory');
  let submissions = 0;
  const server = net.createServer(socket => socket.once('data', () => { submissions++; socket.end(JSON.stringify({ ok: true, result: { id: 'accepted' } }) + '\n'); }));
  await new Promise(resolve => server.listen(path.join(dir, 'broker.sock'), resolve)); t.after(() => server.close());
  const { QueueClient } = require('../src/queue-client');
  const client = Object.assign(Object.create(QueueClient.prototype), { dir, registered: true, auth: { clientId: 'client' } });
  const result = await client.call('submit', { request: { cwd: project } });
  assert.equal(result.id, 'accepted'); assert.equal(submissions, 1);
});
