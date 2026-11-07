'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { executeRegionalFixture } = require('./integrated-qualification/regional_typed');

function fixture(t, mode) {
  const outputDirectory = fs.mkdtempSync('/tmp/opencode/regional-typed-');
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const manifestPath = path.resolve(__dirname, '../../assets/native-qualification/regional-geometry.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath)), manifestSha256 = createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  const run = { id: 'synthetic-regional-run', clientId: 'registered-native', sourceCommit: 'f'.repeat(40), buildHash: 'a'.repeat(64),
    epochId: 'synthetic-epoch', document: { name: 'SYNTHETIC_SCRATCH', creationId: 'synthetic-owned-doc', fileId: null } };
  run.grant = { epochId: run.epochId, clientId: run.clientId, document: run.document,
    nativeFixture: { fixtureId: manifest.fixtureId, operations: manifest.operations, manifestSha256,
      buildHash: run.buildHash, sourceCommit: run.sourceCommit } };
  const requests = new Map(), jobs = new Map(), calls = [];
  const delayed = new Set();
  let bodies = 0, caseIndex = 0, lostAck = mode === 'lost-ack', uncertain = mode === 'needs-reconciliation';
  const services = { start: async () => {}, query: {
    status: async () => ({ version: 1, build: run.buildHash, sourceCommit: run.sourceCommit, clientId: run.clientId,
      blocked: false, active: false, isolatedScratch: { epochId: run.epochId, document: run.document, admission: 'qualified-fresh-scratch-only' } }),
    request: async requestId => requests.get(requestId) || null,
    result: async jobId => {
      const value = jobs.get(jobId);
      if (uncertain) { uncertain = false; return { ...value, state: 'needs_reconciliation', result: null, outcome: { executionOutcome: 'unknown' } }; }
      if (mode === 'late-negative-output' && value.state === 'failed' && !delayed.has(jobId)) {
        delayed.add(jobId); return { ...value, result: null };
      }
      return value;
    },
  }, async execute(invocation, options) {
    calls.push({ invocation, options });
    let result;
    if (invocation.operation === 'document.status') result = { creationId: run.document.creationId, saved: false, modified: bodies > 0 || mode === 'modified' };
    else if (invocation.operation === 'snapshot') result = { schema: 'fmcad.measure.snapshot.v1',
      counts: { bodyDefinitions: bodies, sketchDefinitions: bodies, featureDefinitions: bodies, timelineItems: bodies },
      timeline: Array.from({ length: bodies }, (_, i) => ({ name: 'synthetic-feature-' + i })), issues: [] };
    else if (invocation.operation.startsWith('shape.')) {
      bodies++;
      result = { healthState: 0, bodies: [{ kind: 'body', token: 'synthetic-token-' + bodies, name: invocation.data.name }] };
    } else if (invocation.operation === 'measure.volume') result = { value: 400, units: 'mm3' };
    else if (invocation.operation === 'geometry.compare-region') {
      const spec = manifest.cases[caseIndex++];
      const status = mode === 'unknown' && caseIndex === 1 ? 'unknown' : mode === 'wrong-case' && caseIndex === 1 ? 'fail' : spec.expected;
      const added = spec.name === 'excluded-mask-hole-negative' ? Math.PI * 0.2 ** 2 * 0.5
        : spec.name === 'equal-volume-outside-mask-negative' ? 0.2 : 1;
      const removed = spec.name === 'equal-volume-outside-mask-negative' ? 0.2 : 0;
      const protectedFailure = status === 'fail' && spec.protected;
      const value = volume => ({ volume, empty: volume === 0, bounds: null });
      const outsideAdded = status === 'fail' && !protectedFailure && !removed ? added : 0;
      const outsideRemoved = status === 'fail' && removed ? removed : 0;
      result = { schemaVersion: 1, operation: invocation.operation,
        documentIdentity: { name: run.document.name, fileId: null, version: null, isModified: true }, frame: invocation.data.frame,
        units: { length: 'cm', volume: 'cm^3' }, mutation: { documentModifiedByOperation: false, temporaryCopiesOnly: true },
        status, passed: status === 'unknown' ? null : status === 'pass', success: status === 'pass',
        precision: status === 'unknown' ? 'unknown' : 'pass', coverage: status === 'unknown' ? 'unknown' : 'pass',
        ...(status === 'unknown' ? { reason: 'synthetic-unavailable' } : {}),
        provenance: [{ entityToken: 'synthetic-native-token', revisionId: 'synthetic-revision', ownership: 'read-only source; private temporary BRep copy' }],
        delta: {
          added: { total: value(added), insideAllowed: value(added - outsideAdded), outsideAllowed: value(outsideAdded), insideProtected: value(protectedFailure ? added : 0) },
          removed: { total: value(removed), insideAllowed: value(removed - outsideRemoved), outsideAllowed: value(outsideRemoved), insideProtected: value(0) },
        },
        controls: { outsideAllowedUnchanged: !outsideAdded && !outsideRemoved, protectedUnchanged: !protectedFailure } };
      if (status === 'unknown') Object.assign(result, { delta: null, controls: null, provenance: [] });
      if (mode === 'missing-negative-evidence' && spec.expected === 'fail') result.delta = null;
      if (mode === 'foreign-identity') result.documentIdentity.creationId = 'foreign-document';
    } else assert.fail('Unexpected operation: ' + invocation.operation);
    const envelope = { success: true, operation: invocation.operation, document: run.document.name, result };
    const failed = require('../../src/dist/core/application/cad/worker-command').cadCommandFailed(envelope, invocation.operation);
    if (failed) envelope.success = false;
    const state = failed ? 'failed' : 'succeeded';
    const receipt = { version: 1, requestId: options.requestId, jobId: 'synthetic-job-' + calls.length, state,
      outcome: { executionOutcome: state, code: failed ? mode === 'unrelated-pipeline-failure' ? 'SDK_EXECUTION_FAILED' : 'LOCAL_EXECUTION_FAILED' : 'EXECUTION_COMPLETE' },
      pythonChecks: [{ status: 'passed', provenance: { checker: 'FAKE' } }],
      result: envelope };
    const accepted = { ...receipt, state: 'preparing', result: null, pythonChecks: [], outcome: { executionOutcome: 'not_started' } };
    jobs.set(receipt.jobId, receipt); requests.set(options.requestId, accepted);
    if (lostAck) { lostAck = false; throw new Error('Synthetic lost acknowledgement'); }
    return accepted;
  } };
  return { run, services, manifestPath, outputDirectory, calls, execute: () => executeRegionalFixture({ services, run, manifestPath, outputDirectory }) };
}

test('FAKE public API: typed regional runner preserves seven positive/negative cases and never creates/closes documents', async t => {
  const f = fixture(t), result = await f.execute();
  assert.equal(result.status, 'PASS'); assert.equal(result.nativeCasesStatus, 'pass');
  assert.equal(result.cases.length, 7);
  assert.equal(result.temporaryCopyCountsTimelineAndStatusUnchanged, true);
  assert.equal(result.receipts.filter(row => row.state === 'failed').length, 4,
    'Expected negative diagnostics keep their actual failed worker receipts');
  assert.equal(f.calls.filter(row => row.invocation.operation.startsWith('shape.')).length, 7);
  assert.ok(f.calls.filter(row => row.invocation.operation === 'geometry.compare-region')
    .every(row => row.invocation.data.frame.space === 'assembly'), 'Native root bodies use the retained assembly frame contract');
  const count = f.calls.length;
  assert.deepEqual(await f.execute(), result);
  assert.equal(f.calls.length, count, 'Completed phases are receipt reads only');
  assert.equal(f.calls.some(row => ['run', 'document.new', 'document.close'].includes(row.invocation.operation)), false);
});

test('FAKE public API: a lost ACK recovers the same owned request without another execute', async t => {
  const f = fixture(t, 'lost-ack');
  await assert.rejects(f.execute(), /Synthetic lost acknowledgement/);
  assert.equal((await f.execute()).status, 'PASS');
  assert.equal(f.calls.filter(row => row.options.requestId.endsWith(':fresh-status')).length, 1);
});

test('FAKE public API: a modified scratch is refused before any fixture mutation', async t => {
  const f = fixture(t, 'modified');
  await assert.rejects(f.execute(), /genuinely fresh/);
  assert.equal(f.calls.some(row => row.invocation.operation.startsWith('shape.')), false);
});

for (const [mode, expected] of [['wrong-case', 'FAIL'], ['unknown', 'UNKNOWN']])
test('FAKE public API: regional ' + mode + ' is not fabricated as native PASS', async t => {
  const f = fixture(t, mode);
  assert.equal((await f.execute()).status, expected);
});

test('FAKE public API: a generic failure without measured regional evidence is never accepted as an expected negative', async t => {
  const f = fixture(t, 'missing-negative-evidence');
  await assert.rejects(f.execute(), /consistent native finite volumes/);
});

test('FAKE public API: an SDK/pipeline failure is not accepted even when it carries an otherwise valid negative report', async t => {
  const f = fixture(t, 'unrelated-pipeline-failure');
  await assert.rejects(f.execute(), /unrelated failure/);
});

test('FAKE public API: the published regional identity may omit creationId, but a conflicting supplied ID is refused', async t => {
  const f = fixture(t, 'foreign-identity');
  await assert.rejects(f.execute(), /exact owned-document/);
});

test('FAKE public API: corrected assembly observations keep the earlier wrong-frame unknown receipt unchanged', async t => {
  const f = fixture(t), file = path.join(f.outputDirectory, f.run.id + '-case-inside-mask-positive-result.json');
  const original = JSON.stringify({ requestId: f.run.id + ':case-inside-mask-positive', jobId: 'earlier-synthetic-job',
    state: 'failed', result: { result: { status: 'unknown', reason: 'kernel-or-input-failure' } } });
  fs.writeFileSync(file, original, { flag: 'wx', mode: 0o600 });
  const report = await f.execute();
  assert.equal(report.status, 'PASS');
  assert.equal(report.priorReadOnlyObservations.length, 1);
  assert.equal(report.priorReadOnlyObservations[0].nativeStatus, 'unknown');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(f.calls.filter(row => row.invocation.operation === 'geometry.compare-region').length, 7);
  assert.ok(f.calls.filter(row => row.invocation.operation === 'geometry.compare-region')
    .every(row => row.options.requestId.includes(':case-assembly-')));
});

test('FAKE public API: terminal negative output may publish late without another execute or a cached incomplete failure', async t => {
  const f = fixture(t, 'late-negative-output');
  assert.equal((await f.execute()).status, 'PASS');
  assert.equal(f.calls.filter(row => row.invocation.operation === 'geometry.compare-region').length, 7);
});

test('FAKE public API: after external owner reconciliation, the original uncertain request is observed rather than replayed', async t => {
  const f = fixture(t, 'needs-reconciliation');
  await assert.rejects(f.execute(), /requires reconciliation/);
  const proof = path.join(f.outputDirectory, f.run.id + '-fresh-status-uncertain.json');
  assert.equal(JSON.parse(fs.readFileSync(proof)).state, 'needs_reconciliation');
  assert.equal((await f.execute()).status, 'PASS');
  assert.equal(f.calls.filter(row => row.options.requestId.endsWith(':fresh-status')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(proof)).state, 'needs_reconciliation', 'Original uncertainty proof is retained unchanged');
});
