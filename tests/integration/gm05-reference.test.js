'use strict';

// Live integration tests for GM-05 (reference images, calibration, comparison).
//
// `reference layout/calibrate/compare` are local, source-preserving image
// workers that need Pillow/NumPy/SciPy in the selected Python interpreter. They
// run without --doc and skip when those dependencies are absent. The native
// Canvas path (G05-06, `reference image`) requires a manually inserted canvas
// and is left to the live operator per docs/GM05.md.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fmcad, hasDoc, clear } = require('./helper');

beforeEach(function () {
  if (!hasDoc()) return;
  clear();
});
afterEach(function () {
  if (!hasDoc()) return;
  clear();
});

const ROOT = path.resolve(__dirname, '..', '..');
const python = process.env.FMCAD_REFERENCE_PYTHON || path.join(ROOT, '.venv/bin/python');
const available = spawnSync(python, ['-B', '-c', 'import PIL, numpy, scipy']).status === 0;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm05-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkPng(dir) {
  const file = path.join(dir, 'source.png');
  const r = spawnSync(python, ['-B', '-c',
    'from PIL import Image; import sys; Image.new("RGB",(300,200),"white").save(sys.argv[1])', file]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return file;
}

function runLayout(dir, png, views) {
  return fmcad(['reference', 'layout', '--data', JSON.stringify({
    schemaVersion: 1, python,
    original: { path: png, status: 'ESTIMATED', uncertaintyPx: 1 },
    frame: { name: 'root', origin: ['0 mm', '0 mm', '0 mm'], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
    views,
    out: path.join(dir, 'layout-out'),
  })]);
}

test('gm05: G05-01 reference layout preserves original bytes and transform metadata', { skip: !available }, (t) => {
  const dir = tmpdir(t);
  const png = mkPng(dir);
  const out = runLayout(dir, png, [
    { id: 'front', orientation: 'front', crop: [0, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'front', frame: 'root' } },
  ]);
  assert.equal(out.operation, 'reference.layout');
  assert.equal(out.documentIdentity, null);
  assert.equal(out.nativeAcceptance, 'notEvaluated');
  assert.deepEqual(fs.readFileSync(out.result.originalCopy.path), fs.readFileSync(png));
});

test('gm05: G05-02 reference layout splits front/side/rear views with oriented crops', { skip: !available }, (t) => {
  const dir = tmpdir(t);
  const png = mkPng(dir);
  const out = runLayout(dir, png, [
    { id: 'front', orientation: 'front', crop: [0, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'front', frame: 'root' } },
    { id: 'side', orientation: 'side', crop: [100, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'side', frame: 'root' } },
    { id: 'rear', orientation: 'rear', crop: [200, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'rear', frame: 'root' } },
  ]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.views.length, 3);
  assert.deepEqual(out.result.views.map((v) => v.id), ['front', 'side', 'rear']);
});

test('gm05: G05-03 reference calibrate fits one shared scale and retains uncertainty', { skip: !available }, (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    { id: 'front', orientation: 'front', crop: [0, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'front', frame: 'root' } },
  ]);
  const out = fmcad(['reference', 'calibrate', '--data', JSON.stringify({
    schemaVersion: 1, python,
    layout: layout.reportPath,
    dimension: { id: 'height', value: '250 mm', uncertainty: '5 mm', source: { path: 'brief.md', status: 'ESTIMATED' } },
    controls: [{ view: 'front', segment: [[50, 0], [50, 199]], anchor: ['0 mm', '0 mm'], angle: '90 deg' }],
    tolerance: '1 mm',
    out: path.join(dir, 'cal-out'),
  })]);
  assert.equal(out.operation, 'reference.calibrate');
  assert.equal(out.status, 'unknown'); // ESTIMATED source remains unresolved
});

test('gm05: G05-04 reference compare measures landmark and silhouette deviation', { skip: !available }, (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    { id: 'front', orientation: 'front', crop: [0, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'front', frame: 'root' } },
  ]);
  const cal = fmcad(['reference', 'calibrate', '--data', JSON.stringify({
    schemaVersion: 1, python,
    layout: layout.reportPath,
    dimension: { id: 'height', value: '250 mm', uncertainty: '5 mm', source: { path: 'brief.md', status: 'ESTIMATED' } },
    controls: [{ view: 'front', segment: [[50, 0], [50, 199]], anchor: ['0 mm', '0 mm'], angle: '90 deg' }],
    tolerance: '1 mm',
    out: path.join(dir, 'cal-out'),
  })]);
  const out = fmcad(['reference', 'compare', '--data', JSON.stringify({
    schemaVersion: 1, python,
    calibration: cal.reportPath,
    comparisons: [{ view: 'front', render: layout.result.views[0].path, camera: { projection: 'unknown', orientation: 'front', frame: 'root' }, landmarks: [{ id: 'tip', reference: [50, 0], render: [50, 0] }], tolerancePx: 2 }],
    out: path.join(dir, 'cmp-out'),
  })]);
  assert.equal(out.operation, 'reference.compare');
  assert.equal(out.result.comparisons[0].metrics[0].deviationPx, 0);
  assert.equal(out.result.comparisons[0].metrics[0].projectedDeviationMm, null);
});

test('gm05: G05-05 reference calibrate blocks OPEN sources instead of fabricating a scale', { skip: !available }, (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    { id: 'front', orientation: 'front', crop: [0, 0, 100, 200], rotation: '0 deg', camera: { projection: 'unknown', orientation: 'front', frame: 'root' } },
  ]);
  assert.throws(() => fmcad(['reference', 'calibrate', '--data', JSON.stringify({
    schemaVersion: 1, python,
    layout: layout.reportPath,
    dimension: { id: 'height', value: '250 mm', uncertainty: '5 mm', source: { path: 'brief.md', status: 'OPEN' } },
    controls: [{ view: 'front', segment: [[50, 0], [50, 199]], anchor: ['0 mm', '0 mm'], angle: '90 deg' }],
    tolerance: '1 mm',
    out: path.join(dir, 'cal-blocked'),
  })]), /blocked/);
});
