'use strict';

// Live integration tests for the default-atomic `batch run` transaction
// (contract §5 scenarios 1-5). Every test starts with `if (skipLive(t)) return;`
// so an unset FMCAD_TEST_DOC skips cleanly offline, and every hook guards
// clear() the same way so no command reaches Fusion without the coordinator's
// document.
//
// These tests exercise the ATOMIC default via `batch run` (no per-step legacy
// client). The aborted/rejected outcomes use the deterministic test-only fault
// injection (FMCAD_TEST_ATOMIC_FAULT, contract §8.4); see README.md in this
// directory and the "Atomic batch transactions" section of BACKENDS.md.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docName, fmcad, cad, resetDoc, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; resetDoc(); });
afterEach(function () { if (!hasDoc()) return; resetDoc(); });

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Read the full design snapshot (measure.snapshot / audit) for independent
// baseline→final comparison. Returns the `.result` snapshot payload.
function snapshot(doc) {
  const out = fmcad(['audit', '--doc', doc]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

// Compare two snapshots and assert that the only allowed difference is the
// document modified flag (Fusion does not guarantee isModified is restored;
// spec §7 explicitly excludes it from rollback proof).
function assertModelUnchanged(doc, baseline, label) {
  const after = snapshot(doc);
  assert.deepEqual(after.counts, baseline.counts, `${label}: counts must be identical`);
  const d = fmcad(['diff', '--doc', doc, '--data', JSON.stringify({ before: baseline, after })]).result;
  const real = (d.changes || []).filter((c) => !c.path.startsWith('/document/isModified'));
  assert.deepEqual(real, [], `${label}: only isModified may differ, got ${JSON.stringify(real)}`);
  return after;
}

// A default-success recipe: component + sketch + circle + extruded cylinder
// (r=10 mm, h=20 mm) chained through $ref dependencies.
function successSteps(componentName) {
  return [
    { id: 'comp', operation: 'component.create', data: { name: componentName } },
    { id: 'section', operation: 'sketch.create', data: { name: 'Section', plane: 'XY' } },
    { id: 'circle', operation: 'sketch.geometry', data: { sketch: { $ref: 'section.result.sketch' },
      geometry: [{ type: 'circle', name: 'rim', center: ['0 mm', '0 mm', '0 mm'], radius: '10 mm' }] } },
    { id: 'solid', operation: 'model.extrude', data: { name: 'Cylinder',
      profile: { kind: 'profile', sketch: { $ref: 'section.result.sketch' } },
      distance: '20 mm', operation: 'newBody' } },
  ];
}

const CYLINDER_VOLUME_MM3 = Math.PI * 100 * 20; // r=10 mm, h=20 mm

test('S1 default success (no atomic): committed with real geometry, one native transaction', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  const report = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'atomic-success', operations: successSteps('Atomic_Success') }),
    '--report-path', path.join(dir, 'run')]);
  assert.equal(report.success, true, JSON.stringify(report));
  assert.equal(report.operation, 'batch.run');
  assert.equal(report.outcome, 'committed');
  assert.equal(report.status, 'success');
  assert.equal(report.atomic.effective, true);
  assert.equal(report.documentIdentity.name, doc, 'documentIdentity.name must pin the exact open document');
  assert.equal(report.documentIdentity.assertionsOnly, true, 'identity is asserted by name only (no file pin)');
  assert.equal(report.terminationReason, 1); // CompletedTerminationReason
  assert.equal(report.rollbackVerified, false); // committed ⇒ rollback N/A, not "failed"
  assert.equal(report.steps.length, 4);
  assert.ok(report.steps.every((s) => s.status === 'success'), JSON.stringify(report.steps));

  // Real dimensions / structure / health via independent readback (not the
  // studied handler's own output). The cylinder body is r=10 mm, h=20 mm.
  const body = report.steps.find((s) => s.id === 'solid').output.result.bodies[0];
  assert.ok(body, 'extrude must report its result body');
  const volume = fmcad(['measure', 'volume', '--doc', doc, '--data', JSON.stringify({ ref: body, units: 'mm3' })]).result;
  assert.equal(volume.units, 'mm3');
  assert.ok(Math.abs(volume.value - CYLINDER_VOLUME_MM3) <= Math.max(0.5, CYLINDER_VOLUME_MM3 * 1e-5),
    `volume ${volume.value} != ${CYLINDER_VOLUME_MM3}`);
  const bounds = fmcad(['measure', 'bounds', '--doc', doc, '--data', JSON.stringify({ ref: body, units: 'mm' })]).result;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(bounds.size[i] - 20) <= 0.01, `bounds.size[${i}]=${bounds.size[i]}`);
  const health = fmcad(['history', 'check', '--doc', doc]).result;
  assert.equal(health.healthy, true, JSON.stringify(health));

  // Undo note: the fmcad CLI does not expose undo (the add-in marks undo/redo
  // unsupported), and this test must not fake it. The single-transaction
  // guarantee is evidenced by the committed report (one native command event
  // grouping every mutation) plus the model re-read above; the single-Undo UI
  // check is the validator's manual evidence step, recorded here as required.
  assert.notEqual(snapshot(doc).counts.bodyDefinitions, baseline.counts.bodyDefinitions, 'a body must be committed');
});

test('S2 error after mutation (no atomic): abort restores the exact baseline', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'after_mutation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'atomic-abort', operations: successSteps('Atomic_Abort') }),
    '--report-path', path.join(dir, 'run')]);
  assert.notEqual(result.code, 0, 'aborted batch must exit nonzero');
  const report = result.json;
  assert.ok(report, 'aborted batch must still emit the JSON report\n' + result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.status, 'failed');
  assert.equal(report.atomic.effective, true);
  // Setting executeFailed requests an abort; the kernel may still report
  // CompletedTerminationReason, but assets/cad/atomic.py records the effective
  // AbortedTerminationReason (3) so terminationReason matches the aborted outcome.
  assert.equal(report.terminationReason, 3); // AbortedTerminationReason (effective)
  assert.equal(report.rollbackVerified, true);
  assert.equal(report.rollback.measured, true);
  assert.equal(report.rollback.matched, true);
  assert.equal(report.errorStep, '__test_fault');
  assert.ok(report.error && /after-mutation/.test(report.error.message), JSON.stringify(report.error));
  // Every real step completed but was rolled back; none is durably applied.
  assert.ok(report.steps.every((s) => s.mutationStatus === 'rolled_back'), JSON.stringify(report.steps));
  assertModelUnchanged(doc, baseline, 'S2 default abort');
});

test('S2 explicit atomic:true behaves identically to the default', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'after_mutation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'atomic-abort-explicit', atomic: true, operations: successSteps('Atomic_AbortTrue') }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.atomic.requested, true);
  assert.equal(report.atomic.effective, true);
  assert.equal(report.rollbackVerified, true);
  assertModelUnchanged(doc, baseline, 'S2 explicit atomic:true abort');
});

test('S3 partial handler (before-ref-publish): abort leaves no orphan object', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'before_ref_publish';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  // The fault handler creates a real component ('__test_orphan') then raises
  // before its reference is published to the step results.
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'atomic-partial', operations: [
      { id: 'seed', operation: 'component.create', data: { name: 'Atomic_Seed' } },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.errorStep, '__test_fault');
  assert.ok(report.error && /before-ref-publish/.test(report.error.message), JSON.stringify(report.error));
  assert.equal(report.steps[0].mutationStatus, 'rolled_back');
  // No orphan: neither the seed nor the fault-created object survive.
  const after = assertModelUnchanged(doc, baseline, 'S3 partial handler');
  assert.equal(after.counts.componentDefinitions, baseline.counts.componentDefinitions);
});

test('S4 edit existing model (parameter + name) before error is restored', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  // Setup a committed baseline model: a component and a user parameter.
  const setup = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-setup', operations: [
      { id: 'comp', operation: 'component.create', data: { name: 'Edit_Target' } },
      { id: 'params', operation: 'param.apply', data: { parameters: [{ name: 'wall', expression: '2 mm', unit: 'mm' }] } },
    ] }),
    '--report-path', path.join(dir, 'setup')]);
  assert.equal(setup.outcome, 'committed', JSON.stringify(setup));
  const baseline = snapshot(doc);
  assert.ok(baseline.counts.parameters >= 1, 'wall parameter must be committed');

  // Edit the parameter, rename the component, then fail: everything reverts.
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'after_mutation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-abort', operations: [
      { id: 'params', operation: 'param.apply', data: { parameters: [{ name: 'wall', expression: '5 mm', unit: 'mm' }], overwrite: true } },
      { id: 'rename', operation: 'component.rename', data: { component: 'Edit_Target', name: 'Edit_Target_Renamed' } },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.rollbackVerified, true);

  // Independent readback: parameter expression and component name restored.
  assertModelUnchanged(doc, baseline, 'S4 edit rollback');
  const params = fmcad(['param', 'inspect', '--doc', doc]).result;
  const wall = params.parameters.find((p) => p.name === 'wall');
  assert.ok(wall, 'wall parameter must survive the rollback');
  assert.equal(wall.expression, '2 mm');
  const comps = fmcad(['entity', 'list', '--doc', doc, '--data', JSON.stringify({ kind: 'component' })]).result;
  assert.ok(comps.entities.some((e) => e.name === 'Edit_Target'), 'component name must be restored');
  assert.ok(!comps.entities.some((e) => e.name === 'Edit_Target_Renamed'), 'rename must be reverted');
});

test('S4 unsupported edit (external-effect) is rejected preflight before mutation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  // document.save_as is external-effect + batchAllowed:false; it must be
  // rejected before the first mutation, never silently executed or skipped.
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-reject', operations: [
      { id: 'seed', operation: 'component.create', data: { name: 'Reject_Seed' } },
      { id: 'save', operation: 'document.save_as', data: { name: 'Never', project: 'x', folder: '', confirm: true } },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  // document.save_as is batchAllowed:false (external-effect); it is rejected
  // before the first mutation with the same outcome:'rejected' shape as the
  // atomic preflight (export/checkpoint), never silently executed or skipped.
  assert.equal(report.outcome, 'rejected');
  assert.equal(report.mutated, false);
  assert.ok(report.errors && report.errors.some((e) => /external-effect|external effect|document.save_as|invoked separately/.test(e)), JSON.stringify(report.errors));
  assertModelUnchanged(doc, baseline, 'S4 preflight reject');
});

test('S5 final validation failure aborts the whole batch', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'final_validation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'atomic-final-check', operations: successSteps('Atomic_Check') }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.rollbackVerified, true);
  assert.equal(report.errorStep, '__test_fault');
  assert.ok(report.error && /final validation/.test(report.error.message), JSON.stringify(report.error));
  assert.ok(report.steps.every((s) => s.mutationStatus === 'rolled_back'), JSON.stringify(report.steps));
  assertModelUnchanged(doc, baseline, 'S5 final validation abort');
});

test('S4 transform edit (occurrence move) before error is restored', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  // Setup: a component occurrence, ungrounded so placement is permitted.
  const setup = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-transform-setup', operations: [
      { id: 'comp', operation: 'component.create', data: { name: 'Edit_Transform' } },
      { id: 'unground', operation: 'assembly.unground', data: { occurrence: { $ref: 'comp.result.occurrence' } } },
    ] }),
    '--report-path', path.join(dir, 'setup')]);
  assert.equal(setup.outcome, 'committed', JSON.stringify(setup));
  const occurrence = setup.steps.find((s) => s.id === 'comp').output.result.occurrence;
  assert.ok(occurrence, 'component.create must report its occurrence');
  const baseline = snapshot(doc);

  // Move the occurrence, then fail: the transform must be restored.
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'after_mutation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-transform-abort', operations: [
      { id: 'move', operation: 'occurrence.transform',
        data: { occurrence, placement: { translation: ['10 mm', '0 mm', '0 mm'] } } },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.rollbackVerified, true);
  assertModelUnchanged(doc, baseline, 'S4 transform rollback');
});

test('S4 material edit (assign) before error is restored', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  // Setup: a committed solid body whose material can be edited.
  const setup = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-material-setup', operations: [
      { id: 'section', operation: 'sketch.create', data: { name: 'MatSection', plane: 'XY' } },
      { id: 'circle', operation: 'sketch.geometry', data: { sketch: { $ref: 'section.result.sketch' },
        geometry: [{ type: 'circle', name: 'rim', center: ['0 mm', '0 mm', '0 mm'], radius: '5 mm' }] } },
      { id: 'solid', operation: 'model.extrude', data: { name: 'MatBody',
        profile: { kind: 'profile', sketch: { $ref: 'section.result.sketch' } },
        distance: '10 mm', operation: 'newBody' } },
    ] }),
    '--report-path', path.join(dir, 'setup')]);
  assert.equal(setup.outcome, 'committed', JSON.stringify(setup));
  const body = setup.steps.find((s) => s.id === 'solid').output.result.bodies[0];
  assert.ok(body, 'extrude must report its result body');
  const baseline = snapshot(doc);
  const beforeMat = fmcad(['material', 'inspect', '--doc', doc, '--data', JSON.stringify({ refs: [body] })]).result
    .affected[0].after.material;

  // Assign a different material, then fail: the assignment must be reverted.
  process.env.FMCAD_TEST_ATOMIC_FAULT = 'after_mutation';
  t.after(() => delete process.env.FMCAD_TEST_ATOMIC_FAULT);
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'edit-material-abort', operations: [
      { id: 'mat', operation: 'material.assign',
        data: { refs: [body], id: 'PrismMaterial-002', library: 'C1EEA57C-3F56-45FC-B8CB-A9EC46A9994C' } },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.outcome, 'aborted');
  assert.equal(report.rollbackVerified, true);
  assertModelUnchanged(doc, baseline, 'S4 material rollback');
  const afterMat = fmcad(['material', 'inspect', '--doc', doc, '--data', JSON.stringify({ refs: [body] })]).result
    .affected[0].after.material;
  assert.deepEqual(afterMat, beforeMat, 'body material must be restored after abort');
});
