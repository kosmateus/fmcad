'use strict';

// Shared owned-backend extraction: tests/scenarios/gm26-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-26 (FPC, PCB, ports, connectors, packing,
// keepouts). All read-only recipe/metadata commands against the shared document.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);
const foldChain = [
  { type: 'line', length: '10 mm' },
  { type: 'bend', radius: '2 mm', angle: '90 deg', axis: 'y' },
  { type: 'line', length: '10 mm' },
];
const boardOutline = [['0 mm', '0 mm'], ['20 mm', '0 mm'], ['20 mm', '20 mm'], ['0 mm', '20 mm']];

test('G26-01: fpc fold preserves the neutral-axis length, never scales', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['fpc', 'fold', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, chain: foldChain,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.neutralLengthPreserved, true);
  assert.equal(out.result.scaled, false);
  near(out.result.flatNeutralLength, 1.0 + 0.2 * (Math.PI / 2) + 1.0);
  near(out.result.foldedNeutralLength, out.result.flatNeutralLength);
});

test('G26-02: fpc flatten straightens bends without changing neutral length', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['fpc', 'flatten', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, chain: foldChain,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.neutralLengthPreserved, true);
  assert.equal(out.result.scaled, false);
  near(out.result.flatNeutralLength, out.result.foldedNeutralLength);
  near(out.result.straightenedBendLengths, 0.2 * (Math.PI / 2));
});

test('G26-03: pcb mechanical-exchange reports the STEP-center vs lens datum offset', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['pcb', 'mechanical-exchange', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    source: { datum: { name: 'step-center', type: 'step-center', origin: ['0 mm', '0 mm', '0 mm'] } },
    target: { datum: { name: 'lens-datum', type: 'lens', origin: ['2 mm', '1 mm', '0 mm'] } },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.compatibleDatum, false);
  near(out.result.datumOffset[0], 0.2);
  near(out.result.datumOffset[1], 0.1);
  assert.ok(out.result.warnings.some((w) => w.includes('STEP')), JSON.stringify(out.result.warnings));
});

test('G26-04: pcb check requires both-side height zones', (t) => {
  if (skipLive(t)) return;
  const valid = fmcad(['pcb', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    board: {
      thickness: '1.6 mm', outline: boardOutline,
      holes: [{ center: ['5 mm', '5 mm', '0 mm'], type: 'round', diameter: '2 mm' }],
      heightZones: [{ side: 'top' }, { side: 'bottom' }],
    },
  })]);
  assert.equal(valid.success, true, JSON.stringify(valid));
  assert.equal(valid.result.passed, true, JSON.stringify(valid.result));
  assert.deepEqual(valid.result.heightZones, ['bottom', 'top']);

  const missing = cad(['pcb', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    board: { thickness: '1.6 mm', outline: boardOutline, heightZones: [{ side: 'top' }] },
  })]).json;
  assert.ok(missing, 'expected a JSON envelope for a failing pcb.check');
  assert.equal(missing.result.passed, false, JSON.stringify(missing.result));
  assert.ok(missing.result.violations.some((v) => v.includes('bottom')), JSON.stringify(missing.result.violations));
});

test('G26-05: port define reports origin, normal, pin1 and mating stroke', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['port', 'define', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, name: 'PWR',
    frame: { origin: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, 1], pin1: ['1 mm', '0 mm', '0 mm'] },
    matingStroke: '5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(out.result.normal, [0, 0, 1]);
  near(out.result.matingStroke, 0.5);
});

test('G26-06: connector mate-check passes a correct intended pair', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['connector', 'mate-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    connectors: [
      { name: 'POWER_M', gender: 'male', pinCount: 4, key: 'pwr-k' },
      { name: 'POWER_F', gender: 'female', pinCount: 4, key: 'pwr-k' },
    ],
    intendedPairs: [['POWER_M', 'POWER_F']],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.passed, true, JSON.stringify(out.result));
  assert.equal(out.result.intended[0].mates, true);
});

test('G26-07: forbidden pair with shared key is a poka-yoke hazard', (t) => {
  if (skipLive(t)) return;
  const out = cad(['connector', 'mate-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    connectors: [
      { name: 'POWER_M', gender: 'male', pinCount: 4, key: '4pin-k' },
      { name: 'POWER_F', gender: 'female', pinCount: 4, key: '4pin-k' },
      { name: 'DATA_F', gender: 'female', pinCount: 4, key: '4pin-k' },
    ],
    intendedPairs: [['POWER_M', 'POWER_F']],
    forbiddenPairs: [['POWER_M', 'DATA_F']],
  })]);
  assert.equal(out.code, 1, JSON.stringify(out));
  assert.equal(out.json.success, false, JSON.stringify(out.json));
  assert.equal(out.json.status, 'fail', JSON.stringify(out.json));
  assert.equal(out.json.result.passed, false);
  assert.equal(out.json.result.forbidden[0].canReachSeating, true, JSON.stringify(out.json.result.forbidden));
  assert.equal(out.json.result.pokaYokeViolation, true);
});

test('G26-08: pack cross-section uses cavity area as the reserve denominator', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['pack', 'cross-section', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    cavity: [['0 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '10 mm'], ['0 mm', '10 mm']],
    items: [{ center: ['5 mm', '5 mm', '0 mm'], radius: '2 mm' }],
    reserve: 0.3,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.passed, true, JSON.stringify(out.result));
  assert.equal(out.result.reserve.denominator, 'cavity area');
  near(out.result.cavityArea, 1);
  assert.ok(out.result.occupiedUnionArea > 0, JSON.stringify(out.result));
});

test('G26-09: keepout check flags a keepout outside the board outline', (t) => {
  if (skipLive(t)) return;
  const inside = fmcad(['keepout', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, board: { outline: boardOutline },
    keepouts: [{ name: 'K1', outline: [['2 mm', '2 mm'], ['8 mm', '2 mm'], ['8 mm', '8 mm'], ['2 mm', '8 mm']] }],
  })]);
  assert.equal(inside.result.passed, true, JSON.stringify(inside.result));

  const outside = cad(['keepout', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, board: { outline: boardOutline },
    keepouts: [{ name: 'K2', outline: [['15 mm', '15 mm'], ['25 mm', '15 mm'], ['25 mm', '25 mm'], ['15 mm', '25 mm']] }],
  })]).json;
  assert.ok(outside, 'expected a JSON envelope for a failing keepout.check');
  assert.equal(outside.result.passed, false, JSON.stringify(outside.result));
  assert.ok(outside.result.violations.length > 0, JSON.stringify(outside.result));
});

test('G26-10: PCB02/04 height zones and through-hole tails, FPC never scaled', (t) => {
  if (skipLive(t)) return;
  const pcb = fmcad(['pcb', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    board: {
      thickness: '1.6 mm', outline: boardOutline,
      holes: [
        { center: ['5 mm', '5 mm', '0 mm'], type: 'round', diameter: '2 mm' },
        { center: ['10 mm', '10 mm', '0 mm'], type: 'slot', length: '4 mm', width: '1 mm' },
      ],
      heightZones: [{ side: 'top' }, { side: 'bottom' }],
    },
  })]);
  assert.equal(pcb.result.passed, true, JSON.stringify(pcb.result));
  assert.equal(pcb.result.holeCount, 2);
  assert.ok(pcb.result.heightZones.includes('bottom'));

  const fpc = fmcad(['fpc', 'fold', '--doc', docName(), '--data', JSON.stringify({ schemaVersion: 1, chain: foldChain })]);
  assert.equal(fpc.result.scaled, false);
  near(fpc.result.foldedNeutralLength, fpc.result.flatNeutralLength);
});

test('G26-11: equal area but geometrically out-of-fit shape is rejected', (t) => {
  if (skipLive(t)) return;
  const out = cad(['pack', 'cross-section', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    cavity: [['0 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '10 mm'], ['0 mm', '10 mm']],
    items: [{ outline: [['8 mm', '8 mm'], ['16 mm', '8 mm'], ['16 mm', '16 mm'], ['8 mm', '16 mm']] }],
    reserve: 0.0,
  })]).json;
  assert.ok(out, 'expected a JSON envelope for a failing pack.cross-section');
  assert.equal(out.result.passed, false, JSON.stringify(out.result));
  assert.ok(out.result.shapeFitViolations.length > 0, JSON.stringify(out.result));
});

test('G26-12: native ECAD/flex remains an explicit gate, recipe is the honest alternative', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['fpc', 'fold', '--doc', docName(), '--data', JSON.stringify({ schemaVersion: 1, chain: foldChain })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.limitations.some((l) => l.includes('ECAD')), JSON.stringify(out.limitations));
});
