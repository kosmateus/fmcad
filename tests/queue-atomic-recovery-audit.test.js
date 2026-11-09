'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRecoveryAudit, auditAtomic, auditSummary } = require('../src/queue-atomic-recovery-audit');
const { createProductionQueueAdmission } = require('../src/queue-admission');
const { resolveRuntimePaths } = require('../src/dist/config-platform');
const { hash, buildHash } = require('../src/queue-instance');
const canonicalHash = require('../src/dist/core/application/cad/json').hash;
const { QueueGate } = require('../src/queue-gate');

function fixtureDirectory(t, prefix) {
  // Synthetic physical ports only; no Fusion is contacted.
  t.after(require('./fixtures/fake-wsl-platform.cjs')());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('legacy audit capability and build mismatch refuse before any control submission', async () => {
  for (const status of [{ features: {} }, { features: { atomicRecoveryAudit: true }, control: { buildHash: 'old' } }]) {
    const calls = [];
    await assert.rejects(auditAtomic({ async call(action) { calls.push(action); return status; } },
      { jobId: 'target', observationJobId: 'prior', requestId: 'audit', buildHash: 'new' }));
    assert.deepEqual(calls, ['queue-summary']);
  }
});

test('audit CLI rejects identity/payload overrides before reading credentials/config', async () => {
  for (const extra of [['--client', 'foreign'], ['--doc-id', 'foreign'], ['--accept-outcome', 'aborted'], ['--', 'run']]) {
    await assert.rejects(require('../src/queue-cli').queueCommand(['audit-atomic', '--job', 'target',
      '--observation-job', 'prior', '--request-id', 'audit', ...extra], {
      loadConfig() { assert.fail('Invalid audit flags cannot access configuration'); },
    }));
  }
});

function summary(identity) {
  const snapshot = { identity: identity.resolvedIdentity, version: null, isSaved: false, isModified: false,
    bodies: 0, sketches: 0, occurrences: 0, parameters: 0, timeline: 0, references: 0 };
  return { version: 1, purpose: 'atomic-recovery-audit-v1', profile: 'atomic-recovery-counts-v1', requestIdentity: identity,
    nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed',
    modulePresent: false, ui: { activeCommand: 'SelectCommand', idle: true }, commandDefinition: { status: 'absent' },
    document: { status: 'observed', identity: identity.resolvedIdentity }, snapshot, fingerprint: canonicalHash(snapshot) };
}

test('audit rejects terminal claims, foreign pins, geometry additions and forged fingerprints', () => {
  const identity = { resolvedIdentity: { name: 'owned', creationId: 'owned-id', fileId: null } };
  for (const mutate of [
    s => { s.nativeOutcome = 'aborted'; }, s => { s.rollbackVerification = 'passed'; },
    s => { s.snapshot.identity.creationId = 'foreign'; }, s => { s.snapshot.geometry = {}; },
    s => { s.fingerprint = '0'.repeat(64); },
  ]) {
    const value = structuredClone(summary(identity));
    mutate(value);
    assert.throws(() => auditSummary({ result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(value) }] } }, identity),
      { code: 'AUDIT_OUTPUT_INVALID' });
  }
});

test('concurrent receipt polls join one publication callback instead of racing epoch activation', async t => {
  const directory = fixtureDirectory(t, 'audit-publication-race-');
  let enteredResolve, releaseResolve, endedResolve, publications = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const blocker = new Promise(resolve => { releaseResolve = resolve; });
  const ended = new Promise(resolve => { endedResolve = resolve; });
  const identity = { resolvedIdentity: { name: 'old', creationId: 'old-id', fileId: null } };
  const controller = createRecoveryAudit({
    installation: path.resolve(__dirname, '..'), buildHash: 'fixture-build', jobDirectory: () => directory,
    assertOwner() {}, inspect: async () => ({ identity, instance: {}, binding: {} }), fence() {}, begin() {}, end: endedResolve,
    admit: send => send(), check: async () => ({ report: { status: 'passed' }, fence() {} }),
    post: async payload => ({ id: payload.id, result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(summary(identity)) }] } }),
    match: response => response, remoteReceipt: () => ({ outcome: 'succeeded' }),
    sendScript: (scope, script) => scope.post({ jsonrpc: '2.0', id: 'caller', method: 'tools/call', params: {
      name: 'execute_python', arguments: { code: script + '\n\nrun("")\n', persistent: false } } }),
    async publishComplete() { publications++; enteredResolve(); await blocker; return { epochId: 'one-publication' }; },
  });
  const message = { jobId: 'target', observationJobId: 'observer', requestId: 'single-request' };
  assert.equal((await controller.handle(message, 'owner')).status, 'pending');
  await entered;
  const polls = Array.from({ length: 8 }, () => controller.handle(message, 'owner'));
  releaseResolve();
  const results = await Promise.all(polls); await ended;
  assert.equal(publications, 1);
  assert.ok(results.every(result => result.activation.epochId === 'one-publication'));
});

test('a lost scratch creation reply retains start/unknown evidence and can never dispatch again', async t => {
  const directory = fixtureDirectory(t, 'scratch-unknown-wire-');
  let sent = 0, endedResolve;
  const ended = new Promise(resolve => { endedResolve = resolve; });
  const kind = 'isolated-scratch-qualification', epochId = require('node:crypto').randomUUID();
  const controller = createRecoveryAudit({
    kind, installation: path.resolve(__dirname, '..'), buildHash: 'fixture-build', jobDirectory: () => directory,
    prepareReader: require('../src/queue-scratch-qualification').prepareScratchQualification,
    parseSummary: require('../src/queue-scratch-qualification').parseScratchQualification,
    assertOwner() {}, inspect: async () => ({ identity: {}, instance: {}, binding: { purpose: 'isolated-scratch-epoch-v1',
      epochId, forbiddenIds: ['old-doc'], sdkProofPath: path.join(directory, kind, 'sdk-qualified.json') } }),
    fence() {}, begin() {}, end: endedResolve, admit: send => send(),
    check: async () => ({ report: { status: 'passed' }, fence() {} }),
    post: async () => { sent++; throw Object.assign(new Error('fixture lost reply'), { code: 'ECONNRESET' }); },
    match() { assert.fail('No reply arrived'); }, remoteReceipt() { assert.fail('No terminal reply arrived'); },
    sendScript: (scope, script) => scope.post({ jsonrpc: '2.0', id: 'caller', method: 'tools/call', params: {
      name: 'execute_python', arguments: { code: script + '\n\nrun("")\n', persistent: false } } }),
    publishComplete() { assert.fail('Never qualify an uncertain creation'); },
  });
  const message = { jobId: 'target', observationJobId: 'observer', requestId: 'single-scratch' };
  await controller.handle(message, 'owner'); await ended;
  const result = await controller.handle(message, 'owner');
  assert.equal(result.status, 'failed'); assert.equal(result.sdkRequestsSent, 1); assert.equal(result.nativeOutcome, 'unknown');
  assert.ok(fs.existsSync(path.join(directory, kind, 'start.json')));
  await controller.handle(message, 'owner'); assert.equal(sent, 1);
  await assert.rejects(controller.handle({ ...message, requestId: 'another-creation' }, 'owner'), { code: 'AUDIT_ALREADY_REQUESTED' });
});

for (const mode of ['passed', 'failed', 'source_drift', 'final_byte_tamper', 'bad_remote_outcome']) {
  test('real production audit check/fence: ' + mode, { timeout: 45000 }, async t => {
    const directory = fixtureDirectory(t, 'atomic-audit-check-');
    const source = path.join(directory, 'runtime/python/recovery/atomic_audit.py');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../runtime/python/recovery/atomic_audit.py'), source);
    if (mode === 'failed') fs.appendFileSync(source, '\n_bad_audit_type: int = "not an int"\n');
    const production = createProductionQueueAdmission(resolveRuntimePaths({ anchor: __filename }).runtime);
    const state = { data: { paused: true, blocked: { id: 'target' } } };
    const gate = new QueueGate(state, 'fixture-owner');
    const identity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32), sessionNonce: 'b'.repeat(32), backend: 'addin',
      runId: 'owned-run', requestHash: 'c'.repeat(64), resolvedIdentity: { name: 'owned', creationId: 'owned-id', fileId: null } };
    const initialState = structuredClone(state.data);
    let sent = 0, busy = false, complete;
    const ended = new Promise(resolve => { complete = resolve; });
    const controller = createRecoveryAudit({
      installation: directory, buildHash: buildHash(), jobDirectory: () => directory,
      assertOwner(_target, _prior, clientId) { if (clientId !== 'owner') throw Object.assign(new Error('foreign'), { code: 'NOT_OWNER' }); },
      async inspect() { return { identity, instance: { pid: 123, birth: 'fixture' }, binding: { purpose: 'atomic-recovery-audit-v1' } }; },
      fence(_value, inFlight) { assert.equal(gate.active.size, inFlight ? 1 : 0); assert.deepEqual(state.data, initialState); },
      begin() { assert.equal(busy, false); busy = true; }, end() { busy = false; complete(); },
      admit: send => gate.administrative(() => gate.run(send)),
      async check(payload, artifact) {
        const certificate = await production.admission.check(payload, artifact);
        assert.equal(certificate.report.status, 'passed');
        assert.equal(certificate.report.provenance.checker, 'basedpyright');
        if (mode === 'source_drift') fs.appendFileSync(source, '\n# drift\n');
        if (mode === 'final_byte_tamper') payload.params.arguments.code += '\n';
        return certificate;
      },
      async post(payload) {
        sent++;
        const value = summary(identity);
        if (mode === 'bad_remote_outcome') value.nativeOutcome = 'committed';
        return { result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(value) }] }, id: payload.id };
      },
      match: response => response, remoteReceipt: () => ({ outcome: 'succeeded' }),
      sendScript: (scope, script) => scope.post({ jsonrpc: '2.0', id: 'caller', method: 'tools/call',
        params: { name: 'execute_python', arguments: { code: script + '\n\nrun("")\n', persistent: false } } }),
    });
    const message = { action: 'audit-atomic', jobId: 'target', observationJobId: 'prior', requestId: 'one-audit', control: {} };
    await assert.rejects(controller.handle(message, 'foreign'), { code: 'NOT_OWNER' });
    assert.equal(sent, 0);
    const pending = await controller.handle(message, 'owner');
    assert.equal(pending.status, 'pending');
    await ended;
    const result = await controller.handle(message, 'owner');
    assert.equal(result.nativeOutcome, 'unknown');
    assert.equal(result.modelValidation, 'not_performed');
    assert.equal(result.rollbackVerification, 'not_performed');
    assert.equal(result.status, mode === 'passed' ? 'complete' : 'failed', JSON.stringify(result));
    assert.equal(sent, ['passed', 'bad_remote_outcome'].includes(mode) ? 1 : 0);
    if (mode === 'failed') { assert.equal(result.code, 'PYTHON_CHECK_REJECTED'); assert.equal(result.pythonCheck.status, 'failed'); }
    if (mode === 'source_drift') assert.equal(result.code, 'BUILD_CHANGED');
    if (mode === 'final_byte_tamper') assert.equal(result.code, 'AUDIT_BYTES_CHANGED');
    if (mode === 'bad_remote_outcome') assert.equal(result.code, 'AUDIT_OUTPUT_INVALID');
    assert.deepEqual(await controller.handle(message, 'owner'), result);
    await assert.rejects(controller.handle({ ...message, requestId: 'second-audit' }, 'owner'), { code: 'AUDIT_ALREADY_REQUESTED' });
    assert.deepEqual(state.data, initialState);
    assert.equal(busy, false);
    assert.equal(hash(JSON.stringify(initialState)), hash(JSON.stringify(state.data)));
  });
}
