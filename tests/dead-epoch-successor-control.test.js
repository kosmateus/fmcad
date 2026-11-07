'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../src/queue-instance');
const canonicalHash = value => require('../src/dist/core/application/cad/json').hash(value);
const { openIsolatedEpoch } = require('../src/queue-isolated-epoch');
const { createSuccessorControl } = require('../src/queue-epoch-successor-control');

function fixture(t, mode = 'success') {
  const base = fs.mkdtempSync('/tmp/opencode/successor-control-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = require('./fixtures/dead-epoch-successor.cjs')(base, path.resolve(__dirname, '..'), { inFlight: true });
  fs.rmSync(path.join(f.audit, 'isolated-scratch-qualification'), { recursive: true, force: true }); // Prospective synthetic proof only.
  const state = openIsolatedEpoch(f.dir, { recover: false });
  let sdk = 0, physicalActive = 0, busy = false, activations = 0;
  const identity = { ...f.authority.expectedProcess, version: 'fixture', activeCommand: 'SelectCommand' };
  const message = suffix => ({ jobId: f.pointer.quarantinedJobIds[0], observationJobId: f.pointer.quarantinedJobIds[1],
    requestId: f.requestId + suffix, control: { fixture: true } });
  const sendScript = scope => scope.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'execute_python', arguments: { code: scope.expectedCode, persistent: false },
  } }, 'synthetic-session');
  const control = createSuccessorControl({ dir: f.dir, state, configHash: api.brokerConfigHash(f.cfg),
    buildHash: f.authority.buildHash, clients: () => ({ [f.clientId]: api.hash(f.token) }), authority: f.authorityEntry,
    assertControl(value) { assert.deepEqual(value, { fixture: true }); },
    fenceRuntime(inFlight) { assert.equal(physicalActive, inFlight ? 1 : 0); },
    sendAuditScript: sendScript, sendScratchScript: sendScript,
    activate() { activations++; },
    ports: {
      installation: path.resolve(__dirname, '..'), buildHash: f.authority.buildHash,
      begin() { assert.equal(busy, false); busy = true; }, end() { busy = false; },
      admit: async send => { physicalActive++; try { return await send(); } finally { physicalActive--; } },
      check: async () => ({ report: { status: 'passed' }, fence() {} }), // FAKE checker; no production/live qualification claim.
      match: response => JSON.parse(response.raw),
      async post(payload) {
        sdk++;
        const creating = fs.existsSync(path.join(f.audit, 'isolated-scratch-qualification', 'start.json'));
        const dir = path.join(f.audit, creating ? 'isolated-scratch-qualification' : 'dead-epoch-current-observation');
        const prior = api.readJson(path.join(dir, 'intent.json')), start = api.readJson(path.join(dir, 'start.json'));
        if ((!creating && mode === 'lost-observation') || (creating && mode === 'lost-creation'))
          throw Object.assign(new Error('Synthetic transport uncertainty'), { code: 'SYNTHETIC_LOST_REPLY' });
        const summary = creating ? { version: 1, purpose: 'isolated-scratch-epoch-v1', epochId: prior.binding.epochId,
          bindingHash: canonicalHash(prior.binding), document: { name: 'FMCAD_ISOLATED_' + prior.binding.epochId,
            creationId: 'really-new-synthetic-sdk-id', fileId: null }, independent: true, empty: true, unsaved: true,
          activeCommand: 'SelectCommand', beforeIdsHash: 'c'.repeat(64), historicalOutcome: 'unknown',
          originalModelValidation: 'not_performed', originalRollbackVerification: 'not_performed',
          previousActiveCreationId: 'synthetic-user-active-document' }
          : { version: 1, purpose: 'atomic-recovery-audit-v1', profile: 'atomic-recovery-counts-v1', requestIdentity: f.auditIdentity,
            nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed',
            modulePresent: false, ui: { activeCommand: 'SelectCommand', idle: true }, commandDefinition: { status: 'absent' },
            document: { status: 'absent', matches: 0 }, snapshot: null, fingerprint: null };
        if (!creating && mode === 'unsafe-ui') summary.ui = { activeCommand: 'SketchLine', idle: false };
        if (!creating && mode === 'surviving-holder') summary.modulePresent = true;
        if (creating) api.durable(prior.binding.sdkProofPath, summary, true);
        api.durable(start.receipt, { ...start.binding, terminal: true, outcome: 'succeeded', instance: identity }, true);
        return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
          result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(summary) }] } }) };
      },
    },
  });
  return { ...f, state, control, message, sdk: () => sdk, busy: () => busy, activations: () => activations };
}

async function settled(f, method, message) {
  const deadline = Date.now() + 10000;
  let result = await f.control[method](message, f.clientId);
  while (result.status === 'pending' || f.busy()) {
    if (Date.now() > deadline) assert.fail('Synthetic successor operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
    result = await f.control[method](message, f.clientId);
  }
  return result;
}

test('FAKE ports: current facts precede exactly one new scratch, old work stays immutable and no grant is copied', async t => {
  const f = fixture(t);
  const oldState = fs.readFileSync(f.authority.predecessor.state.path);
  await assert.rejects(f.control.create(f.message(':create'), f.clientId), { code: 'EPOCH_AUDIT_REQUIRED' });
  assert.equal(f.sdk(), 0);
  const observed = await settled(f, 'observe', f.message(':observe'));
  assert.equal(observed.status, 'complete'); assert.equal(f.sdk(), 1);
  const start = api.readJson(path.join(f.audit, 'dead-epoch-current-observation/start.json'));
  assert.deepEqual(start.binding.auditExpectedProcess, f.authority.expectedProcess);
  const created = await settled(f, 'create', f.message(':create'));
  assert.equal(created.status, 'complete'); assert.equal(created.activation.admission, 'qualified-fresh-scratch-only');
  assert.equal(f.sdk(), 2); assert.ok(f.activations() >= 1);
  assert.notEqual(f.state.epoch.epochId, f.authority.predecessor.epochId);
  assert.notEqual(f.state.epoch.document.creationId, api.readJson(f.authority.predecessor.pointer.path).document.creationId);
  assert.deepEqual(fs.readFileSync(f.authority.predecessor.state.path), oldState);
  assert.equal(f.state.status(f.priorJob.id).quarantined, true);
  assert.equal(fs.readdirSync(f.state.epoch.root).filter(name => name.startsWith('access-')).length, 0);
  await f.control.create(f.message(':create'), f.clientId);
  assert.equal(f.sdk(), 2, 'Receipt reads never replay observation or creation');
});

for (const mode of ['lost-observation', 'lost-creation']) test('FAKE ports: ' + mode + ' retains intent/unknown and never retries SDK', async t => {
  const f = fixture(t, mode);
  const observed = await settled(f, 'observe', f.message(':observe'));
  let result = observed;
  if (mode === 'lost-creation') result = await settled(f, 'create', f.message(':create'));
  assert.equal(result.status, 'failed');
  assert.equal(result.sdkRequestsSent, 1);
  const count = f.sdk();
  await f.control[mode === 'lost-creation' ? 'create' : 'observe'](f.message(mode === 'lost-creation' ? ':create' : ':observe'), f.clientId);
  assert.equal(f.sdk(), count);
  assert.equal(f.state.epoch.epochId, f.authority.predecessor.epochId);
  if (mode === 'lost-observation') await assert.rejects(f.control.create(f.message(':create'), f.clientId), { code: 'EPOCH_AUDIT_REQUIRED' });
});

test('FAKE ports: foreign owner and a second request ID cannot obtain successor authority', async t => {
  const f = fixture(t);
  await assert.rejects(f.control.observe(f.message(':observe'), 'foreign'), { code: 'NOT_OWNER' });
  await assert.rejects(f.control.observe(f.message(':different'), f.clientId), { code: 'INVALID_REQUEST' });
  assert.equal(f.sdk(), 0);
});

for (const mode of ['unsafe-ui', 'surviving-holder']) test('FAKE ports: known ' + mode + ' observation cannot publish scratch authority', async t => {
  const f = fixture(t, mode);
  await assert.rejects(settled(f, 'observe', f.message(':observe')), { code: 'EPOCH_SUCCESSOR_FACTS_UNSAFE' });
  assert.equal(f.sdk(), 1);
  assert.equal(f.control.metadata().currentFactsAvailable, false);
  assert.equal(fs.existsSync(path.join(f.audit, 'observed-current.json')), false);
  await assert.rejects(f.control.create(f.message(':create'), f.clientId), { code: 'EPOCH_AUDIT_REQUIRED' });
  assert.equal(f.sdk(), 1);
});
