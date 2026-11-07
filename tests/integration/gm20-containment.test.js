'use strict';

// Live integration tests for GM20 (containment): analytic inside/outside/boundary
// classification with an own signed-distance boundary tolerance, corridors and
// control-region occupancy. Analytic regions are computed locally (no geometry).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

const cylinder = (points, extra = {}) => ({
  schemaVersion: 1, frame: 'component',
  region: { type: 'cylinder', origin: ['0 mm', '0 mm', '0 mm'], direction: [0, 0, 1], radius: '5 mm', height: '10 mm' },
  points, boundaryTolerance: '0.01 mm', ...extra,
});

test('G20-01: measure contains classifies inside, outside and boundary points', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify(cylinder([
    ['0 mm', '0 mm', '5 mm'], ['6 mm', '0 mm', '5 mm'], ['4.999 mm', '0 mm', '5 mm'],
  ]))]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.result.results.map((r) => r.classification),
    ['inside', 'outside', 'boundary'], JSON.stringify(out));
  assert.deepEqual(out.result.counts, { inside: 1, outside: 1, boundary: 1, error: 0, unknown: 0 }, JSON.stringify(out));
  assert.equal(out.frame.space, 'component', JSON.stringify(out));
});

test('G20-02: boundary membership uses the own signed-distance tolerance method', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify(cylinder([
    ['0 mm', '0 mm', '5 mm'], ['4.999 mm', '0 mm', '5 mm'], ['4.98 mm', '0 mm', '5 mm'], ['6 mm', '0 mm', '5 mm'],
  ]))]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.boundaryTolerance, 0.001, 1e-9, 'boundaryTolerance cm');
  assert.deepEqual(out.result.results.map((r) => r.classification),
    ['inside', 'boundary', 'inside', 'outside'], JSON.stringify(out));
  // The boundary point carries its distance to the region surface.
  assert.ok(out.result.results[1].boundaryDistance < out.result.boundaryTolerance, JSON.stringify(out));
  assert.match(out.limitations.join(' '), /signed-distance/, JSON.stringify(out));
});

test('G20-03: measure corridor reports swept-circle clearance and intrusions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'corridor', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    path: [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '0 mm'], ['0 mm', '20 mm', '0 mm']],
    radius: '2 mm',
    obstacles: [{ point: ['3 mm', '5 mm', '0 mm'] }, { point: ['0.5 mm', '5 mm', '0 mm'] }],
    minimumClearance: '0.5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const occupancy = out.result.occupancy;
  near(occupancy[0].clearance, 0.1, 1e-5, 'obstacle 0 clearance');
  assert.equal(occupancy[0].intrudes, false, JSON.stringify(out));
  near(occupancy[1].clearance, -0.15, 1e-5, 'obstacle 1 clearance');
  assert.equal(occupancy[1].intrudes, true, JSON.stringify(out));
  assert.equal(out.result.intrusions, 1, JSON.stringify(out));
  near(out.result.arcLength, 2.0, 1e-5, 'arcLength cm');
});

test('G20-04: measure region reports occupancy and per-section occupied area', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'region', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    region: { type: 'box', min: ['0 mm', '0 mm', '0 mm'], max: ['10 mm', '10 mm', '10 mm'] },
    occupants: [{ point: ['5 mm', '5 mm', '5 mm'], radius: '2 mm' }, { point: ['20 mm', '5 mm', '5 mm'] }],
    sections: [{ z: '5 mm' }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.occupiedCount, 1, JSON.stringify(out));
  assert.equal(out.result.occupantCount, 2, JSON.stringify(out));
  assert.equal(out.result.sections[0].occupantCount, 1, JSON.stringify(out));
  assert.ok(out.result.sections[0].occupiedUnionArea > 0, JSON.stringify(out));
});

test('G20-05: a ring region keeps its open inner channel (exclusion, not filled)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    region: { type: 'ring', origin: ['0 mm', '0 mm', '0 mm'], direction: [0, 0, 1],
      outerRadius: '8 mm', innerRadius: '3 mm', height: '5 mm' },
    points: [['1 mm', '0 mm', '2.5 mm'], ['5 mm', '0 mm', '2.5 mm']],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.result.results.map((r) => r.classification),
    ['outside', 'inside'], JSON.stringify(out));
});

test('G20-06: signed distance and union of analytic regions classify boundary/exterior points', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const box = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    region: { type: 'box', min: ['0 mm', '0 mm', '0 mm'], max: ['10 mm', '10 mm', '10 mm'] },
    points: [['5 mm', '5 mm', '5 mm'], ['12 mm', '5 mm', '5 mm']],
  })]);
  assert.equal(box.status, 'pass', JSON.stringify(box));
  assert.deepEqual(box.result.results.map((r) => r.classification), ['inside', 'outside'], JSON.stringify(box));
  near(box.result.results[1].signedDistance, -0.2, 1e-5, 'box exterior signed distance');

  const sphere = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    region: { type: 'sphere', center: ['0 mm', '0 mm', '0 mm'], radius: '10 mm' },
    points: [['0 mm', '0 mm', '0 mm']],
  })]);
  assert.equal(sphere.result.results[0].classification, 'inside', JSON.stringify(sphere));

  const union = fmcad(['measure', 'contains', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    region: { type: 'union', regions: [
      { type: 'sphere', center: ['0 mm', '0 mm', '0 mm'], radius: '5 mm' },
      { type: 'sphere', center: ['10 mm', '0 mm', '0 mm'], radius: '5 mm' },
    ] },
    points: [['7 mm', '0 mm', '0 mm']],
  })]);
  assert.equal(union.result.results[0].classification, 'inside', JSON.stringify(union));
});
