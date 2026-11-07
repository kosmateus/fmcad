'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../src/queue-instance');
const { epochControlDirectory } = require('../src/queue-epoch-lineage');
const { createSavedFixtureControl } = require('../src/queue-saved-fixture-control');
const { closedEpochProof } = require('../src/queue-closed-epoch-proof');
const { reference } = require('../src/queue-saved-first-save-evidence');
const { savedAuditKind, savedAuditLegacyKind } = require('../src/queue-saved-audit-path');
const digest = value => require('../src/dist/core/application/cad/json').hash(value);

// FAKE transport/physical receipts only; source execution is tested separately in Python/checker tests.
function controlFixture(t, beforeSave = false) {
  const repo = path.resolve(__dirname, '..');
  const f = require(beforeSave ? './fixtures/saved-first-save.cjs' : './fixtures/saved-first-save-evidence.cjs')(t, repo);
  let directory, busy = false, failRetain = false;
  const sends = { probe: 0, observe: 0, retain: 0 };
  const root = epochControlDirectory(f.dir, f.state.epoch);
  const ports = { installation: repo, buildHash: f.identity.buildHash,
    begin() { assert.equal(busy, false); busy = true; }, end() { busy = false; },
    admit: action => action(), check: async () => ({ report: { status: 'passed' }, fence() {} }),
    match(response, payload) { assert.equal(response.id, payload.id); return response; },
    remoteReceipt: record => api.readJson(record.receipt),
    async post(payload) {
      const intent = api.readJson(path.join(directory, 'intent.json')), binding = intent.binding;
      const start = api.readJson(path.join(directory, 'start.json'));
      const common = { version: 1, purpose: binding.purpose, epochId: binding.epochId,
        document: binding.document, bindingHash: digest(binding) };
      let summary;
      if (binding.purpose === 'saved-fixture-destination-v1') {
        sends.probe++;
        const { record: _record, ...destination } = f.nativeDestination;
        summary = { ...common, destination, readOnly: true };
      } else if (binding.purpose === 'saved-first-save-publication-v1') {
        sends.observe++;
        summary = { ...common, observed: f.observed, readOnly: true };
      } else {
        sends.retain++;
        summary = { ...common, savedDocument: binding.savedDocument, closed: true, saved: true, retained: true,
          activeBeforeCloseCreationId: binding.document.creationId,
          restoredActiveCreationId: binding.restoreActiveCreationId, activeDocumentRestored: true };
      }
      api.durable(binding.sdkProofPath, summary, true);
      api.durable(start.receipt, { ...start.binding, terminal: true, outcome: 'succeeded', instance: f.state.epoch.currentInstance }, true);
      if (failRetain && binding.purpose === 'saved-fixture-retain-v1') throw new Error('FAKE lost retention reply');
      return { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'FMCAD_RESULT ' + JSON.stringify(summary) }] } };
    },
    sendScript(scope, script) { return scope.post({ jsonrpc: '2.0', id: 'fake-owner-call', method: 'tools/call',
      params: { name: 'execute_python', arguments: { code: script + '\n\nrun("")\n', persistent: false } } }); },
  };
  const control = createSavedFixtureControl({ dir: f.dir, state: f.state, clients: () => f.clients,
    assertControl: f.p.assertControl, snapshot: () => ({ state: digest(f.state.data) }), fence() {}, auditPorts: ports,
    closed(epoch) { if (!f.state.data.paused) f.state.pause(true, 'FAKE_RETAINED:' + epoch.epochId); } });
  async function act(phase, requestId, extra = {}) {
    const prefix = phase === 'probe' ? 'dp-' : phase === 'observe' ? 'sp-' : 'sr-';
    directory = path.join(root, savedAuditKind(prefix, requestId));
    const message = { action: phase === 'probe' ? 'probe-saved-destination' : phase === 'observe' ? 'observe-saved-first-save' : 'retain-saved-fixture',
      control: { fake: true }, epochId: f.state.epoch.epochId,
      jobId: phase === 'probe' ? f.readinessJob.id : f.job.id, requestId, ...extra };
    let result = await control[phase](message, f.clientId);
    if (result.status === 'pending') {
      for (let i = 0; i < 1000 && busy; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(busy, false, 'FAKE owner audit did not settle');
      result = await control[phase](message, f.clientId); // Original intent only; never submits another SDK turn.
    }
    return result;
  }
  return { ...f, control, act, sends, failRetain: () => { failRetain = true; } };
}

test('FAKE owner control records an actual native-ID read before first-save authority', async t => {
  const f = controlFixture(t, true);
  fs.unlinkSync(path.join(f.state.epoch.root, 'saved-destination-native.json')); // Only this synthetic test's generated record.
  const result = await f.act('probe', 'new-native-destination-read', { authorityFile: f.message.authorityFile, folderProofFile: f.message.folderProofFile });
  assert.equal(result.status, 'complete'); assert.equal(f.sends.probe, 1);
  assert.equal(result.destination.nativeProjectId, 'native-project'); assert.equal(result.grantIssued, false);
  assert.doesNotThrow(f.grant);
});

test('FAKE owner control separately observes publication, retains once and preserves a genuine closed proof', async t => {
  const f = controlFixture(t);
  const published = await f.act('observe', 'separate-publication-read');
  assert.equal(published.publication.status, 'complete'); assert.equal(published.sdkRequestsSent, 0);
  assert.equal(f.sends.observe, 1);
  const retained = await f.act('retain', 'one-retention');
  assert.equal(retained.status, 'complete'); assert.equal(f.sends.retain, 1);
  assert.equal(f.state.data.paused, true);
  const proof = closedEpochProof(f.dir, f.state.epoch, reference(path.join(f.state.epoch.root, 'closed.json')));
  assert.equal(proof.proof.saved, true); assert.equal(proof.proof.retained, true);
  await f.act('retain', 'one-retention');
  assert.equal(f.sends.retain, 1);
  await assert.rejects(f.act('retain', 'different-retention'), { code: 'SAVED_RETAIN_ALREADY_REQUESTED' });
});

test('FAKE uncertain retention never gets a second close under another request ID', async t => {
  const f = controlFixture(t);
  await f.act('observe', 'publication-before-uncertainty'); f.failRetain();
  const result = await f.act('retain', 'uncertain-retention');
  assert.equal(result.status, 'failed'); assert.equal(f.sends.retain, 1);
  await assert.rejects(f.act('retain', 'blind-retry'), { code: 'SAVED_RETAIN_ALREADY_REQUESTED' });
  assert.equal(f.sends.retain, 1);
  assert.equal(fs.existsSync(path.join(f.state.epoch.root, 'closed.json')), false);
});

test('FAKE legacy failed audit is read as original evidence, never reissued into the short layout', async t => {
  const f = controlFixture(t, true), epoch = f.state.epoch, requestId = 'old-long-directory-probe';
  const kind = savedAuditLegacyKind('dp-', requestId), dir = path.join(epochControlDirectory(f.dir, epoch), kind);
  fs.mkdirSync(dir, { recursive: true });
  const key = { jobId: f.readinessJob.id, requestId, clientId: f.clientId };
  api.durable(path.join(dir, 'intent.json'), { key, binding: { epochId: epoch.epochId,
    ownerTokenHash: epoch.ownerTokenHash, document: epoch.document } }, true);
  api.durable(path.join(dir, 'result.json'), { kind, ...key, status: 'failed', code: 'RECEIPT_UNAVAILABLE', sdkRequestsSent: 1 }, true);
  const result = await f.act('probe', requestId, { authorityFile: f.message.authorityFile, folderProofFile: f.message.folderProofFile });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'RECEIPT_UNAVAILABLE'); assert.equal(result.legacyRecord, true);
  assert.equal(f.sends.probe, 0);
});
