'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createMigrator } = require('../src/queue-atomic-migration');
const { backupTree, verifyTree, fileHash, exclusive } = require('../src/queue-atomic-migration-files');
const { stopOwner } = require('../src/queue-atomic-migration-stop');
const { processBirth, durable, hash } = require('../src/queue-instance');
const clone = structuredClone;
const error = code => Object.assign(new Error(code), { code });

function fixture(options = {}) {
  const scope = { jobId: 'holder', requestId: 'original', projectDirectory: '/tmp/opencode/migration-project',
    reportPath: '/tmp/opencode/migration-report', commandId: 'fmcad_atomic_' + 'a'.repeat(32),
    sessionNonce: 'b'.repeat(32), docId: 'scratch' };
  const job = { id: scope.jobId, requestId: scope.requestId, clientId: 'original-owner', state: 'needs_reconciliation',
    kind: 'command', physicalTurns: 2, dispatch: { rpcCount: 2 }, sequenceState: 'needs_reconciliation',
    request: { cwd: scope.projectDirectory, backend: 'addin', buildHash: 'old-build',
      payload: { version: 1, kind: 'cad', operation: 'batch.run', doc: 'Scratch', docId: scope.docId,
        data: { reportPath: scope.reportPath, runId: 'original-run', atomic: true } } } };
  const state = { version: 1, paused: false, revision: 10, epoch: 2, jobs: { holder: job },
    active: 'holder', blocked: { id: 'holder' }, lease: null, controlGeneration: 24, contextEpoch: 12 };
  let owner = { pid: 123, birth: 'boot:123', nonce: 'old-instance', protocol: 2 };
  let control = { instanceId: owner.nonce, buildHash: 'old-build', generation: 24, contextEpoch: 12,
    activeOperations: 0, activeIds: [], gateClosed: false };
  const identity = { buildHash: 'old-build', instance: { pid: 999, birth: 'fusion-birth', version: '2706' } };
  const records = new Map(), effects = { claims: 0, signals: 0, installs: 0, starts: 0, sdk: 0, release: 0 };
  const input = { jobId: 'holder', requestId: 'migration-once', approval: 'approved', confirmOwnership: true };
  let binding, live = true, installed = false, crash = options.crash;
  const observe = () => clone({ state, owner, identity, status: { paused: state.paused,
    blocked: state.blocked, lease: state.lease, control,
    nonterminalJobCount: Object.values(state.jobs).filter(job => job.state === 'needs_reconciliation').length,
    features: { atomicRecoveryAudit: !!options.auditUpgrade }, stopping: false } });
  const ports = {
    scope, clientId: 'original-owner',
    async authorize() { if (ports.clientId !== job.clientId) throw error('NOT_OWNER'); },
    async approve() { if (options.admissionMissing) throw error('PYTHON_ADMISSION_UNAVAILABLE'); return { buildHash: 'approved-build' }; },
    async authenticate() { if (ports.clientId !== job.clientId) throw error('NOT_OWNER'); },
    async claim(b) { if (binding && JSON.stringify(binding) !== JSON.stringify(b)) throw error('MIGRATION_INTENT_CONFLICT'); binding = clone(b); effects.claims++; },
    binding: () => binding,
    read: stage => clone(records.get(stage)),
    async publish(stage, value) {
      if (records.has(stage)) assert.deepEqual(value, records.get(stage));
      records.set(stage, clone(value));
      if (crash === stage) { crash = null; throw error('SIMULATED_CRASH'); }
      return clone(value);
    },
    observe: async () => observe(),
    async ownerProof() { if (options.wrongProof) throw error('NOT_OWNER'); },
    async liveOwner() { if (!live || options.staleBirth) throw error('MIGRATION_OWNER_CHANGED'); },
    async pause() { if (!state.paused) { state.controlGeneration++; control.generation++; }
      state.paused = true; control.gateClosed = true; },
    async evidence() {},
    async backup() { if (options.backupFailure) throw error('ENOSPC'); return { digest: 'immutable-backup' }; },
    async verifyBackup() { if (options.backupChanged) throw error('BACKUP_MISMATCH'); },
    async fence(paused) {
      if (options.changedHolder) state.jobs.holder.request.payload.docId = 'other';
      if (options.activeAfterBackup) control.activeOperations++;
      if (JSON.stringify(state) !== JSON.stringify(paused.state) || control.activeOperations !== 0 ||
          JSON.stringify(owner) !== JSON.stringify(paused.owner)) throw error('MIGRATION_FENCE_CHANGED');
    },
    async stop() {
      if (live) { effects.signals++; live = false; }
      if (options.crashAfterStop) { options.crashAfterStop = false; throw error('SIMULATED_CRASH'); }
    },
    async originalDead() { return !live; },
    async deadOwner() { if (live) throw error('MIGRATION_OWNER_LIVE'); },
    async install() { effects.installs++; installed = true; return { buildHash: 'approved-build' }; },
    async verifyInstalled() { assert.equal(installed, true); },
    async start(approved, recovering) {
      if (effects.starts) return;
      effects.starts++;
      owner = { pid: 456, birth: 'boot:456', nonce: 'new-instance', protocol: 2 };
      control.instanceId = owner.nonce; control.buildHash = approved.buildHash;
    },
    observeNew: async () => observe(),
    async release() { effects.release++; },
  };
  return { ports, input, run: createMigrator(ports), records, state, job, control, effects, identity };
}

test('migration preserves exact unknown job/history, closed pause and original instance; emits no SDK or probe', async () => {
  const f = fixture(), original = clone(f.state.jobs);
  const result = await f.run(f.input);
  assert.deepEqual(f.state.jobs, original);
  assert.equal(f.state.paused, true);
  assert.equal(f.state.blocked.id, 'holder');
  assert.equal(result.nativeOutcome, 'unknown');
  assert.equal(result.rollbackVerification, 'not_performed');
  assert.equal(result.modelValidation, 'not_performed');
  assert.deepEqual(f.effects, { claims: 1, signals: 1, installs: 1, starts: 1, sdk: 0, release: 1 });
  const again = await f.run(f.input);
  assert.deepEqual(again, result);
  assert.equal(f.effects.signals, 1);
  assert.equal(f.effects.starts, 1);
});

function upgradeFixture() {
  const f = fixture({ auditUpgrade: true });
  const id = '5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a', observationJobId = '3627db2e-0b9d-4e4f-927f-20cb45deae74';
  delete f.state.jobs.holder;
  f.job.id = f.ports.scope.jobId = f.input.jobId = id;
  f.job.hash = 'original-hash'; f.state.jobs[id] = f.job;
  f.state.active = observationJobId; f.state.blocked.id = id;
  f.state.paused = f.control.gateClosed = true;
  f.state.controlGeneration = f.control.generation = 25;
  f.control.buildHash = 'departing-build';
  f.state.jobs[observationJobId] = { id: observationJobId, clientId: 'original-owner', hash: 'observer-hash',
    state: 'needs_reconciliation', request: { buildHash: 'departing-build' }, dispatch: { rpcCount: 1, completedCount: 1 },
    workflowObservation: { targetJobId: id, targetJobHash: f.job.hash, observerJobHash: 'observer-hash' } };
  f.ports.auditUpgrade = () => ({ observationJobId, departingBuildHash: 'departing-build', originalBuildHash: 'old-build',
    previousOwner: { pid: 123, birth: 'boot:123', nonce: 'old-instance', protocol: 2 }, previousComplete: { sha256: 'first-handoff' } });
  return f;
}

test('separate second-window contract preserves both unresolved jobs and already-closed generation', async () => {
  const f = upgradeFixture(), before = clone(f.state);
  const result = await f.run(f.input);
  assert.deepEqual(f.state, before);
  assert.equal(result.purpose, 'atomic-recovery-audit-upgrade-v1');
  assert.equal(result.departingBrokerBuildHash, 'departing-build');
  assert.equal(result.preservedJobIds.length, 2);
  assert.equal(result.nativeOutcome, 'unknown');
  assert.equal(f.effects.sdk, 0);
  assert.equal(f.effects.signals, 1);
  assert.deepEqual(await f.run(f.input), result);
  assert.equal(f.effects.signals, 1);
});

test('legacy purpose cannot acquire second-window authority; wrong observer/owner/build or extra work cannot stop', async () => {
  for (const mutate of [
    f => { delete f.ports.auditUpgrade; },
    f => { f.state.jobs['3627db2e-0b9d-4e4f-927f-20cb45deae74'].clientId = 'foreign'; },
    f => { f.state.jobs['3627db2e-0b9d-4e4f-927f-20cb45deae74'].dispatch.completedCount = 0; },
    f => { f.control.buildHash = 'unknown-build'; },
    f => { f.state.jobs.other = { id: 'other', state: 'needs_reconciliation' }; },
    f => { f.control.activeOperations = 1; },
    f => { f.state.lease = { id: 'lease' }; },
  ]) {
    const f = upgradeFixture(); mutate(f);
    await assert.rejects(f.run(f.input));
    assert.equal(f.effects.signals, 0);
    assert.equal(f.effects.installs, 0);
    assert.equal(f.effects.sdk, 0);
  }
});

test('second-window backup refusal retains the old live owner and both unknown histories', async () => {
  const f = upgradeFixture(), before = clone(f.state.jobs);
  f.ports.verifyBackup = async () => { throw error('BACKUP_MISMATCH'); };
  await assert.rejects(f.run(f.input), { code: 'BACKUP_MISMATCH' });
  assert.equal(f.effects.signals, 0);
  assert.equal(f.state.paused, true);
  assert.deepEqual(f.state.jobs, before);
});

test('wrong owner, unavailable production admission and stale PID birth cannot stop or install', async () => {
  for (const [options, code] of [
    [{ admissionMissing: true }, 'PYTHON_ADMISSION_UNAVAILABLE'],
    [{ wrongProof: true }, 'NOT_OWNER'], [{ staleBirth: true }, 'MIGRATION_OWNER_CHANGED'],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(f.input), { code });
    assert.equal(f.effects.signals, 0); assert.equal(f.effects.installs, 0);
  }
  const f = fixture(); f.ports.clientId = 'foreign';
  await assert.rejects(f.run(f.input), { code: 'NOT_OWNER' });
  assert.equal(f.effects.claims, 0, 'foreign owner cannot publish a global migration guard');
});

test('active operation, another unfinished job, lease or changed holder refuse migration', async () => {
  for (const mutate of [
    f => { f.control.activeOperations = 1; }, f => { f.state.lease = { id: 'lease' }; },
    f => { f.state.jobs.other = { id: 'other', state: 'queued' }; },
    f => { f.state.jobs.holder.request.payload.docId = 'other'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.run(f.input));
    assert.equal(f.effects.signals, 0); assert.equal(f.effects.installs, 0);
  }
  for (const options of [{ changedHolder: true }, { activeAfterBackup: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(f.input), { code: 'MIGRATION_FENCE_CHANGED' });
    assert.equal(f.effects.signals, 0);
  }
});

test('backup failure/tampering leaves the original owner alive and queue paused', async () => {
  for (const options of [{ backupFailure: true }, { backupChanged: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(f.input));
    assert.equal(f.state.paused, true); assert.equal(f.effects.signals, 0); assert.equal(f.effects.installs, 0);
  }
});

test('duplicate intent cannot change approval/request owner or replay a stop/probe', async () => {
  const f = fixture(); await f.run(f.input);
  await assert.rejects(f.run({ ...f.input, requestId: 'different-intent' }), { code: 'MIGRATION_INTENT_CONFLICT' });
  assert.equal(f.effects.signals, 1); assert.equal(f.effects.starts, 1); assert.equal(f.effects.sdk, 0);
});

test('crashes after durable stages resume from original receipts without job edits or repeated signals', async () => {
  for (const stage of ['initial', 'paused', 'backup', 'stop-intent', 'stopped', 'installed', 'complete']) {
    const f = fixture({ crash: stage }), original = clone(f.state.jobs);
    await assert.rejects(f.run(f.input), { code: 'SIMULATED_CRASH' });
    const result = await f.run(f.input);
    assert.equal(result.unresolved, true, stage);
    assert.deepEqual(f.state.jobs, original, stage);
    assert.equal(f.effects.signals, 1, stage);
    assert.equal(f.effects.starts, 1, stage);
  }
});

test('interrupted launch intent resumes through the one-time process claim without another stop or SDK turn', async () => {
  const f = fixture({ crash: 'launch-intent' });
  await assert.rejects(f.run(f.input), { code: 'SIMULATED_CRASH' });
  assert.equal((await f.run(f.input)).unresolved, true);
  assert.equal(f.state.paused, true); assert.equal(f.effects.starts, 1); assert.equal(f.effects.signals, 1);
});

test('death after the signal but before its stage receipt is observed without contacting or signalling the dead broker', async () => {
  const f = fixture({ crashAfterStop: true });
  await assert.rejects(f.run(f.input), { code: 'SIMULATED_CRASH' });
  assert.equal(f.effects.signals, 1);
  assert.equal((await f.run(f.input)).unresolved, true);
  assert.equal(f.effects.signals, 1);
});

test('immutable file escrow verifies digests, refuses symlinks and never overwrites changed backup', t => {
  const dir = fs.mkdtempSync('/tmp/opencode/atomic-migration-files-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), backup = path.join(dir, 'backup');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'state.json'), '{"unknown":true}');
  const manifest = backupTree(source, backup); verifyTree(backup, manifest);
  assert.equal(fileHash(path.join(source, 'state.json')).sha256, manifest.entries[0].sha256);
  exclusive(path.join(dir, 'intent.json'), { owner: 'original' });
  assert.throws(() => exclusive(path.join(dir, 'intent.json'), { owner: 'foreign' }), { code: 'MIGRATION_RECEIPT_CONFLICT' });
  fs.chmodSync(path.join(backup, 'state.json'), 0o600); fs.writeFileSync(path.join(backup, 'state.json'), 'changed');
  assert.throws(() => verifyTree(backup, manifest), { code: 'BACKUP_MISMATCH' });
  assert.throws(() => backupTree(source, backup), { code: 'BACKUP_MISMATCH' });
  fs.symlinkSync(path.join(source, 'state.json'), path.join(source, 'link'));
  assert.throws(() => backupTree(source, path.join(dir, 'unsafe')), { code: 'UNSAFE_MIGRATION_FILE' });
});

test('real Linux pidfd stop targets only the verified fixture process and publishes bounded TERM intents', { timeout: 15000 }, async t => {
  const audit = fs.mkdtempSync('/tmp/opencode/atomic-migration-stop-');
  const child = spawn(process.execPath, ['-e', "process.once('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  await once(child.stdout, 'data');
  const owner = { pid: child.pid, birth: processBirth(child.pid), nonce: 'fixture' };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit; fs.rmSync(audit, { recursive: true, force: true });
  });
  const wrong = stopOwner({ ...owner, birth: 'wrong:birth' }, audit);
  assert.equal(wrong.signalsSent, 0, 'stale birth cannot signal a live unrelated identity');
  assert.equal(processBirth(child.pid), owner.birth);
  const result = stopOwner(owner, audit);
  await exit;
  assert.equal(result.originalDead, true); assert.equal(result.signalsSent, 2);
  for (const name of ['term-1-intent.json', 'term-2-intent.json', 'original-dead.json'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(audit, name))), owner);
  assert.equal(stopOwner(owner, audit).signalsSent, 0, 'completed stop is observed, not repeated');
});

function claimFixture(t, options = {}) {
  const { fastenersScope } = require('../src/atomic-workflow-observation');
  const scope = { ...fastenersScope };
  const { QueueState } = require('../src/queue-state');
  const base = fs.mkdtempSync('/tmp/opencode/atomic-migration-claim-');
  const dir = options.standardQueue ? path.join(base, 'fmcad', 'queue') : base;
  if (options.standardQueue) fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  if (options.prepareCurrentAudit) {
    scope.projectDirectory = path.join(dir, 'project'); scope.reportPath = path.join(dir, 'report');
    fs.mkdirSync(scope.projectDirectory); fs.mkdirSync(scope.reportPath);
  }
  const batchData = { reportPath: scope.reportPath, runId: 'run', atomic: true,
    ...(options.prepareCurrentAudit ? { operations: [{ id: 'read', operation: 'entity.list', data: { kind: 'body' } }] } : {}) };
  const state = new QueueState(dir);
  const submitted = state.submit({ kind: 'command', requestId: scope.requestId, clientId: 'original-owner',
    timeoutMs: 180000, buildHash: 'old-build', backend: 'addin', cwd: scope.projectDirectory,
    argv: ['cad', 'batch', 'run'], payload: { version: 1, kind: 'cad', operation: 'batch.run',
      doc: 'Scratch', docId: scope.docId, data: batchData } });
  const observed = options.auditUpgrade ? state.submit({ kind: 'command', requestId: 'prior-observer', clientId: 'original-owner',
    timeoutMs: 30000, buildHash: 'departing-build', backend: 'addin', cwd: scope.projectDirectory,
    argv: ['cad', 'batch', 'reconcile'], payload: { version: 1, kind: 'cad', operation: 'batch.reconcile',
      doc: 'Scratch', docId: scope.docId, data: { reportPath: scope.reportPath, blockedJobId: scope.jobId,
        commandId: scope.commandId, sessionNonce: scope.sessionNonce, operations: [] } } }) : null;
  state._commit(d => {
    const job = d.jobs[submitted.id]; delete d.jobs[submitted.id]; job.id = scope.jobId;
    job.state = 'needs_reconciliation'; job.physicalTurns = 2; job.dispatch = { rpcCount: 2 };
    job.sequenceState = null; d.jobs[scope.jobId] = job;
    d.active = scope.jobId; d.blocked = { id: scope.jobId, code: 'NEEDS_RECONCILIATION', at: Date.now() };
    d.paused = true; d.controlGeneration = 24; d.contextEpoch = 12;
    if (observed) {
      const observer = d.jobs[observed.id]; delete d.jobs[observed.id];
      observer.id = '3627db2e-0b9d-4e4f-927f-20cb45deae74';
      observer.state = 'needs_reconciliation'; observer.dispatch = { rpcCount: 1, completedCount: 1 };
      observer.workflowObservation = { version: 1, kind: 'atomic-holder-status', targetJobId: scope.jobId,
        targetJobHash: job.hash, observerJobHash: observer.hash, targetRequestId: job.requestId,
        targetClientId: job.clientId, targetBuildHash: 'old-build', observerBuildHash: 'departing-build',
        projectDirectory: scope.projectDirectory, paused: true, controlGeneration: 25, contextEpoch: 12,
        reportPath: scope.reportPath, reportFingerprint: hash('report'), commandId: scope.commandId,
        sessionNonce: scope.sessionNonce, docId: scope.docId };
      d.jobs[observer.id] = observer;
      d.active = observer.id; d.controlGeneration = 25;
    }
    return null;
  });
  const oldOwner = { pid: 2147483647, birth: 'old:birth', nonce: 'original-nonce', protocol: 2 };
  const paused = { state: state.data, owner: oldOwner,
    identity: { buildHash: 'old-build',
      ...(options.config ? { configHash: require('../src/queue-instance').brokerConfigHash(options.config) } : {}),
      instance: { pid: process.pid, birth: processBirth(), version: '2706' } },
    status: { paused: true, lease: null, stopping: false, ...(observed ? { nonterminalJobCount: 2 } : {}), control: { instanceId: oldOwner.nonce,
      buildHash: observed ? 'departing-build' : 'old-build', generation: observed ? 25 : 24,
      contextEpoch: 12, activeOperations: 0, activeIds: [], gateClosed: true } } };
  if (options.processLoss) paused.identity.instance = { pid: 2147483646, birth: 'terminated:fixture', version: '2706' };
  let proofExtras = {};
  if (options.prepareCurrentAudit) {
    const context = { doc: 'Scratch', docId: scope.docId };
    const request = { ...batchData }; delete request.reportPath;
    const semanticHash = require('../src/dist/core/application/cad/json').hash;
    const requestHash = semanticHash({ request, context });
    const doc = { name: 'Scratch', creationId: scope.docId, fileId: null };
    const documentIdentity = { expected: doc, resolved: { ...doc }, assertionsOnly: true };
    const identity = { commandId: scope.commandId, runId: 'run', requestHash, backend: 'addin',
      sessionNonce: scope.sessionNonce, documentIdentity, resolvedIdentity: documentIdentity.resolved };
    const report = { version: 2, operation: 'batch.run', runId: 'run', requestHash, request, context,
      status: 'unknown', outcome: 'unknown', reportPath: scope.reportPath, atomic: { effective: true, backend: 'addin' },
      documentIdentity, commandId: scope.commandId, sessionNonce: scope.sessionNonce, sequence: 0,
      journal: { event: 'submit_unknown', commandId: scope.commandId, runId: 'run', requestHash,
        documentIdentity, backend: 'addin', sessionNonce: scope.sessionNonce } };
    const bytes = JSON.stringify(report);
    fs.writeFileSync(path.join(scope.reportPath, '00000000.json'), bytes);
    proofExtras = { identity, clientId: 'original-owner', readOnlyOperation: 'atomic_status',
      reportFingerprint: hash(`00000000.json:${hash(bytes)}:${Buffer.byteLength(bytes)}`),
      originalInvocationHash: semanticHash(paused.state.jobs[scope.jobId].request.payload), sourceEnvelope: null };
    const targetDir = path.join(dir, 'jobs', scope.jobId); fs.mkdirSync(targetDir, { recursive: true });
    for (const rpcId of ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']) {
      const binding = { jobId: scope.jobId, rpcId, buildHash: 'old-build', requestHash: hash(rpcId), sourceHash: hash('original-source') };
      const receipt = path.join(targetDir, 'remote-' + rpcId + '.json');
      durable(receipt, { ...binding, instance: paused.identity.instance, terminal: true, outcome: 'succeeded' }, true);
      durable(path.join(targetDir, 'rpc-' + rpcId + '.json'), { binding, receipt, instance: paused.identity.instance, terminal: true,
        method: 'tools/call', request: { jsonrpc: '2.0', method: 'tools/call', id: rpcId },
        wireRequest: { jsonrpc: '2.0', method: 'tools/call', id: rpcId },
        response: { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { content: [] } }) } }, true);
    }
  }
  const upgradeHistory = observed ? require('./fixtures/atomic-audit-upgrade.cjs')(dir, paused, proofExtras) : null;
  if (options.processLoss) {
    upgradeHistory.approval.purpose = 'atomic-recovery-process-loss-audit-upgrade-v1';
    upgradeHistory.approval.currentInstance = { pid: process.pid, birth: processBirth(), version: '2706' };
    upgradeHistory.upgrade = require('../src/queue-atomic-audit-upgrade').auditUpgradeApproval(upgradeHistory.approval, dir);
  }
  if (options.epochUpgrade) {
    const facts = require('./fixtures/epoch-audit.cjs')(dir, scope, proofExtras.identity,
      upgradeHistory.approval.currentInstance, paused.identity.instance, oldOwner);
    upgradeHistory.approval.purpose = 'isolated-scratch-epoch-upgrade-v1';
    upgradeHistory.approval.epochPrerequisite = facts.files;
    upgradeHistory.upgrade = require('../src/queue-atomic-audit-upgrade').auditUpgradeApproval(upgradeHistory.approval, dir);
  }
  if (options.responseRecovery) {
    const response = require('./fixtures/audit-response.cjs')(dir, scope, proofExtras.identity,
      upgradeHistory.approval.currentInstance, paused.identity.instance, oldOwner);
    upgradeHistory.approval.purpose = 'atomic-audit-facts-recovery-upgrade-v1';
    upgradeHistory.approval.auditResponseRecovery = response.files;
    upgradeHistory.upgrade = require('../src/queue-atomic-audit-upgrade').auditUpgradeApproval(upgradeHistory.approval, dir);
    paused.status.control.buildHash = upgradeHistory.upgrade.departingBuildHash;
  }
  const requestId = 'migration-once', audit = path.join(dir, 'atomic-migrations', hash(requestId)), nonce = 'migration-nonce';
  fs.mkdirSync(audit, { recursive: true });
  const guard = { kind: 'atomic-owner-migration', nonce, audit, clientId: 'original-owner' };
  for (const name of ['recovery.lock', 'atomic-migration.lock']) durable(path.join(dir, name), guard, true);
  durable(path.join(dir, 'broker.lock'), oldOwner, true);
  durable(path.join(dir, 'instance.json'), paused.identity, true);
  const ownerTokenHash = observed ? hash('fixture-token') : 'token-digest';
  durable(path.join(dir, 'clients.json'), { 'original-owner': ownerTokenHash }, true);
  const sourceStateHash = hash(JSON.stringify(paused.state));
  const recoveryQualification = path.join(dir, 'fixture-qualified-recovery.json');
  if (options.responseRecovery) durable(recoveryQualification, { sourceCommit: 'f'.repeat(40),
    buildHash: options.buildHash, productionAdmission: true, isolatedEpochQualified: true, auditFactsCaptureQualified: true }, true);
  const manifest = { version: 1, sourceStateHash };
  for (const name of ['queue', 'report', 'runtime']) {
    const source = path.join(dir, 'fixture-' + name); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'original.json'), JSON.stringify({ unknown: true, name }));
    if (name === 'queue') fs.writeFileSync(path.join(source, 'queue-state.json'), JSON.stringify(paused.state));
    manifest[name] = backupTree(source, path.join(audit, name + '-backup'));
  }
  durable(path.join(audit, 'backup-manifest.json'), manifest, true);
  const backup = { audit, sourceStateHash, manifest: 'backup-manifest.json', sha256: fileHash(path.join(audit, 'backup-manifest.json')).sha256 };
  durable(path.join(audit, 'intent.json'), { nonce, ownerTokenHash,
    binding: { jobId: scope.jobId, requestId, clientId: 'original-owner' }, approved: {
      buildHash: options.buildHash || 'new-build', installRoot: path.resolve(__dirname, '..'),
      checkerContentFingerprint: require('../src/queue-atomic-migration-runtime').checkerContentFingerprint(path.resolve(__dirname, '..')),
      ...(upgradeHistory?.approval || {}),
      ...(options.responseRecovery ? { candidateRoot: path.resolve(__dirname, '..'), sourceCommit: 'f'.repeat(40),
        qualification: { path: recoveryQualification, sha256: fileHash(recoveryQualification).sha256 } } : {}),
    } }, true);
  durable(path.join(audit, 'paused.json'), paused, true);
  durable(path.join(audit, 'evidence.json'), { sourceEnvelope: null,
    originalInvocationHash: require('../src/dist/core/application/cad/json').hash(paused.state.jobs[scope.jobId].request.payload),
    ...(upgradeHistory ? { auditUpgrade: upgradeHistory.upgrade } : {}) }, true);
  durable(path.join(audit, 'stopped.json'), { stateHash: hash(JSON.stringify(paused.state)), backup }, true);
  durable(path.join(audit, 'installed.json'), { buildHash: options.buildHash || 'new-build' }, true);
  const marker = { pid: process.pid, birth: processBirth(), nonce: 'replacement', protocol: 2 };
  return { dir, audit, nonce, marker, paused, oldOwner, scope, proofExtras };
}

test('production replacement claim preserves byte-identical job snapshot and archives only the verified dead owner', t => {
  const { claimMigratedBroker } = require('../src/queue-atomic-migration-runtime');
  const f = claimFixture(t), before = fs.readFileSync(path.join(f.dir, 'queue-state.json'));
  const stateHash = claimMigratedBroker(f.dir, f.marker, f.nonce, 'new-build');
  assert.equal(stateHash, hash(JSON.stringify(f.paused.state)));
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'queue-state.json')), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'broker.lock'))), f.marker);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.audit, 'original-broker.lock.json'))), f.oldOwner);
  assert.throws(() => claimMigratedBroker(f.dir, f.marker, f.nonce, 'new-build'), { code: 'MIGRATION_LOCK_CHANGED' });
});

test('production replacement refuses wrong nonce/build/owner, corrupt escrow and changed holder without editing the lock', t => {
  const { claimMigratedBroker } = require('../src/queue-atomic-migration-runtime');
  for (const mutation of [
    f => { f.nonce = 'foreign'; }, f => { f.build = 'old-build'; },
    f => { durable(path.join(f.dir, 'clients.json'), { 'original-owner': 'changed-token' }); },
    f => { fs.chmodSync(path.join(f.audit, 'queue-backup/original.json'), 0o600);
      fs.writeFileSync(path.join(f.audit, 'queue-backup/original.json'), 'corrupt'); },
    f => { const s = clone(f.paused.state); s.jobs[Object.keys(s.jobs)[0]].state = 'failed';
      durable(path.join(f.dir, 'queue-state.json'), s); },
  ]) {
    const f = claimFixture(t); mutation(f);
    assert.throws(() => claimMigratedBroker(f.dir, f.marker, f.nonce, f.build || 'new-build'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'broker.lock'))), f.oldOwner);
  }
});

test('replacement can recover a crash after archiving the dead original lock but before claiming its new lock', t => {
  const { claimMigratedBroker } = require('../src/queue-atomic-migration-runtime');
  const f = claimFixture(t);
  durable(path.join(f.audit, 'original-broker.lock.json'), f.oldOwner, true);
  fs.unlinkSync(path.join(f.dir, 'broker.lock'));
  claimMigratedBroker(f.dir, f.marker, f.nonce, 'new-build');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'broker.lock'))), f.marker);
});

test('replacement control remains metadata-only until the migration guard is released', t => {
  const { assertMigrationAdmission } = require('../src/queue-atomic-migration-runtime');
  const f = claimFixture(t);
  for (const action of ['submit', 'observe-atomic', 'audit-atomic', 'backend', 'pause', 'drain', 'resume', 'reconcile', 'console-inspect', 'console-reload'])
    assert.throws(() => assertMigrationAdmission(f.dir, action), { code: 'MIGRATION_IN_PROGRESS' });
  for (const action of ['queue-summary', 'status', 'control-status', 'result', 'find-request', 'register'])
    assert.doesNotThrow(() => assertMigrationAdmission(f.dir, action));
  fs.unlinkSync(path.join(f.dir, 'atomic-migration.lock'));
  assert.doesNotThrow(() => assertMigrationAdmission(f.dir, 'observe-atomic'));
});

test('actual broker migration startup preserves the exact snapshot and sends no SDK initialization or probe', t => {
  const root = path.resolve(__dirname, '..');
  const config = { backend: 'addin', url: 'http://synthetic.invalid', timeoutMs: 1000, routing: 'queue', queue: {} };
  const f = claimFixture(t, { config, buildHash: require('../src/queue-instance').buildHash() });
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const {serve}=require(${JSON.stringify(root + '/src/queue-broker')});
    (async()=>{
      const dir=${JSON.stringify(f.dir)},file=path.join(dir,'queue-state.json'),before=fs.readFileSync(file);
      let calls=0;
      const backend={server:{timeoutMs:1000},_post(){calls++;throw Error('No SDK allowed');},_parse(){throw Error('No response expected');}};
      const broker=await serve(${JSON.stringify(config)},{dir,confirmOwnership:true,autoReconcile:false,
        atomicMigrationNonce:${JSON.stringify(f.nonce)},createBackend:()=>backend});
      await new Promise(r=>setTimeout(r,150));
      assert.deepEqual(fs.readFileSync(file),before);
      assert.equal(calls,0);
      const status=broker.status();
      assert.equal(status.paused,true);assert.equal(status.blocked.id,${JSON.stringify(f.paused.state.active)});
      assert.equal(status.held,'Read-only atomic holder observation only; all other admission remains blocked');
      process.stdout.write(JSON.stringify({calls,paused:status.paused,blocked:status.blocked.id}));process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1)});
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).calls, 0);
});

test('production approval rejects an absent/unready real admission module before any stop or deployment', async t => {
  const { approvedCandidate } = require('../src/queue-atomic-migration-runtime');
  const { buildHash } = require('../src/queue-instance');
  const root = fs.mkdtempSync('/tmp/opencode/atomic-migration-approval-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, 'candidate'), installRoot = path.join(root, 'installed');
  fs.mkdirSync(path.join(candidateRoot, 'src'), { recursive: true }); fs.mkdirSync(installRoot);
  const moduleFile = path.join(candidateRoot, 'src/queue-admission.js');
  fs.writeFileSync(moduleFile, 'module.exports = {};\n');
  const sourceCommit = 'a'.repeat(40), build = buildHash(candidateRoot);
  durable(path.join(candidateRoot, 'runtime-build.json'), { fingerprint: build }, true);
  const qualificationPath = path.join(root, 'qualification.json');
  durable(qualificationPath, { sourceCommit, buildHash: build, productionAdmission: true, passed: true }, true);
  const approvalFile = path.join(root, 'approval.json');
  const approval = { version: 1, sourceCommit, buildHash: build, candidateRoot, installRoot,
    admissionModuleSha256: fileHash(moduleFile).sha256, checkerFingerprint: 'b'.repeat(64),
    qualification: { path: qualificationPath, sha256: fileHash(qualificationPath).sha256 } };
  durable(approvalFile, approval, true);
  let prepared = 0;
  await assert.rejects(approvedCandidate(approvalFile, () => { prepared++; }), { code: 'PYTHON_ADMISSION_UNAVAILABLE' });
  assert.equal(prepared, 0);
  durable(approvalFile, { ...approval, buildHash: 'c'.repeat(64) });
  await assert.rejects(approvedCandidate(approvalFile), { code: 'BUILD_CHANGED' });
  assert.deepEqual(fs.readdirSync(installRoot), [], 'failed qualification cannot change installation files');
});

for (const processLoss of [false, true]) test('second-window production replacement starts metadata-only with two untouched unknown jobs and audit capability; processLoss=' + processLoss, t => {
  const root = path.resolve(__dirname, '..');
  const config = { backend: 'addin', url: 'http://synthetic.invalid', timeoutMs: 1000, routing: 'queue', queue: {} };
  const f = claimFixture(t, { config, auditUpgrade: true, processLoss, buildHash: require('../src/queue-instance').buildHash() });
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    (async()=>{
      const dir=${JSON.stringify(f.dir)},file=path.join(dir,'queue-state.json'),before=fs.readFileSync(file);
      let calls=0;
      const backend={server:{timeoutMs:1000},_post(){calls++;throw Error('No SDK allowed');},_parse(){throw Error('No response expected');}};
      const broker=await require(${JSON.stringify(root + '/src/queue-broker')}).serve(${JSON.stringify(config)},
        {dir,confirmOwnership:true,autoReconcile:false,atomicMigrationNonce:${JSON.stringify(f.nonce)},createBackend:()=>backend});
      const status=await require(${JSON.stringify(root + '/src/queue-connection')}).request(dir,
        {action:'queue-summary',auth:{clientId:'original-owner',clientToken:'fixture-token'}});
      assert.deepEqual(fs.readFileSync(file),before);assert.equal(calls,0);
      assert.equal(status.paused,true);assert.equal(status.control.gateClosed,true);
      assert.equal(status.control.generation,25);assert.equal(status.control.contextEpoch,12);
      assert.equal(status.nonterminalJobCount,2);assert.equal(status.features.atomicRecoveryAudit,true);
      assert.equal(status.features.atomicRecoveryProcessLossAudit,${JSON.stringify(processLoss)});
      if(${JSON.stringify(processLoss)}) {
        assert.equal(status.recoveryAuditScope.newInstanceRebound,false);
        assert.equal(status.recoveryAuditScope.currentModelingAdmission,'blocked');
        assert.equal(status.recoveryAuditScope.historicalProcessState,'terminated');
        assert.equal(status.recoveryAuditScope.currentInstance.pid,${JSON.stringify(process.pid)});
      }
      assert.equal(status.blocked.id,'5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a');
      assert.throws(()=>require(${JSON.stringify(root + '/src/queue-atomic-migration-runtime')}).assertMigrationAdmission(dir,'audit-atomic'),
        {code:'MIGRATION_IN_PROGRESS'});
      process.stdout.write(JSON.stringify({calls,unknownJobs:2,auditBlockedUntilComplete:true}));process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1)});
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).calls, 0);
});

test('a proven-dead migration worker can be retired under the same escrow without stealing a live owner', t => {
  const { claimMigratedBroker, retireDeadMigrationWorker } = require('../src/queue-atomic-migration-runtime');
  const f = claimFixture(t), snapshot = fs.readFileSync(path.join(f.dir, 'queue-state.json'));
  const deadWorker = { pid: 2147483646, birth: 'dead:worker' };
  const previous = { ...deadWorker, nonce: 'retired-migration-owner', protocol: 2 };
  claimMigratedBroker(f.dir, previous, f.nonce, 'new-build');
  durable(path.join(f.audit, 'worker.json'), deadWorker, true);
  durable(path.join(f.audit, 'worker-ready.json'), { owner: previous, buildHash: 'new-build' }, true);
  const intent = JSON.parse(fs.readFileSync(path.join(f.audit, 'intent.json')));
  retireDeadMigrationWorker(f.dir, f.audit, intent);
  assert.equal(fs.existsSync(path.join(f.audit, 'worker.json')), false);
  assert.equal(fs.existsSync(path.join(f.audit, 'worker-ready.json')), false);
  assert.equal(fs.existsSync(path.join(f.audit, 'retired-owner-' + hash(previous.nonce) + '.json')), true);
  claimMigratedBroker(f.dir, f.marker, f.nonce, 'new-build');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'queue-state.json')), snapshot);
  durable(path.join(f.audit, 'worker.json'), { pid: process.pid, birth: processBirth() }, true);
  assert.throws(() => retireDeadMigrationWorker(f.dir, f.audit, intent), { code: 'MIGRATION_OWNER_LIVE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'broker.lock'))), f.marker);
});

test('process-loss handoff completion is explicitly current-audit-only, not an admission epoch rebind', async () => {
  const f = upgradeFixture(), prior = f.ports.auditUpgrade();
  const currentInstance = { pid: 789, birth: 'selected-current', version: '2706' };
  f.ports.auditUpgrade = () => ({ ...prior, purpose: 'atomic-recovery-process-loss-audit-upgrade-v1', currentInstance });
  const observe = f.ports.observeNew;
  f.ports.observeNew = async (...args) => {
    const after = await observe(...args);
    after.status.features.atomicRecoveryProcessLossAudit = true;
    after.status.recoveryAuditScope = { currentInstance, currentModelingAdmission: 'blocked', newInstanceRebound: false };
    return after;
  };
  const jobs = clone(f.state.jobs);
  const result = await f.run(f.input);
  assert.equal(result.purpose, 'atomic-recovery-process-loss-audit-upgrade-v1');
  assert.equal(result.historicalProcessState, 'terminated');
  assert.equal(result.currentModelingAdmission, 'blocked');
  assert.equal(result.nativeOutcome, 'unknown');
  assert.deepEqual(result.currentAuditInstance, currentInstance);
  assert.deepEqual(f.state.jobs, jobs);
  assert.equal(f.state.paused, true);
  assert.equal(f.effects.sdk, 0);
});

test('process-loss owner audit uses the selected current endpoint, keeps original instance/history and never opens admission', t => {
  const root = path.resolve(__dirname, '..');
  const config = { backend: 'addin', url: 'http://synthetic.invalid', timeoutMs: 12000, routing: 'queue', queue: {} };
  const f = claimFixture(t, { config, auditUpgrade: true, processLoss: true, prepareCurrentAudit: true,
    buildHash: require('../src/queue-instance').buildHash() });
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const {durable}=require(${JSON.stringify(root + '/src/queue-instance')});
    const {request}=require(${JSON.stringify(root + '/src/queue-connection')});
    (async()=>{
      const dir=${JSON.stringify(f.dir)},audit=${JSON.stringify(f.audit)},file=path.join(dir,'queue-state.json');
      const before=fs.readFileSync(file),oldIdentity=fs.readFileSync(path.join(dir,'instance.json'));
      const intent=JSON.parse(fs.readFileSync(path.join(audit,'intent.json')));
      const expected=intent.approved.currentInstance;
      let calls=0;
      const summary={version:1,purpose:'atomic-recovery-audit-v1',profile:'atomic-recovery-counts-v1',
        requestIdentity:${JSON.stringify(f.proofExtras.identity)},nativeOutcome:'unknown',modelValidation:'not_performed',
        rollbackVerification:'not_performed',modulePresent:false,ui:{activeCommand:'SelectCommand',idle:true},
        commandDefinition:{status:'absent'},document:{status:'absent',matches:0},snapshot:null,fingerprint:null};
      const backend={server:{timeoutMs:12000},capabilities:{backend:'addin',atomicBatch:true},_parse:JSON.parse,
        async _post(payload){
          calls++;assert.equal(payload.params.name,'execute_python');
          const start=JSON.parse(fs.readFileSync(path.join(dir,'jobs',${JSON.stringify(f.scope.jobId)},'atomic-recovery-audit/start.json')));
          assert.deepEqual(start.instance,expected);
          assert.deepEqual(start.binding.auditExpectedInstance,expected);
          assert.equal(start.pythonCheck.status,'passed');
          durable(start.receipt,{...start.binding,terminal:true,outcome:'succeeded',instance:expected},true);
          return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text:'FMCAD_RESULT '+JSON.stringify(summary)}]}})};
        },
        async callTool(input){
          assert.equal(input.object.readOnly,true);
          const response=await this._post({jsonrpc:'2.0',id:'caller',method:'tools/call',params:{name:'execute_python',
            arguments:{code:input.object.script+'\\n\\nrun("")\\n',persistent:false}}});
          return {failed:false,text:JSON.parse(response.raw).result.content[0].text};
        }};
      const broker=await require(${JSON.stringify(root + '/src/queue-broker')}).serve(${JSON.stringify(config)},
        {dir,confirmOwnership:true,autoReconcile:false,atomicMigrationNonce:${JSON.stringify(f.nonce)},
          createBackend:()=>backend,testAtomicWorkflowScope:${JSON.stringify(f.scope)}});
      const owner=JSON.parse(fs.readFileSync(path.join(dir,'broker.lock')));
      const complete={kind:'atomic-owner-migration',requestId:intent.binding.requestId,jobId:${JSON.stringify(f.scope.jobId)},
        purpose:intent.approved.purpose,owner,observerBuildHash:broker.buildHash,currentAuditInstance:expected,
        gateClosed:true,unresolved:true,sdkRequestsSent:0,nativeOutcome:'unknown'};
      durable(path.join(audit,'complete.json'),complete,true);
      for(const name of ['atomic-migration.lock','recovery.lock'])fs.renameSync(path.join(dir,name),path.join(audit,'released-'+name+'.json'));
      const auth={clientId:'original-owner',clientToken:'fixture-token'};
      const status=await request(dir,{action:'queue-summary',auth});
      const control={instanceId:status.control.instanceId,buildHash:status.control.buildHash,
        generation:status.control.generation,contextEpoch:status.control.contextEpoch};
      const message={action:'audit-atomic',auth,jobId:${JSON.stringify(f.scope.jobId)},
        observationJobId:'3627db2e-0b9d-4e4f-927f-20cb45deae74',requestId:'current-process-facts',control};
      let value=await request(dir,message);
      for(let i=0;i<3000&&value.status==='pending';i++){
        await new Promise(r=>setTimeout(r,10));value=await request(dir,message);
      }
      assert.equal(value.status,'complete',JSON.stringify(value));assert.equal(calls,1);
      assert.equal(value.historicalProcessState,'terminated');assert.equal(value.endpointVerified,true);
      assert.deepEqual(value.currentInstance,expected);assert.equal(value.nativeOutcome,'unknown');
      assert.equal(value.currentModelingAdmission,'blocked');
      assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(path.join(dir,'instance.json')),oldIdentity);
      assert.deepEqual(await request(dir,message),value);assert.equal(calls,1);
      process.stdout.write(JSON.stringify({currentOnlyAudit:true,calls,originalHistoryUnchanged:true,nativeOutcome:value.nativeOutcome}));
      process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1)});
  `], { encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).calls, 1);
});

for (const mode of ['complete', 'creation-unknown', 'creation-forged-id', 'close-unknown']) test('real broker isolated scratch preserves history and forbids replay: ' + mode, t => {
  const root = path.resolve(__dirname, '..');
  const config = { backend: 'addin', url: 'http://synthetic.invalid', timeoutMs: 12000, routing: 'queue', queue: {} };
  const f = claimFixture(t, { config, auditUpgrade: true, processLoss: true, prepareCurrentAudit: true, epochUpgrade: true, standardQueue: true,
    buildHash: require('../src/queue-instance').buildHash() });
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const {durable,hash}=require(${JSON.stringify(root + '/src/queue-instance')});
    const {request}=require(${JSON.stringify(root + '/src/queue-connection')});
    const canonicalHash=require(${JSON.stringify(root + '/src/dist/core/application/cad/json')}).hash;
    (async()=>{
      const dir=${JSON.stringify(f.dir)},audit=${JSON.stringify(f.audit)},stateFile=path.join(dir,'queue-state.json');
      const before=fs.readFileSync(stateFile),oldIdentity=fs.readFileSync(path.join(dir,'instance.json'));
      const intent=JSON.parse(fs.readFileSync(path.join(audit,'intent.json'))),expected=intent.approved.currentInstance;
      const createDir=path.join(dir,'isolated-scratch-qualification'),closeDir=path.join(dir,'isolated-scratch-close');
      const mode=${JSON.stringify(mode)};
      let calls=0,creation=0,close=0;
      const backend={server:{timeoutMs:12000},capabilities:{backend:'addin',atomicBatch:true},_parse:JSON.parse,
        async _post(payload){
          calls++;const closing=fs.existsSync(path.join(closeDir,'start.json')),opDir=closing?closeDir:createDir;
          const start=JSON.parse(fs.readFileSync(path.join(opDir,'start.json')));
          const binding=JSON.parse(fs.readFileSync(path.join(opDir,'intent.json'))).binding;
          assert.deepEqual(start.binding.auditExpectedInstance,expected);assert.equal(start.pythonCheck.status,'passed');
          const document=closing?binding.document:{name:'FMCAD_ISOLATED_'+binding.epochId,
            creationId:mode==='creation-forged-id'?${JSON.stringify(f.scope.docId)}:'actually-new-fixture-id',fileId:null};
          if(mode!=='creation-forged-id')assert.notEqual(document.creationId,${JSON.stringify(f.scope.docId)});
          const summary=closing?{version:1,purpose:'isolated-scratch-close-v1',document,bindingHash:canonicalHash(binding),
            closed:true,saved:false,historicalOutcome:'unknown',originalModelValidation:'not_performed',originalRollbackVerification:'not_performed'}:
            {version:1,purpose:'isolated-scratch-epoch-v1',epochId:binding.epochId,bindingHash:canonicalHash(binding),document,
            independent:true,empty:true,unsaved:true,activeCommand:'SelectCommand',beforeIdsHash:'a'.repeat(64),historicalOutcome:'unknown',
            originalModelValidation:'not_performed',originalRollbackVerification:'not_performed'};
          durable(binding.sdkProofPath,summary,true);
          durable(start.receipt,{...start.binding,terminal:true,outcome:'succeeded',instance:expected},true);
          if(closing)close++;else creation++;
          if((mode==='creation-unknown'&&!closing)||(mode==='close-unknown'&&closing))
            throw Object.assign(new Error('fixture lost reply after SDK effect'),{code:'ECONNRESET'});
          return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text:'FMCAD_RESULT '+JSON.stringify(summary)}]}})};
        },
        async callTool(input){
          assert.equal(input.object.readOnly,false);
          const response=await this._post({jsonrpc:'2.0',id:'caller',method:'tools/call',params:{name:'execute_python',
            arguments:{code:input.object.script+'\\n\\nrun("")\\n',persistent:false}}});
          return {failed:false,text:JSON.parse(response.raw).result.content[0].text};
        }};
      const broker=await require(${JSON.stringify(root + '/src/queue-broker')}).serve(${JSON.stringify(config)},
        {dir,confirmOwnership:true,autoReconcile:false,atomicMigrationNonce:${JSON.stringify(f.nonce)},
          createBackend:()=>backend,testAtomicWorkflowScope:${JSON.stringify(f.scope)}});
      const marker=JSON.parse(fs.readFileSync(path.join(dir,'broker.lock')));
      durable(path.join(audit,'complete.json'),{kind:'atomic-owner-migration',requestId:intent.binding.requestId,
        jobId:${JSON.stringify(f.scope.jobId)},purpose:intent.approved.purpose,owner:marker,observerBuildHash:broker.buildHash,
        currentAuditInstance:expected,gateClosed:true,unresolved:true,sdkRequestsSent:0,nativeOutcome:'unknown'},true);
      const auth={clientId:'original-owner',clientToken:'fixture-token'},foreign={clientId:'mcp',clientToken:'mcp-token'};
      await request(dir,{action:'register',clientId:foreign.clientId,clientToken:foreign.clientToken});
      async function control(){const s=await request(dir,{action:'queue-summary',auth});return {
        instanceId:s.control.instanceId,buildHash:s.control.buildHash,generation:s.control.generation,contextEpoch:s.control.contextEpoch};}
      const message={action:'create-isolated-scratch',auth,jobId:${JSON.stringify(f.scope.jobId)},
        observationJobId:'3627db2e-0b9d-4e4f-927f-20cb45deae74',requestId:'one-new-scratch',control:await control()};
      await assert.rejects(request(dir,message),{code:'MIGRATION_IN_PROGRESS'});assert.equal(calls,0);
      for(const name of ['atomic-migration.lock','recovery.lock'])fs.renameSync(path.join(dir,name),path.join(audit,'released-'+name+'.json'));
      await assert.rejects(request(dir,{...message,auth:foreign}),{code:'NOT_OWNER'});assert.equal(calls,0);
      let value=await request(dir,message);
      for(let i=0;i<3000&&value.status==='pending';i++){await new Promise(r=>setTimeout(r,10));value=await request(dir,message);}
      assert.equal(creation,1);
      if(mode==='creation-unknown'||mode==='creation-forged-id'){
        assert.equal(value.status,'failed',JSON.stringify(value));assert.equal(value.sdkRequestsSent,1);
        assert.equal(fs.existsSync(path.join(dir,'isolated-admission-epoch.json')),false);
        await request(dir,message);assert.equal(calls,1);
        await assert.rejects(request(dir,{...message,requestId:'do-not-replay'}),{code:'AUDIT_ALREADY_REQUESTED'});
        assert.deepEqual(fs.readFileSync(stateFile),before);assert.deepEqual(fs.readFileSync(path.join(dir,'instance.json')),oldIdentity);
        process.stdout.write(JSON.stringify({creation,close,calls,historicalOutcome:'unknown'}));process.exit(0);
      }
      assert.equal(value.status,'complete',JSON.stringify(value));
      const pointer=JSON.parse(fs.readFileSync(path.join(dir,'isolated-admission-epoch.json')));
      assert.equal(pointer.document.creationId,'actually-new-fixture-id');
      const library=require(${JSON.stringify(root + '/src/dist/composition/library-queue')});
      const native=library.createQueueSession(${JSON.stringify(config)},'native-mcp',${JSON.stringify(f.scope.projectDirectory)},'native-fixture');
      await native.start();
      const ownStatus=await native.status();assert.equal(ownStatus.clientId,'native-mcp');
      assert.equal(ownStatus.isolatedScratch.epochId,pointer.epochId);
      assert.deepEqual(fs.readFileSync(stateFile),before);assert.deepEqual(fs.readFileSync(path.join(dir,'instance.json')),oldIdentity);
      const old=await request(dir,{action:'find-request',auth,requestId:${JSON.stringify(f.scope.requestId)}});
      assert.equal(old.job.quarantined,true);assert.equal(old.job.state,'needs_reconciliation');
      await assert.rejects(request(dir,{action:'reconcile',auth,jobId:${JSON.stringify(f.scope.jobId)}}),{code:'INSTANCE_HISTORY_QUARANTINED'});
      await assert.rejects(request(dir,{action:'grant-isolated-scratch',auth:foreign,epochId:pointer.epochId,
        grantClientId:'mcp',control:await control()}),{code:'NOT_OWNER'});
      await request(dir,{action:'grant-isolated-scratch',auth,epochId:pointer.epochId,grantClientId:'mcp',control:await control()});
      await request(dir,{action:'grant-isolated-scratch',auth,epochId:pointer.epochId,grantClientId:ownStatus.clientId,control:await control()});
      const typed=require(${JSON.stringify(root + '/src/cad-service')}).fromParsedCommand({kind:'cad',operation:'sketch.create',data:{name:'S',plane:'XY'},
        context:{doc:pointer.document.name,docId:'old-or-forged-id'},json:true});
      await assert.rejects(request(dir,{action:'submit',auth:foreign,request:{kind:'command',requestId:'forged-doc',timeoutMs:12000,
        cwd:${JSON.stringify(f.scope.projectDirectory)},buildHash:broker.buildHash,backend:'addin',...typed}}),{code:'EPOCH_SCOPE_REQUIRED'});
      await assert.rejects(native.execute(typed.payload,{requestId:'typed-native-wrong-doc'}),{code:'EPOCH_SCOPE_REQUIRED'});
      const closeMessage={...message,action:'close-isolated-scratch',requestId:'one-close',control:await control()};
      value=await request(dir,closeMessage);
      for(let i=0;i<3000&&value.status==='pending';i++){await new Promise(r=>setTimeout(r,10));value=await request(dir,closeMessage);}
      assert.equal(value.status,mode==='close-unknown'?'failed':'complete',JSON.stringify(value));assert.equal(close,1);assert.equal(calls,2);
      await request(dir,closeMessage);assert.equal(calls,2);
      assert.deepEqual(fs.readFileSync(stateFile),before);assert.deepEqual(fs.readFileSync(path.join(dir,'instance.json')),oldIdentity);
      const status=await request(dir,{action:'queue-summary',auth});
      assert.equal(status.isolatedScratchScope.admission,mode==='close-unknown'?'cleanup-pending-or-unknown':'closed');
      assert.equal((await native.status()).blocked,true);
      typed.payload.invocation.docId=pointer.document.creationId;
      typed.argv=require(${JSON.stringify(root + '/src/cad-service')}).policyArguments(typed.payload);
      await assert.rejects(request(dir,{action:'submit',auth:foreign,request:{kind:'command',requestId:'after-cleanup',timeoutMs:12000,
        cwd:${JSON.stringify(f.scope.projectDirectory)},buildHash:broker.buildHash,backend:'addin',...typed}}),
        {code:mode==='close-unknown'?'EPOCH_CLEANUP_PENDING':'EPOCH_CLOSED'});
      await request(dir,message);assert.equal(calls,2);
      process.stdout.write(JSON.stringify({creation,close,calls,historicalOutcome:'unknown'}));process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1)});
  `], { encoding: 'utf8', timeout: 60000, cwd: f.scope.projectDirectory,
    env: { ...process.env, HOME: path.join(f.dir, 'home'), XDG_CONFIG_HOME: path.join(f.dir, 'config'),
      XDG_STATE_HOME: path.dirname(path.dirname(f.dir)), XDG_CACHE_HOME: path.join(f.dir, 'cache') } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { creation: 1, close: mode.startsWith('creation-') ? 0 : 1,
    calls: mode.startsWith('creation-') ? 1 : 2, historicalOutcome: 'unknown' });
});

for (const mode of ['success', 'lost-reply-with-durable-facts', 'missing-sdk-facts', 'forged-sdk-facts'])
test('facts recovery broker preserves original failed audit and requires a separate actual-facts authority: ' + mode,
  { skip: !process.env.FMCAD_TEST_LEGACY_843_RUNTIME && 'Requires exact qualified legacy 843 runtime; set FMCAD_TEST_LEGACY_843_RUNTIME' }, t => {
  const root = path.resolve(__dirname, '..');
  const config = { backend: 'addin', url: 'http://synthetic.invalid', timeoutMs: 12000, routing: 'queue', queue: {} };
  const f = claimFixture(t, { config, auditUpgrade: true, processLoss: true, prepareCurrentAudit: true,
    responseRecovery: true, buildHash: require('../src/queue-instance').buildHash() });
  const result = spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const {durable,hash}=require(${JSON.stringify(root + '/src/queue-instance')});
    const {request}=require(${JSON.stringify(root + '/src/queue-connection')});
    const canonicalHash=require(${JSON.stringify(root + '/src/dist/core/application/cad/json')}).hash;
    (async()=>{
      const dir=${JSON.stringify(f.dir)},audit=${JSON.stringify(f.audit)},mode=${JSON.stringify(mode)};
      const oldDir=path.join(dir,'jobs',${JSON.stringify(f.scope.jobId)},'atomic-recovery-audit');
      const original=fs.readFileSync(path.join(oldDir,'result.json')),snapshot=fs.readFileSync(path.join(dir,'queue-state.json'));
      const intent=JSON.parse(fs.readFileSync(path.join(audit,'intent.json'))),expected=intent.approved.currentInstance;
      const captureDir=path.join(dir,'jobs',${JSON.stringify(f.scope.jobId)},'atomic-audit-facts-capture');
      let calls=0;
      const backend={server:{timeoutMs:12000},capabilities:{backend:'addin',atomicBatch:true},_parse:JSON.parse,
        async _post(payload){
          calls++;const local=JSON.parse(fs.readFileSync(path.join(captureDir,'intent.json'))),b=local.binding;
          const start=JSON.parse(fs.readFileSync(path.join(captureDir,'start.json')));
          assert.equal(start.pythonCheck.status,'passed');assert.equal(b.originalRpcId,intent.approved.auditResponseRecovery?JSON.parse(fs.readFileSync(oldDir+'/start.json')).binding.rpcId:'missing');
          const summary={version:1,purpose:'atomic-recovery-audit-v1',profile:'atomic-recovery-counts-v1',
            requestIdentity:local.identity,nativeOutcome:'unknown',modelValidation:'not_performed',rollbackVerification:'not_performed',
            modulePresent:false,ui:{activeCommand:'SelectCommand',idle:true},commandDefinition:{status:'absent'},
            document:{status:'absent',matches:0},snapshot:null,fingerprint:null};
          if(mode!=='missing-sdk-facts')durable(b.captureProofPath,{version:1,kind:'atomic-current-facts-capture-v1',
            bindingHash:mode==='forged-sdk-facts'?'forged':canonicalHash(b),originalRpcId:b.originalRpcId,observedAtMs:Date.now(),
            summary,historicalOutcome:'unknown',modelValidation:'not_performed',rollbackVerification:'not_performed'},true);
          durable(start.receipt,{...start.binding,terminal:true,outcome:'succeeded',instance:expected},true);
          if(mode!=='success')throw Object.assign(new Error('fixture lost HTTP reply'),{code:'EPROTO'});
          return {status:200,raw:JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text:'FMCAD_RESULT '+JSON.stringify(summary)}]}})};
        },
        async callTool(input){assert.equal(input.object.readOnly,true);const response=await this._post({jsonrpc:'2.0',id:2,method:'tools/call',
          params:{name:'execute_python',arguments:{code:input.object.script+'\\n\\nrun("")\\n',persistent:false}}});
          return {text:JSON.parse(response.raw).result.content[0].text,failed:false};}};
      const broker=await require(${JSON.stringify(root + '/src/queue-broker')}).serve(${JSON.stringify(config)},
        {dir,confirmOwnership:true,autoReconcile:false,atomicMigrationNonce:${JSON.stringify(f.nonce)},
          createBackend:()=>backend,testAtomicWorkflowScope:${JSON.stringify(f.scope)}});
      const marker=JSON.parse(fs.readFileSync(path.join(dir,'broker.lock')));
      durable(path.join(audit,'complete.json'),{kind:'atomic-owner-migration',requestId:intent.binding.requestId,
        jobId:${JSON.stringify(f.scope.jobId)},purpose:intent.approved.purpose,owner:marker,observerBuildHash:broker.buildHash,currentAuditInstance:expected,
        gateClosed:true,unresolved:true,sdkRequestsSent:0,nativeOutcome:'unknown'},true);
      const auth={clientId:'original-owner',clientToken:'fixture-token'};
      const foreign={clientId:'foreign-reader',clientToken:'foreign-fixture-token'};
      await request(dir,{action:'register',clientId:foreign.clientId,clientToken:foreign.clientToken});
      async function status(){return request(dir,{action:'queue-summary',auth});}
      async function control(){const s=await status();return {instanceId:s.control.instanceId,buildHash:s.control.buildHash,
        generation:s.control.generation,contextEpoch:s.control.contextEpoch};}
      const requestId=JSON.parse(fs.readFileSync(oldDir+'/intent.json')).key.requestId;
      const message={action:'capture-audit-facts',auth,jobId:${JSON.stringify(f.scope.jobId)},
        observationJobId:'3627db2e-0b9d-4e4f-927f-20cb45deae74',requestId,confirmReadOnly:true,control:await control()};
      await assert.rejects(request(dir,message),{code:'MIGRATION_IN_PROGRESS'});
      for(const name of ['atomic-migration.lock','recovery.lock'])fs.renameSync(path.join(dir,name),path.join(audit,'released-'+name+'.json'));
      assert.equal((await status()).features.isolatedScratchEpoch,false);
      await assert.rejects(request(dir,{...message,auth:foreign}),{code:'AUDIT_CAPTURE_NOT_AUTHORIZED'});assert.equal(calls,0);
      await assert.rejects(request(dir,{...message,confirmReadOnly:false}),{code:'AUDIT_CAPTURE_CONFIRMATION_REQUIRED'});
      await assert.rejects(request(dir,{...message,requestId:'NEW-audit-is-not-allowed'}),{code:'AUDIT_CAPTURE_CONFIRMATION_REQUIRED'});
      let value=await request(dir,message),failure;
      for(let n=0;n<3000&&value.status==='pending';n++){await new Promise(r=>setTimeout(r,10));
        try{value=await request(dir,message);}catch(error){failure=error;break;}}
      assert.equal(calls,1);assert.deepEqual(fs.readFileSync(oldDir+'/result.json'),original);
      assert.deepEqual(fs.readFileSync(path.join(dir,'queue-state.json')),snapshot);
      if(mode==='forged-sdk-facts'){
        assert.equal(failure?.code,'AUDIT_CAPTURE_PROOF_INVALID');assert.equal(fs.existsSync(path.join(captureDir,'derived-facts.json')),false);
      }else if(mode==='missing-sdk-facts'){
        assert.equal(value.status,'failed');assert.equal(value.endpointVerified,false);await request(dir,message);assert.equal(calls,1);
      }else{
        assert.equal(value.kind,'derived-current-audit-facts-v1');assert.equal(value.status,'complete');assert.equal(value.endpointVerified,true);
        assert.equal(value.originalAuditFactsRecovered,false);assert.equal(value.originalAuditStatus.endpointVerified,false);
        assert.equal(value.transportStatus,mode==='success'?'complete':'failed');assert.equal(value.epochEligible,mode==='success');
        assert.equal((await status()).features.isolatedScratchEpoch,false,'Capture is NOT epoch authorization');
        const derived=path.join(captureDir,'derived-facts.json'),approval=path.join(dir,'fixture-facts-approval.json');
        durable(approval,{version:1,purpose:'isolated-scratch-current-facts-approval-v1',auditRequestId:requestId,
          sourceCommit:intent.approved.sourceCommit,buildHash:broker.buildHash,qualification:intent.approved.qualification,
          derivedFacts:{path:derived,sha256:hash(fs.readFileSync(derived))},currentInstance:expected},true);
        const authorization={action:'authorize-isolated-scratch',auth,requestId,approval,confirmCurrentFacts:true,control:await control()};
        if(mode==='success'){
          await assert.rejects(request(dir,{...authorization,auth:foreign}),{code:'AUDIT_CAPTURE_NOT_AUTHORIZED'});
          await assert.rejects(request(dir,{...authorization,confirmCurrentFacts:false}),{code:'EPOCH_FACTS_CONFIRMATION_REQUIRED'});
          const bad=JSON.parse(fs.readFileSync(approval));bad.currentInstance={...expected,birth:'forged'};
          const badFile=path.join(dir,'fixture-wrong-facts-approval.json');durable(badFile,bad,true);
          await assert.rejects(request(dir,{...authorization,approval:badFile}),{code:'EPOCH_AUDIT_REQUIRED'});
          await request(dir,authorization);assert.equal((await status()).isolatedScratchScope.creation,'owner-bound-new-document-only');
        }else{
          await assert.rejects(request(dir,authorization),{code:'EPOCH_AUDIT_REQUIRED'});
          assert.equal((await status()).features.isolatedScratchEpoch,false);
        }
        assert.equal((await status()).paused,true);assert.equal(calls,1);
        await request(dir,message);assert.equal(calls,1);
      }
      process.stdout.write(JSON.stringify({calls,originalUnchanged:true,mode}));process.exit(0);
    })().catch(error=>{console.error(error);process.exit(1)});
  `], { encoding: 'utf8', timeout: 60000, cwd: f.scope.projectDirectory,
    env: { ...process.env, HOME: path.join(f.dir, 'home'), XDG_CONFIG_HOME: path.join(f.dir, 'config'),
      XDG_STATE_HOME: path.join(f.dir, 'state'), XDG_CACHE_HOME: path.join(f.dir, 'cache') } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 1, originalUnchanged: true, mode });
});

test('duplicate migration worker launch loses its one-time process claim before reading config or creating a broker', { timeout: 10000 }, async t => {
  const f = claimFixture(t), script = path.resolve(__dirname, '../src/queue-atomic-migration-worker.js');
  const child = spawn(process.execPath, [script, f.audit], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exit; });
  const workerFile = path.join(f.audit, 'worker.json');
  await new Promise((resolve, reject) => {
    const watcher = fs.watch(f.audit, () => { if (fs.existsSync(workerFile)) finish(); });
    const timer = setTimeout(() => finish(new Error('Fixture worker claim not published')), 3000);
    function finish(error) { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); }
    if (fs.existsSync(workerFile)) finish();
  });
  const owner = JSON.parse(fs.readFileSync(workerFile));
  const duplicate = spawnSync(process.execPath, [script, f.audit], { input: 'not a configuration', encoding: 'utf8', timeout: 3000 });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(workerFile)), owner);
  assert.equal(fs.existsSync(path.join(f.audit, 'worker-error.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'broker.lock'))), f.oldOwner);
});

test('interrupted TERM intent can resume against the same live pidfd without assuming that the earlier signal was sent', { timeout: 10000 }, async t => {
  const audit = fs.mkdtempSync('/tmp/opencode/atomic-migration-stop-gap-');
  const child = spawn(process.execPath, ['-e', "process.once('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'); await once(child.stdout, 'data');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit; fs.rmSync(audit, { recursive: true, force: true });
  });
  const owner = { pid: child.pid, birth: processBirth(child.pid), nonce: 'interrupted-fixture' };
  durable(path.join(audit, 'term-1-intent.json'), owner, true); // Crash before any actual signal.
  const result = stopOwner(owner, audit); await exit;
  assert.equal(result.signalsSent, 2);
  for (const name of ['term-1-intent.json', 'term-2-sent.json', 'term-3-sent.json', 'original-dead.json'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(audit, name))), owner);
});

test('typed owner migration matches retained state, evidence and effects across every interrupted stage', async () => {
  const old = require('./fixtures/historical-module.cjs')(
    '330849f22302bcf0ee955cd1945ddb2040eff8c7', 'src/queue-atomic-migration.js');
  for (const crash of [undefined, 'initial', 'paused', 'backup', 'stop-intent', 'stopped', 'installed', 'launch-intent', 'complete']) {
    const results = [];
    for (const create of [old.createMigrator, createMigrator]) {
      const f = fixture({ crash }); const run = create(f.ports);
      if (crash) await assert.rejects(run(f.input), { code: 'SIMULATED_CRASH' });
      const result = await run(f.input);
      assert.deepEqual(await run(f.input), result);
      results.push({ result, records: [...f.records], effects: f.effects, state: f.state });
    }
    assert.deepEqual(results[1], results[0], crash || 'uninterrupted');
  }
  for (const options of [{ admissionMissing: true }, { wrongProof: true }, { staleBirth: true },
    { backupFailure: true }, { backupChanged: true }, { changedHolder: true }, { activeAfterBackup: true }]) {
    const results = [];
    for (const create of [old.createMigrator, createMigrator]) {
      const f = fixture(options); let code;
      await assert.rejects(create(f.ports)(f.input), error => { code = error.code; return true; });
      results.push({ code, records: [...f.records], effects: f.effects, state: f.state });
    }
    assert.deepEqual(results[1], results[0], JSON.stringify(options));
  }
});
