const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { QueueState } = require('../src/queue-state');
const { hash } = require('../src/batch');
const { atomicStatusSummaryFromReply, deriveAtomicHolderScope, prepareAtomicHolderObservation, validateAtomicReconcileInvocation,
  isAtomicObservationCandidate, validateAtomicRuntimeSourceCompatibility, verifyAtomicObservationFence,
  snapshotStillCurrent } = require('../src/atomic-workflow-observation');
const atomicObserverComposition = require('./fixtures/atomic-observer-composition.json');
const observerLiteralReader = path.join(__dirname, 'fixtures', 'observer-python-literals.py');

async function atomicScopeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-atomic-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, 'batch-v1');
  fs.mkdirSync(reportPath, { mode: 0o700 });
  const docId = 'f9f27526-55d2-47bb-a4d8-312246f2de08';
  const commandId = 'fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7';
  const sessionNonce = 'a87b938ad05f67893a0af5889b7b36c3';
  const requestId = 'measured-fasteners-fixture-setup-20261027-1905z';
  const request = { runId: 'fasteners-fixture', atomic: true, operations: [{ id: 'capture', operation: 'entity.list', data: {} }] };
  const context = { doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX', docId, component: null, projectId: null };
  const requestHash = hash({ request, context });
  const documentIdentity = {
    expected: { name: context.doc, creationId: docId, fileId: null },
    resolved: { name: context.doc, creationId: docId, fileId: null },
    assertionsOnly: false,
  };
  const report = {
    version: 2, operation: 'batch.run', runId: request.runId, requestHash, request, context,
    commandId, sessionNonce, reportPath, status: 'unknown', outcome: 'unknown',
    atomic: { effective: true, supported: true, backend: 'addin' }, documentIdentity,
    sequence: 0,
    journal: { event: 'submit_unknown', commandId, runId: request.runId, requestHash,
      documentIdentity, backend: 'addin', sessionNonce },
  };
  fs.writeFileSync(path.join(reportPath, '00000000.json'), JSON.stringify(report), { mode: 0o600 });
  const job = {
    id: '5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a', requestId, clientId: 'cli:PC:kamil',
    hash: 'original-job-hash',
    kind: 'command', state: 'needs_reconciliation', physicalTurns: 2,
    dispatch: { rpcCount: 2 },
    request: {
      requestId, clientId: 'cli:PC:kamil', kind: 'command', backend: 'addin', buildHash: 'original-build', cwd: root,
      payload: {
        version: 1, kind: 'cad', operation: 'batch.run', data: { ...request, reportPath },
        doc: context.doc, docId, preview: false,
      },
    },
  };
  const scope = {
    version: 1, kind: 'atomic_holder_status', jobId: job.id, requestId, projectDirectory: root, reportPath,
    commandId, sessionNonce, docId,
  };
  const reconcileInvocation = {
    operation: 'batch.reconcile',
    data: { reportPath, blockedJobId: job.id, commandId, sessionNonce, operations: [] },
    doc: context.doc,
    docId,
  };
  return { reportPath, docId, commandId, sessionNonce, requestId, job, reconcileInvocation, scope };
}

function observerPythonLiterals(script) {
  const result = spawnSync('python3', ['-I', '-B', observerLiteralReader], {
    input: script, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('observer fixture reads receipt metadata inside _qr_execute as literals without executing code', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-observer-literals-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binding = { rpcId: '11111111-1111-4111-8111-111111111111',
    observationKind: 'atomic_holder_status', pythonOriginHash: 'a'.repeat(64) };
  const request = { operation: 'atomic_status' };
  const receiptPath = String.raw`\\wsl$\Ubuntu\tmp\observer.receipt.json`;
  const sideEffectPath = path.join(directory, 'must-not-exist');
  const script = [
    `_ATOMIC_STATUS_REQUEST = __import__('json').loads(${JSON.stringify(JSON.stringify(request))})`,
    'def _qr_execute() -> None:',
    `    _qr_binding_value = _qr_cast(object, _qr_json.loads(${JSON.stringify(JSON.stringify(binding))}))`,
    '    _qr_binding = _qr_object(_qr_binding_value)',
    `    _qr_path = ${JSON.stringify(receiptPath)}`,
    `    open(${JSON.stringify(sideEffectPath)}, "w").write("executed")`,
  ].join('\n');

  const values = observerPythonLiterals(script);
  assert.deepEqual(values._ATOMIC_STATUS_REQUEST, request);
  assert.deepEqual(values._qr_binding, binding);
  assert.equal(values._qr_path, receiptPath);
  assert.equal(fs.existsSync(sideEffectPath), false, 'the test parser must never execute wrapper code');
});

test('atomic observer E2E manifest keeps the isolated qualification composition explicit', () => {
  assert.equal(atomicObserverComposition.version, 1);
  assert.equal(atomicObserverComposition.approvedBase.semanticIdentityCommit,
    'f6eea61d4753ac315587f8d3af61701a099e4c97');
  assert.equal(atomicObserverComposition.approvedBase.admissionPortTip,
    '8c7b7fdb97af29d58ac9c04feeb96031be25012d');
  assert.equal(atomicObserverComposition.entrypoints.fixtureReader, 'tests/fixtures/observer-python-literals.py');
  assert.equal(atomicObserverComposition.entrypoints.runProof,
    'tests/atomic-workflow-recovery.test.js#compositionProof');
  assert.deepEqual(atomicObserverComposition.positive.origins, ['typed', 'raw']);
  assert.equal(atomicObserverComposition.positive.physicalSenderCallsPerOrigin, 1);
  assert.equal(atomicObserverComposition.negative.physicalSenderCallsPerMode, 0);
  assert.equal(atomicObserverComposition.qualification.approvedSourceCommit,
    'c00b96c73bc04e5441dd950ed9da34137d208e64');
  assert.equal(atomicObserverComposition.qualification.readerSourceApprovedCommit,
    'cf56791b52fe5c2fca3cad663fe6a0629dbc4f5f');
  assert.equal(atomicObserverComposition.qualification.result, 'scoped-observer-approved-passed');
  assert.equal(atomicObserverComposition.qualification.requiresRetestOnApprovedReaderCommit, false);
  assert.equal(atomicObserverComposition.qualification.counts.build, 'passed');
  assert.equal(atomicObserverComposition.qualification.counts.typecheck, 'passed');
  assert.equal(atomicObserverComposition.qualification.counts.lint, 'passed');
  assert.equal(atomicObserverComposition.qualification.counts.recovery, 11);
  assert.equal(atomicObserverComposition.qualification.counts.installedAdmission, 7);
  assert.equal(atomicObserverComposition.qualification.additionalEntrypointAudit.operation, 'document.status');
  assert.equal(atomicObserverComposition.qualification.additionalEntrypointAudit.status,
    'PYTHON_CHECK_REJECTED_before_sender');
  assert.equal(atomicObserverComposition.qualification.additionalEntrypointAudit.diagnosticCount, 1315);
  assert.match(atomicObserverComposition.qualification.additionalEntrypointAudit.dispatchEvidence,
    /no RPC journal or remote receipt/);
  assert.equal(Object.values(atomicObserverComposition.qualification.additionalEntrypointAudit.diagnosticsByFile)
    .reduce((total, count) => total + count, 0), 1315);
  assert.equal(atomicObserverComposition.qualification.additionalEntrypointAudit.relevantSourceUnchangedThrough,
    'c00b96c73bc04e5441dd950ed9da34137d208e64');
});

test('reproduces batch.reconcile deadlock behind a typed unknown atomic holder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-atomic-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new QueueState(dir);
  const owner = 'cli:PC:kamil';
  const commandId = 'fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7';
  const sessionNonce = 'a87b938ad05f67893a0af5889b7b36c3';
  const docId = 'f9f27526-55d2-47bb-a4d8-312246f2de08';

  const original = state.submit({
    kind: 'command',
    requestId: 'measured-fasteners-fixture-setup-20261027-1905z',
    clientId: owner,
    timeoutMs: 180000,
    argv: ['batch', 'run', '--report-path', '/tmp/opencode/measured-fasteners-native/batch-v1'],
    cwd: '/tmp/opencode/fmcad-backlog/measured-fasteners',
  });
  state.next();
  state.markDispatch(original.id, { rpcCount: 2, completedCount: 1 });
  state.block(original.id, {
    code: 'WORKFLOW_NONTERMINAL',
    workflowOutcome: { type: 'atomic-batch', commandId, sessionNonce, docId },
  });

  const observer = state.submit({
    kind: 'command',
    requestId: 'fasteners-scoped-atomic-observation',
    clientId: owner,
    timeoutMs: 180000,
    argv: [
      'batch', 'reconcile',
      '--report-path', '/tmp/opencode/measured-fasteners-native/batch-v1',
      '--data', '{}',
    ],
    cwd: '/tmp/opencode/fmcad-backlog/measured-fasteners',
  });

  assert.equal(state.status(original.id).state, 'needs_reconciliation');
  assert.equal(state.status(observer.id).state, 'queued');
  assert.equal(state.summary().blocked.id, original.id);
  assert.equal(state.summary().active, original.id);
  assert.equal(state.next(), null, 'the normal queue scheduler will not grant a second job');
  assert.equal(state.status(observer.id).state, 'queued');
  assert.equal(state.status(original.id).dispatch.rpcCount, 2, 'reconciliation did not replay the original workflow');
});

test('the same QueueDomain scheduler grants one marked atomic observer without clearing the original block', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-atomic-observation-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new QueueState(dir);
  const clientId = 'fasteners-owner';
  const target = state.submit({ kind: 'command', requestId: 'target-request', clientId, timeoutMs: 1000,
    backend: 'addin', buildHash: 'original-build', argv: ['cad', 'batch', 'run'], cwd: dir,
    payload: { version: 1, kind: 'cad', operation: 'batch.run', data: { runId: 'run', reportPath: path.join(dir, 'batch') }, doc: 'Model', docId: 'doc-creation' } });
  state.next();
  state.markDispatch(target.id, { rpcCount: 1, completedCount: 0 });
  state.block(target.id, { code: 'WORKFLOW_NONTERMINAL' });
  const marker = {
    version: 1, kind: 'atomic-holder-status', targetJobId: target.id, targetRequestId: target.requestId,
    targetClientId: clientId, targetJobHash: state.data.jobs[target.id].hash,
    targetBuildHash: 'original-build', observerBuildHash: 'observer-build', projectDirectory: dir,
    paused: state.data.paused, controlGeneration: state.data.controlGeneration || 0, contextEpoch: state.data.contextEpoch || 0,
    reportPath: path.join(dir, 'batch'),
    reportFingerprint: 'a'.repeat(64), commandId: 'fmcad_atomic_' + 'b'.repeat(32),
    sessionNonce: 'c'.repeat(32), docId: 'doc-creation',
  };
  const observer = state.submit({ kind: 'command', requestId: 'observer-request', clientId, timeoutMs: 1000,
    backend: 'addin', buildHash: 'observer-build', argv: ['cad', 'batch', 'reconcile', '--doc-id', 'doc-creation'], cwd: dir,
    payload: { version: 1, kind: 'cad', operation: 'batch.reconcile',
      data: { reportPath: marker.reportPath, blockedJobId: target.id, commandId: marker.commandId,
        sessionNonce: marker.sessionNonce }, doc: 'Model', docId: 'doc-creation' } });
  marker.observerJobHash = state.data.jobs[observer.id].hash;
  state.armWorkflowObservation(observer.id, marker);
  assert.equal(state.next().id, observer.id);
  assert.equal(state.summary().active, observer.id);
  assert.equal(state.summary().blocked.id, target.id);
  assert.equal(state.status(target.id).state, 'needs_reconciliation');
  state.finish(observer.id, { state: 'succeeded', code: 'ATOMIC_STATUS_OBSERVED', mayHaveMutated: false });
  assert.equal(state.status(observer.id).state, 'succeeded');
  assert.equal(state.summary().active, target.id);
  assert.equal(state.summary().blocked.id, target.id);
  assert.equal(state.status(target.id).state, 'needs_reconciliation');
  const duplicate = state.submit({ kind: 'command', requestId: 'observer-request-2', clientId, timeoutMs: 1000,
    backend: 'addin', buildHash: 'observer-build', argv: ['cad', 'batch', 'reconcile', '--doc-id', 'doc-creation'], cwd: dir,
    payload: { version: 1, kind: 'cad', operation: 'batch.reconcile',
      data: { reportPath: marker.reportPath, blockedJobId: target.id, commandId: marker.commandId,
        sessionNonce: marker.sessionNonce }, doc: 'Model', docId: 'doc-creation' } });
  const duplicateMarker = { ...marker, observerJobHash: state.data.jobs[duplicate.id].hash };
  assert.throws(() => state.armWorkflowObservation(duplicate.id, duplicateMarker), { code: 'WORKFLOW_OBSERVATION_EXISTS' });
});

test('one marked read-only observer can run through an already paused gate without changing that pause', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-atomic-paused-observation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new QueueState(dir);
  const clientId = 'fasteners-owner';
  const reportPath = path.join(dir, 'batch-v1');
  const commandId = 'fmcad_atomic_' + 'b'.repeat(32);
  const sessionNonce = 'c'.repeat(32);
  const docId = 'doc-creation';
  const target = state.submit({ kind: 'command', requestId: 'target-request', clientId, timeoutMs: 1000,
    backend: 'addin', buildHash: 'original-build', argv: ['cad', 'batch', 'run'], cwd: dir,
    payload: { version: 1, kind: 'cad', operation: 'batch.run', data: { runId: 'run', reportPath }, doc: 'Model', docId } });
  state.next();
  state.markDispatch(target.id, { rpcCount: 1, completedCount: 0 });
  state.block(target.id, { code: 'WORKFLOW_NONTERMINAL' });
  state.pause(true, 'owner-pause-before-observation');
  const marker = {
    version: 1, kind: 'atomic-holder-status', targetJobId: target.id, targetRequestId: target.requestId,
    targetClientId: clientId, targetJobHash: state.data.jobs[target.id].hash,
    targetBuildHash: 'original-build', observerBuildHash: 'observer-build', projectDirectory: dir,
    paused: state.data.paused, controlGeneration: state.data.controlGeneration || 0, contextEpoch: state.data.contextEpoch || 0,
    reportPath, reportFingerprint: 'a'.repeat(64), commandId, sessionNonce, docId,
  };
  const observer = state.submit({ kind: 'command', requestId: 'observer-request', clientId, timeoutMs: 1000,
    backend: 'addin', buildHash: 'observer-build', argv: ['cad', 'batch', 'reconcile'], cwd: dir,
    payload: { version: 1, kind: 'cad', operation: 'batch.reconcile', data: {
      reportPath, blockedJobId: target.id, commandId, sessionNonce,
    }, doc: 'Model', docId } });
  marker.observerJobHash = state.data.jobs[observer.id].hash;
  state.armWorkflowObservation(observer.id, marker);
  assert.equal(state.next().id, observer.id);
  state.finish(observer.id, { state: 'succeeded', code: 'ATOMIC_STATUS_OBSERVED', mayHaveMutated: false });
  assert.equal(state.data.paused, true, 'scoped observation never resumes or rewrites pause state');
  assert.equal(state.data.controlGeneration, marker.controlGeneration);
  assert.equal(state.data.active, target.id);
  assert.equal(state.data.blocked.id, target.id);
  assert.equal(state.status(target.id).state, 'needs_reconciliation');
});

test('broker generic reconcile sends no probe and rejects an unscoped follow-up while blocked', { timeout: 15000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-atomic-broker-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const child = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.env.FMCAD_ATOMIC_RECOVERY_ROOT;
    const base = process.env.FMCAD_ATOMIC_RECOVERY_TMP;
    const dir = path.join(base, 'queue');
    const { QueueState } = require(path.join(root, 'src/queue-state'));
    const { serve } = require(path.join(root, 'src/queue-broker'));
    const { request } = require(path.join(root, 'src/queue-connection'));
    const { durable, buildHash, brokerConfigHash } = require(path.join(root, 'src/queue-instance'));
    const cfg = {
      backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {}, timeoutMs: 1000,
      tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18', routing: 'queue',
      queue: { autoStart: true }, controlCenter: { port: 4748 },
    };
    const instance = { pid: 42, birth: 'test:42', version: 'fixture', activeCommand: 'SelectCommand', documents: [] };
    const state = new QueueState(dir);
    const job = state.submit({
      kind: 'command', requestId: 'measured-fasteners-fixture-setup-20261027-1905z', clientId: 'fasteners-owner',
      timeoutMs: 5000, argv: ['batch', 'run', '--report-path', '/tmp/opencode/measured-fasteners-native/batch-v1'],
      cwd: '/tmp/opencode/fmcad-backlog/measured-fasteners', buildHash: buildHash(),
    });
    state.next();
    state.markDispatch(job.id, { rpcCount: 2, completedCount: 1 });
    state.block(job.id, { code: 'WORKFLOW_NONTERMINAL' });
    const jobDir = path.join(dir, 'jobs', job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    durable(path.join(jobDir, 'worker-result.json'), {
      jobId: job.id, terminal: false, nonterminal: true,
      workflowOutcome: { operation: 'batch.run', outcome: 'unknown' },
    });
    durable(path.join(dir, 'instance.json'), {
      configHash: brokerConfigHash(cfg), buildHash: buildHash(), instance,
    });
    let sdkCalls = 0;
    const physical = {
      server: { timeoutMs: 1000 }, _parse: JSON.parse,
      async _post() { sdkCalls++; throw new Error('No SDK or physical RPC expected'); },
      async callTool() { sdkCalls++; throw new Error('No SDK probe expected'); },
    };
    (async () => {
      await serve(cfg, { dir, confirmOwnership: true, createBackend: () => physical, autoReconcile: false, pollMs: 10000 });
      const auth = { clientId: 'fasteners-owner', clientToken: 'private-owner-token' };
      await request(dir, { action: 'register', ...auth });
      await assert.rejects(request(dir, { action: 'reconcile', jobId: job.id, auth }), {
        code: 'WORKFLOW_RECONCILIATION_REQUIRED',
      });
      assert.equal(sdkCalls, 0, 'generic reconcile sends no physical probe for typed unknown workflow');
      await assert.rejects(request(dir, { action: 'submit', auth, request: {
        kind: 'command', requestId: 'fasteners-atomic-batch-reconcile', clientId: auth.clientId,
        backend: 'addin', timeoutMs: 5000, buildHash: buildHash(),
        argv: ['cad', 'batch', 'reconcile'], cwd: '/tmp/opencode/fmcad-backlog/measured-fasteners',
        payload: { version: 1, kind: 'cad', operation: 'batch.reconcile',
          data: { reportPath: '/tmp/opencode/measured-fasteners-native/batch-v1', operations: [] },
          doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX',
          docId: 'f9f27526-55d2-47bb-a4d8-312246f2de08' },
      } }), { code: 'INVALID_WORKFLOW_SCOPE' });
      const blocked = await request(dir, { action: 'status', jobId: job.id, auth });
      assert.equal(blocked.state, 'needs_reconciliation');
      assert.equal(sdkCalls, 0);
      process.stdout.write(JSON.stringify({ originalJobId: job.id, sdkCalls }));
      process.exit(0);
    })().catch(error => {
      process.stderr.write(String(error.stack || error));
      process.exit(1);
    });
  `;
  const result = spawnSync(process.execPath, ['--require', require.resolve('./fixtures/fake-wsl-preload.cjs'), '-e', child], {
    cwd: root,
    encoding: 'utf8',
    timeout: 12000,
    env: { ...process.env, FMCAD_ATOMIC_RECOVERY_ROOT: root, FMCAD_ATOMIC_RECOVERY_TMP: dir },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout);
  assert.ok(proof.originalJobId);
  assert.equal(proof.sdkCalls, 0);
});

test('broker runs one typed atomic_status observer through the existing gate and leaves the original job blocked', { timeout: 240000 }, (t) => {
  const dir = fs.mkdtempSync(path.join('/tmp/opencode', 'fmcad-atomic-broker-observe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.resolve(__dirname, '..');
  const root = require('./fixtures/isolated-observer-source.cjs').isolatedObserverSource(sourceRoot, path.join(dir, 'code'));
  const child = String.raw`
    (async () => {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.env.FMCAD_ATOMIC_RECOVERY_ROOT;
    const base = process.env.FMCAD_ATOMIC_RECOVERY_TMP;
    process.env.XDG_STATE_HOME = path.join(base, 'state');
    const rawOrigin = process.env.FMCAD_ATOMIC_RECOVERY_RAW_ORIGIN === 'true';
    const checkerMode = process.env.FMCAD_ATOMIC_RECOVERY_CHECKER_MODE || 'passed';
    const auditMode = process.env.FMCAD_ATOMIC_RECOVERY_AUDIT === 'true';
    let restoreOnExit = null;
    if (checkerMode === 'failed' || checkerMode === 'incomplete') {
      const file = path.join(root, 'runtime/python/fmcad/adapters/fusion/atomic_status.py');
      const bytes = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(checkerMode === 'failed'
        ? '\n__observer_invalid_type: int = "invalid"\n' : '\nimport fmcad_missing_observer_test_module_xyz\n')]));
      restoreOnExit = () => fs.writeFileSync(file, bytes);
    } else if (checkerMode === 'tool_error' || checkerMode === 'missing_checker') {
      const pkg = require.resolve('basedpyright/package.json', { paths: [root] });
      assert.ok(pkg.startsWith(path.join(root, 'node_modules', 'basedpyright') + path.sep),
        'negative fixture must never alter a shared checker installation');
      const file = checkerMode === 'tool_error' ? path.join(path.dirname(pkg), 'dist/pyright.js') : pkg;
      const preserved = file + '.observer-fixture-backup';
      fs.renameSync(file, preserved);
      restoreOnExit = () => fs.renameSync(preserved, file);
    }
    if (restoreOnExit) process.once('exit', restoreOnExit);
    const compositionManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/atomic-observer-composition.json'), 'utf8'));
    const queueDir = require(path.join(root, 'src/queue-connection')).queueDirectory();
    const project = path.join(base, 'project');
    const reportPath = path.join(base, 'fasteners', 'batch-v1');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(reportPath, { recursive: true });
    const { QueueState } = require(path.join(root, 'src/queue-state'));
    if (checkerMode === 'final_byte_tamper') {
      const module = require(path.join(root, 'src/queue-admission'));
      const create = module.createProductionQueueAdmission;
      module.createProductionQueueAdmission = (...args) => {
        const production = create(...args);
        return { ...production, fencePrepared(prepared, expectedBuildHash) {
          prepared.outgoing.params.arguments.code += '\n';
          return production.fencePrepared(prepared, expectedBuildHash);
        } };
      };
    }
    const { serve } = require(path.join(root, 'src/queue-broker'));
    const { request } = require(path.join(root, 'src/queue-connection'));
    const { durable, buildHash, brokerConfigHash, hash } = require(path.join(root, 'src/queue-instance'));
    const { deriveAtomicHolderScope, prepareAtomicHolderObservation } = require(path.join(root, 'src/atomic-workflow-observation'));
    const config = {
      backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {}, timeoutMs: 12000,
      tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18', routing: 'queue',
      queue: { autoStart: true }, controlCenter: { port: 4748 },
    };
    const originalBuild = 'a'.repeat(64), observerBuild = buildHash();
    const instance = { pid: 50352, birth: 'fixture:50352', version: '2706.1.14', activeCommand: 'SelectCommand', documents: [] };
    const owner = 'fasteners-owner', requestId = 'measured-fasteners-fixture-setup-20261027-1905z';
    const doc = 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX';
    const docId = 'f9f27526-55d2-47bb-a4d8-312246f2de08';
    const commandId = 'fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7';
    const sessionNonce = 'a87b938ad05f67893a0af5889b7b36c3';
    const inputData = { runId: 'fasteners-fixture', atomic: true,
      operations: [{ id: 'probe', operation: 'entity.list', data: { kind: 'body' } }], reportPath };
    const context = { doc, docId, preview: false };
    const reportRequest = { ...inputData }; delete reportRequest.reportPath;
    const requestHash = require(path.join(root, 'dist/src/dist/core/application/cad/json')).hash({ request: reportRequest, context });
    const documentIdentity = {
      expected: { name: doc, creationId: docId, fileId: null },
      resolved: { name: doc, creationId: docId, fileId: null },
      assertionsOnly: false,
    };
    const report = {
      version: 2, operation: 'batch.run', runId: inputData.runId, requestHash, request: reportRequest,
      context, status: 'unknown', outcome: 'unknown', reportPath,
      atomic: { effective: true, supported: true, backend: 'addin' }, commandId, sessionNonce,
      documentIdentity, sequence: 0,
      journal: { event: 'submit_unknown', commandId, runId: inputData.runId, requestHash,
        documentIdentity, backend: 'addin', sessionNonce },
    };
    fs.writeFileSync(path.join(reportPath, '00000000.json'), JSON.stringify(report), { mode: 0o600 });

    const state = new QueueState(queueDir);
    const approvedScope = { jobId: null, requestId, projectDirectory: project, reportPath,
      commandId, sessionNonce, docId };
    const targetInvocation = { version: 1, kind: 'cad-command', invocation: {
      version: 1, kind: 'cad', operation: 'batch.run', data: inputData,
      doc, docId, docFileId: null, component: null, projectId: null, preview: false,
    }, output: { json: rawOrigin, summary: false } };
    const inputFile = path.join(base, 'original-batch.json');
    const inputBytes = JSON.stringify(inputData);
    fs.writeFileSync(inputFile, inputBytes);
    const target = state.submit({ kind: 'command', phased: true, requestId, clientId: owner, backend: 'addin',
      buildHash: originalBuild, timeoutMs: 12000, cwd: project,
      ...(rawOrigin ? { argv: ['batch', 'run', '--doc', doc, '--doc-id', docId, '--file', inputFile, '--json'],
        inputFiles: [{ path: inputFile, sha256: hash(inputBytes) }] }
        : { argv: ['cad', 'batch', 'run'], payload: targetInvocation }) });
    approvedScope.jobId = target.id;
    state.readyTurn(target.id); state.next();
    state.markDispatch(target.id, { rpcCount: 1, completedCount: 1 });
    state.releaseTurn(target.id, 10000);
    state.readyTurn(target.id); state.next();
    state.markDispatch(target.id, { rpcCount: 2, completedCount: 1 });
    state.block(target.id, { code: 'WORKFLOW_NONTERMINAL', reason: 'fixture unknown; no result payload is read by test' });
    state.pause(true, 'fasteners-owner-pause');
    const targetJob = state.data.jobs[target.id];
    const targetDir = path.join(queueDir, 'jobs', target.id);
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    if (rawOrigin) {
      const typedRequest = require(path.join(root, 'src/composition/execution-request')).prepareRequest(targetJob);
      durable(path.join(targetDir, 'request.json'), { id: target.id, request: typedRequest, buildHash: originalBuild }, true);
      fs.writeFileSync(inputFile, '{"changedAfterOriginalAdmission":true}');
    }
    const scope = deriveAtomicHolderScope(targetJob, {
      operation: 'batch.reconcile',
      data: { reportPath, operations: [], blockedJobId: target.id, commandId, sessionNonce },
      doc, docId, docFileId: null, component: null, projectId: null, preview: false,
    }, project, approvedScope);
    const prepared = await prepareAtomicHolderObservation(targetJob, scope, {
      clientId: owner, observerBuildHash: observerBuild, originalBuildHash: originalBuild,
      approvedScope,
    });
    let originalDispatchId = 0;
    for (const rpcId of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      const wireId = 'fmcad:' + rpcId;
      const binding = { jobId: target.id, rpcId, requestHash: hash('original:' + rpcId), buildHash: originalBuild, sourceHash: hash('atomic-original-source') };
      const receipt = path.join(targetDir, 'remote-' + rpcId + '.json');
      const request = { jsonrpc: '2.0', method: 'tools/call', id: 'caller:' + rpcId };
      const wireRequest = { jsonrpc: '2.0', method: 'tools/call', id: wireId };
      const response = { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: wireId,
        result: { content: [{ type: 'text', text: 'accepted original script' }] } }) };
      durable(path.join(targetDir, 'rpc-' + rpcId + '.json'), {
        binding, instance, request, wireRequest, response, terminal: true, method: 'tools/call', receipt,
        pythonArtifact: { version: 1, units: prepared.sourceCompatibilityUnits.map(({ id, filename, sha256 }) => ({ id, filename, role: 'runtime', sha256 })) },
      }, true);
      durable(receipt, { ...binding, terminal: true, outcome: 'succeeded', instance }, true);
      originalDispatchId++;
    }
    assert.equal(originalDispatchId, 2);
    durable(path.join(queueDir, 'instance.json'), { configHash: brokerConfigHash(config), buildHash: originalBuild, instance });
    const summary = {
      status: 'completed', accepted: true, completed: true, destroyed: true, cleanupCompleted: false,
      definitionDeleted: false, outcome: 'committed', terminationReason: 1, idle: true,
      createdCount: 1, executeCount: 1, executeCompleted: true, terminationCompleted: true,
      identity: prepared.identity,
    };
    if (auditMode) {
      Object.assign(summary, { status: 'unavailable', accepted: null, completed: false, destroyed: false,
        outcome: 'unknown', createdCount: null, executeCount: null });
      delete summary.identity;
    }
    let physicalCalls = 0, observedOperation = null;
    const unwrap = source => {
      for (let depth = 0; depth < 8; depth++) {
        const nested = source.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
        if (!nested) return source;
        source = JSON.parse(nested[1]);
      }
      throw new Error('script nesting too deep');
    };
    const readObserverLiterals = script => {
      const parsed = require('node:child_process').spawnSync('python3', ['-I', '-B',
        path.join(root, 'tests/fixtures/observer-python-literals.py')], { input: script, encoding: 'utf8', timeout: 10000 });
      assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
      return JSON.parse(parsed.stdout);
    };
    const physical = {
      server: { timeoutMs: 12000, backend: 'addin' }, capabilities: { backend: 'addin', atomicBatch: true },
      _parse: JSON.parse,
      async _post(payload) {
        physicalCalls++;
        assert.equal(payload.method, 'tools/call');
        assert.equal(payload.params.name, 'execute_python');
        const args = payload.params.arguments;
        assert.equal(args.persistent, false);
        const source = unwrap(args.code);
        const literals = readObserverLiterals(source);
        observedOperation = literals._AA_REQUEST ? 'atomic_recovery_audit' : literals._ATOMIC_STATUS_REQUEST.operation;
        assert.ok(['atomic_status', 'atomic_recovery_audit'].includes(observedOperation));
        const receiptMetadata = readObserverLiterals(args.code);
        const binding = receiptMetadata._qr_binding;
        const rawReceiptPath = receiptMetadata._qr_path;
        assert.ok(binding && rawReceiptPath, 'scoped call has the broker-bound remote receipt wrapper');
        const receiptPath = rawReceiptPath.replace(/^\\\\wsl\$\\[^\\]+/, '').replaceAll('\\', '/');
        durable(receiptPath, { ...binding, terminal: true, outcome: 'succeeded', instance }, true);
        let returned = summary;
        if (literals._AA_REQUEST) {
          const identity = literals._AA_REQUEST.identity;
          const snapshot = { identity: identity.resolvedIdentity, version: null, isSaved: false, isModified: false,
            bodies: 0, sketches: 0, occurrences: 0, parameters: 0, timeline: 0, references: 0 };
          returned = { version: 1, purpose: 'atomic-recovery-audit-v1', profile: 'atomic-recovery-counts-v1',
            requestIdentity: identity, nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed',
            modulePresent: false, ui: { activeCommand: 'SelectCommand', idle: true }, commandDefinition: { status: 'absent' },
            document: { status: 'observed', identity: identity.resolvedIdentity }, snapshot,
            fingerprint: require(path.join(root, 'src/dist/core/application/cad/json')).hash(snapshot) };
        }
        return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
          result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(returned) }] } }) };
      },
      async callTool(request, tool = 'fusion_mcp_execute') {
        assert.equal(tool, 'fusion_mcp_execute');
        assert.equal(request.featureType, 'script');
        assert.equal(request.object.readOnly, true);
        const code = request.object.script + '\n\nrun("")\n';
        const response = await this._post({ jsonrpc: '2.0', id: 'mcp-caller', method: 'tools/call',
          params: { name: 'execute_python', arguments: { code, persistent: false } } });
        return { failed: false, text: JSON.parse(response.raw).result.content[0].text };
      },
    };
    let broker;
    try {
      broker = await serve(config, { dir: queueDir, confirmOwnership: true, createBackend: () => physical,
        autoReconcile: false, pollMs: 5, testAtomicWorkflowScope: approvedScope, testFusionProcessAlive: () => true });
    } catch (error) {
      if (checkerMode === 'missing_checker') {
        assert.equal(physicalCalls, 0);
        process.stdout.write(JSON.stringify({ checkerMode, physicalCalls, startupRefused: true }));
        process.exit(0);
      }
      throw error;
    }
    void broker;
    let phase = 'register';
    try {
      const auth = { clientId: owner, clientToken: 'fasteners-private-token' };
      await request(queueDir, { action: 'register', ...auth });
      const foreign = { clientId: 'foreign-owner', clientToken: 'foreign-private-token' };
      await request(queueDir, { action: 'register', ...foreign });
      phase = 'submit';
      const reconcileInvocation = { version: 1, kind: 'cad-command', invocation: {
        version: 1, kind: 'cad', operation: 'batch.reconcile',
        data: { reportPath, operations: [], blockedJobId: target.id, commandId, sessionNonce },
        doc, docId, docFileId: null, component: null, projectId: null, preview: false,
      }, output: { json: false, summary: false } };
      const buildObserverRequest = (requestId, payload = reconcileInvocation, requestClientId = owner) => ({
        kind: 'command', requestId, clientId: requestClientId, backend: 'addin', buildHash: observerBuild,
        timeoutMs: 12000, argv: ['cad', 'batch', 'reconcile', '--doc', doc, '--doc-id', docId],
        cwd: project, clientContext: { clientId: requestClientId, requestId, projectDirectory: project, doc, docId }, payload,
      });
      await assert.rejects(request(queueDir, { action: 'submit', auth: foreign,
        request: buildObserverRequest('wrong-owner-observe') }), { code: 'NOT_OWNER' });
      for (const [name, mutate] of [
        ['wrong-command', value => { value.invocation.data.commandId = 'fmcad_atomic_' + '0'.repeat(32); }],
        ['wrong-session', value => { value.invocation.data.sessionNonce = '0'.repeat(32); }],
        ['wrong-document', value => { value.invocation.docId = 'different-creation-id'; }],
        ['wrong-report', value => { value.invocation.data.reportPath = path.join(base, 'other-report'); }],
      ]) {
        const altered = structuredClone(reconcileInvocation);
        mutate(altered);
        await assert.rejects(request(queueDir, { action: 'submit', auth,
          request: buildObserverRequest(name + '-observe', altered) }), { code: 'INVALID_WORKFLOW_SCOPE' });
      }
      const wrongProject = buildObserverRequest('wrong-project-observe');
      wrongProject.cwd = path.join(base, 'other-project');
      wrongProject.clientContext.projectDirectory = wrongProject.cwd;
      await assert.rejects(request(queueDir, { action: 'submit', auth, request: wrongProject }),
        { code: 'WORKFLOW_OBSERVATION_REQUEST_MISMATCH' });
      assert.equal(Object.keys(new QueueState(queueDir).data.jobs).length, 1, 'rejected wrong-scope requests create no jobs');
      const beforeObservation = await request(queueDir, { action: 'queue-summary', auth });
      assert.equal(beforeObservation.features.atomicWorkflowObserve, true);
      const control = { instanceId: beforeObservation.control.instanceId, buildHash: observerBuild,
        generation: beforeObservation.control.generation, contextEpoch: beforeObservation.control.contextEpoch };
      const observeMessage = { action: 'observe-atomic', auth, jobId: target.id,
        requestId: 'fasteners-scoped-atomic-observe', control };
      await assert.rejects(request(queueDir, { ...observeMessage, auth: foreign }), { code: 'NOT_OWNER' });
      for (const [key, value, code] of [
        ['instanceId', 'old-owner', 'INSTANCE_CHANGED'], ['buildHash', 'old-build', 'BUILD_CHANGED'],
        ['generation', control.generation + 1, 'STATE_CONFLICT'],
        ['contextEpoch', control.contextEpoch + 1, 'STATE_CONFLICT'],
      ]) await assert.rejects(request(queueDir, { ...observeMessage, control: { ...control, [key]: value } }), { code });
      await assert.rejects(request(queueDir, { ...observeMessage, docId: 'stale-doc' }), { code: 'INVALID_REQUEST' });
      const submitted = await request(queueDir, observeMessage);
      phase = 'poll-result';
      let result;
      for (let i = 0; i < 3200; i++) {
        result = await request(queueDir, { action: 'result', auth, jobId: submitted.id });
        if (['succeeded', 'failed', 'needs_reconciliation'].includes(result.job.state)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (checkerMode !== 'passed') {
        assert.equal(result.job.state, 'failed', JSON.stringify({ checkerMode, result }));
        assert.equal(physicalCalls, 0, 'real production rejection cannot invoke the physical sender');
        const status = result.pythonChecks?.[0]?.status;
        const expected = { failed: 'failed', incomplete: 'incomplete', tool_error: 'tool_error' }[checkerMode];
        if (expected) assert.equal(status, expected, JSON.stringify(result.pythonChecks));
        process.stdout.write(JSON.stringify({ checkerMode, checkerStatus: status ?? null, physicalCalls }));
        process.exit(0);
      }
      if (auditMode) {
        assert.equal(physicalCalls, 1);
        const beforeAudit = JSON.parse(fs.readFileSync(path.join(queueDir, 'queue-state.json')));
        const audit = { action: 'audit-atomic', auth, jobId: target.id, observationJobId: submitted.id,
          requestId: 'owned-recovery-audit', control };
        await assert.rejects(request(queueDir, { ...audit, auth: foreign }), { code: 'NOT_OWNER' });
        await assert.rejects(request(queueDir, { ...audit, control: { ...control, generation: control.generation + 1 } }), { code: 'STATE_CONFLICT' });
        await assert.rejects(request(queueDir, { ...audit, payload: {} }), { code: 'INVALID_REQUEST' });
        const pending = await request(queueDir, audit);
        assert.equal(pending.status, 'pending');
        let audited;
        for (let i = 0; i < 3200; i++) {
          audited = await request(queueDir, audit);
          if (audited.status !== 'pending') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(audited.status, 'complete', JSON.stringify(audited));
        assert.equal(audited.nativeOutcome, 'unknown');
        assert.equal(audited.summary.modulePresent, false);
        assert.equal(audited.sdkRequestsSent, 1);
        assert.equal(physicalCalls, 2);
        const start = JSON.parse(fs.readFileSync(path.join(targetDir, 'atomic-recovery-audit/start.json')));
        assert.equal(start.pythonCheck.status, 'passed');
        assert.equal(start.pythonCheck.provenance.checker, 'basedpyright');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(queueDir, 'queue-state.json'))), beforeAudit);
        assert.deepEqual(await request(queueDir, audit), audited);
        await assert.rejects(request(queueDir, { ...audit, requestId: 'duplicate-audit' }), { code: 'AUDIT_ALREADY_REQUESTED' });
        assert.equal(physicalCalls, 2);
        process.stdout.write(JSON.stringify({ recoveryAudit: true, physicalCalls, auditChecker: start.pythonCheck.status,
          targetUnchanged: true, nativeOutcome: audited.nativeOutcome }));
        process.exit(0);
      }
      assert.equal(result.job.state, 'succeeded', JSON.stringify({ state: result.job.state, code: result.job.code }));
      assert.equal(physicalCalls, 1);
      assert.equal(result.pythonChecks.length, 1);
      assert.equal(result.pythonChecks[0].status, 'passed');
      assert.equal(result.pythonChecks[0].provenance.checker, 'basedpyright');
      const observerDirectory = path.join(queueDir, 'jobs', submitted.id);
      const observerJournals = fs.readdirSync(observerDirectory)
        .filter(name => /^rpc-.*\.json$/.test(name) && name !== 'rpc-result.json');
      assert.equal(observerJournals.length, 1);
      const observerRecord = JSON.parse(fs.readFileSync(path.join(observerDirectory, observerJournals[0]), 'utf8'));
      const origin = observerRecord.pythonArtifact.context.origin;
      const abiProof = observerRecord.atomicRuntimeAbi;
      const semanticHash = require(path.join(root, 'dist/src/dist/core/application/cad/json')).hash;
      assert.equal(observerRecord.dispatchClass, 'python');
      assert.equal(observerRecord.pythonCheck.status, 'passed');
      assert.equal(observerRecord.binding.pythonOriginHash, origin.artifactHash);
      assert.equal(observerRecord.binding.atomicRuntimeAbiHash, semanticHash(abiProof));
      assert.equal(origin.context.atomicRuntimeAbiHash, observerRecord.binding.atomicRuntimeAbiHash);
      assert.deepEqual(origin.context.abiPinnedUnits, abiProof.abiPinnedUnits);
      assert.deepEqual(origin.context.executedUnits, origin.units.map(unit => unit.filename));
      assert.equal(observerRecord.pythonCheck.provenance.artifactHash, observerRecord.pythonArtifact.artifactHash);
      assert.equal(observerRecord.pythonCheck.provenance.wireHash, observerRecord.pythonArtifact.sha256);
      const compositionProof = {
        manifestVersion: compositionManifest.version,
        manifestFileSha256: hash(fs.readFileSync(path.join(root, 'tests/fixtures/atomic-observer-composition.json'))),
        approvedBase: compositionManifest.approvedBase,
        originMode: rawOrigin ? 'raw' : 'typed',
        observerBuildHash: observerBuild,
        senderCalls: physicalCalls,
        binding: {
          observationKind: observerRecord.binding.observationKind,
          observationTargetJobId: observerRecord.binding.observationTargetJobId,
          observationIdentityHash: observerRecord.binding.observationIdentityHash,
          atomicRuntimeAbiHash: observerRecord.binding.atomicRuntimeAbiHash,
          pythonOriginHash: observerRecord.binding.pythonOriginHash,
          sourceHash: observerRecord.binding.sourceHash,
        },
        origin: { artifactHash: origin.artifactHash, units: origin.units },
        executedUnits: origin.units.map(({ id, filename, role, sha256 }) => ({ id, filename, role, sha256 })),
        checkedUnits: observerRecord.pythonArtifact.units,
        abiPinnedUnits: abiProof.abiPinnedUnits,
        checker: {
          status: observerRecord.pythonCheck.status,
          name: observerRecord.pythonCheck.provenance.checker,
          version: observerRecord.pythonCheck.provenance.checkerVersion,
          artifactHash: observerRecord.pythonCheck.provenance.artifactHash,
          wireHash: observerRecord.pythonCheck.provenance.wireHash,
        },
      };
      fs.writeFileSync(path.join(base, 'composition-proof.json'), JSON.stringify(compositionProof, null, 2), { mode: 0o600 });
      assert.equal(observedOperation, 'atomic_status');
      const output = JSON.parse(result.stdout);
      assert.equal(output.outcome, 'unknown', 'read-only holder inspection does not accept the original outcome');
      assert.equal(output.nativeOutcome, 'committed');
      assert.equal(output.observation.destroyed, true);
      assert.equal(Object.hasOwn(output, 'results'), false, 'owner receives no holder geometry payload');
      const targetStatus = await request(queueDir, { action: 'status', auth, jobId: target.id });
      assert.equal(targetStatus.state, 'needs_reconciliation', 'owner acceptance remains separate from observation');
      const queue = await request(queueDir, { action: 'queue-summary', auth });
      assert.equal(queue.blocked.id, target.id);
      assert.equal(queue.paused, true);
      assert.equal(queue.nonterminalJobCount, 1);
      assert.equal(queue.control.phase, 'RECOVERY_BLOCKED');
      assert.equal(queue.control.gateClosed, true);
      assert.equal(physicalCalls, 1, 'no fixture or original operation replay occurred');
      const sameObservation = await request(queueDir, observeMessage);
      assert.equal(sameObservation.id, submitted.id, 'lost ACK returns the exact original observer job');
      await assert.rejects(request(queueDir, { ...observeMessage, requestId: 'second-atomic-probe' }),
        { code: 'WORKFLOW_OBSERVATION_EXISTS' });
      assert.equal(physicalCalls, 1, 'duplicate control requests cannot send another probe');
      await assert.rejects(request(queueDir, { action: 'reconcile', auth: foreign, jobId: target.id,
        acceptedOutcome: 'committed' }), { code: 'NOT_OWNER' });
      await assert.rejects(request(queueDir, { action: 'reconcile', auth, jobId: target.id,
        acceptedOutcome: 'aborted' }), { code: 'OBSERVED_OUTCOME_MISMATCH' });
      const stillBlocked = await request(queueDir, { action: 'status', auth, jobId: target.id });
      assert.equal(stillBlocked.state, 'needs_reconciliation', 'a mismatched owner acknowledgment cannot release the blocker');
      const acceptance = await request(queueDir, { action: 'reconcile', auth, jobId: target.id,
        acceptedOutcome: 'committed' });
      assert.equal(acceptance.kind, 'atomic-workflow-owner-acceptance');
      assert.equal(acceptance.acceptedOutcome, 'committed');
      assert.equal(acceptance.effects.rollbackVerification, 'not_performed');
      assert.equal(acceptance.effects.modelValidation, 'not_performed');
      assert.equal(acceptance.effects.mayHaveMutated, true);
      assert.equal(Object.hasOwn(acceptance, 'rollbackVerified'), false);
      const acceptedStatus = await request(queueDir, { action: 'status', auth, jobId: target.id });
      assert.equal(acceptedStatus.state, 'succeeded');
      const acceptedQueue = await request(queueDir, { action: 'queue-summary', auth });
      assert.equal(acceptedQueue.blocked, null);
      assert.equal(acceptedQueue.paused, true, 'owner acceptance must preserve the existing manual pause');
      assert.equal(acceptedQueue.control.gateClosed, true);
      assert.equal(acceptedQueue.nonterminalJobCount, 0);
      const repeatedAcceptance = await request(queueDir, { action: 'reconcile', auth, jobId: target.id,
        acceptedOutcome: 'committed' });
      assert.equal(repeatedAcceptance.kind, 'atomic-workflow-owner-acceptance', 'the terminal owner receipt is idempotently readable');
      const originalAfter = JSON.parse(fs.readFileSync(path.join(queueDir, 'queue-state.json'), 'utf8')).jobs[target.id];
      assert.equal(originalAfter.hash, targetJob.hash);
      if (rawOrigin) assert.equal(Object.hasOwn(originalAfter.request, 'payload'), false,
        'original raw job identity remains raw; typed observer never edits its request');
      process.stdout.write(JSON.stringify({ observerJobId: submitted.id, targetJobId: target.id,
        physicalCalls, compositionProof, phase: queue.control.phase, targetState: targetStatus.state,
        acceptedTargetState: acceptedStatus.state, acceptedPaused: acceptedQueue.paused }));
      process.exit(0);
    } catch (error) {
      process.stderr.write('phase=' + phase + '\n' + String(error.stack || error));
      process.exit(1);
    }
    })().catch(error => { process.stderr.write(String(error.stack || error)); process.exit(1); });
  `;
  const auditOnly = process.env.FMCAD_RECOVERY_AUDIT_ONLY === 'true';
  for (const rawOrigin of auditOnly ? [] : [false, true]) {
    const result = spawnSync(process.execPath, ['--require', require.resolve('./fixtures/fake-wsl-preload.cjs'), '-e', child], {
      cwd: root, encoding: 'utf8', timeout: 45000,
      env: { ...process.env, FMCAD_ATOMIC_RECOVERY_ROOT: root,
        FMCAD_ATOMIC_RECOVERY_TMP: path.join(dir, rawOrigin ? 'raw' : 'typed'),
        FMCAD_ATOMIC_RECOVERY_RAW_ORIGIN: String(rawOrigin) },
    });
    assert.equal(result.status, 0, `${rawOrigin ? 'raw' : 'typed'} origin: ${result.stderr || result.stdout}`);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.physicalCalls, 1);
    assert.equal(proof.compositionProof.senderCalls, atomicObserverComposition.positive.physicalSenderCallsPerOrigin);
    assert.equal(proof.compositionProof.originMode, rawOrigin ? 'raw' : 'typed');
    assert.equal(proof.compositionProof.checker.status, atomicObserverComposition.positive.status);
    assert.equal(proof.compositionProof.checker.name, atomicObserverComposition.checker.split('@')[0]);
    assert.equal(proof.compositionProof.origin.artifactHash, proof.compositionProof.binding.pythonOriginHash);
    assert.equal(proof.phase, 'RECOVERY_BLOCKED');
    assert.equal(proof.targetState, 'needs_reconciliation');
    assert.equal(proof.acceptedTargetState, 'succeeded');
    assert.equal(proof.acceptedPaused, true);
  }
  for (const checkerMode of auditOnly ? [] : atomicObserverComposition.negative.modes) {
    const result = spawnSync(process.execPath, ['--require', require.resolve('./fixtures/fake-wsl-preload.cjs'), '-e', child], {
      cwd: root, encoding: 'utf8', timeout: 45000,
      env: { ...process.env, FMCAD_ATOMIC_RECOVERY_ROOT: root,
        FMCAD_ATOMIC_RECOVERY_TMP: path.join(dir, checkerMode),
        FMCAD_ATOMIC_RECOVERY_RAW_ORIGIN: 'false', FMCAD_ATOMIC_RECOVERY_CHECKER_MODE: checkerMode },
    });
    assert.equal(result.status, 0, `${checkerMode}: ${result.stderr || result.stdout}`);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.checkerMode, checkerMode);
    assert.equal(proof.physicalCalls, atomicObserverComposition.negative.physicalSenderCallsPerMode);
    if (checkerMode === 'missing_checker') assert.equal(proof.startupRefused, true);
  }
  const audited = spawnSync(process.execPath, ['--require', require.resolve('./fixtures/fake-wsl-preload.cjs'), '-e', child], {
    cwd: root, encoding: 'utf8', timeout: 45000,
    env: { ...process.env, FMCAD_ATOMIC_RECOVERY_ROOT: root, FMCAD_ATOMIC_RECOVERY_TMP: path.join(dir, 'audit'),
      FMCAD_ATOMIC_RECOVERY_RAW_ORIGIN: 'false', FMCAD_ATOMIC_RECOVERY_AUDIT: 'true' },
  });
  assert.equal(audited.status, 0, audited.stderr || audited.stdout);
  const auditProof = JSON.parse(audited.stdout);
  assert.equal(auditProof.recoveryAudit, true);
  assert.equal(auditProof.auditChecker, 'passed');
  assert.equal(auditProof.physicalCalls, 2, 'one prior status and exactly one distinct audit');
  assert.equal(auditProof.targetUnchanged, true);
  assert.equal(auditProof.nativeOutcome, 'unknown');
});

test('atomic holder preparation is owner-bound, identity-pinned, read-only and report-stable', async (t) => {
  const f = await atomicScopeFixture(t);
  const approvedScope = {
    jobId: f.job.id, requestId: f.requestId, projectDirectory: f.job.request.cwd,
    reportPath: f.reportPath, commandId: f.commandId, sessionNonce: f.sessionNonce, docId: f.docId,
  };
  const prepare = (job, scope, options = {}) => prepareAtomicHolderObservation(job, scope, {
    clientId: f.job.clientId, observerBuildHash: 'candidate-build', originalBuildHash: 'original-build',
    approvedScope, ...options,
  });
  for (const physicalTurns of [undefined, NaN, 0, 0.5]) {
    await assert.rejects(prepare({ ...f.job, physicalTurns }, f.scope),
      { code: 'WORKFLOW_OWNER_OR_JOB_MISMATCH' });
  }
  const pinnedJob = structuredClone(f.job);
  pinnedJob.request.cwd = '/tmp/opencode/fmcad-backlog/measured-fasteners';
  pinnedJob.request.payload.data.reportPath = '/tmp/opencode/measured-fasteners-native/batch-v1';
  const pinnedInvocation = structuredClone(f.reconcileInvocation);
  pinnedInvocation.data.reportPath = '/tmp/opencode/measured-fasteners-native/batch-v1';
  const pinnedApprovedScope = {
    jobId: pinnedJob.id, requestId: pinnedJob.requestId,
    projectDirectory: pinnedJob.request.cwd,
    reportPath: '/tmp/opencode/measured-fasteners-native/batch-v1',
    commandId: f.commandId, sessionNonce: f.sessionNonce, docId: f.docId,
  };
  const pinnedScope = deriveAtomicHolderScope(pinnedJob, pinnedInvocation, pinnedJob.request.cwd, pinnedApprovedScope);
  assert.deepEqual(pinnedScope, {
    version: 1, kind: 'atomic_holder_status', jobId: f.job.id, requestId: f.requestId,
    projectDirectory: '/tmp/opencode/fmcad-backlog/measured-fasteners',
    reportPath: '/tmp/opencode/measured-fasteners-native/batch-v1',
    commandId: f.commandId, sessionNonce: f.sessionNonce, docId: f.docId,
  });
  assert.equal(isAtomicObservationCandidate(pinnedJob, 'original-build', pinnedApprovedScope), true);
  for (const change of [
    job => { job.id = 'wrong-job'; },
    job => { job.requestId = 'wrong-request'; },
    job => { job.request.cwd = '/tmp/opencode/other-project'; },
    job => { job.request.payload.data.reportPath = '/tmp/opencode/other-report'; },
    job => { job.request.payload.docId = 'wrong-document'; },
  ]) {
    const wrongJob = structuredClone(pinnedJob);
    change(wrongJob);
    assert.equal(deriveAtomicHolderScope(wrongJob, pinnedInvocation, pinnedJob.request.cwd, pinnedApprovedScope), null);
    assert.equal(isAtomicObservationCandidate(wrongJob, 'original-build', pinnedApprovedScope), false);
  }
  for (const change of [
    invocation => { invocation.data.blockedJobId = 'wrong-job'; },
    invocation => { invocation.data.reportPath = '/tmp/opencode/other-report'; },
    invocation => { invocation.data.commandId = 'fmcad_atomic_' + '0'.repeat(32); },
    invocation => { invocation.data.sessionNonce = '0'.repeat(32); },
    invocation => { invocation.docId = 'wrong-document'; },
  ]) {
    const wrongInvocation = structuredClone(pinnedInvocation);
    change(wrongInvocation);
    assert.equal(deriveAtomicHolderScope(pinnedJob, wrongInvocation, pinnedJob.request.cwd, pinnedApprovedScope), null);
  }
  const prepared = await prepare(f.job, f.scope);
  assert.deepEqual(prepared.artifact.units.filter(unit => unit.role === 'runtime').map(unit => unit.id),
    ['atomic-status'], 'only the complete typed read-only reader is executed and checked');
  assert.deepEqual(prepared.sourceCompatibilityUnits.map(unit => unit.id),
    ['values', 'fusion-values', 'core', 'atomic', 'identity'],
    'original writer source hashes remain separate ABI provenance, not checker coverage');
  assert.equal(prepared.artifact.units.some(unit => /containment|fastener|sketch/.test(unit.filename)), false,
    'unrelated modeling families are not part of the scoped read-only artifact');
  const owner = { pid: 101, birth: 'test:101', nonce: 'broker-nonce', protocol: 2 };
  const observerJob = { id: 'observer-job', clientId: f.job.clientId, state: 'running', workflowObservation: { targetJobId: f.job.id } };
  const initialState = { paused: true, controlGeneration: 8, contextEpoch: 4, lease: null,
    active: observerJob.id, blocked: { id: f.job.id } };
  const currentState = { ...initialState, active: observerJob.id, jobs: { [f.job.id]: f.job, [observerJob.id]: observerJob },
    controlBlocked: null, localUnknown: null };
  const fence = {
    prepared, jobId: f.job.id, observerJobId: observerJob.id, clientId: f.job.clientId, state: currentState, initialState,
    initialActiveIds: [], activeIds: ['observation-rpc'], originalActiveIds: [], inFlight: true,
    resetActive: false, owner, expectedOwner: { ...owner },
    buildHash: 'candidate-build', expectedBuildHash: 'candidate-build',
    instance: { pid: 101, birth: 'fusion:101', version: '2706.1.14' },
    expectedInstance: { pid: 101, birth: 'fusion:101', version: '2706.1.14' },
    instanceAlive: true,
  };
  assert.equal(verifyAtomicObservationFence(fence), true);
  assert.equal(prepared.readOnly, true);
  assert.equal(prepared.args.operation, 'atomic_status');
  assert.equal(prepared.args.commandId, f.commandId);
  assert.equal(prepared.args.sessionNonce, f.sessionNonce);
  assert.equal(prepared.args.docId, f.docId);
  const originalUnits = prepared.sourceCompatibilityUnits.map(unit => ({ filename: unit.filename, sha256: unit.sha256 }));
  assert.equal(validateAtomicRuntimeSourceCompatibility(prepared, [originalUnits]), true);
  assert.throws(() => validateAtomicRuntimeSourceCompatibility(prepared, [[...originalUnits,
    { filename: 'runtime/python/fmcad/adapters/fusion/atomic.py', sha256: 'f'.repeat(64) }]]), { code: 'RECEIPT_MISMATCH' });
  assert.throws(() => validateAtomicRuntimeSourceCompatibility(prepared, [[]]), { code: 'BUILD_CHANGED' });
  const statusRequest = observerPythonLiterals(prepared.script)._ATOMIC_STATUS_REQUEST;
  assert.equal(statusRequest.operation, 'atomic_status');
  assert.equal(statusRequest.documentIdentity.resolved.creationId, f.docId);
  assert.match(prepared.script, /_summary: AtomicStatusObject = \{key: _value\.get\(key\) for key in/);
  assert.equal(prepared.snapshot.lock, null, 'observation accepts the report after the atomic runner released its writer lock');
  assert.equal(Object.hasOwn(prepared.snapshot, 'report'), false, 'scoped proof metadata does not expose report payload');
  assert.equal(snapshotStillCurrent(prepared.snapshot), true);

  assert.equal(validateAtomicReconcileInvocation({
    version: 1, kind: 'cad', operation: 'batch.reconcile', data: { reportPath: f.reportPath, operations: [],
      blockedJobId: f.job.id, commandId: f.commandId, sessionNonce: f.sessionNonce },
    doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX', docId: f.docId,
  }, prepared), true);
  assert.throws(() => validateAtomicReconcileInvocation({
    version: 1, kind: 'cad', operation: 'batch.reconcile',
    data: { reportPath: f.reportPath, operations: [{ operation: 'document.status', data: {} }] },
    doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX', docId: f.docId,
  }, prepared), { code: 'WORKFLOW_OBSERVATION_NOT_ALLOWED' });
  assert.throws(() => validateAtomicReconcileInvocation({
    version: 1, kind: 'cad', operation: 'batch.finalize', data: { reportPath: f.reportPath },
    doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX', docId: f.docId,
  }, prepared), { code: 'WORKFLOW_TYPE_NOT_ALLOWED' });
  assert.throws(() => validateAtomicReconcileInvocation({
    version: 1, kind: 'cad', operation: 'batch.reconcile', data: { reportPath: f.reportPath,
      blockedJobId: 'stale-job', commandId: f.commandId, sessionNonce: f.sessionNonce },
    doc: 'FMCAD_MEASURED_FASTENERS_2706_20261027T0707Z_LUNAMAX', docId: f.docId,
  }, prepared), { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  const safeReply = { result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify({
    status: 'completed', completed: true, destroyed: true, cleanupCompleted: false,
    outcome: 'committed',
    identity: prepared.identity,
  }) }] } };
  assert.deepEqual(atomicStatusSummaryFromReply(safeReply), JSON.parse(safeReply.result.content[0].text.slice('FMCAD_RESULT '.length)));
  assert.throws(() => atomicStatusSummaryFromReply({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify({
    status: 'completed', results: { body: { geometry: 'private' } },
  }) }] } }), { code: 'WORKFLOW_OBSERVATION_OUTPUT' });
  assert.throws(() => atomicStatusSummaryFromReply({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify({
    status: 'completed', unavailableEvidence: ['x'.repeat(257)],
  }) }] } }), { code: 'WORKFLOW_OBSERVATION_OUTPUT' });
  assert.throws(() => atomicStatusSummaryFromReply({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify({
    status: 'completed', identity: { ...prepared.identity, geometry: 'private' },
  }) }] } }), { code: 'WORKFLOW_OBSERVATION_OUTPUT' });

  await assert.rejects(prepare(f.job, f.scope, { clientId: 'foreign-client' }), { code: 'WORKFLOW_OWNER_OR_JOB_MISMATCH' });
  await assert.rejects(prepare(f.job, {
    ...f.scope, jobId: 'stale-job',
  }), { code: 'WORKFLOW_OWNER_OR_JOB_MISMATCH' });
  await assert.rejects(prepare(f.job, {
    ...f.scope, sessionNonce: '0'.repeat(32),
  }), { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  await assert.rejects(prepare(f.job, {
    ...f.scope, reportPath: path.join(f.reportPath, 'not-the-report'),
  }), { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  await assert.rejects(prepare(f.job, {
    ...f.scope, docId: 'changed-document-creation-id',
  }), { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  const changedRequestJob = structuredClone(f.job);
  changedRequestJob.request.payload.data.operations[0].operation = 'document.save_as';
  await assert.rejects(prepare(changedRequestJob, f.scope), { code: 'WORKFLOW_IDENTITY_MISMATCH' });
  const staleObserverPrepared = await prepare(f.job, f.scope, { observerBuildHash: 'stale-build' });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, prepared: staleObserverPrepared }), {
    code: 'BUILD_CHANGED',
  });
  await assert.rejects(prepare(f.job, f.scope, { originalBuildHash: 'stale-original-build' }), { code: 'BUILD_CHANGED' });
  await assert.rejects(prepare(f.job, {
    ...f.scope, extra: 'not-whitelisted',
  }), { code: 'INVALID_WORKFLOW_SCOPE' });

  assert.throws(() => verifyAtomicObservationFence({ ...fence, state: { ...currentState, controlGeneration: 9 } }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, state: { ...currentState, contextEpoch: 5 } }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, resetActive: true }), {
    code: 'FUSION_RESET_IN_PROGRESS',
  });
  const openButBlocked = { ...fence, initialState: { ...initialState, paused: false }, state: { ...currentState, paused: false } };
  assert.equal(verifyAtomicObservationFence(openButBlocked), true, 'unresolved blocked job—not a global pause—is the recovery gate');
  assert.throws(() => verifyAtomicObservationFence({ ...fence, state: { ...currentState, paused: false } }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, initialActiveIds: ['foreign-rpc'] }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, activeIds: ['observation-rpc', 'foreign-rpc'] }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, inFlight: false, activeIds: ['observation-rpc'] }), {
    code: 'WORKFLOW_GATE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, buildHash: 'different-build' }), {
    code: 'BUILD_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, owner: { ...owner, nonce: 'different-owner' } }), {
    code: 'BROKER_OWNER_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, instance: { pid: 101, birth: 'fusion:reused', version: '2706.1.14' } }), {
    code: 'INSTANCE_CHANGED',
  });
  assert.throws(() => verifyAtomicObservationFence({ ...fence, instanceAlive: false }), {
    code: 'INSTANCE_CHANGED',
  });

  fs.appendFileSync(path.join(f.reportPath, '00000000.json'), ' ');
  assert.equal(snapshotStillCurrent(prepared.snapshot), false, 'report drift fences the physical send');
  assert.throws(() => verifyAtomicObservationFence(fence), { code: 'WORKFLOW_REPORT_CHANGED' });
});

test('atomic holder accepts omitted optional context pins but rejects conflicting identity and version', async t => {
  const f = await atomicScopeFixture(t);
  const { version, kind, ...approvedScope } = f.scope;
  void version; void kind;
  const options = { clientId: f.job.clientId, observerBuildHash: 'observer-build',
    originalBuildHash: 'original-build', approvedScope };
  const file = path.join(f.reportPath, '00000000.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = report => {
    // A self-consistent report hash must not mask a cross-document/context pin.
    report.requestHash = hash({ request: report.request, context: report.context });
    report.journal.requestHash = report.requestHash;
    report.journal.documentIdentity = report.documentIdentity;
    fs.writeFileSync(file, JSON.stringify(report));
  };
  for (const omitted of [['component'], ['projectId'], ['component', 'projectId']]) {
    const report = structuredClone(original);
    for (const key of omitted) delete report.context[key];
    write(report);
    const prepared = await prepareAtomicHolderObservation(f.job, f.scope, options);
    assert.equal(prepared.expectedContext.component, null);
    assert.equal(prepared.expectedContext.projectId, null);
    assert.equal(snapshotStillCurrent(prepared.snapshot), true);
    assert.equal(Object.hasOwn(report.context, 'docFileId'), false);
    assert.equal(prepared.identity.documentIdentity.resolved.creationId, f.docId);
  }
  for (const [label, change] of [
    ['component', r => { r.context.component = 'foreign-component'; }],
    ['projectId', r => { r.context.projectId = 'foreign-project'; }],
    ['docId', r => { r.context.docId = 'foreign-document'; }],
    ['same-name different creationId', r => { r.documentIdentity.resolved.creationId = 'foreign-document'; }],
    ['fileId', r => { r.documentIdentity.resolved.fileId = 'foreign-file'; }],
    ['runId', r => { r.runId = 'foreign-run'; }],
    ['commandId', r => { r.commandId = 'fmcad_atomic_' + '0'.repeat(32); }],
    ['sessionNonce', r => { r.sessionNonce = '0'.repeat(32); }],
    ['unknown document version pin', r => { r.context.docVersion = 2; }],
    ['unsupported report version', r => { r.version = 3; }],
  ]) {
    const report = structuredClone(original);
    delete report.context.component;
    delete report.context.projectId;
    change(report);
    write(report);
    await assert.rejects(prepareAtomicHolderObservation(f.job, f.scope, options),
      error => ['WORKFLOW_IDENTITY_MISMATCH', 'WORKFLOW_RECEIPT_INVALID'].includes(error.code), label);
  }
});

test('narrow canonical atomic_status executes read-only and retains every source fence from the full bundle', async t => {
  const f = await atomicScopeFixture(t);
  const { version, kind, ...approvedScope } = f.scope;
  void version; void kind;
  const prepared = await prepareAtomicHolderObservation(f.job, f.scope, {
    clientId: f.job.clientId, observerBuildHash: 'observer-build', originalBuildHash: 'original-build', approvedScope,
  });
  const python = require('../src/python');
  const root = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: require.resolve('../src/atomic-workflow-observation') }).installation;
  const full = python.cadBundleUnits(root);
  assert.equal(full.length, python.cadBundleManifest.length, 'ordinary public bundle inventory remains complete');
  assert.equal(full.some(unit => unit.id === 'containment'), true);
  const hashes = full.map(unit => ({ filename: unit.filename,
    sha256: require('node:crypto').createHash('sha256').update(unit.source).digest('hex') }));
  assert.equal(validateAtomicRuntimeSourceCompatibility(prepared, [hashes]), true);
  const harness = `
import sys, types, json, copy
p = json.load(sys.stdin)
def mutation(*args, **kwargs):
    raise AssertionError('atomic_status attempted an SDK mutation')
core, fusion, adsk = types.ModuleType('adsk.core'), types.ModuleType('adsk.fusion'), types.ModuleType('adsk')
identity = p['identity']
resolved = identity['resolvedIdentity']
doc = types.SimpleNamespace(name=resolved['name'], creationId=resolved['creationId'], dataFile=None,
    isValid=True, activate=mutation, save=mutation, close=mutation)
other = types.SimpleNamespace(name='unrelated active document')
definition = types.SimpleNamespace(id=identity['commandId'], isValid=True, isNative=False, deleteMe=mutation)
app = types.SimpleNamespace(documents=[doc], activeDocument=other,
    userInterface=types.SimpleNamespace(activeCommand='SelectCommand',
      commandDefinitions=types.SimpleNamespace(itemById=lambda key: definition, addButtonDefinition=mutation)))
core.Application = types.SimpleNamespace(get=lambda: app)
adsk.core, adsk.fusion = core, fusion
sys.modules.update({'adsk':adsk, 'adsk.core':core, 'adsk.fusion':fusion})
holder = types.ModuleType('_fmcad_' + identity['commandId'])
holder.identity = identity
holder.definitionId = identity['commandId']
holder.state = {'outcome':'aborted', 'accepted':True, 'completed':True, 'destroyed':True,
    'cleanupCompleted':False, 'definitionDeleted':False}
before = copy.deepcopy(holder.state)
sys.modules[holder.__name__] = holder
namespace = {'__name__':'isolated_atomic_status_bundle'}
exec(p['script'], namespace)
namespace['run']('')
assert holder.state == before
assert app.activeDocument is other
assert sys.modules[holder.__name__] is holder
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', harness], {
    input: JSON.stringify({ identity: prepared.identity, script: prepared.script }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('FMCAD_RESULT '));
  const status = JSON.parse(line.slice('FMCAD_RESULT '.length));
  assert.equal(status.outcome, 'aborted');
  assert.equal(status.destroyed, true); assert.equal(status.idle, true);
  assert.deepEqual(status.identity, prepared.identity);
});

test('raw CLI origin uses only its preserved typed worker envelope and fences header/byte drift without editing the job', async t => {
  const f = await atomicScopeFixture(t), root = path.resolve(__dirname, '..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-raw-origin-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const script = String.raw`
    (async()=>{
      const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
      const input=JSON.parse(fs.readFileSync(0,'utf8')),root=input.root,base=input.base;
      process.env.XDG_STATE_HOME=path.join(base,'state');
      const {hash}=require(path.join(root,'src/queue-instance'));
      const a=require(path.join(root,'src/atomic-workflow-observation'));
      const job=structuredClone(input.job), scope=input.scope, approved={...scope};
      delete approved.version;delete approved.kind;
      const data=job.request.payload.data,doc=job.request.payload.doc,docId=job.request.payload.docId;
      const file=path.join(base,'original.json'),bytes=JSON.stringify(data);
      fs.writeFileSync(file,bytes);
      delete job.request.payload;
      job.request.phased=true;
      job.request.argv=['batch','run','--doc',doc,'--doc-id',docId,'--file',file,'--json'];
      job.request.inputFiles=[{path:file,sha256:hash(bytes)}];
      const envelope={id:job.id,buildHash:job.request.buildHash,
        request:require(path.join(root,'src/composition/execution-request')).prepareRequest(job)};
      const directory=path.join(require(path.join(root,'src/queue-connection')).queueDirectory(),'jobs',job.id);
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      const envelopeFile=path.join(directory,'request.json'),original=JSON.stringify(envelope);
      fs.writeFileSync(envelopeFile,original,{mode:0o600});
      fs.writeFileSync(file,'{"changedAfterOriginalAdmission":true}');
      assert.equal(a.isAtomicObservationCandidate(job,job.request.buildHash,approved),true);
      const prepared=await a.prepareAtomicHolderObservation(job,scope,{clientId:job.clientId,
        observerBuildHash:'observer-build',originalBuildHash:job.request.buildHash,approvedScope:approved});
      assert.equal(a.sourceEnvelopeStillCurrent(prepared.sourceEnvelope),true);
      const observer={id:'observer',hash:'observer-hash',state:'running',clientId:job.clientId,
        workflowObservation:{targetJobId:job.id,observerJobHash:'observer-hash'}};
      const state={active:'observer',blocked:{id:job.id},paused:true,controlGeneration:24,contextEpoch:12,
        lease:null,jobs:{[job.id]:job,observer}};
      const owner={pid:100,birth:'fixture:100',nonce:'fixture'},instance={pid:200,birth:'fixture:200',version:'fixture'};
      const fence={prepared,jobId:job.id,observerJobId:observer.id,clientId:job.clientId,state,initialState:state,
        initialActiveIds:[],activeIds:['probe'],originalActiveIds:[],inFlight:true,resetActive:false,
        owner,expectedOwner:owner,instance,expectedInstance:instance,instanceAlive:true,
        buildHash:'observer-build',expectedBuildHash:'observer-build'};
      assert.equal(a.verifyAtomicObservationFence(fence),true);
      fs.writeFileSync(envelopeFile,original+'\n');
      assert.equal(a.sourceEnvelopeStillCurrent(prepared.sourceEnvelope),false);
      assert.throws(()=>a.verifyAtomicObservationFence(fence),{code:'WORKFLOW_INPUT_CHANGED'});
      for(const change of [
        value=>{value.id='foreign-job'},value=>{value.buildHash='old-build'},
        value=>{value.request.clientId='foreign-owner'},
        value=>{value.request.inputFiles[0].sha256='0'.repeat(64)},
        value=>{value.request.argv.push('--readonly')},
        value=>{value.request.payload.invocation.data.atomic=false},
      ]){
        const altered=structuredClone(envelope);change(altered);
        fs.writeFileSync(envelopeFile,JSON.stringify(altered));
        assert.equal(a.atomicInvocationProjection(job,approved),null);
      }
      fs.unlinkSync(envelopeFile);
      assert.equal(a.atomicInvocationProjection(job,approved),null,'missing original input is not rebuilt from mutable argv/file');
      const alias=path.join(directory,'alias.json');fs.writeFileSync(alias,original);
      fs.symlinkSync(alias,envelopeFile);
      assert.equal(a.atomicInvocationProjection(job,approved),null,'symlink cannot replace the original broker input');
      assert.equal(Object.hasOwn(job.request,'payload'),false);assert.equal(job.hash,input.job.hash);
      process.stdout.write(JSON.stringify({unchangedJobHash:true,jobStillRaw:true,sdkCalls:0}));
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['--require', require.resolve('./fixtures/fake-wsl-preload.cjs'), '-e', script], {
    input: JSON.stringify({ root, base, job: f.job, scope: f.scope }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { unchangedJobHash: true, jobStillRaw: true, sdkCalls: 0 });
});

test('atomic status summary preserves byte bounds and rejects malformed scalar metadata', () => {
  const reply = stdout => ({ result: { structuredContent: { stdout } } });
  const parse = value => atomicStatusSummaryFromReply(reply('FMCAD_RESULT ' + JSON.stringify(value)));
  assert.deepEqual(parse({ status: 'unknown', createdCount: 0, accepted: false, outcome: null }),
    { status: 'unknown', createdCount: 0, accepted: false, outcome: null });
  for (const value of [{ createdCount: '0' }, { executeCount: -1 }, { accepted: 0 },
    { outcome: {} }, { terminationReason: {} }, { unavailableEvidence: Array(17).fill('missing') }]) {
    assert.throws(() => parse(value), { code: 'WORKFLOW_OBSERVATION_OUTPUT' });
  }
  // Three UTF-8 bytes per character: UTF-16 length alone would admit this payload.
  assert.throws(() => atomicStatusSummaryFromReply(reply('€'.repeat(22000) + '\nFMCAD_RESULT {}')),
    { code: 'WORKFLOW_OBSERVATION_OUTPUT' });
  assert.throws(() => atomicStatusSummaryFromReply(reply('FMCAD_RESULT {broken')),
    { code: 'WORKFLOW_OBSERVATION_OUTPUT' });
});
