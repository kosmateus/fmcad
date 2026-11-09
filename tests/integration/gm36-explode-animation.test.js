'use strict';

// Shared owned-backend extraction: tests/scenarios/gm36-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-36 (explode and animation sequencing). These
// drive the real fmcad CLI against the coordinator-provided document
// (FMCAD_TEST_DOC) and assert the deterministic pose/frame contracts from
// FMCAD_GENERIC_METHODS_SPEC.md §4 GM-36 and docs/EXPLODE_ANIMATION.md.
// Explosion poses are deterministic interpolations of real occurrence
// transforms; a native storyboard action is never claimed and a film is never
// faked without a declared encoder.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'fmcad.js');

// Run the CLI and return exit code plus parsed JSON without throwing, for
// outcomes the spec expects to exit nonzero (blocked export).
function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json', '--timeout', '60000'], {
    cwd: ROOT, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  let out = null;
  try { out = JSON.parse(result.stdout); } catch (_) { /* non-JSON error output */ }
  return { code: result.status, out, raw: result.stdout, err: result.stderr };
}

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

// Create two root child components and return their occurrence refs.
function twoOccurrences(doc, a, b) {
  const cover = fmcad(['component', 'create', '--doc', doc, '--data', JSON.stringify({ name: a })]);
  const pcb = fmcad(['component', 'create', '--doc', doc, '--data', JSON.stringify({ name: b })]);
  assert.equal(cover.success, true, JSON.stringify(cover));
  assert.equal(pcb.success, true, JSON.stringify(pcb));
  return { cover: cover.result.occurrence, pcb: pcb.result.occurrence };
}

test('G36-01: explode.plan yields a deterministic cock/release/return schedule over instances', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const { cover, pcb } = twoOccurrences(doc, 'Cover', 'Pcb');

  const out = fmcad(['explode', 'plan', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    occurrences: [
      { ref: cover, axis: [0, 0, 1], distance: '30 mm', phase: 'release', label: 'cover' },
      { ref: pcb, axis: [0, 0, 1], distance: '15 mm', phase: 'return', label: 'pcb' },
    ],
    phases: ['cock', 'release', 'return'],
    disconnections: [{ name: 'clip', from: cover, to: pcb }],
    duration: '2 s',
    fps: 30,
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.frameCount, 61, JSON.stringify(out));
  assert.equal(out.result.fps, 30, JSON.stringify(out));
  assert.deepEqual(out.result.phaseSchedule.map((p) => p.name), ['cock', 'release', 'return'], JSON.stringify(out));
  assert.deepEqual(out.result.order.map((o) => o.label), ['cover', 'pcb'], JSON.stringify(out));
  assert.deepEqual(out.result.blockers, [], JSON.stringify(out));
  assert.deepEqual(out.result.cycles, [], JSON.stringify(out));
  assert.equal(out.result.poses.length, out.result.frameCount, JSON.stringify(out));
  assert.equal(out.result.trails.length, 2, JSON.stringify(out));
  assert.equal(out.result.balloons.length, 2, JSON.stringify(out));
  // Honesty gates: an exploded assembly is not a service-path proof, and no
  // native storyboard action sequence is authored.
  assert.equal(out.result.explodeIsNotServicePath, true, JSON.stringify(out));
  assert.equal(out.result.nativeStoryboardActionsCreated, false, JSON.stringify(out));
});

test('G36-02: explode.render moves and restores occurrence transforms with trails/balloons', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const { cover } = twoOccurrences(doc, 'Cover', 'Pcb');

  const out = fmcad(['explode', 'render', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    occurrences: [{ ref: cover, axis: [0, 0, 1], distance: '30 mm', phase: 'release', label: 'cover' }],
    phases: ['cock', 'release', 'return'],
    duration: '1 s',
    fps: 10,
    confirm: true,
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.frameCount, 11, JSON.stringify(out));
  assert.equal(out.result.restored, true, JSON.stringify(out));
  assert.deepEqual(out.result.restoreErrors, [], JSON.stringify(out));
  assert.equal(out.result.restoreRequested, true, JSON.stringify(out));
  assert.equal(out.result.trails.length, 1, JSON.stringify(out));
  assert.equal(out.result.balloons.length, 1, JSON.stringify(out));
});

test('G36-03: animation.sequence plans camera/visibility/section tracks into a manifest', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const out = fmcad(['animation', 'sequence', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    tracks: [
      { type: 'camera', phase: 'intro', from: { eye: ['0 cm', '0 cm', '30 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] }, to: { eye: ['10 cm', '0 cm', '30 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] } },
      { type: 'visibility', phase: 'reveal', ref: 'Sketch1', visible: false },
      { type: 'section', phase: 'reveal', name: 'MidSection', isLightBulbOn: true },
    ],
    phases: ['intro', 'reveal'],
    duration: '2 s',
    fps: 30,
    easing: 'easeInOut',
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.frameCount, 61, JSON.stringify(out));
  assert.equal(out.result.frames.length, 61, JSON.stringify(out));
  assert.equal(out.result.trackCount, 3, JSON.stringify(out));
  assert.equal(out.result.easing, 'easeInOut', JSON.stringify(out));
  assert.deepEqual(out.result.phaseSchedule.map((p) => p.name), ['intro', 'reveal'], JSON.stringify(out));
  assert.equal(out.result.nativeStoryboardActionsCreated, false, JSON.stringify(out));
  // Camera is interpolated; the visibility/section steps apply at their phase start.
  assert.ok(out.result.frames[0].camera, JSON.stringify(out.result.frames[0]));
  assert.ok(out.result.frames.at(-1).sections.MidSection === true, JSON.stringify(out.result.frames.at(-1)));
});

test('G36-04: animation.sequence samples a joint track without authoring native actions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const out = fmcad(['animation', 'sequence', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    tracks: [
      { type: 'joint', ref: { name: 'pan' }, rotation: { from: '0 deg', to: '90 deg' } },
      { type: 'camera', ref: { name: 'cam' }, from: { eye: ['0 cm', '0 cm', '30 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] }, to: { eye: ['0 cm', '0 cm', '20 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] } },
    ],
    phases: ['sweep'],
    duration: '1 s',
    fps: 10,
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.frameCount, 11, JSON.stringify(out));
  assert.equal(out.result.nativeStoryboardActionsCreated, false, JSON.stringify(out));
  // The joint track is interpolated frame by frame; the first and last values
  // differ (0 -> 90 deg).
  assert.ok(out.result.frames[0].joints.pan, JSON.stringify(out.result.frames[0]));
  assert.ok(out.result.frames.at(-1).joints.pan.rotation > out.result.frames[0].joints.pan.rotation, JSON.stringify(out.result.frames.at(-1)));
});

test('G36-05: animation.capabilities reports no native action/video authoring', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const out = fmcad(['animation', 'capabilities', '--doc', doc, '--data', '{}']);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.actionCreation, false, JSON.stringify(out.result));
  assert.equal(out.result.videoPublish, false, JSON.stringify(out.result));
  assert.equal(out.result.collectionAccess, 'notChecked', JSON.stringify(out.result));
  assert.equal(out.result.count, null, JSON.stringify(out.result));
});

test('G36-06: animation.export without a declared encoder is blocked, not a fake film', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-anim-'));
  const frames = [0, 1].map((i) => path.join(dir, `frame-${i}.png`));
  for (const frame of frames) fs.writeFileSync(frame, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const output = path.join(dir, 'film.mp4');

  const result = cli(['animation', 'export', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    frames,
    output,
    confirm: true,
  })]);

  assert.notEqual(result.code, 0, 'blocked export must exit nonzero');
  assert.ok(result.out, 'expected a JSON envelope: ' + result.err);
  assert.equal(result.out.status, 'blocked', JSON.stringify(result.out));
  assert.equal(result.out.result.fileWritten, false, JSON.stringify(result.out.result));
  assert.equal(result.out.result.playable, false, JSON.stringify(result.out.result));
  assert.equal(result.out.result.film, null, JSON.stringify(result.out.result));
});

test('G36-07: explode.plan timing and easing are deterministic (frameCount and phase slices)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const { cover } = twoOccurrences(doc, 'Cover', 'Pcb');

  const plan = (easing) => fmcad(['explode', 'plan', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    occurrences: [{ ref: cover, axis: [0, 0, 1], distance: '30 mm', phase: 'release', label: 'cover' }],
    phases: ['cock', 'release', 'return'],
    duration: '2 s',
    fps: 30,
    easing,
  })]);

  const linear = plan('linear');
  const smooth = plan('smoothstep');
  assert.equal(linear.result.frameCount, 61, JSON.stringify(linear));
  assert.equal(linear.result.frameCount, Math.floor(2 * 30) + 1, JSON.stringify(linear));
  assert.equal(linear.result.durationSeconds, 2, JSON.stringify(linear));
  // Phase windows slice the duration into equal spans.
  for (const phase of linear.result.phaseSchedule) {
    assert.ok(phase.endTime > phase.startTime, JSON.stringify(phase));
  }
  // The final pose reaches axis * distance regardless of easing law.
  const lastLinear = linear.result.poses.at(-1).occurrences[0].origin[2];
  const lastSmooth = smooth.result.poses.at(-1).occurrences[0].origin[2];
  assert.ok(Math.abs(lastLinear - 3.0) < 1e-6, JSON.stringify(lastLinear));
  assert.ok(Math.abs(lastSmooth - 3.0) < 1e-6, JSON.stringify(lastSmooth));
  // Mid-window interpolation differs between easing laws (deterministic, not identical).
  assert.notEqual(linear.result.poses[35].occurrences[0].origin[2], smooth.result.poses[35].occurrences[0].origin[2]);
});

test('G36-08: explode.render restore:false leaves the final exploded pose', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const { cover } = twoOccurrences(doc, 'Cover', 'Pcb');

  const out = fmcad(['explode', 'render', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    occurrences: [{ ref: cover, axis: [0, 0, 1], distance: '30 mm', phase: 'release', label: 'cover' }],
    phases: ['cock', 'release', 'return'],
    duration: '1 s',
    fps: 10,
    confirm: true,
    restore: false,
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.restoreRequested, false, JSON.stringify(out));
  assert.equal(out.result.restored, null, JSON.stringify(out));
});
