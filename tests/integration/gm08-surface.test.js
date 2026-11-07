'use strict';

// GM08 (surface) live integration tests. Each test invokes the real fmcad CLI
// against the coordinator-provided cloud document and asserts the SPEC's
// expected result, including blocked-not-substituted where the SPEC declares a
// gap. With FMCAD_TEST_DOC unset every test and hook skips cleanly.

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

function buildCircle(doc, sketchName, radius = '20 mm', center = ['0 mm', '0 mm', '0 mm']) {
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: sketchName, plane: 'XY' })]);
  fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: sketchName,
    geometry: [{ type: 'circle', center, radius }],
  })]);
}

function buildBox(doc) {
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: 'BoxSketch', plane: 'XY' })]);
  fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: 'BoxSketch',
    geometry: [{ type: 'rectangle', start: ['0 mm', '0 mm', '0 mm'], end: ['40 mm', '20 mm', '0 mm'] }],
  })]);
  return fmcad(['model', 'extrude', '--doc', doc, '--data', JSON.stringify({
    name: 'Box', profile: { kind: 'profile', sketch: 'BoxSketch', index: 0 },
    distance: '10 mm', operation: 'newBody',
  })]);
}

test('G08-01: model.revolve solid:false produces a surface body', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  // Revolve an off-axis circle around Y so the profile does not cross the axis of
  // rotation (a center-on-axis full circle would self-intersect and be refused).
  buildCircle(doc, 'Section', '20 mm', ['30 mm', '0 mm', '0 mm']);
  const out = fmcad(['model', 'revolve', '--doc', doc, '--data', JSON.stringify({
    profile: { kind: 'profile', sketch: 'Section', index: 0 },
    axis: 'Y', angle: '360 deg', solid: false, name: 'RevolvedSurface',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.surfaceVariant, true);
  assert.equal(out.result.isSolid, false);
  assert.ok(out.result.bodies.length >= 1);
});

test('G08-02: surface.patch continuity G1/G2 is blocked (no public API)', (t) => {
  if (skipLive(t)) return;
  assert.throws(() => fmcad(['surface', 'patch', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    boundary: { kind: 'profile', sketch: 'Section', index: 0 },
    continuity: 'G1',
  })]), /Boundary continuity/);
});

test('G08-03: surface.stitch with protected zones is blocked', (t) => {
  if (skipLive(t)) return;
  assert.throws(() => fmcad(['surface', 'stitch', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    bodies: ['SurfaceA', 'SurfaceB'], tolerance: '0.01 mm',
    protected: [{ token: 'protected-body' }],
  })]), /Protected zones/);
});

test('G08-04: surface.trim with protected zones is blocked', (t) => {
  if (skipLive(t)) return;
  assert.throws(() => fmcad(['surface', 'trim', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    tool: 'XZ', mode: 'plan',
    protected: [{ token: 'protected-body' }],
  })]), /Protected zones/);
});

test('G08-05: surface.offset with protected zones is blocked', (t) => {
  if (skipLive(t)) return;
  assert.throws(() => fmcad(['surface', 'offset', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    faces: [{ token: 'face-token' }], distance: '1 mm',
    protected: [{ token: 'protected-body' }],
  })]), /Protected zones/);
});

test('G08-06: surface.extend with protected zones is blocked (critical-zone protection)', (t) => {
  if (skipLive(t)) return;
  assert.throws(() => fmcad(['surface', 'extend', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    edges: [{ token: 'edge-token' }], distance: '2 mm',
    protected: [{ token: 'protected-body' }],
  })]), /Protected zones/);
});

test('G08-07: surface.check measures free edges and solid closure', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const box = buildBox(doc);
  assert.equal(box.success, true, JSON.stringify(box));
  const out = fmcad(['surface', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    bodies: [box.result.bodies[0]], expectSolid: true, expectClosed: true,
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const row = out.result.bodies[0];
  assert.equal(row.isSolid, true);
  assert.equal(row.freeEdgeCount, 0);
  // A closed solid has no free edges; passing sampled G0/G1/G2 seam evidence
  // requires edge/face token discovery and is covered by tests/surface_test.py.
});

test('G08-08: capsule/arm from a reference with section/shell regeneration', (t) => {
  // Requires a CWG image reference plus cross-section regeneration, which needs
  // the reference/image and datum families to set up a fixture. Not exercised
  // here; the surface variants and measured-evidence contract are covered by
  // G08-01..G08-07 and tests/surface_test.py.
  if (skipLive(t)) return;
  t.skip('requires CWG reference + section regeneration fixture');
});
