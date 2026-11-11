'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { assemble } = require('../scripts/assemble-native-evidence.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp/opencode', 'native-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const values = {}, references = {};
  function write(name, value) {
    const file = path.join(dir, name + '.json'), bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes); values[name] = value;
    return references[name] = { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  const document = { name: 'OWNED', creationId: 'doc-owned', fileId: null };
  const sourceCommit = 'a'.repeat(40), buildHash = 'b'.repeat(64);
  write('raw', { expectedNativeNegative: 'fail', missingReading: 'unknown', coverage: 'partial' });
  write('proof', { version: 1, status: 'independently-verified-native-containment-pass', sourceCommit, buildHash,
    epochId: 'owned-epoch', document, jobId: 'native-job', evidence: [references.raw], cleanup: 'not_performed',
    limitations: ['Synthetic test, not Fusion qualification.'] });
  write('qualification', { passed: true, sourceCommit, buildHash, liveSdkRequestsSent: 0 });
  write('receipt', { status: 'complete', summary: { purpose: 'isolated-scratch-close-v1', document,
    closed: true, saved: false, activeDocumentRestored: true, restoredActiveCreationId: 'restore-owned' } });
  write('closed', { epochId: 'owned-epoch', document, receipt: references.receipt });
  write('cleanup', { epochId: 'owned-epoch', document, closed: true, saved: false, activeDocumentRestored: true,
    restoredActiveCreationId: 'restore-owned', receipt: references.receipt, closedEpochProof: references.closed });
  const index = { schemaVersion: 1, evidenceRoots: [dir], entries: [{ featureId: 'containment',
    sourceCommit, buildHash, proof: references.proof, cleanup: references.cleanup, qualification: references.qualification }] };
  return { dir, index, values, write };
}

test('offline importer retains original version/negative/unknown and does not fabricate current qualification', t => {
  const f = fixture(t), report = assemble(f.index), row = report.features.find(row => row.id === 'containment');
  assert.equal(row.status, 'ACCEPTED_AT_RECORDED_VERSION');
  assert.equal(row.sourceCommit, f.index.entries[0].sourceCommit);
  assert.equal(row.recordedEvidence.cleanup, 'not_performed');
  assert.equal(row.verifiedCleanup.closed, true);
  assert.equal(report.currentCandidateQualified, false); assert.equal(report.nativeQualified, false);
  assert.equal(report.liveSdkRequestsSent, 0);
  assert.equal(report.features.find(row => row.id === 'brep-baselines').status, 'NOT_IMPORTED');
  assert.equal(report.verifiedFiles.length, 6);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'raw.json'))),
    { expectedNativeNegative: 'fail', missingReading: 'unknown', coverage: 'partial' });
});

for (const [name, mutate] of [
  ['changed nested evidence hash', f => fs.appendFileSync(path.join(f.dir, 'raw.json'), ' ')],
  ['different source', f => { f.index.entries[0].sourceCommit = 'c'.repeat(40); }],
  ['different build', f => { f.index.entries[0].buildHash = 'c'.repeat(64); }],
  ['different epoch', f => { f.index.entries[0].cleanup = f.write('bad-cleanup', { ...f.values.cleanup, epochId: 'foreign' }); }],
  ['different document', f => { f.index.entries[0].cleanup = f.write('bad-cleanup', { ...f.values.cleanup,
    document: { ...f.values.cleanup.document, creationId: 'foreign' } }); }],
  ['unproven restore', f => { f.index.entries[0].cleanup = f.write('bad-cleanup', { ...f.values.cleanup, activeDocumentRestored: false }); }],
  ['unknown proof status', f => { f.index.entries[0].proof = f.write('bad-proof', { ...f.values.proof, status: 'some-pass' }); }],
  ['duplicate feature', f => { f.index.entries.push(f.index.entries[0]); }],
  ['outside configured root', f => { const allowed = path.join(f.dir, 'allowed'); fs.mkdirSync(allowed); f.index.evidenceRoots = [allowed]; }],
  ['symbolic link reference', f => { const link = path.join(f.dir, 'linked.json'); fs.symlinkSync(f.index.entries[0].proof.path, link);
    f.index.entries[0].proof = { ...f.index.entries[0].proof, path: link }; }],
]) test('offline importer rejects ' + name, t => {
  const f = fixture(t); mutate(f); assert.throws(() => assemble(f.index));
});

test('diagnostic and parent grid proof remain nonqualification/partial', t => {
  const f = fixture(t), entry = f.index.entries[0];
  entry.featureId = 'drive-precision';
  entry.proof = f.write('diagnostic', { ...f.values.proof,
    status: 'independently-verified-native-coordinate-diagnosis', arbitraryAnglePrecisionQualified: false });
  let report = assemble(f.index);
  assert.equal(report.diagnostics[0].status, 'DIAGNOSTIC_ONLY');
  entry.featureId = 'native-drive-test';
  entry.proof = f.write('grid', { ...f.values.proof,
    status: 'independently-verified-native-degree-grid-coupling-pass', arbitraryAnglePrecisionQualified: false });
  report = assemble(f.index);
  assert.equal(report.features.find(row => row.id === entry.featureId).status, 'PARTIAL_GRID_ONLY');
});

test('CLI never overwrites existing proof or report files', t => {
  const f = fixture(t), index = path.join(f.dir, 'index.json'), output = f.index.entries[0].proof.path;
  fs.writeFileSync(index, JSON.stringify(f.index));
  const before = fs.readFileSync(output);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/assemble-native-evidence.cjs'),
    '--index', index, '--out', output], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(output), before);
});
