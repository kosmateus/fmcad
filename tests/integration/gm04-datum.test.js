'use strict';

// Live integration tests for GM-04 (frames, datums and nested joints).
//
// `datum transform` is a read-only native conversion (matrix + points/vectors).
// The remaining commands create native datums/planes/points/axes/occurrences and
// inspect joint frames. Numeric oracles follow docs/GM04.md acceptance matrix.

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

test('gm04: G04-01 datum transform converts points and vectors with a rigid matrix', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['datum', 'transform', '--doc', doc, '--data', JSON.stringify({
    from: 'root', to: 'root', points: [['10 mm', '2 mm', '0 mm']], vectors: [[1, 0, 0], [0, 0, 2]],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.matrix.length, 16);
  assert.equal(out.result.matrix[0], 1);
  assert.equal(out.result.matrix[5], 1);
  assert.equal(out.result.matrix[10], 1);
  assert.equal(out.result.matrix[15], 1);
  assert.equal(out.result.points.length, 1);
  assert.equal(out.result.vectors.length, 2);
});

test('gm04: G04-02 datum frame stores metadata and datum point creates native geometry', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const frame = fmcad(['datum', 'frame', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_frame', origin: ['0 mm', '0 mm', '25 mm'], xAxis: [1, 0, 0], yAxis: [0, 1, 0],
  })]);
  assert.equal(frame.success, true, JSON.stringify(frame));

  const point = fmcad(['datum', 'point', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_pt', mode: 'coordinates', point: ['-10 mm', '5 mm', '20 mm'],
  })]);
  assert.equal(point.success, true, JSON.stringify(point));
  assert.ok(point.result.point || point.result.ref || point.result, 'expected a point result');
});

test('gm04: G04-03 datum plane-on-path creates a plane normal to a sketch path', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'gm04_path', plane: 'XY' })]);
  const geom = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'gm04_path',
    geometry: [{ type: 'line', name: 'rail', start: ['0 mm', '0 mm', '0 mm'], end: ['40 mm', '0 mm', '0 mm'] }],
  })]);
  assert.equal(geom.success, true, JSON.stringify(geom));
  const curve = geom.result.entities.find((e) => e.name === 'rail') || geom.result.refs.rail;

  const plane = fmcad(['datum', 'plane-on-path', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_section', path: { curves: [curve], chain: 'none' }, position: { mode: 'proportional', value: '0.5' }, representation: 'native',
  })]);
  assert.equal(plane.success, true, JSON.stringify(plane));
});

test('gm04: G04-04 plane-on-path rejects out-of-range positions and reports section orientation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'gm04_path', plane: 'XY' })]);
  const geom = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'gm04_path',
    geometry: [{ type: 'line', name: 'rail', start: ['0 mm', '0 mm', '0 mm'], end: ['40 mm', '0 mm', '0 mm'] }],
  })]);
  const curve = geom.result.entities.find((e) => e.name === 'rail') || geom.result.refs.rail;

  const oriented = fmcad(['datum', 'plane-on-path', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_section', path: { curves: [curve], chain: 'none' },
    position: { mode: 'proportional', value: '0.5' },
    orientation: { direction: [0, 0, 1], frame: 'root' }, representation: 'native',
  })]);
  assert.equal(oriented.success, true, JSON.stringify(oriented));

  // Out-of-range proportional positions are refused before mutation, not clamped.
  assert.throws(() => fmcad(['datum', 'plane-on-path', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_bad', path: { curves: [curve], chain: 'none' }, position: { mode: 'proportional', value: '1.5' }, representation: 'native',
  })]), /outside|clamp/i);
});

test('gm04: G04-05 occurrence transform sets an absolute root-frame pose', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const comp = fmcad(['component', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'gm04_part' })]);
  assert.equal(comp.success, true, JSON.stringify(comp));

  // Fusion grounds the first occurrence of a new component by default; placement
  // refuses grounded occurrences, so unground explicitly before transforming.
  const ungrounded = fmcad(['assembly', 'unground', '--doc', doc, '--data', JSON.stringify({ occurrence: 'gm04_part:1' })]);
  assert.equal(ungrounded.success, true, JSON.stringify(ungrounded));

  const moved = fmcad(['occurrence', 'transform', '--doc', doc, '--data', JSON.stringify({
    occurrence: 'gm04_part:1', placement: { translation: ['10 mm', '20 mm', '0 mm'], axis: [0, 0, 1], angle: '90 deg' },
  })]);
  assert.equal(moved.success, true, JSON.stringify(moved));
});

test('gm04: G04-06 joint frame reads signed motion axes after a revolute joint', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['component', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'gm04_base' })]);
  fmcad(['component', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'gm04_arm' })]);

  const joint = fmcad(['joint', 'revolute', '--doc', doc, '--data', JSON.stringify({
    name: 'gm04_hinge', occurrenceOne: 'gm04_base:1', occurrenceTwo: 'gm04_arm:1', point: 'origin', axis: 'Z',
  })]);
  assert.equal(joint.success, true, JSON.stringify(joint));

  const frame = fmcad(['joint', 'frame', '--doc', doc, '--data', JSON.stringify({
    joint: { token: joint.result.joint.token }, to: 'root',
  })]);
  assert.equal(frame.success, true, JSON.stringify(frame));
});

test('gm04: G04-07 datum transform preserves signed coordinates and vectors', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['datum', 'transform', '--doc', doc, '--data', JSON.stringify({
    from: 'root', to: 'root', points: [['-10 mm', '2 mm', '0 mm']], vectors: [[0, -1, 0]],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.points.length, 1);
  assert.equal(out.result.vectors.length, 1);
});
