'use strict';

// Live integration tests for GM-07 (file profiles, fitting, inspection and
// normal offsets).
//
// `sketch profile-file` / `curve fit` adapt samples into the existing sketch
// geometry DSL; `curve inspect` reads continuity/closure; `curve offset` builds
// an expression-driven normal offset. All commands are native and read/write the
// coordinator document. G07-07 (live gasket/cam recipe) remains open in C_todo.

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

function makeSketch(doc, name) {
  const out = fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name, plane: 'XY' })]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

test('gm07: G07-01 sketch profile-file imports an open cam without adding a chord', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Profile');
  const out = fmcad(['sketch', 'profile-file', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Profile', frame: 'sketch', plane: 'sketchXY',
    columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: false, interpolation: 'spline',
    records: [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 8 }, { x: 12, y: 12 }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(Array.isArray(out.result.entities), 'expected created curve entities');
});

test('gm07: G07-02 sketch profile-file honors closed loops and winding', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Closed');
  const out = fmcad(['sketch', 'profile-file', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Closed', frame: 'sketch', plane: 'sketchXY',
    columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: true, winding: 'cw',
    records: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));

  // Closed data that is missing its repeated endpoint must refuse a chord.
  assert.throws(() => fmcad(['sketch', 'profile-file', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Closed', frame: 'sketch', plane: 'sketchXY',
    columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: true,
    records: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  })]), /chord|endpoint/i);
});

test('gm07: G07-03 curve fit returns sample provenance and fitted geometry', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Fit');
  const out = fmcad(['curve', 'fit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Fit', frame: 'sketch', plane: 'sketchXY',
    columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: false,
    records: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.match(out.result.provenance.sha256, /^[a-f0-9]{64}$/);
});

test('gm07: G07-04 curve inspect reports continuity, closure and crossings', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Profile');
  const profile = fmcad(['sketch', 'profile-file', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Profile', frame: 'sketch', plane: 'sketchXY',
    columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: false, interpolation: 'spline',
    records: [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 8 }, { x: 12, y: 12 }],
  })]);
  const out = fmcad(['curve', 'inspect', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Profile', frame: 'sketch', entities: profile.result.entities,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
});

test('gm07: G07-05 curve offset builds a normal offset and exposes its dimension', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Offset');
  const geom = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'GM07_Offset',
    geometry: [{ type: 'circle', name: 'rim', center: ['0 mm', '0 mm', '0 mm'], radius: '10 mm' }],
  })]);
  assert.equal(geom.success, true, JSON.stringify(geom));
  const out = fmcad(['curve', 'offset', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Offset', frame: 'sketch', entities: [geom.result.refs.rim], distance: '1 mm', side: 'right',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.offsetParameter, 'expected the native offset dimension name');
});

test('gm07: G07-06 curve offset blocks an infeasible inward offset at the radius', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  makeSketch(doc, 'GM07_Infeasible');
  const geom = fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'GM07_Infeasible',
    geometry: [{ type: 'circle', name: 'rim', center: ['0 mm', '0 mm', '0 mm'], radius: '10 mm' }],
  })]);
  assert.equal(geom.success, true, JSON.stringify(geom));
  assert.throws(() => fmcad(['curve', 'offset', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, sketch: 'GM07_Infeasible', frame: 'sketch', entities: [geom.result.refs.rim], distance: '10 mm', side: 'left',
  })]), /blocked|infeasible|radius/i);
});
