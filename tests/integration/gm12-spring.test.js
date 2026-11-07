'use strict';

// GM12 (helix / spring) live integration tests. Each test invokes the real
// fmcad CLI against the coordinator-provided cloud document and asserts the
// SPEC's expected result. With FMCAD_TEST_DOC unset every test and hook skips
// cleanly.

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

test('G12-01: curve.helix generates a real helical centerline (recipe, never native Coil)', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['curve', 'helix', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', turns: 8, hand: 'right',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(Math.abs(out.result.radius.value - 4) < 1e-6);
  assert.ok(Math.abs(out.result.pitch.value - 5.75) < 1e-6);
  assert.equal(out.result.turns, 8);
  assert.ok(Math.abs(out.result.height.value - 46) < 1e-6);
  assert.equal(out.result.hand, 'right');
  assert.equal(out.result.representation, 'recipe');
  assert.equal(out.result.nativeCoil, false);
  const turnLength = Math.hypot(5.75, 2 * Math.PI * 4);
  assert.ok(Math.abs(out.result.arcLength.value - turnLength * 8) < 1e-6);
  const curvature = 4 / (4 ** 2 + (5.75 / (2 * Math.PI)) ** 2);
  assert.ok(Math.abs(out.result.curvature.value - curvature) < 1e-9);

  // shape.helix delegates to the same generated-mode handler.
  const shaped = fmcad(['shape', 'helix', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', turns: 8,
  })]);
  assert.equal(shaped.result.status, 'pass', JSON.stringify(shaped));
  assert.ok(shaped.result.arcLength);
});

test('G12-02: helix pitch/turns/height, handedness and mutually exclusive inputs', (t) => {
  if (skipLive(t)) return;
  // turns + height derive pitch.
  const derived = fmcad(['curve', 'helix', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', radius: '4 mm', turns: 8, height: '46 mm',
  })]);
  assert.equal(derived.status, 'pass', JSON.stringify(derived));
  assert.ok(Math.abs(derived.result.pitch.value - 5.75) < 1e-9);

  // Handedness is reported.
  const left = fmcad(['curve', 'helix', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', turns: 1, hand: 'left',
  })]);
  assert.equal(left.status, 'pass', JSON.stringify(left));
  assert.equal(left.result.hand, 'left');

  // pitch and height are contradictory.
  assert.throws(() => fmcad(['curve', 'helix', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', height: '46 mm', turns: 8,
  })]), /contradictory/);
});

test('G12-03: shape.spring reports wire length, mass, solid height and diameters', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'spring', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', name: 'Spring',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    endStyle: 'ground', hand: 'right',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(Math.abs(out.result.outerDiameter.value - 8.5) < 1e-6);
  assert.ok(Math.abs(out.result.innerDiameter.value - 7.5) < 1e-6);
  assert.ok(Math.abs(out.result.solidHeight.value - 4) < 1e-6); // totalCoils * wireDiameter
  assert.equal(out.result.representation, 'recipe');
  assert.equal(out.result.nativeCoil, false);
  assert.ok(out.result.wireLength.value > 0);
  assert.ok(out.result.mass.value > 0);
  assert.ok(out.result.stiffness.value > 0);
});

test('G12-04: ground ends are a declared recipe gap (native Coil gate), never faked', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'spring', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', name: 'GroundSpring',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    endStyle: 'ground', hand: 'right',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.endStyle, 'ground');
  assert.equal(out.result.nativeCoil, false);
  assert.equal(out.result.representation, 'recipe');
  assert.ok(out.result.assumptions.some((a) => a.includes('recipe representations only')),
    JSON.stringify(out.result.assumptions));
});

test('G12-05: spring.evaluate reports stiffness, wire length, mass, solid height and forces', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['spring', 'evaluate', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    wireDiameter: '1 mm', meanDiameter: '10 mm', activeCoils: 10, totalCoils: 12, freeLength: '30 mm',
    shearModulus: '77000 N/mm^2', density: '7850 kg/m^3',
    installedLength: '25 mm', compressedLength: '20 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  // k = G*d^4/(8*D^3*n) = 77000*1/(8*1000*10) = 0.9625 N/mm.
  assert.ok(Math.abs(out.result.stiffness.value - 0.9625) < 1e-9, JSON.stringify(out.result.stiffness));
  assert.equal(out.result.stiffness.units, 'N/mm');
  assert.ok(Math.abs(out.result.solidHeight.value - 12) < 1e-6); // totalCoils * wireDiameter
  assert.ok(out.result.wireLength.value > 0);
  assert.ok(out.result.mass.value > 0);
  assert.ok(out.result.solidHeightMargin.value > 0);
  const forces = Object.fromEntries(out.result.forces.map((f) => [f.state, f.force.value]));
  assert.ok(Math.abs(forces.compressed - 0.9625 * 10) < 1e-6, JSON.stringify(forces));
  assert.ok(Math.abs(forces.installed - 0.9625 * 5) < 1e-6, JSON.stringify(forces));
});

test('G12-06: spring.configure checks guide clearance and rejects coil bind', (t) => {
  if (skipLive(t)) return;
  const rod = fmcad(['spring', 'configure', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    installedLength: '27 mm', compressedLength: '17 mm',
    guide: { kind: 'rod', diameter: '7.4 mm' },
  })]);
  assert.equal(rod.status, 'pass', JSON.stringify(rod));
  const guideRod = rod.result.checks.find((c) => c.check === 'guide-rod');
  assert.equal(guideRod.status, 'pass');
  assert.ok(Math.abs(guideRod.clearance.value - 0.1) < 1e-9, JSON.stringify(guideRod));

  // Compressed below solid height (material volume would change) fails.
  assert.throws(() => fmcad(['spring', 'configure', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    compressedLength: '3 mm',
  })]), /below solid height/);
});

test('G12-07: spring.evaluate reproduces the P054 fixture (k, forces, solid height)', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['spring', 'evaluate', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    shearModulus: '77000 N/mm^2', density: '7850 kg/m^3',
    installedLength: '27 mm', compressedLength: '17 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  // P054: k = 77000*0.5^4/(8*8^3*6) = 0.195821 N/mm.
  assert.ok(Math.abs(out.result.stiffness.value - 0.19582112630208334) < 1e-9,
    JSON.stringify(out.result.stiffness));
  assert.ok(Math.abs(out.result.solidHeight.value - 4) < 1e-6);
  const forces = Object.fromEntries(out.result.forces.map((f) => [f.state, f.force.value]));
  assert.ok(Math.abs(forces.compressed - 0.19582112630208334 * 18) < 1e-6, JSON.stringify(forces));
  assert.ok(Math.abs(forces.installed - 0.19582112630208334 * 8) < 1e-6, JSON.stringify(forces));
});

test('G12-08: spring.configure resolves installed/compressed state with solid-height margin', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['spring', 'configure', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    installedLength: '27 mm', compressedLength: '17 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const volume = out.result.checks.find((c) => c.check === 'material-volume');
  assert.equal(volume.status, 'pass');
  assert.ok(Math.abs(volume.margin.value - 13) < 1e-9, JSON.stringify(volume)); // 17 - 4
  assert.ok(Math.abs(out.result.configuredState.solidHeight.value - 4) < 1e-6);
  assert.ok(Math.abs(out.result.configuredState.compressedLength.value - 17) < 1e-6);
});
