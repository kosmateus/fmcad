'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const terminal = state => ['succeeded', 'failed', 'cancelled', 'expired', 'needs_reconciliation'].includes(state);
const fail = message => { throw new Error(message); };
function publish(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function settledValues(promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}
function regionalDiagnostic(result, document) {
  if (result.schemaVersion !== 1 || result.operation !== 'geometry.compare-region' ||
      result.documentIdentity?.name !== document.name || result.documentIdentity.fileId !== null || result.documentIdentity.version !== null ||
      (result.documentIdentity.creationId !== undefined && result.documentIdentity.creationId !== document.creationId) ||
      typeof result.documentIdentity.isModified !== 'boolean' ||
      !same(result.frame, { space: 'assembly', component: { kind: 'component', name: 'root' } }) ||
      result.units?.volume !== 'cm^3' || result.mutation?.documentModifiedByOperation !== false ||
      result.mutation.temporaryCopiesOnly !== true || !['pass', 'fail', 'unknown'].includes(result.status))
    fail('Regional output is not exact owned-document finite-solid diagnostic evidence');
  if (result.status === 'unknown') {
    if (result.passed !== null || result.success !== false || result.precision !== 'unknown' || result.coverage !== 'unknown' ||
        typeof result.reason !== 'string' || !result.reason) fail('Unknown regional evidence is inconsistent');
    return;
  }
  if (result.precision !== 'pass' || result.coverage !== 'pass' || result.success !== result.passed ||
      result.passed !== (result.status === 'pass') || !result.provenance?.length ||
      result.provenance.some(row => !row.entityToken || !row.revisionId || row.ownership !== 'read-only source; private temporary BRep copy'))
    fail('Regional pass/fail lacks complete native precision, coverage or source provenance');
  for (const side of ['added', 'removed']) {
    const delta = result.delta?.[side];
    for (const part of ['total', 'insideAllowed', 'outsideAllowed', 'insideProtected']) {
      const value = delta?.[part];
      if (!value || !Number.isFinite(value.volume) || value.volume < 0 || typeof value.empty !== 'boolean' ||
          value.empty !== (value.volume === 0)) fail('Regional diagnostic lacks consistent native finite volumes');
    }
    const tolerance = Math.max(1e-10, delta.total.volume * 1e-8);
    if (Math.abs(delta.total.volume - delta.insideAllowed.volume - delta.outsideAllowed.volume) > tolerance ||
        delta.insideProtected.volume > delta.total.volume + tolerance) fail('Native regional volume partition is inconsistent');
  }
  const outside = ['added', 'removed'].every(side => result.delta[side].outsideAllowed.empty);
  const protectedUnchanged = ['added', 'removed'].every(side => result.delta[side].insideProtected.empty);
  if (result.controls?.outsideAllowedUnchanged !== outside || result.controls.protectedUnchanged !== protectedUnchanged ||
      result.passed !== (outside && protectedUnchanged)) fail('Native control verdict contradicts its measured volumes');
}

// Public FmcadServices only. No SDK, run/raw Python, document creation/closing,
// owner administration, implicit retries, or adoption of a non-fresh document.
async function executeRegionalFixture({ services, run, manifestPath, outputDirectory }) {
  if (!run || !/^[A-Za-z0-9_-]{6,80}$/.test(run.id || '') || !/^[a-f0-9]{40}$/.test(run.sourceCommit || '') ||
      !/^[a-f0-9]{64}$/.test(run.buildHash || '') || !run.document?.creationId || run.document.fileId !== null ||
      !path.isAbsolute(outputDirectory) || !path.isAbsolute(manifestPath) ||
      fs.realpathSync(outputDirectory) !== outputDirectory || fs.realpathSync(manifestPath) !== manifestPath)
    fail('Exact stable run, qualified build, owned unsaved document and canonical private evidence paths required');
  const manifest = read(manifestPath), manifestSha256 = sha(fs.readFileSync(manifestPath));
  const grant = run.grant;
  if (!grant || grant.epochId !== run.epochId || grant.clientId !== run.clientId || !same(grant.document, run.document) ||
      grant.nativeFixture?.fixtureId !== 'regional-geometry-v1' || grant.nativeFixture.manifestSha256 !== manifestSha256 ||
      grant.nativeFixture.buildHash !== run.buildHash || grant.nativeFixture.sourceCommit !== run.sourceCommit ||
      manifest.version !== 1 || manifest.fixtureId !== grant.nativeFixture.fixtureId ||
      !same(manifest.operations, grant.nativeFixture.operations) || manifest.fixtures.length !== 7 || manifest.cases.length !== 7)
    fail('The exact owner-issued typed fixture grant and installed manifest must agree');
  for (const row of [...manifest.fixtures, ...manifest.cases])
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(row.label || row.name || '')) fail('Unsafe fixture phase label');
  await services.start();
  const status = await services.query.status();
  if (status.build !== run.buildHash || status.sourceCommit !== run.sourceCommit || status.clientId !== run.clientId ||
      status.blocked || status.active || status.isolatedScratch?.epochId !== run.epochId ||
      !same(status.isolatedScratch.document, run.document) || status.isolatedScratch.admission !== 'qualified-fresh-scratch-only')
    fail('Public broker status does not prove this exact idle granted fixture scope');
  const receipts = [];
  async function phase(label, operation, data) {
    const requestId = run.id + ':' + label, base = path.join(outputDirectory, requestId.replace(':', '-'));
    const invocation = { version: 1, kind: 'cad', operation, data, doc: run.document.name, docId: run.document.creationId,
      purpose: run.id + ' — regional fixture: ' + label };
    const intent = { requestId, invocation, epochId: run.epochId, buildHash: run.buildHash, manifestSha256 };
    let receipt;
    if (fs.existsSync(base + '-intent.json')) {
      if (!same(read(base + '-intent.json'), intent)) fail('Existing phase intent differs; never reuse its request ID');
      if (fs.existsSync(base + '-result.json')) receipt = read(base + '-result.json');
      else {
        receipt = await services.query.request(requestId);
        if (!receipt?.jobId) fail('Existing send intent has no observed acceptance; retain it, never resubmit');
      }
    } else {
      publish(base + '-intent.json', intent);
      receipt = await services.execute(invocation, { requestId }); // Exactly one submit, including after a lost ACK.
      publish(base + '-accepted.json', receipt);
    }
    if (!receipt?.jobId || receipt.requestId !== requestId) fail('Owned acceptance receipt missing or mismatched');
    const jobId = receipt.jobId, deadline = Date.now() + 900000;
    if (!fs.existsSync(base + '-result.json')) {
      let outputDeadline = Infinity;
      const typedOutputRequired = state => state === 'succeeded' || (operation === 'geometry.compare-region' && state === 'failed');
      const knownRefusal = () => receipt.pythonChecks?.some(check => check.status !== 'passed');
      while (Date.now() < Math.min(deadline, outputDeadline)) {
        receipt = await services.query.result(jobId);
        if (receipt.requestId !== requestId || receipt.jobId !== jobId) fail('Same-job observation identity changed');
        if (terminal(receipt.state)) {
          if (!typedOutputRequired(receipt.state) || receipt.result != null ||
              knownRefusal()) break;
          if (!Number.isFinite(outputDeadline)) outputDeadline = Date.now() + 30000;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!terminal(receipt.state) || (typedOutputRequired(receipt.state) && receipt.result == null && !knownRefusal()))
        fail('Owned job did not settle with published output; never resubmit');
      if (receipt.state === 'needs_reconciliation') {
        if (!fs.existsSync(base + '-uncertain.json')) publish(base + '-uncertain.json', receipt);
        fail('The original owned job requires reconciliation; retain its evidence, never resubmit');
      }
      publish(base + '-result.json', receipt);
    }
    if (!receipt.pythonChecks?.length || receipt.pythonChecks.some(check => check.status !== 'passed') ||
        !receipt.result || receipt.result.operation !== operation ||
        receipt.result.document !== run.document.name || !receipt.result.result)
      fail('Native operation lacks terminal success, production checker evidence or exact operation/document output: ' + label);
    if (operation === 'geometry.compare-region') regionalDiagnostic(receipt.result.result, run.document);
    const expectedState = operation === 'geometry.compare-region' && receipt.result.result.status !== 'pass' ? 'failed' : 'succeeded';
    if (receipt.state !== expectedState || receipt.outcome?.executionOutcome !== expectedState ||
        receipt.result.success !== (expectedState === 'succeeded') ||
        (expectedState === 'failed' && receipt.outcome.code !== 'LOCAL_EXECUTION_FAILED'))
      fail('Worker/operation outcome differs from the validated diagnostic; never turn an unrelated failure into expected-negative PASS');
    receipts.push({ phase: label, operation, requestId, jobId, state: receipt.state, executionOutcome: receipt.outcome.executionOutcome,
      path: base + '-result.json', sha256: sha(fs.readFileSync(base + '-result.json')) });
    return receipt.result.result;
  }
  const initial = await phase('fresh-status', 'document.status', {});
  const initialSnapshot = await phase('fresh-snapshot', 'snapshot', {});
  if (initial.creationId !== run.document.creationId || initial.saved !== false || initial.modified !== false ||
      initialSnapshot.counts?.bodyDefinitions !== 0 || initialSnapshot.counts.sketchDefinitions !== 0 ||
      initialSnapshot.counts.featureDefinitions !== 0 || initialSnapshot.counts.timelineItems !== 0)
    fail('Fixture requires a genuinely fresh unsaved unmodified empty scratch; never substitute the smoke model');
  const prefix = 'NQ' + sha(run.id).slice(0, 12).toUpperCase();
  const bodies = Object.fromEntries(await settledValues(manifest.fixtures.map(async fixture => {
    const result = await phase('create-' + fixture.label, fixture.operation, { ...fixture.data, name: prefix + '_' + fixture.label });
    if (result.bodies?.length !== 1 || result.bodies[0].kind !== 'body' || !result.bodies[0].token ||
        (fixture.operation === 'shape.box' ? result.healthState !== 0 : result.healthState !== undefined && result.healthState !== 0))
      fail('Native fixture did not return exactly one healthy body: ' + fixture.label);
    return [fixture.label, result.bodies[0]];
  })));
  const equalVolumes = await settledValues(['EqualBefore', 'EqualAfter'].map(label => phase('volume-' + label,
    'measure.volume', { ref: bodies[label], units: 'mm3' })));
  if (equalVolumes.some(value => value.units !== 'mm3' || !Number.isFinite(value.value) || Math.abs(value.value - 400) > 0.01))
    fail('Equal-volume negative fixture did not establish two native 400 mm3 bodies');
  const before = await phase('before-measurement', 'snapshot', {});
  const beforeStatus = await phase('before-status', 'document.status', {});
  if (before.counts?.bodyDefinitions !== 7 || before.issues?.length) fail('Native fixture body count or feature health differs');
  const region = spec => Object.fromEntries(Object.entries(spec).map(([key, labels]) => [key, labels.map(label => {
    if (!bodies[label]) fail('Fixture references an uncreated native body'); return bodies[label];
  })]));
  const cases = await settledValues(manifest.cases.map(async spec => {
    const result = await phase('case-assembly-' + spec.name, 'geometry.compare-region', { before: bodies[spec.before], after: bodies[spec.after],
      frame: { space: 'assembly', component: { kind: 'component', name: 'root' } }, allowed: region(spec.allowed),
      ...(spec.protected ? { protected: region(spec.protected) } : {}) });
    const expectedAdded = spec.name === 'excluded-mask-hole-negative' ? Math.PI * 0.2 ** 2 * 0.5
      : spec.name === 'equal-volume-outside-mask-negative' ? 0.2 : 1;
    const expectedRemoved = spec.name === 'equal-volume-outside-mask-negative' ? 0.2 : 0;
    const volumesMatch = result.status !== 'unknown' && Math.abs(result.delta.added.total.volume - expectedAdded) < 1e-6 &&
      Math.abs(result.delta.removed.total.volume - expectedRemoved) < 1e-6;
    return { name: spec.name, expected: spec.expected, expectedVolumesCm3: { added: expectedAdded, removed: expectedRemoved },
      result, passed: result.status === spec.expected && volumesMatch };
  }));
  const after = await phase('after-measurement', 'snapshot', {}), afterStatus = await phase('after-status', 'document.status', {});
  const unchanged = same(before.counts, after.counts) && same(before.timeline, after.timeline) &&
    beforeStatus.creationId === afterStatus.creationId && beforeStatus.modified === afterStatus.modified && beforeStatus.saved === afterStatus.saved;
  const failed = !unchanged || cases.some(row => !row.passed && row.result.status !== 'unknown');
  const unknown = cases.some(row => row.result.status === 'unknown');
  const statusValue = failed ? 'FAIL' : unknown ? 'UNKNOWN' : 'PASS';
  const priorReadOnlyObservations = manifest.cases.flatMap(spec => {
    const file = path.join(outputDirectory, run.id + '-case-' + spec.name + '-result.json');
    if (!fs.existsSync(file)) return [];
    const prior = read(file);
    return [{ case: spec.name, requestId: prior.requestId, jobId: prior.jobId, state: prior.state,
      nativeStatus: prior.result?.result?.status, reason: prior.result?.result?.reason,
      path: file, sha256: sha(fs.readFileSync(file)), correction: 'New read-only request uses the documented root assembly frame; original receipt is unchanged.' }];
  });
  const report = { version: 1, featureId: 'regional-geometry', status: statusValue, nativeCasesStatus: statusValue.toLowerCase(),
    sourceCommit: run.sourceCommit, buildHash: run.buildHash, epochId: run.epochId, document: run.document, manifestSha256,
    ...(run.driverCommit ? { driverCommit: run.driverCommit, driverSha256: run.driverSha256 } : {}),
    ...(run.driverCorrection ? { driverCorrection: run.driverCorrection } : {}),
    cases, equalVolumes, priorReadOnlyObservations, temporaryCopyCountsTimelineAndStatusUnchanged: unchanged,
    receipts: receipts.sort((a, b) => a.phase.localeCompare(b.phase)),
    cleanup: 'not_performed_by_fixture', restore: 'not_performed_by_fixture',
    limitations: ['Native kernel/model qualification only, not manufacturing or real-world physical validation.',
      'Snapshot counts, timeline and saved/modified flags are unchanged; this is not a full topology equivalence claim.'] };
  const reportFile = path.join(outputDirectory, run.id + '-report.json');
  if (fs.existsSync(reportFile)) { if (!same(read(reportFile), report)) fail('Existing report changed'); }
  else publish(reportFile, report);
  return report;
}

module.exports = { executeRegionalFixture };
