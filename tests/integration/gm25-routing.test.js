'use strict';

// Live integration tests for GM-25 (3D routing). These are read-only CAD
// commands resolved against the coordinator-provided document; every test is
// guarded and clears the shared document before/after.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);

test('G25-01: route create3d solves a spatial S-curve through waypoints', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'create3d', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    waypoints: [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '10 mm'], ['0 mm', '0 mm', '20 mm']],
    up: [0, 0, 1],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.routeState, 'numerically-solved');
  assert.ok(out.result.arcLength > 0, JSON.stringify(out.result));
  assert.ok(out.result.minBendRadius !== null, JSON.stringify(out.result));
  assert.ok(out.result.frames.length > 0, JSON.stringify(out.result));
  assert.ok(out.result.frames[0].position, JSON.stringify(out.result.frames[0]));
});

test('G25-02: end tangents, normal sections and a stable transport frame at inflection', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'create3d', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    waypoints: [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '10 mm'], ['0 mm', '0 mm', '20 mm']],
    up: [0, 0, 1],
    endTangents: { start: [0, 0, 1], end: [0, 0, 1] },
    normalSections: [{ station: '0.5 cm' }, { station: '2 cm' }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.routeState, 'set');
  assert.equal(out.result.normalSections.length, 2, JSON.stringify(out.result));
  assert.ok(out.result.endTangents.computed.start, JSON.stringify(out.result.endTangents));
  assert.ok(out.result.endTangents.computed.end, JSON.stringify(out.result.endTangents));
});

test('G25-03: route inspect reports arc length, bend radius and self-clearance', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'inspect', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    waypoints: [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '0 mm'], ['10 mm', '10 mm', '0 mm']],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(out.result.arcLength > 0, JSON.stringify(out.result));
  assert.ok(typeof out.result.minBendRadius === 'number', JSON.stringify(out.result));
  assert.ok(out.result.selfClearance !== null, JSON.stringify(out.result));
});

test('G25-04: route cut-list uses 1.1*L + 2*15 mm interpretation', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'cut-list', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm', allowanceFactor: 1.1, serviceTail: '15 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  near(out.result.cutLengthPerPiece, 140);
  assert.ok(out.result.interpretation.includes('1.1'), out.result.interpretation);
});

test('G25-05: route motion-states evaluates the PAN x TILT cartesian product preserving length', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'motion-states', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm',
    pan: { min: '-45 deg', max: '45 deg' }, tilt: { min: '-30 deg', max: '30 deg' },
    minBendRadius: '5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.states.length, 4, JSON.stringify(out.result));
  assert.equal(out.result.lengthPreserved, true);
  assert.ok(out.result.states.every((s) => s.lengthPreserved), JSON.stringify(out.result.states));
  assert.ok(out.result.extremeCoverage.includes('cartesian'), out.result.extremeCoverage);
});

test('G25-06: route state is explicitly set or native-dependent, never guessed', (t) => {
  if (skipLive(t)) return;
  const set = fmcad(['route', 'motion-states', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm',
    poses: [{ pan: '0 deg', tilt: '0 deg', bendRadius: '8 mm' }],
  })]);
  assert.equal(set.result.states[0].state, 'set', JSON.stringify(set.result));
  near(set.result.states[0].requiredBendRadius, 0.8);

  const native = fmcad(['route', 'motion-states', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm',
    pan: { min: '-45 deg', max: '45 deg' }, tilt: { min: '-30 deg', max: '30 deg' },
    state: 'native-dependent',
  })]);
  assert.ok(native.result.states.every((s) => s.state === 'native-dependent'), JSON.stringify(native.result.states));
});

test('G25-07: bend limit flags a route whose required radius is too tight', (t) => {
  if (skipLive(t)) return;
  const fits = fmcad(['route', 'motion-states', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm',
    pan: { min: '-45 deg', max: '45 deg' }, tilt: { min: '-30 deg', max: '30 deg' },
    minBendRadius: '5 mm',
  })]);
  assert.ok(fits.result.states.every((s) => s.fits === true), JSON.stringify(fits.result.states));

  const tooTight = fmcad(['route', 'motion-states', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm',
    pan: { min: '-45 deg', max: '45 deg' }, tilt: { min: '-30 deg', max: '30 deg' },
    minBendRadius: '100 mm',
  })]);
  assert.ok(tooTight.result.states.every((s) => s.fits === false), JSON.stringify(tooTight.result.states));
});

test('G25-08: modeled service tail is not added twice; AWG is not insulation diameter', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['route', 'cut-list', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, length: '100 mm', allowanceFactor: 1.1, serviceTail: '15 mm', serviceTailModeled: true,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  near(out.result.cutLengthPerPiece, 110);
  assert.ok(out.result.warnings.some((w) => w.includes('not added again')), JSON.stringify(out.result.warnings));
  assert.ok(out.limitations.some((l) => l.includes('AWG')), JSON.stringify(out.limitations));
});
