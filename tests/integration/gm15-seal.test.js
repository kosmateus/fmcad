'use strict';

// Live integration tests for GM15 (seals): O-ring torus, glands, profiles,
// installed evaluation and dock seal sequences. Every test guards with
// skipLive() so an unset FMCAD_TEST_DOC skips cleanly; clear() runs before and
// after so the shared document is left empty.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

test('G15-01: shape o_ring builds a free torus with volume V = 2*pi^2*R*r^2', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['shape', 'o_ring', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', name: 'ORing', id: '10 mm', cs: '2 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  assert.equal(body.torus, true, JSON.stringify(out));
  assert.equal(body.recipe, 'o-ring', JSON.stringify(out));
  near(body.innerDiameter.value, 10.0, 1e-6, 'innerDiameter');
  near(body.cs.value, 2.0, 1e-6, 'cs');
  near(body.meanRadius.value, 6.0, 1e-6, 'meanRadius');
  near(body.crossRadius.value, 1.0, 1e-6, 'crossRadius');
  near(body.volume.value, 2 * Math.PI ** 2 * 6.0 * 1.0 ** 2, 1e-5, 'volume');
  assert.equal(body.regeneration, 'recipeRegeneration', JSON.stringify(out));
});

test('G15-02: seal gland computes groove depth, squeeze/fill and hard-stop', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['seal', 'gland', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', type: 'radial',
    oRing: { id: '10 mm', cs: '2 mm' }, squeeze: 0.15,
    hardStop: { clearance: '0.05 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.gland.depth.value, 1.7, 1e-6, 'gland depth');
  near(body.squeeze.nominal, 0.15, 1e-6, 'squeeze nominal');
  near(body.fill.nominal, 0.75, 1e-4, 'fill nominal');
  assert.ok(body.hardStop, JSON.stringify(out));
  near(body.hardStop.clearance.value, 0.05, 1e-6, 'hardStop clearance');
  assert.match(body.hardStop.role, /does not set squeeze/);
});

test('G15-03: seal profile accepts a custom gasket cross-section (not an O-ring)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['seal', 'profile', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    crossSection: { shape: 'custom', points: [
      ['0 mm', '0 mm'], ['2 mm', '0 mm'], ['2 mm', '1.5 mm'], ['0 mm', '1.5 mm'], ['0 mm', '0 mm'],
    ] },
    layout: 'gasket', path: { closed: true, length: '80 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  assert.equal(body.crossSection.isPlainORing, false, JSON.stringify(out));
  assert.equal(body.crossSection.continuity.closed, true, JSON.stringify(out));
  assert.equal(body.envelope.type, 'sweep', JSON.stringify(out));
});

test('G15-04: seal evaluate reports squeeze/fill and notEvaluated extrusion gap', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['seal', 'evaluate', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    oRing: { id: '10 mm', cs: '2 mm' },
    gland: { depth: '1.6 mm', width: '2.4 mm' }, type: 'radial',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.squeeze, 0.2, 1e-6, 'squeeze');
  const gap = body.checks.find((c) => c.check === 'extrusion-gap');
  assert.ok(gap, JSON.stringify(out));
  assert.equal(gap.status, 'notEvaluated', JSON.stringify(out));
});

test('G15-05: seal gland separates undeformed cross-section from the installed envelope', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['seal', 'gland', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', type: 'radial',
    oRing: { id: '10 mm', cs: '2 mm' },
    gland: { depth: '1.7 mm' }, swell: 0.03,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.oRing.cs.value, 2.0, 1e-6, 'undeformed cs');
  near(body.installedCs.value, 2.0 * Math.sqrt(1.03), 1e-6, 'installed cs');
  assert.notEqual(body.installedCs.value, body.oRing.cs.value);
  assert.match(body.installedEnvelope, /no material\/sealing solution/);
});

test('G15-06: dock sequence-check resolves connect and reverse disconnect order', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['dock', 'sequence-check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    connect: [
      { event: 'lead-in', at: '0 mm' },
      { event: 'locator-engage', at: '2 mm' },
      { event: 'seal-contact', at: '4 mm' },
      { event: 'valve-open', at: '4.6 mm' },
      { event: 'both-valve-open', at: '5 mm' },
    ],
    disconnect: [
      { event: 'valve-close', at: '5 mm' },
      { event: 'valve-close', at: '4.6 mm' },
      { event: 'seal-contact', at: '4 mm' },
      { event: 'locator-engage', at: '2 mm' },
      { event: 'lead-in', at: '0 mm' },
    ],
    minimumSealBeforeOpen: '0.5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  assert.equal(body.connectOrder.length, 5, JSON.stringify(out));
  assert.equal(body.disconnectOrder.length, 5, JSON.stringify(out));
  const bothOpen = body.checks.find((c) => c.check === 'both-valve-open');
  assert.ok(bothOpen, JSON.stringify(out));
  assert.equal(bothOpen.status, 'pass', JSON.stringify(out));
});

test('G15-07: seal profile circle cross-section is a plain O-ring with closed continuity', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['seal', 'profile', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    crossSection: { shape: 'circle', radius: '1 mm' },
    layout: 'face', axis: 'Z',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  assert.equal(body.crossSection.isPlainORing, true, JSON.stringify(out));
  assert.equal(body.crossSection.continuity.closed, true, JSON.stringify(out));
  assert.match(body.crossSection.continuity.continuity, /G0/);
  assert.equal(body.envelope.type, 'revolution', JSON.stringify(out));
});

test('G15-08: dock sequence-check keeps worst-case seal-before-open margin >= 0.5 mm', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['dock', 'sequence-check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    connect: [
      { event: 'lead-in', at: '0 mm' },
      { event: 'locator-engage', at: '2 mm' },
      { event: 'seal-contact', at: '4 mm' },
      { event: 'valve-open', at: '4.6 mm' },
      { event: 'both-valve-open', at: '5 mm' },
    ],
    axialTolerance: '0.1 mm',
    minimumSealBeforeOpen: '0.5 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.sealBeforeOpenMargin.value, 0.6, 1e-6, 'sealBeforeOpenMargin');
  near(body.worstCaseMargin.value, 0.5, 1e-6, 'worstCaseMargin');
  assert.ok(body.worstCaseMargin.value >= 0.5 - 1e-6, JSON.stringify(out));
});
