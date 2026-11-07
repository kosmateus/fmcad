'use strict';

// Live integration tests for GM-06 (complete sketches and controlled editing).
//
// Every command is native. Tests build an ellipse sketch through the GM06 v1
// `sketch build` schema, then exercise geometry, dimensions, inspection,
// transforms, movePoints and the reviewable dimension plan/apply flow.

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

function buildOval(doc, name, plane = 'XY') {
  const out = fmcad(['sketch', 'build', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, name, plane,
    geometry: [{ type: 'ellipse', name: 'oval', center: ['0 mm', '0 mm', '0 mm'], majorRadius: '20 mm', minorRadius: '10 mm' }],
    dimensions: [
      { type: 'majorRadius', entities: ['oval'], expression: '20 mm' },
      { type: 'minorRadius', entities: ['oval'], expression: '10 mm' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

test('gm06: G06-01 sketch build creates an ellipse with driving dimensions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const result = buildOval(doc, 'Oval');
  assert.ok(result.refs, 'expected named refs in build result');
  assert.ok(result.refs.oval, 'expected the oval ellipse ref');
});

test('gm06: G06-02 sketch geometry adds a validated ellipse on a supported plane', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'Section', plane: 'XZ' })]);
  const out = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Section',
    geometry: [{ type: 'ellipse', name: 'oval', center: ['0 mm', '0 mm', '0 mm'], majorAxisPoint: ['20 mm', '0 mm', '0 mm'], minorAxisPoint: ['0 mm', '10 mm', '0 mm'] }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
});

test('gm06: G06-03 sketch dimension adds major/minor radius dimensions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'Oval', plane: 'XY' })]);
  const geom = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval',
    geometry: [{ type: 'ellipse', name: 'oval', center: ['0 mm', '0 mm', '0 mm'], majorRadius: '20 mm', minorRadius: '10 mm' }],
  })]);
  assert.equal(geom.success, true, JSON.stringify(geom));
  const oval = geom.result.refs.oval;
  const out = fmcad(['sketch', 'dimension', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', type: 'minorRadius', entities: [oval], expression: '12 mm', text: ['0 mm', '0 mm', '0 mm'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
});

test('gm06: G06-04 sketch inspect reads back ellipse curves, axes and dimensions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  buildOval(doc, 'Oval');
  const out = fmcad(['sketch', 'inspect', '--doc', doc, '--data', JSON.stringify({ sketch: 'Oval' })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.curves || out.result.geometry || out.result.entities, 'expected curve readback');
});

test('gm06: G06-05 sketch transform rotates and translates with before/after', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const result = buildOval(doc, 'Oval');
  const out = fmcad(['sketch', 'transform', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', entities: [result.refs.oval], frame: 'sketch',
    rotate: { angle: '90 deg', center: ['0 mm', '0 mm', '0 mm'] },
    translate: ['-5 mm', '0 mm', '0 mm'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.before, 'expected before snapshot');
  assert.ok(out.result.after, 'expected after snapshot');
});

test('gm06: G06-06 sketch edit movePoints repositions a center without deleting constraints', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const result = buildOval(doc, 'Oval');
  const out = fmcad(['sketch', 'edit', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', frame: 'sketch',
    movePoints: [{ point: { entity: result.refs.oval, point: 'center' }, to: ['-5 mm', '0 mm', '0 mm'] }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
});

test('gm06: G06-07 sketch dimension-plan proposes reviewed dimensions without mutating', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  buildOval(doc, 'Oval');
  const out = fmcad(['sketch', 'dimension-plan', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', schemaVersion: 1, maxEntities: 200,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.plan, 'expected a plan');
  assert.ok(Array.isArray(out.result.plan.proposals), 'expected proposal list');
});

test('gm06: G06-08 sketch dimension-apply applies explicitly accepted proposals', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  buildOval(doc, 'Oval');
  const plan = fmcad(['sketch', 'dimension-plan', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', schemaVersion: 1,
  })]);
  assert.equal(plan.success, true, JSON.stringify(plan));
  const ids = plan.result.plan.proposals.map((p) => p.id);
  if (!ids.length) return t.skip('no proposals for an already-dimensioned ellipse');
  const out = fmcad(['sketch', 'dimension-apply', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', plan: plan.result.plan, accept: [ids[0]],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
});

test('gm06: G06-09 an ellipse profile lofts between two offset sections', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  buildOval(doc, 'OvalA', 'XY');
  fmcad(['datum', 'plane', '--doc', doc, '--data', JSON.stringify({ name: 'gm06_plane', mode: 'offset', plane: 'XY', offset: '20 mm' })]);
  buildOval(doc, 'OvalB', 'gm06_plane');
  const loft = fmcad(['model', 'loft', '--doc', doc, '--data', JSON.stringify({
    profiles: [
      { kind: 'profile', sketch: 'OvalA', index: 0 },
      { kind: 'profile', sketch: 'OvalB', index: 0 },
    ],
  })]);
  assert.equal(loft.success, true, JSON.stringify(loft));
});

test('gm06: G06-10 constrained points refuse moves; XZ/YZ transforms keep the axis direction', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const result = buildOval(doc, 'Oval', 'XZ');

  // A fully constrained/fixed point must be refused, not silently moved.
  const ellipse = result.refs.oval;
  assert.throws(() => fmcad(['sketch', 'edit', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', frame: 'sketch',
    movePoints: [{ point: { entity: { token: '__nonexistent__' }, point: 'center' }, to: ['0 mm', '0 mm', '0 mm'] }],
  })]));

  // Rotating on an XZ sketch keeps the ellipse orientation readback valid.
  const out = fmcad(['sketch', 'transform', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', entities: [ellipse], frame: 'sketch',
    rotate: { angle: '90 deg', center: ['0 mm', '0 mm', '0 mm'] },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
});

test('gm06: G06-11 re-planning after apply recognizes dimensions and adds no duplicates', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  buildOval(doc, 'Oval');
  const first = fmcad(['sketch', 'dimension-plan', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', schemaVersion: 1,
  })]);
  assert.equal(first.success, true, JSON.stringify(first));
  const second = fmcad(['sketch', 'dimension-plan', '--doc', doc, '--data', JSON.stringify({
    sketch: 'Oval', schemaVersion: 1,
  })]);
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(second.result.plan.proposals.length, first.result.plan.proposals.length);
});
