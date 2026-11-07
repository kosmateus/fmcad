'use strict';

// Live integration tests for GM18 (poses): named product states stored as a
// local attribute manifest (explicitly not a native Fusion ConfigurationTable).
// State dimensions without geometry (fill/spring/route/service) are
// manifest-carried, so save/list/apply/evaluate run without real joints/bodies.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const servicePose = (name, extra = {}) => ({
  schemaVersion: 1, frame: 'component', name,
  fillState: 'EMPTY', springState: 'COCKED',
  service: { disconnections: ['tank-dock'] },
  ...extra,
});

test('G18-01: pose save/list/delete roundtrips the local manifest', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const saved = fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Service'))]);
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.status, 'pass', JSON.stringify(saved));
  assert.equal(saved.result.name, 'Service', JSON.stringify(saved));
  assert.equal(saved.result.revision, 1, JSON.stringify(saved));
  assert.equal(saved.result.manifest.schema, 'fmcad.pose.manifest.v1', JSON.stringify(saved));
  assert.equal(saved.result.manifest.fillState, 'EMPTY', JSON.stringify(saved));

  const listed = fmcad(['pose', 'list', '--doc', doc, '--data', JSON.stringify({ schemaVersion: 1, frame: 'component' })]);
  assert.equal(listed.status, 'pass', JSON.stringify(listed));
  assert.equal(listed.result.count, 1, JSON.stringify(listed));
  assert.equal(listed.result.poses[0].name, 'Service', JSON.stringify(listed));

  const deleted = fmcad(['pose', 'delete', '--doc', doc, '--data', JSON.stringify({ schemaVersion: 1, frame: 'component', name: 'Service', confirm: true })]);
  assert.equal(deleted.status, 'pass', JSON.stringify(deleted));
  assert.equal(deleted.result.deleted, true, JSON.stringify(deleted));

  const after = fmcad(['pose', 'list', '--doc', doc, '--data', JSON.stringify({ schemaVersion: 1, frame: 'component' })]);
  assert.equal(after.result.count, 0, JSON.stringify(after));
});

test('G18-02: pose apply leaves the requested state in place', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Service'))]);

  const out = fmcad(['pose', 'apply', '--doc', doc, '--data', JSON.stringify({ schemaVersion: 1, frame: 'component', name: 'Service' })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.leftApplied, true, JSON.stringify(out));
  assert.deepEqual(out.result.unapplied, [], JSON.stringify(out));
});

test('G18-03: pose evaluate applies temporarily and restores the previous state', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Service'))]);

  const out = fmcad(['pose', 'evaluate', '--doc', doc, '--data', JSON.stringify({ schemaVersion: 1, frame: 'component', name: 'Service' })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.restored, true, JSON.stringify(out));
  assert.deepEqual(out.result.restoreErrors, [], JSON.stringify(out));
});

test('G18-04: pose manifest roundtrips all eight state dimensions', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const payload = {
    schemaVersion: 1, frame: 'component', name: 'Full',
    joints: [{ joint: { token: 'joint-1' }, rotation: '30 deg' }],
    parameters: [{ name: 'wall', expression: '2 mm' }],
    visibility: [{ ref: { token: 'body-1' }, visible: false }],
    fillState: 'FULL', springState: 'COCKED',
    routeVariant: 'service-route',
    service: { disconnections: ['tank-dock'] },
  };
  const out = fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(payload)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const manifest = out.result.manifest;
  assert.equal(manifest.joints.length, 1, JSON.stringify(out));
  assert.equal(manifest.parameters.length, 1, JSON.stringify(out));
  assert.equal(manifest.visibility.length, 1, JSON.stringify(out));
  assert.equal(manifest.fillState, 'FULL', JSON.stringify(out));
  assert.equal(manifest.springState, 'COCKED', JSON.stringify(out));
  assert.equal(manifest.routeVariant, 'service-route', JSON.stringify(out));
  assert.deepEqual(manifest.service.disconnections, ['tank-dock'], JSON.stringify(out));
});

test('G18-05: fill/spring/service states are recorded distinctly (FULL vs EMPTY)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const full = fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Full', { fillState: 'FULL' }))]);
  const empty = fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Empty', { fillState: 'EMPTY' }))]);
  assert.equal(full.status, 'pass', JSON.stringify(full));
  assert.equal(empty.status, 'pass', JSON.stringify(empty));
  assert.equal(full.result.manifest.fillState, 'FULL', JSON.stringify(full));
  assert.equal(empty.result.manifest.fillState, 'EMPTY', JSON.stringify(empty));
  assert.equal(full.result.manifest.springState, 'COCKED', JSON.stringify(full));
  assert.deepEqual(empty.result.manifest.service.disconnections, ['tank-dock'], JSON.stringify(empty));
});

test('G18-06: the manifest is a local manifest, not a native ConfigurationTable', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['pose', 'save', '--doc', doc, '--data', JSON.stringify(servicePose('Service'))]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.manifest.schema, 'fmcad.pose.manifest.v1', JSON.stringify(out));
  assert.match(out.method, /not a native ConfigurationTable/, JSON.stringify(out));
});
