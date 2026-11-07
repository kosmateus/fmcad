'use strict';

// Live integration tests for GM-28 (geometric optics and sensor alignment).
// All read-only recipe commands against the shared document.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);
const frustum = (extra) => ({
  schemaVersion: 1,
  pupil: { origin: ['0 mm', '0 mm', '0 mm'], direction: [0, 0, 1], up: [0, 1, 0] },
  fov: { horizontal: '60 deg', vertical: '40 deg' },
  ranges: { near: '10 mm', far: '100 mm' },
  ...extra,
});

test('G28-01: optics frustum builds the basis and clips against a limiting window', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['optics', 'frustum', '--doc', docName(), '--data', JSON.stringify(frustum())]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.result.axis, [0, 0, 1]);
  assert.deepEqual(out.result.horizontal, [0, 1, 0]);
  assert.deepEqual(out.result.vertical, [-1, 0, 0]);
  near(out.result.halfAngles.horizontal, Math.PI / 6);
  near(out.result.halfAngles.vertical, 20 * Math.PI / 180);
  assert.equal(out.result.corners.near.length, 4);
  assert.equal(out.result.windowLimited, false);

  const clipped = fmcad(['optics', 'frustum', '--doc', docName(), '--data', JSON.stringify(frustum({
    window: { distance: '50 mm', width: '20 mm', height: '20 mm' },
  }))]);
  assert.equal(clipped.result.windowLimited, true, JSON.stringify(clipped.result));
  near(clipped.result.effectiveHalfAngles.horizontal, Math.atan(1 / 5));
  assert.ok(clipped.result.effectiveHalfAngles.horizontal < clipped.result.halfAngles.horizontal);
});

test('G28-02: optics coverage union is below the individual sum with dead zones', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['optics', 'coverage', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    sensors: [
      { name: 'camA', pupil: { origin: ['-20 mm', '0 mm', '30 mm'], direction: [0.5, 0, -0.866], up: [0, 1, 0] }, fov: { horizontal: '40 deg', vertical: '30 deg' }, ranges: { near: '1 mm', far: '100 mm' } },
      { name: 'camB', pupil: { origin: ['20 mm', '0 mm', '30 mm'], direction: [-0.5, 0, -0.866], up: [0, 1, 0] }, fov: { horizontal: '40 deg', vertical: '30 deg' }, ranges: { near: '1 mm', far: '100 mm' } },
    ],
    targets: [{ name: 'board', origin: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, 1], u: [1, 0, 0],
      outline: [['-30 mm', '-30 mm'], ['30 mm', '-30 mm'], ['30 mm', '30 mm'], ['-30 mm', '30 mm']] }],
    samplingBudget: 40000,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  const target = out.result.targets[0];
  assert.ok(target.unionCoveredArea > 0, JSON.stringify(target));
  assert.ok(target.sumIndividualArea > target.unionCoveredArea, JSON.stringify(target));
  assert.ok(target.coveredFraction > 0 && target.coveredFraction < 1, JSON.stringify(target));
  assert.ok(target.deadZoneFraction > 0, JSON.stringify(target));
});

test('G28-03: optics occlusion blocks a baffled line, passes a declared window', (t) => {
  if (skipLive(t)) return;
  const blocked = fmcad(['optics', 'occlusion', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, pupil: { origin: ['0 mm', '0 mm', '0 mm'] },
    rays: [{ target: ['0 mm', '0 mm', '50 mm'] }],
    obstacles: [{ name: 'baffle', kind: 'baffle', shape: { type: 'disk', origin: ['0 mm', '0 mm', '25 mm'], normal: [0, 0, 1], radius: '4 mm' } }],
  })]);
  assert.equal(blocked.result.rays[0].result, 'blocked', JSON.stringify(blocked.result));
  assert.equal(blocked.result.rays[0].obstacleName, 'baffle');
  assert.equal(blocked.result.blockedCount, 1);

  const window = fmcad(['optics', 'occlusion', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, pupil: { origin: ['0 mm', '0 mm', '0 mm'] },
    rays: [{ target: ['0 mm', '0 mm', '50 mm'] }],
    obstacles: [{ name: 'window', kind: 'window', transmittance: 0.9, shape: { type: 'disk', origin: ['0 mm', '0 mm', '25 mm'], normal: [0, 0, 1], radius: '8 mm' } }],
  })]);
  assert.equal(window.result.rays[0].result, 'window', JSON.stringify(window.result));
  near(window.result.rays[0].transmittance, 0.9);
  assert.equal(window.result.transparentCount, 1);
});

test('G28-04: sensor alignment-check reports angle deviation and forbidden zones', (t) => {
  if (skipLive(t)) return;
  const angle = cad(['sensor', 'alignment-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    sensor: { name: 'ir', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, Math.sin(10 * Math.PI / 180), Math.cos(10 * Math.PI / 180)] },
    reference: { name: 'magnet', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
    limits: { angle: '5 deg', offset: '0.5 mm' },
  })]).json;
  assert.ok(angle, 'expected a JSON envelope for a failing alignment-check');
  assert.equal(angle.status, 'fail', JSON.stringify(angle));
  assert.equal(angle.result.aligned, false);
  near(angle.result.angleDeviationDegrees, 10, 1e-3);
  assert.ok(angle.result.violations.some((v) => v.includes('angle')), JSON.stringify(angle.result.violations));

  const zone = cad(['sensor', 'alignment-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    sensor: { name: 'ir', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
    reference: { name: 'magnet', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
    limits: { angle: '5 deg', offset: '0.5 mm' },
    forbiddenZones: [{ name: 'magnet-zone', type: 'box', min: ['0 mm', '0 mm', '0 mm'], max: ['10 mm', '10 mm', '10 mm'] }],
  })]).json;
  assert.ok(zone, 'expected a JSON envelope for a forbidden-zone failure');
  assert.equal(zone.status, 'fail', JSON.stringify(zone));
  assert.ok(zone.result.forbiddenZoneIntersections.includes('magnet-zone'), JSON.stringify(zone.result));
});

test('G28-05: near-field gap is reported, not hidden by angle sums', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['optics', 'coverage', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    sensors: [{ name: 'cam', pupil: { origin: ['0 mm', '0 mm', '30 mm'], direction: [0, 0, -1] }, fov: { horizontal: '60 deg', vertical: '60 deg' }, ranges: { near: '50 mm', far: '200 mm' } }],
    targets: [{ name: 'board', origin: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, 1], u: [1, 0, 0],
      outline: [['-10 mm', '-10 mm'], ['10 mm', '-10 mm'], ['10 mm', '10 mm'], ['-10 mm', '10 mm']] }],
    samplingBudget: 40000,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  const target = out.result.targets[0];
  assert.ok(target.nearFieldGapFraction > 0.9, JSON.stringify(target));
  assert.ok(target.coveredFraction < 0.05, JSON.stringify(target));
});

test('G28-06: aligned sensor passes without any optical/RF/magnetic claim', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['sensor', 'alignment-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    sensor: { name: 'ir', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
    reference: { name: 'magnet', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
    limits: { angle: '5 deg', offset: '0.5 mm', gap: { min: '0 mm', max: '2 mm' } },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.aligned, true);
  near(out.result.angleDeviation, 0, 1e-6);
  assert.deepEqual(out.result.violations, []);
  assert.ok(out.limitations.some((l) => /magnetic-field|RF/i.test(l)), JSON.stringify(out.limitations));
});
