'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// Explicit fake physical backends require only synthetic WSL path spelling.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const { QueueState } = require('../src/queue-state');
const brokerModule = require('../src/queue-broker');
const { brokerConfigHash, serve } = brokerModule;
const { queueCommand } = require('../src/queue-cli');
const qi = require('../src/queue-instance');

const config = {
  backend: 'addin',
  url: 'http://127.0.0.1:8765/mcp',
  headers: {},
  timeoutMs: 1000,
  tool: 'execute_python',
  transport: 'node',
  protocolVersion: '2025-06-18',
  routing: 'queue',
  queue: { autoStart: true },
  controlCenter: { port: 4748 },
};

function fixture(t, { currentDocuments, oldPid, pendingJob = false, paused = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-version-transition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new QueueState(dir);
  let pendingJobId;
  if (pendingJob) {
    pendingJobId = state.submit({
      kind: 'command',
      requestId: 'pending-before-version-transition',
      clientId: 'owner',
      timeoutMs: 1000,
      argv: ['doc', 'list'],
      cwd: dir,
    }).id;
  }
  if (paused) state.pause(true, 'test-pause');

  const previous = {
    pid: oldPid ?? 2147483647,
    birth: oldPid === process.pid ? qi.processBirth() : 'old-boot:1',
    version: '2705.1.25',
    activeCommand: 'SelectCommand',
    documents: [{ id: 'old-document', isSaved: false, isModified: true }],
  };
  const current = {
    pid: 50352,
    birth: 'new-windows-process-birth',
    version: '2706.1.14',
    activeCommand: 'SelectCommand',
    documents: currentDocuments ?? [
      { id: 'current-document', fileId: null, isSaved: false, isModified: false },
    ],
  };
  const oldIdentity = {
    configHash: brokerConfigHash(config),
    buildHash: 'old-runtime-build',
    instance: previous,
  };
  qi.durable(path.join(dir, 'instance.json'), oldIdentity);

  let probes = 0;
  const client = {
    server: { timeoutMs: 1000 },
    _post() {},
    _parse: JSON.parse,
    async callTool() {
      probes++;
      return { failed: false, text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(current) };
    },
  };
  return { dir, previous, current, oldIdentity, pendingJobId, probes: () => probes, client };
}

test('explicit quiescent Fusion version transition records both identities before readiness', async (t) => {
  const f = fixture(t);
  const broker = await serve(config, {
    dir: f.dir,
    confirmOwnership: true,
    confirmVersionTransition: true,
    createBackend: () => f.client,
  });

  try {
    assert.equal(f.probes(), 1);
    const identity = qi.readJson(path.join(f.dir, 'instance.json'));
    assert.equal(identity.instance.version, '2706.1.14');
    assert.equal(identity.configHash, f.oldIdentity.configHash);
    const files = fs.readdirSync(f.dir).filter(name => name.startsWith('instance-transition-'));
    assert.equal(files.length, 1);
    const transition = qi.readJson(path.join(f.dir, files[0]));
    assert.equal(transition.source, 'explicit-quiescent-version-transition');
    assert.deepEqual(transition.previous, f.previous);
    assert.deepEqual(transition.current, f.current);
    assert.equal(broker.status().held, null);
  } finally {
    await broker.close();
  }
});

test('version transition stays fenced without explicit confirmation or clean, quiescent state', async (t) => {
  const cases = [
    { name: 'explicit confirmation', options: {} },
    {
      name: 'modified current document',
      options: { confirmVersionTransition: true },
      fixture: { currentDocuments: [{ id: 'current-document', isSaved: false, isModified: true }] },
    },
    {
      name: 'live previous Fusion process',
      options: { confirmVersionTransition: true },
      fixture: { oldPid: process.pid },
    },
    {
      name: 'nonterminal queued job',
      options: { confirmVersionTransition: true },
      fixture: { pendingJob: true },
    },
    {
      name: 'manual queue pause',
      options: { confirmVersionTransition: true },
      fixture: { paused: true },
    },
  ];

  for (const scenario of cases) {
    const f = fixture(t, scenario.fixture);
    await assert.rejects(
      serve(config, {
        dir: f.dir,
        confirmOwnership: true,
        ...scenario.options,
        createBackend: () => f.client,
      }),
      { code: 'INSTANCE_CHANGED' },
      scenario.name,
    );
    assert.equal(f.probes(), 1, scenario.name);
    assert.deepEqual(qi.readJson(path.join(f.dir, 'instance.json')), f.oldIdentity, scenario.name);
    const state = new QueueState(f.dir);
    assert.equal(state.data.jobs[f.pendingJobId]?.state, scenario.fixture?.pendingJob ? 'queued' : undefined);
  }
});

test('queue serve passes the version-transition flag only as explicit confirmation', async (t) => {
  const originalServe = brokerModule.serve;
  const beforeSignals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  let received;
  brokerModule.serve = async (cfg, options) => {
    received = { cfg, options };
    return { socket: '/tmp/fake-broker.sock', buildHash: 'test-build' };
  };
  t.after(() => {
    brokerModule.serve = originalServe;
    for (const [signal, before] of beforeSignals) {
      for (const listener of process.listeners(signal))
        if (!before.has(listener)) process.removeListener(signal, listener);
    }
  });

  await queueCommand(['serve', '--confirm-ownership', 'true', '--confirm-version-transition', 'true'], {
    loadConfig: () => ({ cfg: config }),
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(received.options.confirmOwnership, true);
  assert.equal(received.options.confirmVersionTransition, true);
});
