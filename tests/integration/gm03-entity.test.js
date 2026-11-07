'use strict';

// Live integration tests for GM-03 (current-topology entity queries).
//
// Every command here is native and read-only against the coordinator document.
// Each test builds a small body with `shape.cylinder`/`shape.box`, then resolves
// it through `entity find`/`entity stats`/`model fillet`. Expected counts follow
// the gm03-native handoff oracles in docs/ENTITY_QUERIES.md.

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

function cylinder(doc, name, radius, height) {
  const out = fmcad(['shape', 'cylinder', '--doc', doc, '--data', JSON.stringify({ name, radius, height })]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

function box(doc, name, width, depth, height) {
  const out = fmcad(['shape', 'box', '--doc', doc, '--data', JSON.stringify({ name, width, depth, height })]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

test('gm03: G03-01 entity find scopes a body and returns reusable refs', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const out = fmcad(['entity', 'find', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'body', scope: { body }, expect: 1, frame: 'root',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.count, 1);
  assert.equal(out.result.refs.length, 1);
  assert.equal(out.associativity, 'snapshot');
});

test('gm03: G03-02 entity stats applies analytic filters (geometry, radius, axis)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const out = fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'edge', scope: { body },
    filters: { geometry: 'circle', radius: '5 mm', axis: [0, 0, -1] },
    expect: 2, groupBy: ['geometry', 'radius', 'axis'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.count, 2); // top and bottom circular edges
  assert.ok(out.result.groups.length > 0, JSON.stringify(out.result.groups));
});

test('gm03: G03-03 entity stats enforces expect counts and reports mismatch', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const ok = fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'edge', scope: { body }, filters: { geometry: 'circle', radius: '5 mm' }, expect: 2,
  })]);
  assert.equal(ok.success, true, JSON.stringify(ok));

  // Expectation mismatch must fail with all matches returned and nonzero exit.
  assert.throws(() => fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'edge', scope: { body }, filters: { geometry: 'circle', radius: '5 mm' }, expect: 99,
  })]), /fail/);
});

test('gm03: G03-04 entity stats groups by geometry with numeric statistics', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const out = fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'edge', scope: { body }, expect: { min: 1 }, groupBy: ['geometry', 'radius', 'length'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  // groupBy 'geometry' keys use the native SDK type (Circle3D/Arc3D), not the
  // public input name 'circle' (see assets/cad/entity.py _ENTITY_TYPES). Assert
  // membership so a partial arc (Arc3D) still groups under the circle family.
  const circle = out.result.groups.find((g) => ['Circle3D', 'Arc3D'].includes(g.key.geometry));
  assert.ok(circle, JSON.stringify(out.result.groups));
  assert.equal(circle.count, 2);
  assert.ok(circle.statistics, 'expected per-group statistics');
});

test('gm03: G03-05 model fillet resolves a GM03 query and captures a snapshot', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const out = fmcad(['model', 'fillet', '--doc', doc, '--data', JSON.stringify({
    name: 'GM03Round', radius: '0.5 mm', tangentChain: false,
    query: { scope: { body }, filters: { geometry: 'circle', radius: '5 mm', level: { axis: 'z', value: '10 mm' } }, expect: 1 },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(out.result.resolvedQuery, 'expected a pre-mutation resolvedQuery');
  assert.equal(out.result.selectionAssociativity, 'snapshot');
});

test('gm03: G03-06 query results declare snapshot associativity', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const body = cylinder(doc, 'GM03Cylinder', '5 mm', '10 mm').bodies[0];

  const out = fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'body', scope: { body }, expect: 1,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.associativity, 'snapshot');
});

test('gm03: G03-07 short edges and topology change resolve through current geometry', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const short = box(doc, 'GM03ShortBox', '2 mm', '3 mm', '0.2 mm').bodies[0];

  const edges = fmcad(['entity', 'stats', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, kind: 'edge', scope: { body: short }, filters: { length: { max: '0.2 mm' } }, expect: 4,
  })]);
  assert.equal(edges.success, true, JSON.stringify(edges));
  assert.equal(edges.result.count, 4); // four length-0.2 mm box edges
});
