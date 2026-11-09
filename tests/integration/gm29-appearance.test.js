'use strict';

// Shared owned-backend extraction: tests/scenarios/gm29-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-29 (appearances, materials, textures, metadata).
// Appearance/material resources are RETAINED by document clear (see
// docs/DOCUMENT_CLEAR.md "Retained"), so these tests use timestamped unique
// names and never assume a freshly empty style library. Every command targets
// the coordinator-provided cloud document and leaves it cleared before/after.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () {
  if (!hasDoc()) return;
  clear();
});
afterEach(function () {
  if (!hasDoc()) return;
  clear();
});

// Return the first design-local appearance ID, or throw a clear error.
function sourceAppearance(doc) {
  const list = fmcad(['appearance', 'list', '--doc', doc, '--data', '{}']);
  assert.equal(list.success, true, JSON.stringify(list));
  assert.ok(list.result.items.length > 0, 'design exposes no appearance to copy');
  return list.result.items[0].id;
}

// Return the first design-local material ID, or throw a clear error.
function sourceMaterial(doc) {
  const list = fmcad(['material', 'list', '--doc', doc, '--data', '{}']);
  assert.equal(list.success, true, JSON.stringify(list));
  assert.ok(list.result.items.length > 0, 'design exposes no material to copy');
  return list.result.items[0].id;
}

// Copy an appearance under a unique name and return the created id.
function createAppearance(doc) {
  const sourceId = sourceAppearance(doc);
  const created = fmcad(['appearance', 'create', '--doc', doc, '--data', JSON.stringify({
    name: 'FMCAD G29 Paint ' + Date.now(),
    id: sourceId,
  })]);
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.result.copiedFrom, sourceId);
  assert.ok(typeof created.result.id === 'string' && created.result.id.length > 0);
  return created.result.id;
}

// Copy a material under a unique name and return the created id.
function createMaterial(doc) {
  const sourceId = sourceMaterial(doc);
  const created = fmcad(['material', 'create', '--doc', doc, '--data', JSON.stringify({
    name: 'FMCAD G29 ABS ' + Date.now(),
    id: sourceId,
  })]);
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.result.copiedFrom, sourceId);
  assert.ok(typeof created.result.id === 'string' && created.result.id.length > 0);
  return created.result.id;
}

test('gm29: G29-01 appearance.create copies a resource and edit renames it', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const sourceId = sourceAppearance(doc);

  const created = fmcad(['appearance', 'create', '--doc', doc, '--data', JSON.stringify({
    name: 'FMCAD G29 Paint ' + Date.now(),
    id: sourceId,
  })]);
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.result.copiedFrom, sourceId);

  const edited = fmcad(['appearance', 'edit', '--doc', doc, '--data', JSON.stringify({
    id: created.result.id,
    name: 'FMCAD G29 Renamed ' + Date.now(),
  })]);
  assert.equal(edited.status, 'pass', JSON.stringify(edited));
  assert.equal(edited.result.changed, true);
  assert.ok(edited.result.changedFields.includes('name'));
});

test('gm29: G29-02 appearance.texture connects a channel on a design-local appearance', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const id = createAppearance(doc);

  const out = cad(['appearance', 'texture', '--doc', doc, '--data', JSON.stringify({
    id,
    channel: 'color',
    image: '',
  })]);
  // The colorTexture setter is a preview feature; an installed SDK that lacks it
  // reports an honest blocked envelope rather than silently substituting.
  if (out.json && out.json.status === 'blocked') {
    assert.equal(out.json.success, false, JSON.stringify(out.json));
    return;
  }
  assert.equal(out.json.status, 'pass', JSON.stringify(out.json));
  assert.ok(out.json.result.changed.includes('image'));
  assert.equal(out.json.result.after.image, '');
});

test('gm29: G29-03 appearance.projection reads current type and gates a set request', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const id = createAppearance(doc);

  const read = fmcad(['appearance', 'projection', '--doc', doc, '--data', JSON.stringify({ id })]);
  assert.equal(read.status, 'pass', JSON.stringify(read));
  assert.equal(read.result.changed, false);
  assert.ok(read.result.projection === null || typeof read.result.projection === 'string');

  const set = cad(['appearance', 'projection', '--doc', doc, '--data', JSON.stringify({
    id,
    projection: 'planar',
  })]);
  if (set.json.status === 'blocked') {
    assert.equal(set.json.success, false, JSON.stringify(set.json));
  } else {
    assert.equal(set.json.status, 'pass', JSON.stringify(set.json));
    assert.equal(set.json.result.changed, true);
  }
});

test('gm29: G29-04 material.create copies a physical material and edit renames it', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const sourceId = sourceMaterial(doc);

  const created = fmcad(['material', 'create', '--doc', doc, '--data', JSON.stringify({
    name: 'FMCAD G29 ABS ' + Date.now(),
    id: sourceId,
  })]);
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.result.copiedFrom, sourceId);

  const edited = fmcad(['material', 'edit', '--doc', doc, '--data', JSON.stringify({
    id: created.result.id,
    name: 'FMCAD G29 ABS Renamed ' + Date.now(),
  })]);
  assert.equal(edited.status, 'pass', JSON.stringify(edited));
  assert.equal(edited.result.changed, true);
  assert.ok(edited.result.changedFields.includes('name'));
});

test('gm29: G29-05 entity.attribute set/get store namespaced strings on the root component', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const group = 'fmcad.g29';

  const set = fmcad(['entity', 'attribute', 'set', '--doc', doc, '--data', JSON.stringify({
    ref: { name: 'root' },
    group,
    name: 'source',
    value: 'STEP import',
  })]);
  assert.equal(set.status, 'pass', JSON.stringify(set));
  assert.equal(set.result.changed, true);
  assert.equal(set.result.resourceIdentity.kind, 'component');

  const got = fmcad(['entity', 'attribute', 'get', '--doc', doc, '--data', JSON.stringify({
    ref: { name: 'root' },
    group,
    name: 'source',
  })]);
  assert.equal(got.status, 'pass', JSON.stringify(got));
  assert.deepEqual(got.result.attributes, [{ name: 'source', value: 'STEP import' }]);
});

test('gm29: G29-06 material.assign-map reads assignments without assuming equivalence', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['material', 'assign-map', '--doc', doc, '--data', JSON.stringify({
    refs: [{ name: 'root' }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.kind, 'material');
  assert.ok(Array.isArray(out.result.assignments));
  assert.equal(out.result.mismatchCount, 0);
});

test('gm29: G29-07 appearance.assign-map reads assignments (body/face/occurrence scope)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['appearance', 'assign-map', '--doc', doc, '--data', JSON.stringify({
    refs: [{ name: 'root' }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.kind, 'appearance');
  assert.ok(Array.isArray(out.result.assignments));
  assert.equal(out.result.mismatchCount, 0);
});

test('gm29: G29-08 styles.report aggregates appearance/material state and flags duplicates', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  // A report with no duplicate names passes; accumulated duplicates (styles are
  // retained across clears) are disclosed as a fail and exit nonzero, never
  // assumed equivalent. Use cad() so the fail envelope can be asserted directly.
  const out = cad(['styles', 'report', '--doc', doc, '--data', JSON.stringify({
    refs: [{ name: 'root' }],
  })]);
  const body = out.json;
  assert.ok(body, 'expected a JSON envelope: ' + out.stderr);
  assert.ok(body.status === 'pass' || body.status === 'fail', JSON.stringify(body));
  assert.ok(Array.isArray(body.result.styles));
  assert.ok(Array.isArray(body.result.density));
  assert.equal(typeof body.result.appearanceCount, 'number');
  assert.equal(typeof body.result.materialCount, 'number');
  assert.ok(body.result.duplicateNames && typeof body.result.duplicateNames.appearance === 'object');
  assert.ok(body.result.duplicateNames && typeof body.result.duplicateNames.material === 'object');
});

test('gm29: G29-09 texture.heightmap writes a deterministic tileable PNG', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  // Fusion-host path: /tmp maps to \\wsl$\<distro>\tmp on the Fusion machine.
  const path = '/tmp/fmcad-g29-heightmap-' + Date.now() + '.png';
  const out = fmcad(['texture', 'heightmap', '--doc', doc, '--data', JSON.stringify({
    path,
    width: 64,
    height: 64,
    seed: 7,
    amplitude: 0.8,
    period: 8,
    pattern: 'waves',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.deterministic, true);
  assert.equal(out.result.file.exists, true);
  assert.ok(/^[0-9a-f]{64}$/.test(out.result.sha256));
  assert.equal(out.result.parameters.pattern, 'waves');
});

test('gm29: G29-10 texture.heightmap is byte-deterministic and never silently overwrites', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const path = '/tmp/fmcad-g29-heightmap-' + Date.now() + '.png';
  const params = { width: 64, height: 64, seed: 11, amplitude: 0.5, period: 8, pattern: 'grooves' };

  const first = fmcad(['texture', 'heightmap', '--doc', doc, '--data', JSON.stringify({ path, ...params })]);
  const second = fmcad(['texture', 'heightmap', '--doc', doc, '--data', JSON.stringify({
    path, ...params, overwrite: true, confirm: true,
  })]);
  assert.equal(first.result.sha256, second.result.sha256);
  assert.deepEqual(first.result.parameters, second.result.parameters);

  // A third write without overwrite permission is refused, not silently replaced.
  const refused = cad(['texture', 'heightmap', '--doc', doc, '--data', JSON.stringify({
    path, ...params, pattern: 'noise',
  })]);
  assert.notEqual(refused.code, 0);
  assert.ok((refused.stdout + refused.stderr).includes('requires overwrite'), refused.stderr);
});

test('gm29: G29-11 appearance.create reports typed property descriptors for the copy', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const sourceId = sourceAppearance(doc);

  const created = fmcad(['appearance', 'create', '--doc', doc, '--data', JSON.stringify({
    name: 'FMCAD G29 Typed ' + Date.now(),
    id: sourceId,
  })]);
  assert.equal(created.success, true, JSON.stringify(created));
  // Typed property readback: every descriptor carries a concrete Property type.
  assert.ok(Array.isArray(created.result.properties));
  for (const prop of created.result.properties) {
    assert.ok(typeof prop.id === 'string');
    assert.ok(typeof prop.type === 'string');
    assert.equal(typeof prop.isReadOnly, 'boolean');
  }
  // (Face override on flat/curved faces and duplicate-ID scenarios are
  //  native-pending acceptance items exercised in the offline Python suite.)
});

test('gm29: G29-12 appearance.projection read reflects the actual installed projection', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const id = createAppearance(doc);

  // Actual projection read (no projection field) never fabricates a frame; it
  // returns the installed value or null. Save/reopen dependency persistence is
  // not expressible inside a single clear() cycle and stays native-pending.
  const out = fmcad(['appearance', 'projection', '--doc', doc, '--data', JSON.stringify({ id })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.changed, false);
  assert.ok('projection' in out.result);
});
