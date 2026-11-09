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

test('typed recovery reader preserves predecessor facts and refuses ambiguous result evidence', () => {
  const old = require('./fixtures/historical-module.cjs')(
    '5102259463ba490b942d4d94dc8db959bfcfbe0e', 'src/queue-atomic-recovery-audit.js');
  const identity = { resolvedIdentity: { name: 'owned', creationId: 'owned-id', fileId: null } };
  const value = summary(identity), line = 'FMCAD_RESULT ' + JSON.stringify(value);
  const reply = text => ({ result: { content: [{ type: 'text', text }] } });
  for (const text of [line, JSON.stringify({ stdout: line }), 'progress\r\n' + line + '\r\n'])
    assert.deepEqual(auditSummary(reply(text), identity), old.auditSummary(reply(text), identity));
  for (const tail of [line, 'FMCAD_RESULT {"nativeOutcome":"committed"}']) {
    const ambiguous = reply(line + '\n' + tail);
    assert.deepEqual(old.auditSummary(ambiguous, identity), value);
    assert.throws(() => auditSummary(ambiguous, identity), { code: 'AUDIT_OUTPUT_INVALID' });
  }
  const multiple = { result: { content: [{ type: 'text', text: line }, { type: 'text', text: line }] } };
  assert.deepEqual(old.auditSummary(multiple, identity), value);
  assert.throws(() => auditSummary(multiple, identity), { code: 'AUDIT_OUTPUT_INVALID' });
  for (const mutate of [
    s => { s.ui.idle = false; }, s => { s.commandDefinition.status = 'owned'; },
    s => { s.document.matches = -1; }, s => { s.snapshot.bodies = 0.5; },
    s => { s.snapshot = null; }, s => { s.requestIdentity = {}; },
    s => { s.ui.errorType = 'bad error'; }, s => { s.snapshot.isSaved = 'yes'; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    for (const api of [old, { auditSummary }]) assert.throws(
      () => api.auditSummary(reply('FMCAD_RESULT ' + JSON.stringify(changed)), identity),
      { code: 'AUDIT_OUTPUT_INVALID' });
  }
});

test('typed migration evidence adapter preserves immutable inventories, backups and refusals', t => {
  const old = require('./fixtures/historical-module.cjs')(
    '330849f22302bcf0ee955cd1945ddb2040eff8c7', 'src/queue-atomic-migration-files.js');
  const current = require('../src/queue-atomic-migration-files');
  const root = fixtureDirectory(t, 'migration-files-paired-');
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'first'), 'one');
  fs.writeFileSync(path.join(source, 'nested', 'second'), 'two');
  fs.writeFileSync(path.join(source, 'excluded'), 'not escrowed');
  const exclude = name => name === 'excluded';
  assert.deepEqual(current.inventory(source, exclude), old.inventory(source, exclude));
  for (const [index, api] of [old, current].entries()) {
    const destination = path.join(root, 'backup-' + index);
    const manifest = api.backupTree(source, destination, exclude);
    assert.deepEqual(manifest, current.inventory(source, exclude));
    assert.deepEqual(api.backupTree(source, destination, exclude), manifest);
    assert.equal(api.verifyTree(destination, manifest), undefined);
    fs.chmodSync(path.join(destination, 'first'), 0o600);
    fs.writeFileSync(path.join(destination, 'first'), 'tampered');
    assert.throws(() => api.verifyTree(destination, manifest), { code: 'BACKUP_MISMATCH' });
    assert.throws(() => api.backupTree(source, destination, exclude), { code: 'BACKUP_MISMATCH' });
    const link = path.join(root, 'link-' + index); fs.symlinkSync(source, link);
    assert.throws(() => api.directory(link), { code: 'UNSAFE_MIGRATION_PATH' });
    const fileLink = path.join(root, 'file-link-' + index); fs.symlinkSync(path.join(source, 'first'), fileLink);
    assert.throws(() => api.fileHash(fileLink), { code: 'UNSAFE_MIGRATION_FILE' });
    const receipt = path.join(root, 'receipt-' + index);
    assert.deepEqual(api.exclusive(receipt, { owner: 'one' }), { owner: 'one' });
    assert.deepEqual(api.exclusive(receipt, { owner: 'one' }), { owner: 'one' });
    assert.throws(() => api.exclusive(receipt, { owner: 'two' }), { code: 'MIGRATION_RECEIPT_CONFLICT' });
    assert.equal(fs.readFileSync(receipt, 'utf8'), '{"owner":"one"}');
  }
});
