'use strict';

// GM14 (cam) live integration tests. Each test invokes the real fmcad CLI
// against the coordinator-provided cloud document and asserts the SPEC's
// expected result. With FMCAD_TEST_DOC unset every test and hook skips cleanly.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () {
  if (!hasDoc()) return;
  clear();
});
afterEach(function () {
  if (!hasDoc()) return;
  clear();
});

const HALF_COSINE = {
  schemaVersion: 1,
  frame: 'component',
  baseRadius: '15 mm',
  rollerRadius: '5 mm',
  rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' },
  followerLine: [0, 1, 0],
  phase: '0 deg',
  direction: 'ccw',
};

test('G14-01: cam.profile reproduces source pressure angle and curvature', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['cam', 'profile', '--doc', docName(), '--data', JSON.stringify(HALF_COSINE)]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  // Source computation: max pressure angle ~10.9596 deg, min pitch curvature ~18.3267 mm.
  assert.ok(Math.abs(out.result.maxPressureAngle.value - 10.95961788503868) < 1e-4,
    JSON.stringify(out.result.maxPressureAngle));
  assert.ok(Math.abs(out.result.minPitchCurvatureRadius.value - 18.326658996398017) < 1e-4,
    JSON.stringify(out.result.minPitchCurvatureRadius));
  assert.equal(out.result.maxPressureAngle.units, 'deg');
  assert.equal(out.result.minPitchCurvatureRadius.units, 'mm');
});

test('G14-02: pitch→working profile is a normal (not radial) R5 offset with follower phase', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['cam', 'profile', '--doc', docName(), '--data', JSON.stringify(HALF_COSINE)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.normalOffset.value, 5);
  assert.deepEqual(out.result.followerLine, [0, 1, 0]);
  const pitch = out.result.pitchProfile;
  const working = out.result.workingProfile;
  assert.ok(Math.abs(Math.hypot(pitch[0][0], pitch[0][1]) - 15) < 1e-3,
    'pitch profile starts at the base radius');
  assert.ok(Math.abs(Math.hypot(pitch[pitch.length - 1][0], pitch[pitch.length - 1][1]) - 25) < 1e-3,
    'pitch profile ends at base + lift');
  for (let i = 0; i < pitch.length; i += Math.max(1, Math.floor(pitch.length / 20))) {
    const gap = Math.hypot(pitch[i][0] - working[i][0], pitch[i][1] - working[i][1]);
    assert.ok(Math.abs(gap - 5) < 1e-3, `working offset at sample ${i}`);
  }
});

test('G14-03: cam.evaluate checks declared pressure/curvature limits', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['cam', 'evaluate', '--doc', docName(), '--data', JSON.stringify({
    ...HALF_COSINE, maximumPressureAngle: '12 deg', minimumCurvatureRadius: '10 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const checks = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(checks['pressure-angle'], 'pass');
  assert.equal(checks.curvature, 'pass');
});

test('G14-04: cam.cycle-check resolves release only with an explicit return law', (t) => {
  if (skipLive(t)) return;
  const open = fmcad(['cam', 'cycle-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' },
  })]);
  // Rise-only source: release and dwell are unresolved, never auto-closed.
  assert.equal(open.status, 'unknown', JSON.stringify(open));
  assert.ok(open.result.unresolvedIntervals.some((u) => u.interval === 'release'),
    JSON.stringify(open.result.unresolvedIntervals));
  assert.equal(open.result.cycleStatus, 'unknown');

  const full = fmcad(['cam', 'cycle-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' },
    returnLaw: 'spring-return', dwell: {},
  })]);
  assert.equal(full.status, 'pass', JSON.stringify(full));
  assert.equal(full.result.cycleStatus, 'pass');
});

test('G14-05: cam.profile reproduces the sample rise flank and R5 normal offset', (t) => {
  if (skipLive(t)) return;
  const samples = [];
  for (let deg = 0; deg <= 240; deg += 15) {
    const theta = (Math.PI * deg) / 180;
    const lift = 5.0 * (1 - Math.cos(Math.PI * theta / ((Math.PI * 240) / 180)));
    samples.push({ angle: `${deg.toFixed(1)} deg`, lift: `${lift.toFixed(6)} mm` });
  }
  const out = fmcad(['cam', 'profile', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', baseRadius: '15 mm', rollerRadius: '5 mm',
    rise: { samples },
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const pitch = out.result.pitchProfile;
  assert.ok(Math.abs(Math.hypot(pitch[0][0], pitch[0][1]) - 15) < 1e-3);
  assert.ok(Math.abs(Math.hypot(pitch[pitch.length - 1][0], pitch[pitch.length - 1][1]) - 25) < 1e-3);
  assert.ok(out.result.minPitchCurvatureRadius.value > 5);
  assert.equal(out.result.normalOffset.value, 5);
});

test('G14-06: rise-only release is preserved (no chord/eccentric, no forced coupling)', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['cam', 'profile', '--doc', docName(), '--data', JSON.stringify(HALF_COSINE)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.contact, 'resolved over the rise only');
  assert.equal(out.result.separation, 'release contact unresolved');
  assert.ok(out.result.unresolvedIntervals.some((u) => u.interval === 'release'),
    JSON.stringify(out.result.unresolvedIntervals));
});

test('G14-07: drop/dynamics are blocked as missing data, not a fake-completed cycle', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['cam', 'cycle-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' },
  })]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.dropEdgeDynamics, 'blocked (no proper definition or evidence)');
  assert.equal(out.result.cycleStatus, 'unknown');
});
