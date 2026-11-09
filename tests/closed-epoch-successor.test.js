'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const api = require('../src/queue-instance');
const { reference, successionAuthority } = require('../src/queue-epoch-lineage');

function fixture(t) {
  // Only spell Windows receipt paths for these synthetic physical ports.
  t.after(require('./fixtures/fake-wsl-platform.cjs')());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-successor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return require('./fixtures/closed-epoch-successor.cjs')(root, path.resolve(__dirname, '..'));
}

test('FAKE metadata: known closed scratch may authorize a new one on the same live process, with no grants or SDK', t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.epoch.root, 'queue-state.json'));
  const result = f.authorize();
  assert.equal(result.sdkRequestsSent, 0);
  assert.equal(result.kind, 'closed-epoch-successor-authorized');
  const checked = successionAuthority(f.dir, result.authority);
  assert.equal(checked.authority.previousProcessTerminated, false);
  assert.equal(checked.authority.previousBrokerTerminated, false);
  assert.deepEqual(checked.pointer, f.epoch);
  assert.deepEqual(f.authorize(), result, 'A stable authority receipt is idempotent metadata');
  assert.deepEqual(fs.readFileSync(path.join(f.epoch.root, 'queue-state.json')), before);
  assert.equal(fs.existsSync(path.join(f.audit, 'isolated-scratch-qualification', 'start.json')), false);
});

for (const [name, change] of [
  ['missing cleanup', f => { fs.unlinkSync(path.join(f.epoch.root, 'closed.json')); }],
  ['changed cleanup hash', f => { f.approval.closedProofHash = 'a'.repeat(64); }],
  ['wrong source build', f => { f.approval.buildHash = 'b'.repeat(64); }],
  ['unknown local work', f => { f.state.data.localUnknown = {}; }],
  ['live sequence', f => { f.state.data.lease = {}; }],
  ['unqualified runtime', f => { const q = api.readJson(f.qfile); delete q.closedEpochSuccessorQualified; api.durable(f.qfile, q); f.approval.qualification = reference(f.qfile); }],
]) test('FAKE metadata: closed-scratch successor refuses ' + name, t => {
  const f = fixture(t); change(f); api.durable(f.approvalFile, f.approval);
  assert.throws(f.authorize);
  assert.equal(fs.existsSync(f.authorityEntry.path), false);
});

test('FAKE metadata: a modeling grantee cannot authorize scratch rollover', t => {
  const f = fixture(t);
  assert.throws(() => f.authorize('grantee'), { code: 'NOT_OWNER' });
});

test('FAKE metadata: publication-only recovery restores the same authority without issuing another one', t => {
  const f = fixture(t), original = f.authorize();
  fs.unlinkSync(path.join(f.dir, 'active-epoch-succession.json')); // Simulated interruption of our synthetic last publication.
  assert.deepEqual(f.authorize(), original);
  assert.deepEqual(api.readJson(path.join(f.dir, 'active-epoch-succession.json')).authority, original.authority);
});

test('FAKE metadata: an unconsumed different authority cannot be bypassed with a new request ID', t => {
  const f = fixture(t);
  f.authorize();
  api.durable(f.approvalFile, { ...f.approval, requestId: 'different-request' });
  assert.throws(f.authorize, { code: 'EPOCH_SUCCESSOR_PENDING' });
});

test('FAKE physical ports: known cleanup permits one observed fresh scratch on the same Fusion, never adoption or grant copying', async t => {
  const f = fixture(t), authority = f.authorize();
  const before = fs.readFileSync(path.join(f.epoch.root, 'queue-state.json'));
  let sdk = 0, busy = false, physicalActive = 0;
  const instance = { ...f.epoch.currentInstance, activeCommand: 'SelectCommand' };
  const digest = value => require('../src/dist/core/application/cad/json').hash(value);
  const send = scope => scope.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'execute_python', arguments: { code: scope.expectedCode, persistent: false } } }, 'synthetic-session');
  const control = require('../src/queue-epoch-successor-control').createSuccessorControl({ ...f.p,
    configHash: api.brokerConfigHash(f.cfg), authority: authority.authority,
    sendAuditScript: send, sendScratchScript: send,
    fenceRuntime(inFlight) { assert.equal(physicalActive, inFlight ? 1 : 0); },
    activate() {},
    ports: { installation: path.resolve(__dirname, '..'), buildHash: f.p.buildHash,
      begin() { assert.equal(busy, false); busy = true; }, end() { busy = false; },
      admit: async operation => { physicalActive++; try { return await operation(); } finally { physicalActive--; } },
      check: async () => ({ report: { status: 'passed' }, fence() {} }), // FAKE checker, not installed qualification.
      match: response => JSON.parse(response.raw),
      async post(payload) {
        sdk++;
        const creating = fs.existsSync(path.join(f.audit, 'isolated-scratch-qualification', 'start.json'));
        const dir = path.join(f.audit, creating ? 'isolated-scratch-qualification' : 'closed-epoch-current-observation');
        const prior = api.readJson(path.join(dir, 'intent.json')), start = api.readJson(path.join(dir, 'start.json'));
        const summary = creating ? { version: 1, purpose: 'isolated-scratch-epoch-v1', epochId: prior.binding.epochId,
          bindingHash: digest(prior.binding), document: { name: 'FMCAD_ISOLATED_' + prior.binding.epochId,
            creationId: 'synthetic-next-owned-document', fileId: null }, independent: true, empty: true, unsaved: true,
          activeCommand: 'SelectCommand', beforeIdsHash: 'a'.repeat(64), historicalOutcome: 'unknown',
          originalModelValidation: 'not_performed', originalRollbackVerification: 'not_performed', previousActiveCreationId: 'user-active-document' }
          : { version: 1, purpose: 'atomic-recovery-audit-v1', profile: 'atomic-recovery-counts-v1', requestIdentity: f.auditIdentity,
            nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed',
            modulePresent: false, ui: { activeCommand: 'SelectCommand', idle: true }, commandDefinition: { status: 'absent' },
            document: { status: 'absent', matches: 0 }, snapshot: null, fingerprint: null };
        if (creating) api.durable(prior.binding.sdkProofPath, summary, true);
        api.durable(start.receipt, { ...start.binding, terminal: true, outcome: 'succeeded', instance }, true);
        return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
          result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(summary) }] } }) };
      },
    },
  });
  const message = suffix => ({ jobId: f.epoch.quarantinedJobIds[0], observationJobId: f.epoch.quarantinedJobIds[1],
    requestId: f.requestId + suffix, control: { synthetic: true } });
  async function complete(method, suffix) {
    let result = await control[method](message(suffix), f.epoch.ownerClientId);
    const deadline = Date.now() + 10000;
    while (result.status === 'pending' || busy) {
      if (Date.now() > deadline) assert.fail('Synthetic fixed operation did not settle');
      await new Promise(resolve => setTimeout(resolve, 5));
      result = await control[method](message(suffix), f.epoch.ownerClientId);
    }
    return result;
  }
  await assert.rejects(control.create(message(':create'), f.epoch.ownerClientId), { code: 'EPOCH_AUDIT_REQUIRED' });
  assert.equal((await complete('observe', ':observe')).status, 'complete');
  assert.equal((await complete('create', ':create')).status, 'complete');
  assert.equal(sdk, 2);
  assert.notEqual(f.state.epoch.epochId, f.epoch.epochId);
  assert.equal(api.sameInstance(f.state.epoch.currentInstance, f.epoch.currentInstance), true);
  assert.equal(f.state.epoch.currentInstance.activeCommand, 'SelectCommand');
  assert.deepEqual(fs.readFileSync(path.join(f.epoch.root, 'queue-state.json')), before);
  assert.equal(fs.readdirSync(f.state.epoch.root).filter(name => name.startsWith('access-')).length, 0);
  await complete('observe', ':observe'); await complete('create', ':create');
  assert.equal(sdk, 2, 'Only original receipts may be read after completion');
});
