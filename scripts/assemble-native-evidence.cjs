'use strict';
// Offline envelope/integrity review, not re-execution of native validators.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const manifest = require('../tests/native/integrated-qualification/manifest.json');

const contracts = {
  'regional-geometry': ['regional-native-kernel-qualification-pass', 'ACCEPTED_AT_RECORDED_VERSION'],
  containment: ['independently-verified-native-containment-pass', 'ACCEPTED_AT_RECORDED_VERSION'],
  'section-witnesses': ['independently-verified-native-sections-witness-pass', 'ACCEPTED_AT_RECORDED_VERSION'],
  'sketch-geometry-proof': ['native-sketch-proof-with-corrected-seam-pass', 'ACCEPTED_AT_RECORDED_VERSION'],
  'measured-fasteners': ['independently-verified-native-measured-fasteners-pass', 'ACCEPTED_AT_RECORDED_VERSION'],
  'motion-link': ['independently-verified-native-degree-grid-coupling-pass', 'ACCEPTED_GRID_ONLY'],
  'native-drive-test': ['independently-verified-native-degree-grid-coupling-pass', 'PARTIAL_GRID_ONLY'],
  'drive-precision': ['independently-verified-native-coordinate-diagnosis', 'DIAGNOSTIC_ONLY'],
};
const referenceFields = ['receipt', 'closedEpochProof', 'nativeProof', 'diagnosticProof', 'originalRunProof',
  'originalFixedRun', 'correctedReadbackProof', 'result'];

function assemble(index) {
  assert.equal(index.schemaVersion, 1, 'Unsupported evidence index');
  assert.ok(Array.isArray(index.evidenceRoots) && index.evidenceRoots.length, 'Explicit evidence roots required');
  const roots = index.evidenceRoots.map(root => {
    assert.ok(path.isAbsolute(root) && fs.realpathSync(root) === path.resolve(root), 'Real absolute evidence root required');
    return path.resolve(root);
  });
  const verified = new Map();
  function readReference(reference) {
    assert.ok(reference && typeof reference.path === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256), 'Hashed reference required');
    const file = path.resolve(reference.path);
    assert.ok(path.isAbsolute(reference.path) && roots.some(root => file.startsWith(root + path.sep)), 'Reference outside evidence roots');
    assert.ok(fs.lstatSync(file).isFile() && fs.realpathSync(file) === file, 'Regular evidence file without symlinks required');
    const bytes = fs.readFileSync(file);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), reference.sha256, 'Evidence hash mismatch: ' + file);
    if (verified.has(file)) return verified.get(file);
    const value = file.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : null;
    verified.set(file, value);
    // Follow only known evidence-envelope fields, not arbitrary paths in SDK data.
    if (value && typeof value === 'object') {
      for (const key of referenceFields) if (value[key]?.path && value[key]?.sha256) readReference(value[key]);
      for (const key of ['evidence', 'qualificationEvidence']) {
        if (Array.isArray(value[key])) for (const child of value[key]) {
          if (child?.path && child?.sha256) readReference(child);
        }
      }
    }
    return value;
  }
  assert.ok(Array.isArray(index.entries), 'Evidence entries required');
  const imported = new Map();
  for (const entry of index.entries) {
    const contract = contracts[entry.featureId];
    assert.ok(contract && !imported.has(entry.featureId), 'Unknown or duplicate feature');
    const proof = readReference(entry.proof), cleanup = readReference(entry.cleanup), qualification = readReference(entry.qualification);
    assert.equal(proof.version, 1); assert.equal(proof.status, contract[0], 'Unsupported native proof status');
    assert.ok(/^[a-f0-9]{40}$/.test(entry.sourceCommit) && /^[a-f0-9]{64}$/.test(entry.buildHash), 'Exact recorded source/build required');
    assert.equal(proof.sourceCommit, entry.sourceCommit, 'Proof source mismatch');
    assert.equal(proof.buildHash, entry.buildHash, 'Proof build mismatch');
    assert.equal(qualification.passed, true); assert.equal(qualification.sourceCommit, entry.sourceCommit, 'Qualification source mismatch');
    assert.equal(qualification.buildHash, entry.buildHash, 'Qualification build mismatch');
    assert.equal(qualification.liveSdkRequestsSent, 0, 'Installed qualification must remain offline');
    assert.ok(proof.epochId && proof.document?.creationId && proof.document?.name, 'Exact epoch/document required');
    assert.equal(proof.document.fileId, null, 'Only recorded unsaved-scratch envelopes supported');
    assert.equal(cleanup.epochId, proof.epochId, 'Cleanup epoch mismatch');
    assert.deepEqual(cleanup.document, proof.document, 'Cleanup document mismatch');
    assert.equal(cleanup.closed, true); assert.equal(cleanup.saved, false); assert.equal(cleanup.activeDocumentRestored, true);
    assert.ok(cleanup.restoredActiveCreationId, 'Exact restored active identity required');
    const closed = readReference(cleanup.closedEpochProof), receipt = readReference(cleanup.receipt);
    assert.equal(closed.epochId, proof.epochId); assert.deepEqual(closed.document, proof.document);
    assert.deepEqual(closed.receipt, cleanup.receipt, 'Closed proof receipt mismatch');
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.summary?.purpose, 'isolated-scratch-close-v1');
    assert.deepEqual(receipt.summary.document, proof.document);
    assert.equal(receipt.summary.closed, true); assert.equal(receipt.summary.saved, false);
    assert.equal(receipt.summary.activeDocumentRestored, true);
    assert.equal(receipt.summary.restoredActiveCreationId, cleanup.restoredActiveCreationId);
    assert.ok(Array.isArray(proof.evidence) && proof.evidence.length, 'Independent evidence references required');
    for (const evidence of proof.evidence) readReference(evidence);
    if (entry.featureId === 'drive-precision' || entry.featureId === 'motion-link' || entry.featureId === 'native-drive-test')
      assert.equal(proof.arbitraryAnglePrecisionQualified, false, 'Do not promote precision diagnosis/grid to arbitrary-angle PASS');
    imported.set(entry.featureId, { id: entry.featureId, status: contract[1], sourceCommit: proof.sourceCommit,
      buildHash: proof.buildHash, epochId: proof.epochId, document: proof.document, jobId: proof.jobId ?? null,
      proof: entry.proof, cleanup: entry.cleanup, qualification: entry.qualification,
      recordedEvidence: proof, verifiedCleanup: { closed: true, saved: false, activeDocumentRestored: true,
        restoredActiveCreationId: cleanup.restoredActiveCreationId, receipt: cleanup.receipt },
      currentCandidateQualified: false, physicalValidationPerformed: false });
  }
  const features = manifest.features.map(feature => imported.get(feature.id) || { id: feature.id, status: 'NOT_IMPORTED' });
  const diagnostics = [...imported.values()].filter(entry => !manifest.features.some(feature => feature.id === entry.id));
  return { schemaVersion: 1, kind: 'distributed-native-evidence-review', assembledAt: new Date().toISOString(),
    nativeQualified: false, currentCandidateQualified: false, liveSdkRequestsSent: 0,
    features, diagnostics, verifiedFiles: [...verified.keys()],
    limitations: ['Integrity/identity review of explicit independent attestations; geometric/native validators were not rerun.',
      'Each feature retains its original source/build. No single integrated run, sequenceId, or current-candidate PASS is fabricated.',
      'Original failure/unknown observations and sampled/partial limits remain in recordedEvidence and referenced artifacts.',
      'NOT_IMPORTED means no supported evidence envelope was supplied, not proof that a feature was never tested.',
      'Grid coupling excludes arbitrary-angle precision; the parent Drive restore-failure live case remains unqualified.'] };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 4 && args[0] === '--index' && args[2] === '--out', 'Usage: --index <explicit-index.json> --out <new-report.json>');
    const report = assemble(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    fs.writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report: args[3], imported: report.features.filter(row => row.status !== 'NOT_IMPORTED').length,
      diagnostics: report.diagnostics.length, verifiedFiles: report.verifiedFiles.length, currentCandidateQualified: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { assemble };
