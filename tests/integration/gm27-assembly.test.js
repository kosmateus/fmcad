'use strict';

// Shared owned-backend extraction: tests/scenarios/gm27-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-27 (assembly sequence, service path-check, tool
// access, fixture access). All read-only recipe commands against the shared doc.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);

test('G27-01: assembly sequence orders rigid dependencies, media never rigidized', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['assembly', 'sequence', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    parts: ['base', 'connector', 'shaft', 'housing'],
    dependencies: [['base', 'connector'], ['connector', 'shaft'], ['shaft', 'housing']],
    removedParts: ['connector'],
    disconnectedMedia: [{ name: 'PWR-cable', connects: ['connector', 'shaft'] }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(out.result.order, ['base', 'connector', 'shaft', 'housing']);
  assert.deepEqual(out.result.disassemblyOrder, ['housing', 'shaft', 'connector', 'base']);
  assert.equal(out.result.mediaRigidized, false);
  assert.deepEqual(out.result.blockers.shaft, ['connector']);
  const removals = { ...Object.fromEntries(out.result.removals.map((r) => [r.part, r])) };
  assert.deepEqual(removals.connector.removeBlockers, ['shaft']);
  assert.deepEqual(removals.connector.disconnections, ['PWR-cable']);
});

test('G27-02: service path-check verifies a straight tank withdrawal', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['service', 'path-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    part: { name: 'tank', outline: [['-10 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '20 mm'], ['-10 mm', '20 mm']] },
    direction: [0, 1], distance: '30 mm',
    obstacles: [{ name: 'wall', outline: [['15 mm', '0 mm'], ['30 mm', '0 mm'], ['30 mm', '50 mm'], ['15 mm', '50 mm']] }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.feasible, true, JSON.stringify(out.result));
  assert.equal(out.result.blocked, false);
  assert.deepEqual(out.result.blockers, []);
  near(out.result.minClearance, 0.5);
});

test('G27-03: D6x40 tool reaches the fastener seat', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['tool', 'access', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    tool: { diameter: '6 mm', length: '40 mm' },
    target: { origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1], engagementDepth: '4 mm' },
    entry: { origin: ['0 mm', '0 mm', '30 mm'], direction: [0, 0, -1] },
    obstacles: [{ name: 'rib', point: ['6 mm', '0 mm', '15 mm'], radius: '2 mm' }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.reachable, true, JSON.stringify(out.result));
  assert.equal(out.result.lengthSufficient, true);
  assert.equal(out.result.axisAligned, true);
  near(out.result.reach, 2.6);
  assert.deepEqual(out.result.blockers, []);
});

test('G27-04: fixture access seats a pin/hole and datum pair', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['fixture', 'access', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    part: { name: 'pcb', features: [
      { name: 'pinA', kind: 'pin', origin: ['0 mm', '0 mm', '0 mm'], diameter: '2 mm' },
      { name: 'datA', kind: 'datum', origin: ['10 mm', '0 mm', '0 mm'], direction: [0, 0, 1] },
    ] },
    fixture: { approach: { direction: [0, 0, 1] }, features: [
      { name: 'holeA', kind: 'hole', origin: ['0 mm', '0 mm', '0 mm'], diameter: '2.1 mm' },
      { name: 'datA', kind: 'datum', origin: ['10 mm', '0 mm', '0 mm'], direction: [0, 0, 1] },
    ] },
    pairs: [['pinA', 'holeA'], ['datA', 'datA']],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.seatPossible, true, JSON.stringify(out.result));
  assert.ok(out.result.pairs.every((p) => p.fits), JSON.stringify(out.result.pairs));
});

test('G27-05: trapped screw requires cover removal first', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['assembly', 'sequence', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    parts: ['housing', 'screw', 'cover'],
    dependencies: [['screw', 'cover'], ['housing', 'cover']],
    removedParts: ['screw'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  const screw = out.result.removals.find((r) => r.part === 'screw');
  assert.deepEqual(screw.removeBlockers, ['cover']);
});

test('G27-06: head/ring/power service states; exploded endpoint is never an assembly path', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['assembly', 'sequence', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    parts: ['head', 'ring', 'power', 'chassis'],
    dependencies: [['chassis', 'head'], ['chassis', 'ring'], ['chassis', 'power']],
    removedParts: ['head', 'ring', 'power'],
    serviceStates: [
      { part: 'head', requires: [{ media: 'head-media', state: 'disconnected' }] },
      { part: 'ring', requires: [{ media: 'ring-media', state: 'disconnected' }] },
      { part: 'power', requires: [{ state: 'powerOff' }, { media: 'power-cable', state: 'disconnected' }] },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  const removals = { ...Object.fromEntries(out.result.removals.map((r) => [r.part, r])) };
  assert.deepEqual(removals.power.servicePrerequisites, [
    { state: 'powerOff' }, { media: 'power-cable', state: 'disconnected' },
  ]);
  assert.deepEqual(removals.head.servicePrerequisites, [{ media: 'head-media', state: 'disconnected' }]);
  assert.ok(out.limitations.some((l) => l.includes('exploded endpoint')), JSON.stringify(out.limitations));
});
