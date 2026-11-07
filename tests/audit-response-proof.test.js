'use strict';
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, {
  skip: !process.env.FMCAD_TEST_LEGACY_843_RUNTIME && 'Requires exact qualified legacy 843 runtime; set FMCAD_TEST_LEGACY_843_RUNTIME',
}, fn);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { auditResponseProof, auditResponseProofStillCurrent } = require('../src/queue-audit-response-proof');
const { durable } = require('../src/queue-instance');
const { fileHash } = require('../src/queue-atomic-migration-files');
function fixture(t) {
  const dir = fs.mkdtempSync('/tmp/opencode/audit-response-proof-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scope = { jobId: 'target', observationJobId: 'observer' };
  const f = require('./fixtures/audit-response.cjs')(dir, scope, { commandId: 'fmcad_atomic_fixture',
    resolvedIdentity: { name: 'Historical fixture', creationId: 'old', fileId: null } },
  { pid: 20, birth: 'selected', version: '2706' }, { pid: 10, birth: 'historical', version: '2706' }, { nonce: 'departing-843' });
  return { ...f, dir, scope, read: () => auditResponseProof(f.files, dir, scope) };
}
test('successful source/process-bound execution never invents missing dynamic facts or epoch eligibility', t => {
  const f = fixture(t), proof = f.read();
  assert.equal(proof.executionProof.exactGuardBeforeBodyVerified, true);
  assert.equal(proof.responseContract.callerId, 2);
  assert.match(proof.responseContract.wireId, /^fmcad:/);
  assert.deepEqual(proof.facts.summary, null); assert.equal(proof.facts.available, false);
  assert.equal(proof.epochEligible, false); assert.equal(proof.originalStatus.endpointVerified, false);
  assert.equal(proof.historicalOutcome, 'unknown');
  assert.equal(auditResponseProofStillCurrent(proof), true);
  durable(f.files.auditResult.path, { forged: true }); assert.equal(auditResponseProofStillCurrent(proof), false);
});
for (const [name, record, mutate] of [
  ['forged current instance', 'auditRemote', x => { x.instance.birth = 'foreign'; }],
  ['wrong source hash', 'auditRemote', x => { x.sourceHash = 'other'; }],
  ['nonterminal receipt', 'auditRemote', x => { x.terminal = false; }],
  ['failed Python body', 'auditRemote', x => { x.outcome = 'failed'; }],
  ['different original caller', 'auditStart', x => { x.binding.requestHash = 'other'; }],
  ['stripped endpoint guard', 'auditStart', x => { delete x.binding.auditExpectedInstance; }],
  ['changed checked wire', 'auditWire', x => { x.outgoing.params.arguments.code += '\n# drift'; }],
  ['wrong wire identity', 'auditWire', x => { x.outgoing.id = 'foreign'; }],
  ['forged summary', 'auditResult', x => { x.summary = { ready: true }; }],
  ['fabricated endpoint verification', 'auditResult', x => { x.endpointVerified = true; }],
  ['wrong owner', 'auditIntent', x => { x.key.clientId = 'foreign'; }],
  ['checker not passed', 'auditStart', x => { x.pythonCheck.status = 'incomplete'; }],
]) test('even rehashed original evidence rejects ' + name, t => {
  const f = fixture(t), p = f.files[record].path, value = JSON.parse(fs.readFileSync(p));
  mutate(value); durable(p, value); f.files[record].sha256 = fileHash(p).sha256;
  assert.throws(f.read);
});
