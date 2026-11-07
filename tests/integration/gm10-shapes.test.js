'use strict';

// GM10 (generic shape library) live integration tests. Each test invokes the
// real fmcad CLI against the coordinator-provided cloud document and asserts
// the SPEC's expected result. With FMCAD_TEST_DOC unset every test and hook
// skips cleanly.

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

test('G10-01: shape.annular_segment drives radii and reports the sector span', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'annular_segment', '--doc', docName(), '--data', JSON.stringify({
    name: 'Annulus', innerRadius: '10 mm', outerRadius: '20 mm',
    start: '0 deg', sweep: '120 deg', height: '5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'annular_segment');
  assert.ok(out.result.feature, 'annular_segment must return a feature');
  assert.deepEqual(Object.keys(out.result.refs).sort(), ['capEnd', 'capStart', 'inner', 'origin', 'outer']);
  assert.equal(out.result.diameters.inner, '10 mm');
  assert.equal(out.result.diameters.outer, '20 mm');
  assert.equal(out.result.diameters.sweep, '120 deg');
  assert.equal(out.result.atomic, false);
});

test('G10-02: shape.arc_strip builds a curved strip from arc and three-point centerlines', (t) => {
  if (skipLive(t)) return;
  const arc = fmcad(['shape', 'arc_strip', '--doc', docName(), '--data', JSON.stringify({
    name: 'Blade', centerline: { radius: '30 mm', start: '10 deg', sweep: '80 deg' },
    thickness: '2 mm', height: '20 mm',
  })]);
  assert.equal(arc.success, true, JSON.stringify(arc));
  assert.equal(arc.result.recipe, 'arc_strip');
  assert.ok(arc.result.centerline.innerRadius, JSON.stringify(arc.result.centerline));
  assert.ok(arc.result.centerline.outerRadius, JSON.stringify(arc.result.centerline));

  const three = fmcad(['shape', 'arc_strip', '--doc', docName(), '--data', JSON.stringify({
    name: 'Blade3', centerline: { start: ['10 mm', '0 mm', '0 mm'], through: ['0 mm', '10 mm', '0 mm'], end: ['-10 mm', '0 mm', '0 mm'] },
    thickness: '1 mm', height: '5 mm',
  })]);
  assert.equal(three.success, true, JSON.stringify(three));
  assert.equal(three.result.recipe, 'arc_strip');
  // Three-point center reduces to a circle at the origin.
  assert.ok(Math.abs(parseFloat(three.result.centerline.center[0]) - 0) < 1e-4,
    JSON.stringify(three.result.centerline.center));
});

test('G10-03: shape.can composes blank revolve, shell and fillets', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'can', '--doc', docName(), '--data', JSON.stringify({
    name: 'Can', diameter: '40 mm', height: '60 mm', wallThickness: '1.5 mm',
    opening: 'top', radii: ['2 mm', '1 mm'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'can');
  assert.ok(out.result.blank, 'blank feature missing');
  assert.ok(out.result.shell, 'shell feature missing');
  assert.equal(out.result.fillets.length, 2);
  assert.equal(out.result.atomic, false);
});

test('G10-04: shape.impeller wires hub -> blade -> pattern dependencies', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'impeller', '--doc', docName(), '--data', JSON.stringify({
    name: 'Impeller',
    hub: { diameter: '20 mm', height: '15 mm' },
    blade: { innerRadius: '10 mm', outerRadius: '40 mm', sweep: '60 deg', height: '15 mm' },
    count: 6,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'impeller');
  assert.ok(out.result.hub, 'hub feature missing');
  assert.ok(out.result.blade, 'blade feature missing');
  assert.ok(out.result.pattern, 'pattern feature missing');
  assert.equal(out.result.atomic, false);
  assert.match(out.result.dependencies, /hub/);
});

test('G10-05: shape.boss_pattern repeats a boss with hole across a circular layout', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'boss_pattern', '--doc', docName(), '--data', JSON.stringify({
    name: 'Bosses',
    boss: { diameter: '8 mm', height: '5 mm' },
    hole: { diameter: '3 mm', depth: '5 mm' },
    layout: { type: 'circular', axis: 'Z', quantity: 6, angle: '360 deg' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'boss_pattern');
  assert.ok(out.result.boss, 'boss feature missing');
  assert.ok(out.result.hole, 'hole feature missing');
  assert.ok(out.result.pattern, 'pattern feature missing');
  assert.equal(out.result.atomic, false);
});

test('G10-06: shape.slot is generated on a frame-aligned plane', (t) => {
  if (skipLive(t)) return;
  fmcad(['datum', 'frame', '--doc', docName(), '--data', JSON.stringify({
    name: 'SlotFrame', origin: ['0 mm', '0 mm', '0 mm'], xAxis: [1, 0, 0], yAxis: [0, 1, 0],
  })]);
  const out = fmcad(['shape', 'slot', '--doc', docName(), '--data', JSON.stringify({
    name: 'Slot', length: '30 mm', width: '6 mm',
    position: ['10 mm', '-5 mm', '0 mm'], angle: '30 deg', thickness: '3 mm',
    operation: 'newBody', frame: { datum: 'SlotFrame' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.slotGeometry, 'slotGeometry missing');
});

test('G10-07: mixed profiles reuse the shared sketch builder (three-point rounded profile)', (t) => {
  if (skipLive(t)) return;
  // The three-point centerline is a rounded/clipped profile reduced locally by
  // the shared GM06/GM07 sketch builder, not a second DSL.
  const out = fmcad(['shape', 'arc_strip', '--doc', docName(), '--data', JSON.stringify({
    name: 'Rounded', centerline: { start: ['20 mm', '0 mm', '0 mm'], through: ['0 mm', '20 mm', '0 mm'], end: ['-20 mm', '0 mm', '0 mm'] },
    thickness: '1 mm', height: '3 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.recipe, 'arc_strip');
  assert.ok(Math.abs(parseFloat(out.result.centerline.center[0])) < 1e-4,
    JSON.stringify(out.result.centerline.center));
  assert.ok(Math.abs(parseFloat(out.result.centerline.center[1])) < 1e-4,
    JSON.stringify(out.result.centerline.center));
});

test('G10-08: recipes report the dependency chain and non-atomic regeneration', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['shape', 'impeller', '--doc', docName(), '--data', JSON.stringify({
    name: 'Impeller',
    hub: { diameter: '20 mm', height: '15 mm' },
    blade: { innerRadius: '10 mm', outerRadius: '40 mm', sweep: '60 deg', height: '15 mm' },
    count: 4,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.atomic, false);
  assert.ok(out.result.dependencies, 'dependencies string missing');
  assert.ok(out.result.helpers && out.result.helpers.length > 0, 'helpers missing');
});
