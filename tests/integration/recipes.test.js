'use strict';

// Live integration tests for the ten cross-cutting reference recipes
// (FMCAD_GENERIC_METHODS_SPEC.md §5, tests/fixtures/recipes/). Each recipe is
// a version-1 definition/batch JSON authored from public fmcad methods that
// returns NAMED results for later steps. A test runs the recipe end-to-end via
// `definition instantiate` against the coordinator-provided document
// (FMCAD_TEST_DOC), asserts the run completes, and asserts every named output
// resolves in the batch `exports`.
//
// Recipes are project data, not SDK code: any live data bug found here (wrong
// reference paths, closed profiles, array-vs-object, units, placeholder ids)
// is fixed in the recipe JSON itself, never in the SDK.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

const RECIPES = path.resolve(__dirname, '..', 'fixtures', 'recipes');

// A fresh report directory per run keeps each run independent (the batch engine
// writes immutable numbered snapshots and refuses replay/stale locks otherwise).
function freshReportPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-recipe-'));
}

// Run one recipe definition and return the report envelope.
function runRecipe(t, file, extra = []) {
  const doc = docName();
  const args = ['definition', 'instantiate', '--doc', doc, '--file', path.join(RECIPES, file),
    '--report-path', freshReportPath(), ...extra];
  return fmcad(args);
}

// Assert the recipe completed and every named output key resolved.
function assertNamedOutputs(result, names) {
  assert.equal(result.success, true, JSON.stringify(result.error || result));
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.ok(result.exports && typeof result.exports === 'object', JSON.stringify(result));
  for (const name of names) {
    assert.ok(Object.hasOwn(result.exports, name), `missing named output ${name}: ${JSON.stringify(result.exports)}`);
  }
}

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

test('X-01: engine shell/can + mount pattern (engine-can.json)', (t) => {
  if (skipLive(t)) return;
  // engine-can carries a durable regeneration binding, so the durable-recipe
  // lifecycle requires a pinned saved document (--doc-file-id).
  const doc = docName();
  const status = fmcad(['document', 'status', '--doc', doc]);
  const fileId = status.result && status.result.fileId;
  assert.ok(fileId, `document status returned no fileId: ${JSON.stringify(status)}`);
  const result = runRecipe(t, 'engine-can.json', ['--doc-file-id', fileId]);
  assertNamedOutputs(result, ['canBody', 'canFeature', 'mountSeed', 'mountPattern', 'rimFillet']);
});

test('X-02: engine vane/impeller/insulator (engine-impeller.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'engine-impeller.json');
  assertNamedOutputs(result, ['impellerBody', 'hubBody', 'shroudSurface', 'insulatorBody', 'vaneProfile']);
});

test('X-03: filter pleats, cage and slots (filter-pleats.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'filter-pleats.json');
  assertNamedOutputs(result, ['cageBody', 'pleatSeed', 'slotFrontCut', 'slotSideCut', 'slotTopCut']);
});

test('X-04: engine materials/texture/sections/captures (engine-materials.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'engine-materials.json');
  assertNamedOutputs(result, ['body', 'appearance', 'material', 'heightmap', 'section', 'shot']);
});

test('X-05: CWG skeleton + catalog + envelopes (cwg-skeleton.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-skeleton.json');
  assertNamedOutputs(result, ['skeleton', 'mountPlane', 'params', 'catalog', 'ledger']);
});

test('X-06: CWG ring PCB + optics (cwg-ring-pcb.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-ring-pcb.json');
  assertNamedOutputs(result, ['mount', 'boardCheck', 'port', 'mateCheck', 'fpc', 'coverage']);
  // The recipe declares a forbidden 4-pin pairing: the mate-check must RECORD the
  // expected negative check (status fail) and the run still completes, not abort.
  const mate = result.steps.find((step) => step.id === 'mate');
  assert.ok(mate, 'expected a mate step: ' + JSON.stringify(result.steps.map((s) => s.id)));
  assert.equal(mate.status, 'success', JSON.stringify(mate));
  assert.equal(mate.output.result.status, 'fail', JSON.stringify(mate.output));
  assert.equal(result.exports.mateCheck, 'fail', JSON.stringify(result.exports));
});

test('X-07: CWG PAN/TILT, counter and media (cwg-pan-tilt.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-pan-tilt.json');
  assertNamedOutputs(result, ['driveGear', 'pair', 'counterSpringRate', 'couple', 'route', 'cutList', 'poseCocked']);
});

test('X-08: CWG spring-piston + cam (cwg-spring-piston-cam.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-spring-piston-cam.json');
  assertNamedOutputs(result, ['spring', 'springRate', 'pitchProfile', 'workingProfile', 'maxPressureAngle', 'cycle']);
});

test('X-09: CWG tank/dock/valves (cwg-tank-dock.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-tank-dock.json');
  assertNamedOutputs(result, ['oRing', 'gland', 'sealStatus', 'dockSequence', 'assemblySequence', 'tankWithdrawal']);
});

test('X-10: CWG enclosure + release (cwg-enclosure.json)', (t) => {
  if (skipLive(t)) return;
  const result = runRecipe(t, 'cwg-enclosure.json');
  assertNamedOutputs(result, ['aSurface', 'enclosureBody', 'mount', 'screwStack', 'bayonet', 'dfm', 'flatPattern', 'report']);
});
