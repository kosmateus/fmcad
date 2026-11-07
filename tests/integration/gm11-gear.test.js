'use strict';

// GM11 (gear) live integration tests. Each test invokes the real fmcad CLI
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

const STANDARD = { name: 'Gear', module: '2 mm', teeth: 20, pressureAngle: '20 deg', faceWidth: '10 mm' };

test('G11-01: shape.gear builds an involute gear with analytic diameters and approximation error', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify(STANDARD)]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'gear');
  assert.equal(out.result.toothCount, 20);
  const diameters = out.result.diameters;
  assert.ok(Math.abs(diameters.pitch - 4.0) < 1e-6, JSON.stringify(diameters)); // d = m*z
  assert.ok(Math.abs(diameters.base - 4.0 * Math.cos(Math.PI / 9)) < 1e-4, JSON.stringify(diameters)); // db = d*cos(alpha)
  assert.ok(Math.abs(diameters.addendum - 4.4) < 1e-6, JSON.stringify(diameters)); // da = m*(z+2)
  assert.ok(Math.abs(diameters.root - 3.5) < 1e-6, JSON.stringify(diameters)); // df = m*(z-2.5)
  assert.ok(out.result.approximationError > 0, JSON.stringify(out.result.approximationError));
  assert.ok(out.result.feature, 'gear must return a feature ref');
});

test('G11-02: undercut detection and root treatment are explicit', (t) => {
  if (skipLive(t)) return;
  const small = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify({
    name: 'Small', module: '2 mm', teeth: 12, faceWidth: '5 mm',
  })]);
  assert.equal(small.success, true, JSON.stringify(small));
  assert.equal(small.result.undercut.undercut, true);
  assert.equal(small.result.undercut.minimumTeeth, 18);

  const straight = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify({
    name: 'Gear', module: '2 mm', teeth: 20, faceWidth: '5 mm', rootTreatment: 'straight',
  })]);
  assert.equal(straight.success, true, JSON.stringify(straight));
  assert.equal(straight.result.rootTreatment, 'straight');
  assert.equal(straight.result.rootFilletRadius, '0 mm');
});

test('G11-03: profile shift, bore, hub and key are honored', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify({
    name: 'Gear', module: '2 mm', teeth: 20, faceWidth: '10 mm', profileShift: 0.5,
    bore: '8 mm', hub: { diameter: '15 mm', height: '5 mm' }, key: { width: '2 mm', depth: '1 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  // da = m*(z + 2*ha + 2x) = 2*(20+2+1) = 46 mm = 4.6 cm.
  assert.ok(Math.abs(out.result.diameters.addendum - 4.6) < 1e-6, JSON.stringify(out.result.diameters));
  assert.ok(out.result.bore, 'bore feature missing');
  assert.ok(out.result.hub, 'hub feature missing');
  assert.ok(out.result.key, 'key feature missing');
});

test('G11-04: gear.pair-check reports ratio/sign, center distance and backlash sum', (t) => {
  if (skipLive(t)) return;
  const external = fmcad(['gear', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    gear1: { module: '2 mm', teeth: 20, pressureAngle: '20 deg' },
    gear2: { module: '2 mm', teeth: 40, pressureAngle: '20 deg' },
    external: true, phase: 0,
  })]);
  assert.equal(external.status, 'pass', JSON.stringify(external));
  assert.equal(external.result.ratio, 2.0);
  assert.equal(external.result.sign, 1);
  assert.ok(Math.abs(external.result.centerDistance - 6.0) < 1e-6, JSON.stringify(external.result)); // m*(z1+z2)/2
  assert.deepEqual(external.result.teeth, [20, 40]);

  const backlash = fmcad(['gear', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    gear1: { module: '2 mm', teeth: 20, backlashAllocation: '0.05 mm' },
    gear2: { module: '2 mm', teeth: 20, backlashAllocation: '0.03 mm' },
  })]);
  assert.equal(backlash.status, 'pass', JSON.stringify(backlash));
  assert.ok(Math.abs(backlash.result.backlash - 0.008) < 1e-6, JSON.stringify(backlash.result.backlash));

  const internal = fmcad(['gear', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    gear1: { module: '2 mm', teeth: 40, pressureAngle: '20 deg' },
    gear2: { module: '2 mm', teeth: 20, pressureAngle: '20 deg' },
    external: false,
  })]);
  assert.equal(internal.status, 'pass', JSON.stringify(internal));
  assert.equal(internal.result.ratio, -0.5);
  assert.equal(internal.result.sign, -1);
});

test('G11-05: analytic diameter expressions match d=mz, db, da, df', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify(STANDARD)]);
  assert.equal(out.success, true, JSON.stringify(out));
  const expressions = out.result.diameterExpressions;
  assert.equal(expressions.pitch, '(2 mm) * 20');
  assert.equal(expressions.base, '(2 mm) * 20 * cos(20 deg)');
  assert.equal(expressions.addendum, '(2 mm) * (20 + 2.0)');
  assert.equal(expressions.root, '(2 mm) * (20 - 2.5)');
  assert.equal(out.result.undercut.undercut, false);
});

test('G11-06: single closed tooth loop — healthState 0, addendum readback', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify({
    name: 'G11Gear', module: '2 mm', teeth: 20, pressureAngle: '20 deg', faceWidth: '10 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.healthState, 0);
  assert.equal(out.result.message, '');
  assert.ok(out.result.bodies.length >= 1);
  assert.ok(Math.abs(out.result.diameters.addendum - 4.4) < 1e-6, JSON.stringify(out.result.diameters));
});

test('G11-07: regeneration is a declared recipe (driving radii, sampled flanks)', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'gear', '--doc', docName(), '--data', JSON.stringify(STANDARD)]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.regeneration, 'recipeRegeneration');
  assert.equal(out.result.atomic, false);
  assert.match(out.result.dependencies, /recipeRegeneration/);
});
