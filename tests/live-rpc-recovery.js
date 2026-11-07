'use strict';

// Opt-in fault injection at the real physical adapter boundary. Uses the one
// global broker, real Fusion and read-only Python; never stops/restarts Fusion.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createBrokerTransport } = require('../packages/node-adapters/dist/fusion-transport/broker');
const { requestTimeout } = require('../src/request-timeout');
const { resolveRuntimePaths } = require('../src/dist/config-platform');
const { serve } = require('../src/queue-broker');
const { queueDirectory, queueSocket } = require('../src/queue-connection');
const { QueueClient } = require('../src/queue-client');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error('Timed out: ' + label + '; inspect original jobs, never resubmit');
}

async function main() {
  assert.ok(process.argv.includes('--run'), 'Explicit --run required');
  const dir = queueDirectory();
  assert.ok(!fs.existsSync(path.join(dir, 'broker.lock')), 'Drain/stop the idle broker before this isolated physical fault-injection test');
  const configured = loadConfig({ routing: 'queue' }).cfg;
  assert.equal(configured.backend, 'addin', 'This real transport test currently covers the installed addin backend only');
  const cfg = { ...configured, routing: 'queue', queue: {} };
  const physical = createBrokerTransport(cfg, {
    version: require('../package.json').version,
    requestTimeout,
    bridgeSource: () => {
      const assets = resolveRuntimePaths({ anchor: path.resolve(__dirname, '../src/queue-broker.js') }).assets;
      return fs.readFileSync(path.join(assets, 'cad/identity.py'), 'utf8') + '\n' +
        fs.readFileSync(path.join(assets, 'addin-bridge.py'), 'utf8');
    },
  });
  const original = physical._post.bind(physical);
  const marker = 'FMCAD_RPC_DROP_' + randomUUID().replaceAll('-', '_');
  let releaseDrop;
  const dropGate = new Promise(resolve => { releaseDrop = resolve; });
  let dropped = 0;
  physical._post = async (payload, sessionId, controlPlane) => {
    const response = await original(payload, sessionId, controlPlane);
    if (payload.params?.name === 'execute_python' && payload.params.arguments.code.includes(marker)) {
      dropped++;
      await dropGate;
      throw Object.assign(new Error('Injected lost real Fusion RPC response after physical completion'), { code: 'ECONNRESET' });
    }
    return response;
  };
  const report = { startedAt: new Date().toISOString(), backend: cfg.backend, realFusion: true,
    modelMutationsRequested: false, automaticReplay: false, jobs: [], tests: [] };
  const reportPath = path.join(__dirname, 'live-rpc-recovery-report.json');
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const broker = await serve(cfg, { confirmOwnership: true, autoReconcile: true, createBackend: () => physical });
  const a = new QueueClient('live:rpc-loss:a:' + randomUUID(), { cfg: configured });
  const b = new QueueClient('live:rpc-loss:b:' + randomUUID(), { cfg: configured });
  await a.register(); await b.register();
  const input = (code, requestId = randomUUID()) => ({ kind: 'rpc', requestId, backend: cfg.backend,
    cwd: path.resolve(__dirname, '..'), timeoutMs: 15000, buildHash: broker.buildHash,
    payload: { jsonrpc: '2.0', id: requestId, method: 'tools/call',
      params: { name: 'execute_python', arguments: { code, persistent: false } } } });
  const terminal = (client, id) => until(async () => {
    const value = await client.call('result', { jobId: id });
    return ['succeeded', 'failed', 'cancelled', 'expired'].includes(value.job.state) && value;
  }, 'terminal result ' + id);
  const snapshot = async () => {
    const job = await a.submit(input('import adsk.core, json\na=adsk.core.Application.get()\nprint(json.dumps(sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,active=d==a.activeDocument) for d in a.documents],key=lambda d:d["id"])))'));
    const result = await terminal(a, job.id);
    assert.equal(result.job.state, 'succeeded');
    const response = JSON.parse(result.rpc.raw);
    const payload = JSON.parse(response.result.content.find(item => item.type === 'text').text);
    assert.equal(payload.success, true);
    return JSON.parse(payload.stdout);
  };
  try {
    report.before = await snapshot();
    const first = await a.submit(input('print(' + JSON.stringify(marker) + ')'));
    report.jobs.push(first.id); save();
    await until(() => dropped === 1, 'real Fusion response reached the injection point');
    const second = await b.submit(input('print("FMCAD_RPC_FOLLOWUP_OK")'));
    report.jobs.push(second.id); save();
    const releasedAt = Date.now();
    releaseDrop();
    const [lost, next] = await Promise.all([terminal(a, first.id), terminal(b, second.id)]);
    assert.equal(dropped, 1, 'Physical operation must never be replayed');
    assert.equal(lost.job.state, 'failed');
    // The receipt proves completion, not the deliberately discarded return
    // value. RESULT_UNAVAILABLE is the truthful result, not a replay/success.
    assert.equal(lost.job.code, 'RESULT_UNAVAILABLE');
    assert.equal(next.job.state, 'succeeded');
    assert.ok(Date.now() - releasedAt < 10000, 'Other client must resume promptly after completion proof');
    report.tests.push({ name: 'lost real physical RPC reply then automatic continuation', status: 'passed',
      lost: lost.job, next: next.job, droppedResponses: dropped, elapsedMs: Date.now() - releasedAt });
    save();

    const requestId = randomUUID();
    const disconnected = input('print("FMCAD_DISCONNECTED_CALLER_OK")', requestId);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(queueSocket(dir));
      socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({ action: 'submit', auth: a.auth, request: disconnected }) + '\n', () => {
        socket.destroy(); resolve(); // Lose the admission acknowledgement, never resubmit.
      }));
    });
    const durable = await until(() => Object.values(broker.status().jobs).find(job => job.requestId === requestId), 'job after caller disconnect');
    report.jobs.push(durable.id);
    const follow = await b.submit(input('print("FMCAD_AFTER_DISCONNECT_OK")'));
    report.jobs.push(follow.id);
    const [owned, followed] = await Promise.all([terminal(a, durable.id), terminal(b, follow.id)]);
    assert.equal(owned.job.state, 'succeeded');
    assert.equal(followed.job.state, 'succeeded');
    assert.equal(owned.job.dispatch.rpcCount, 1);
    report.tests.push({ name: 'caller socket disconnected, owned job and next client complete', status: 'passed', owned: owned.job, next: followed.job });
    report.after = await snapshot();
    assert.deepEqual(report.after, report.before, 'User documents or active document changed');
    assert.equal(broker.status().blocked, null);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack;
    throw error;
  } finally {
    releaseDrop();
    report.finishedAt = new Date().toISOString(); save();
    await broker.close(); // Unknown work intentionally prevents ownership release.
    console.log('RPC_RECOVERY_REPORT ' + reportPath);
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
