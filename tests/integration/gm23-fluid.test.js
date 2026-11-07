'use strict';

// Live integration tests for GM-23 (fill volume / level curve / drain / cleaning
// access). These are LOCAL methods: no --doc, no document clear, no backend.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { local } = require('./helper');

const base = () => ({
  schemaVersion: 1,
  identity: { model: 'fluid-live', revision: '1' },
  frame: 'tank',
  assumptions: ['Closed analytic box cavity; fill axis is the declared frame Z; box displacers only.'],
});
const cavity = () => ({ type: 'box', length: '1 m', width: '1 m', height: '0.5 m' });
const gravity = { direction: { x: 0, y: 0, z: -1 } };
const displacers = () => [
  { id: 'd1', length: '0.4 m', width: '0.4 m', height: '0.2 m', position: { x: '0.2 m', y: '0.2 m', z: '0.1 m' } },
  { id: 'd2', length: '0.4 m', width: '0.4 m', height: '0.2 m', position: { x: '0.3 m', y: '0.3 m', z: '0.1 m' } },
];
const closure = () => ({ closedDomain: true });
const near = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);

test('G23-01: explicit box cavity fill half-space gives gross/net volume, mass and CG', () => {
  const d = base();
  d.cavity = cavity();
  d.level = '0.5 m';
  d.density = '1000 kg/m3';
  d.gravity = gravity;
  d.closure = closure();
  d.minimumVolume = '0.45 m3';
  d.maximumVolume = '0.55 m3';
  const out = local(['measure', 'fill-volume', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.grossVolume.value, 0.5);
  near(out.result.netVolume.value, 0.5);
  near(out.result.liquidMass.value, 500);
  near(out.result.liquidCG.z.value, 0.25);
  near(out.result.liquidCG.x.value, 0.5);
});

test('G23-02: overlapping displacers are unioned, never double-subtracted', () => {
  const d = base();
  d.cavity = cavity();
  d.level = '0.5 m';
  d.density = '1000 kg/m3';
  d.gravity = gravity;
  d.displacers = displacers();
  d.closure = closure();
  d.minimumVolume = '0.45 m3';
  d.maximumVolume = '0.46 m3';
  const out = local(['measure', 'fill-volume', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.grossVolume.value, 0.5);
  near(out.result.displacedUnionVolume.value, 0.046); // unioned, not 2 x 0.032
  near(out.result.netVolume.value, 0.454);
  near(out.result.liquidMass.value, 454);
});

test('G23-03: level-curve is monotonic with MIN/MAX criteria', () => {
  const d = base();
  d.cavity = cavity();
  d.density = '1000 kg/m3';
  d.gravity = gravity;
  d.displacers = displacers();
  d.closure = closure();
  d.levels = ['0.1 m', '0.2 m', '0.3 m'];
  d.criteria = [
    { id: 'pickup', level: '0.2 m', kind: 'minimum', volume: '0.15 m3' },
    { id: 'headspace', level: '0.3 m', kind: 'maximum', volume: '0.26 m3' },
  ];
  const out = local(['fluid', 'level-curve', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.monotonic, true);
  near(out.result.curve[0].volume.value, 0.077);
  near(out.result.curve[1].volume.value, 0.154);
  near(out.result.curve[2].volume.value, 0.254);
  assert.equal(out.result.criteria[0].status, 'pass');
  assert.equal(out.result.criteria[1].status, 'pass');
});

test('G23-04: drain check reports zero residual at the floor outlet', () => {
  const d = base();
  d.cavity = cavity();
  d.density = '1000 kg/m3';
  d.gravity = gravity;
  d.outlet = { position: { x: '0.5 m', y: '0.5 m', z: '0 m' }, diameter: '10 mm' };
  d.drainLevel = '0 m';
  d.maximumResidual = '0.001 m3';
  const out = local(['drain', 'check', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.drainStatus, 'pass');
  near(out.result.residualVolume.value, 0);
});

test('G23-05: cleaning access tool reach and diameter fit', () => {
  const d = base();
  d.cavity = cavity();
  d.gravity = gravity;
  d.tool = { type: 'brush', length: '300 mm', diameter: '50 mm' };
  d.accesses = [{ id: 'a1', at: { x: '0.5 m', y: '0.5 m', z: '0.5 m' }, direction: { x: 0, y: 0, z: -1 }, depth: '200 mm', openingDiameter: '60 mm' }];
  const out = local(['cleaning', 'access', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.accesses[0].reach, true);
  assert.equal(out.result.accesses[0].fits, true);
});

test('G23-06: ambiguous open cavity is blocked, never guessed', () => {
  const d = base();
  d.cavity = cavity();
  d.level = '0.5 m';
  d.density = '1000 kg/m3';
  d.gravity = gravity;
  d.displacers = displacers();
  d.closure = { closedDomain: false, errors: ['open cavity without caps or seed faces'] };
  const out = local(['measure', 'fill-volume', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'blocked', JSON.stringify(out));
  assert.equal(out.result.closureErrors.length, 1);
  assert.equal(out.result.netVolume, null);
});
