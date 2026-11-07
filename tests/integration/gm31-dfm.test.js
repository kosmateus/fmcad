'use strict';

// Live integration tests for GM-31 (manufacturing rules, draft, undercuts, wall
// thickness). These are declared-sample evaluations computed in the Fusion
// handler; native B-Rep ray sampling is a gated path reported as blocked.

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

const near = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tol, `${actual} != ${expected}`);

test('gm31: G31-01 manufacturing.zone applies protection defaults and warns on missing material', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['manufacturing', 'zone', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    zones: [
      { name: 'seal-groove', kind: 'seal' },
      { name: 'a-panel', kind: 'a-surface' },
      { name: 'boss', kind: 'fit', protected: false },
    ],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const byName = Object.fromEntries(out.result.zones.map((zone) => [zone.name, zone]));
  assert.equal(byName['seal-groove'].protected, true);
  assert.equal(byName['a-panel'].protected, true);
  assert.equal(byName.boss.protected, false);
  assert.ok(out.result.warnings.some((w) => /material/i.test(w)));
});

test('gm31: G31-02 manufacturing.check rejects a global operation that touches a protected zone', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const base = {
    schemaVersion: 1,
    zones: [{ name: 'seal', kind: 'seal' }],
    faces: [{ name: 'wall', point: ['0 mm', '0 mm', '10 mm'], normal: [1, 0, 0] }],
    walls: [{ name: 'shell', point: ['0 mm', '0 mm', '0 mm'], opposite: ['2 mm', '0 mm', '0 mm'], continuity: 'solid' }],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
  };

  const clean = fmcad(['manufacturing', 'check', '--doc', doc, '--data', JSON.stringify(base)]);
  assert.equal(clean.status, 'pass', JSON.stringify(clean));
  assert.equal(clean.result.passed, true);

  const violated = cad(['manufacturing', 'check', '--doc', doc, '--data', JSON.stringify({
    ...base,
    operations: [{ name: 'global-draft', touches: ['seal'] }],
  })]);
  assert.equal(violated.json.status, 'fail', JSON.stringify(violated.json));
  assert.equal(violated.json.result.passed, false);
  assert.ok(violated.json.result.protectedZones.includes('seal'));
  assert.ok(violated.json.result.violations.some((v) => v.source === 'protected-zone'));
});

test('gm31: G31-03 measure.draft reports a signed draft map with the sign convention', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'draft', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    faces: [
      { name: 'wall', point: ['0 mm', '0 mm', '10 mm'], normal: [1, 0, 0] },
      { name: 'top', point: ['0 mm', '0 mm', '10 mm'], normal: [0, 0, 1] },
      { name: 'under', point: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, -1] },
    ],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.units, { length: 'cm', angle: 'deg' });
  const byFace = Object.fromEntries(out.result.draftMap.map((r) => [r.face, r]));
  near(byFace.wall.signedDraft, 0);
  assert.equal(byFace.wall.pullWall, true);
  near(byFace.top.signedDraft, 90);
  near(byFace.under.signedDraft, -90);
  assert.equal(out.result.demoldableIsNotDraftAlone, true);
});

test('gm31: G31-04 undercut.check detects a face locked against the pull direction', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const detected = cad(['undercut', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    faces: [{ name: 'lip', point: ['0 mm', '0 mm', '5 mm'], normal: [0, 0, -1] }],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
  })]);
  assert.equal(detected.json.status, 'fail', JSON.stringify(detected.json));
  assert.equal(detected.json.result.passed, false);
  assert.equal(detected.json.result.undercutCount, 1);
  assert.equal(detected.json.result.undercuts[0].undercut, true);

  const clear = fmcad(['undercut', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    faces: [{ name: 'side', point: ['0 mm', '0 mm', '5 mm'], normal: [0, 0, 1] }],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
  })]);
  assert.equal(clear.status, 'pass', JSON.stringify(clear));
  assert.equal(clear.result.passed, true);
});

test('gm31: G31-05 measure.wall-map checks material continuity and flags void-backed samples', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'wall-map', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    samples: [
      { name: 'shell', point: ['0 mm', '0 mm', '0 mm'], opposite: ['2 mm', '0 mm', '0 mm'], continuity: 'solid' },
      { name: 'boss', point: ['10 mm', '0 mm', '0 mm'], opposite: ['14 mm', '0 mm', '0 mm'], continuity: 'void' },
    ],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.wallMap[0].thickness, 0.2);
  assert.equal(out.result.wallMap[0].voidBacked, false);
  assert.equal(out.result.wallMap[1].voidBacked, true);
  assert.ok(out.result.unhandledAreas.includes('boss'));
  assert.equal(out.result.materialContinuityChecked, true);
});

test('gm31: G31-06 wall-map reports thin walls and uniformity for shell/rib fixtures', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['measure', 'wall-map', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    samples: [
      { name: 'a', point: ['0 mm', '0 mm', '0 mm'], opposite: ['2 mm', '0 mm', '0 mm'] },
      { name: 'b', point: ['0 mm', '10 mm', '0 mm'], opposite: ['2 mm', '10 mm', '0 mm'] },
    ],
    minThickness: '3 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.wallMap.every((r) => r.thinWall), true);
  assert.equal(out.result.uniform, true);
  assert.equal(out.result.thinWallViolations.length, 2);
});

test('gm31: G31-07 native sampling is an honest blocked gap and draft alone never proves demoldability', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const draft = cad(['measure', 'draft', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    method: 'native',
    faces: [{ name: 'wall', point: ['0 mm', '0 mm', '10 mm'], normal: [1, 0, 0] }],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
  })]);
  assert.equal(draft.json.status, 'blocked', JSON.stringify(draft.json));
  assert.equal(draft.json.success, false);
  assert.equal(draft.json.result.nativeSampling.available, false);
  assert.equal(draft.json.result.requestedMethod, 'native');

  const analytic = fmcad(['measure', 'draft', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    faces: [{ name: 'wall', point: ['0 mm', '0 mm', '10 mm'], normal: [1, 0, 0] }],
    pullDirections: [{ name: 'eject', axis: [0, 0, 1] }],
    minDraft: '1 deg',
  })]);
  assert.equal(analytic.status, 'pass', JSON.stringify(analytic));
  assert.equal(analytic.result.demoldableByDraft, false);
  assert.equal(analytic.result.demoldableIsNotDraftAlone, true);
});
