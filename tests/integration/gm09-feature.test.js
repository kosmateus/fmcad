'use strict';

// GM09 (feature) live integration tests. Each test builds geometry through the
// fmcad CLI, asserts the result envelope, and relies on clear() before/after so
// the shared document is left empty. With FMCAD_TEST_DOC unset, every test and
// hook skips cleanly and nothing touches Fusion.

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

// Build one extrude from a closed circle profile and return its envelope.
function buildExtrude(doc, name = 'Base', distance = '10 mm') {
  const section = name + '__section';
  fmcad(['sketch', 'create', '--doc', doc, '--data', JSON.stringify({ name: section, plane: 'XY' })]);
  fmcad(['sketch', 'geometry', '--doc', doc, '--data', JSON.stringify({
    sketch: section,
    geometry: [{ type: 'circle', center: ['0 mm', '0 mm', '0 mm'], radius: '20 mm' }],
  })]);
  return fmcad(['model', 'extrude', '--doc', doc, '--data', JSON.stringify({
    name, profile: { kind: 'profile', sketch: section, index: 0 }, distance, operation: 'newBody',
  })]);
}

function inspect(doc, token) {
  return fmcad(['feature', 'inspect', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
  })]);
}

test('G09-01: feature.inspect reads structural role, unit, expression and extent', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const extrude = buildExtrude(doc);
  assert.equal(extrude.success, true, JSON.stringify(extrude));

  const out = inspect(doc, extrude.result.feature.token);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.units, { length: 'cm', angle: 'rad' }, JSON.stringify(out));
  assert.equal(out.result.type, 'ExtrudeFeature');

  const distance = out.result.parameters.find((parameter) => parameter.role === 'distance');
  assert.ok(distance, 'expected a distance role in ' + JSON.stringify(out.result.parameters));
  assert.equal(distance.unit, 'mm');
  assert.equal(distance.expression, '10 mm');
  assert.equal(typeof distance.value, 'number');

  assert.equal(out.result.extent.mode, 'distance');
  assert.equal(out.result.extent.distance.role, 'distance');
  assert.equal(out.result.extent.distance.expression, '10 mm');
  assert.equal(out.result.roleSource, 'feature structure');
});

test('G09-02: change.preview resolves a typed before/after plan without mutation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const extrude = buildExtrude(doc);
  const snap = inspect(doc, extrude.result.feature.token);
  const distance = snap.result.parameters.find((parameter) => parameter.role === 'distance');

  const out = fmcad(['change', 'preview', '--doc', doc, '--data', JSON.stringify({
    feature: { token: extrude.result.feature.token },
    name: 'BaseRenamed',
    parameters: { [distance.name]: '15 mm' },
  })]);

  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.applied, false);
  assert.equal(out.result.proposedName, 'BaseRenamed');
  const change = out.result.parameters.find((row) => row.parameter === distance.name);
  assert.ok(change, 'expected a planned change for ' + distance.name);
  assert.equal(change.before, '10 mm');
  assert.equal(change.after, '15 mm');
});

test('G09-03: feature.edit resolves parameters by role and by name selectors', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const extrude = buildExtrude(doc);
  const token = extrude.result.feature.token;
  const distance = inspect(doc, token).result.parameters.find((p) => p.role === 'distance');

  const byRole = fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
    entries: [{ role: 'distance', expression: '20 mm' }],
  })]);
  assert.equal(byRole.status, 'pass', JSON.stringify(byRole));
  assert.equal(byRole.result.applied, true);
  assert.deepEqual(byRole.result.conflicts, [], JSON.stringify(byRole.result.conflicts));

  const byName = fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
    entries: [{ name: distance.name, expression: '15 mm' }],
  })]);
  assert.equal(byName.status, 'pass', JSON.stringify(byName));
  assert.equal(byName.result.applied, true);
  assert.deepEqual(byName.result.conflicts, [], JSON.stringify(byName.result.conflicts));
});

test('G09-04: feature.edit applies startOffset/distance extent and restores the marker', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const extrude = buildExtrude(doc);
  const token = extrude.result.feature.token;

  const out = fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
    extent: { mode: 'distance', distance: '25 mm', startOffset: '2 mm' },
  })]);

  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.applied, true);
  assert.equal(out.result.markerRestored, true);
  assert.equal(out.result.geometryDeleted, false);
  assert.deepEqual(out.result.conflicts, [], JSON.stringify(out.result.conflicts));
  const startOffset = out.result.after.parameters.find((p) => p.role === 'startOffset');
  assert.ok(startOffset, 'expected a startOffset role in ' + JSON.stringify(out.result.after.parameters));
});

test('G09-05: assembly-aware combine refuses cross-component tools', (t) => {
  if (skipLive(t)) return;
  // The cross-occurrence refusal ("Modeling requires native input geometry in
  // the selected component; cross-occurrence creation is unsupported") needs a
  // foreign component/occurrence fixture from the component/occurrence family,
  // which this suite does not set up. Covered by the offline assembly/combine
  // tests; not exercised here.
  t.skip('cross-component combine refusal requires a foreign occurrence fixture');
});

test('G09-06: ambiguous or unknown role selectors are rejected', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const extrude = buildExtrude(doc);
  const token = extrude.result.feature.token;

  assert.throws(() => fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
    entries: [{ role: 'bogusRole', expression: '5 mm' }],
  })]), /No feature parameter matches/);

  assert.throws(() => fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token },
    entries: [{ role: 'distance', name: 'nonexistent', expression: '5 mm' }],
  })]), /No feature parameter matches/);
});

test('G09-07: marker restore never deletes geometry and reports downstream health', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const first = buildExtrude(doc, 'First', '10 mm');
  buildExtrude(doc, 'Second', '5 mm');

  const out = fmcad(['feature', 'edit', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', feature: { token: first.result.feature.token },
    extent: { mode: 'distance', distance: '12 mm' },
  })]);

  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.markerRestored, true);
  assert.equal(out.result.geometryDeleted, false);
  assert.equal(out.result.downstream.status, 'pass', JSON.stringify(out.result.downstream));
  assert.ok(out.result.downstream.scanned >= 1, JSON.stringify(out.result.downstream));
});
