'use strict';

// Live integration tests for GM19 (interference/clearance): set/pair expansion,
// expected contacts, Cartesian joint products, sampling budgets and motion
// envelopes. Pair expansion and the sample x pair plan are deterministic and are
// asserted through the budget guard (no geometry); expected-contact and field
// separation use two real overlapping boxes created via shape box.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

function createBox(doc, name) {
  const out = fmcad(['shape', 'box', '--doc', doc, '--data', JSON.stringify({
    name, width: '10 mm', depth: '10 mm', height: '10 mm',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result.bodies[0];
}

test('G19-01: clearance grid expands an instance set into all unordered pairs', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['clearance', 'grid', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    instances: ['body-a', 'body-b', 'body-c', 'body-d'],
    budget: { maxChecks: 1 },
  })]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.plan.pairCount, 6, JSON.stringify(out));
  assert.equal(out.result.plan.totalChecks, 6, JSON.stringify(out));
  assert.equal(out.result.coverage.continuousVerified, false, JSON.stringify(out));
});

test('G19-02: an expected contact carries a cause and allowed range and is not deleted', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const a = createBox(doc, 'G19A');
  const b = createBox(doc, 'G19B');
  const out = fmcad(['clearance', 'grid', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    pairs: [{ a, b }],
    expectedContacts: [{ a, b, cause: 'seal face', clearance: { min: '0 mm', max: '0.05 mm' } }],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const pair = out.result.results[0];
  assert.equal(pair.expected, true, JSON.stringify(out));
  assert.equal(pair.cause, 'seal face', JSON.stringify(out));
  assert.equal(pair.status, 'tested', JSON.stringify(out));
  assert.equal(pair.passed, true, JSON.stringify(out));
});

test('G19-03: joint ranges sample as a Cartesian product, not a diagonal track', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['clearance', 'grid', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    pairs: [{ a: 'body-a', b: 'body-b' }],
    joints: [
      { joint: 'j1', rotation: { from: '0 deg', to: '90 deg' } },
      { joint: 'j2', rotation: { from: '0 deg', to: '180 deg' } },
    ],
    samples: 3,
    budget: { maxChecks: 1 },
  })]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.plan.configCount, 9, JSON.stringify(out));
  assert.equal(out.result.plan.pairCount, 1, JSON.stringify(out));
  assert.equal(out.result.plan.totalChecks, 9, JSON.stringify(out));
});

test('G19-05: a sample x pair product above budget is reported without testing', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['clearance', 'grid', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    instances: ['body-a', 'body-b', 'body-c'],
    budget: { maxChecks: 1 },
  })]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.plan.withinBudget, false, JSON.stringify(out));
  assert.equal(out.result.plan.budget.maxChecks, 1, JSON.stringify(out));
  assert.equal(out.result.skippedReason, 'budget exceeded', JSON.stringify(out));
  assert.deepEqual(out.result.results, [], JSON.stringify(out));
  assert.equal(out.result.coverage.unknown, 3, JSON.stringify(out));
});

test('G19-06: motion envelope samples a translation range', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['motion', 'envelope', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    motion: { type: 'translation', axis: [1, 0, 0], from: '0 mm', to: '20 mm' },
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    representation: 'sampled', samples: 5,
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.sampleCount, 5, JSON.stringify(out));
  near(out.result.sampledEnvelope.max[0], 12.0, 1e-6, 'sampled max x');
  assert.equal(out.result.continuousVerified, false, JSON.stringify(out));
});

test('G19-07: motion envelope conservative bound carries an explicit errorBound', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['motion', 'envelope', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    motion: { type: 'rotation', axis: [0, 0, 1], from: '0 deg', to: '360 deg' },
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    representation: 'conservative',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(out.result.sampledEnvelope, JSON.stringify(out));
  assert.ok(out.result.conservativeEnvelope, JSON.stringify(out));
  near(out.result.errorBound.value, Math.sqrt(75), 1e-5, 'bounding-sphere radius');
  assert.equal(out.result.continuousVerified, false, JSON.stringify(out));
});

test('G19-08: unsigned distance, overlap volume and interference stay separate fields', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const a = createBox(doc, 'G19A');
  const b = createBox(doc, 'G19B');
  const { code, json: out } = cad(['clearance', 'grid', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    pairs: [{ a, b }],
  })]);
  assert.equal(code, 1, JSON.stringify(out));
  assert.equal(out.status, 'fail', JSON.stringify(out));
  const r = out.result.results[0];
  assert.equal(r.interferes, true, JSON.stringify(out));
  assert.ok(r.overlapVolume.value > 0, JSON.stringify(out));
  near(r.distance.value, 0.0, 1e-6, 'unsigned distance is zero at contact');
  assert.equal(r.clearancePassed, false, JSON.stringify(out));
  assert.equal(out.result.coverage.continuousVerified, false, JSON.stringify(out));
});

test('G19-11: continuousVerified is false without a certifiedPath coverage proof', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['motion', 'envelope', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    motion: { type: 'translation', axis: [1, 0, 0], from: '0 mm', to: '20 mm' },
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    representation: 'certified',
  })]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.continuousVerified, false, JSON.stringify(out));
  assert.equal(out.result.certified, false, JSON.stringify(out));
});
