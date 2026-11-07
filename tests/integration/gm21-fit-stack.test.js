'use strict';

// Live integration tests for GM21 (fit stacks / interfaces) — LOCAL methods.
// These run with no --doc and no document clear; they are pure analytic
// computations (SI output) exercised through the real CLI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { local } = require('./helper');

const near = (actual, expected, tol = 1e-9, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

const base = () => ({
  schemaVersion: 1, identity: { model: 'fixture', revision: '1' },
  frame: 'datum:A', assumptions: ['Independent bounded dimensions in a common datum.'],
});
const term = (id, sign, nominal, minus = '0 mm', plus = '0 mm') => ({ id, sign, nominal, minus, plus });
const stack35 = () => ({
  ...base(),
  terms: [term('a', 1, '5 mm'), ...[0.4, 0.3, 0.15, 0.15, 0.5].map((n, i) => term(`b${i}`, -1, `${n} mm`))],
  minimum: '3.5 mm',
});
const definition = (revision) => ({
  ...base(), id: 'seat', revision,
  parts: ['Root/A:1', 'Root/B:2'], datums: ['A'],
  requirements: [stack35()], representation: 'snapshot',
});

test('G21-01: interface define produces an immutable local mating-interface contract', () => {
  const out = local(['interface', 'define', '--data', JSON.stringify(definition('1'))]);
  assert.equal(out.status, 'notEvaluated', JSON.stringify(out));
  assert.equal(out.associativity, 'snapshot', JSON.stringify(out));
  assert.equal(out.result.contract.representation, 'snapshot', JSON.stringify(out));
  assert.deepEqual(out.result.contract.parts, ['Root/A:1', 'Root/B:2'], JSON.stringify(out));
  assert.deepEqual(out.affected, ['Root/A:1', 'Root/B:2'], JSON.stringify(out));
});

test('G21-02: fit stack reproduces signed asymmetric tolerance contributions', () => {
  const out = local(['fit', 'stack', '--data', JSON.stringify({
    ...base(),
    terms: [term('a', 1, '10 mm', '1 mm', '2 mm'), term('b', -1, '3 mm', '0.2 mm', '0.7 mm')],
  })]);
  assert.equal(out.status, 'notEvaluated', JSON.stringify(out));
  near(out.result.nominal.value, 0.007, 1e-9, 'nominal');
  near(out.result.minimum.value, 0.0053, 1e-9, 'minimum');
  near(out.result.maximum.value, 0.0092, 1e-9, 'maximum');
  assert.equal(out.units, 'SI', JSON.stringify(out));
});

test('G21-03: fit stack folds thermal expansion and deflection into extrema', () => {
  const thermal = term('a', 1, '100 mm');
  thermal.thermal = { alpha: '10 ppm/K', delta: '10 deltaK', minimumDelta: '-20 deltaK', maximumDelta: '30 deltaK' };
  const t = local(['fit', 'stack', '--data', JSON.stringify({ ...base(), terms: [thermal] })]);
  assert.equal(t.status, 'notEvaluated', JSON.stringify(t));
  near(t.result.maximum.value, 0.10003, 1e-9, 'thermal maximum');

  const defl = term('a', 1, '100 mm');
  defl.deflection = { nominal: '-1 mm', minimum: '-2 mm', maximum: '0 mm' };
  const d = local(['fit', 'stack', '--data', JSON.stringify({ ...base(), terms: [defl] })]);
  assert.equal(d.status, 'notEvaluated', JSON.stringify(d));
  near(d.result.minimum.value, 0.098, 1e-9, 'deflection minimum');
});

test('G21-04: worst case stays separate from the correlated statistical model', () => {
  const data = {
    ...base(),
    terms: [term('a', 1, '5 mm'), term('b', -1, '1 mm')],
    statistics: { model: 'linear-normal', coverage: 3, correlation: [[1, 1], [1, 1]],
      assumptions: ['Identical systematic displacement; final contribution sigmas.'] },
  };
  data.terms.forEach((t) => { t.sigma = '0.1 mm'; });

  const correlated = local(['fit', 'stack', '--data', JSON.stringify(data)]);
  assert.equal(correlated.status, 'notEvaluated', JSON.stringify(correlated));
  // Worst-case interval is unaffected by the statistical model (RSS never replaces WC).
  near(correlated.result.minimum.value, 0.004, 1e-9, 'WC minimum');
  near(correlated.result.maximum.value, 0.004, 1e-9, 'WC maximum');
  near(correlated.result.statistical.sigma.value, 0.0, 1e-9, 'correlated sigma cancels');

  data.statistics.correlation = [[1, 0], [0, 1]];
  const independent = local(['fit', 'stack', '--data', JSON.stringify(data)]);
  near(independent.result.statistical.sigma.value, Math.sqrt(2) * 0.0001, 1e-9, 'independent sigma');
});

test('G21-05: a changed interface invalidates all mating-part evidence', () => {
  const defined = local(['interface', 'define', '--data', JSON.stringify(definition('1'))]);
  assert.equal(defined.status, 'notEvaluated', JSON.stringify(defined));
  const previous = { contract: defined.result.contract, fingerprint: defined.result.fingerprint };

  const ok = local(['interface', 'check', '--data', JSON.stringify({ ...base(), definition: definition('1') })]);
  assert.equal(ok.status, 'pass', JSON.stringify(ok));

  const changed = local(['interface', 'check', '--data', JSON.stringify({
    ...base(), definition: definition('2'), previous,
  })]);
  assert.equal(changed.status, 'blocked', JSON.stringify(changed));
  assert.deepEqual(changed.result.invalidatedParts, ['Root/A:1', 'Root/B:2'], JSON.stringify(changed));
});

test('G21-06: fit stack recreates the 5-0.4-0.3-0.15-0.15-0.5 = 3.5 mm fixture', () => {
  const out = local(['fit', 'stack', '--data', JSON.stringify(stack35())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.nominal.value, 0.0035, 1e-9, 'nominal 3.5 mm');
  near(out.result.minimum.value, 0.0035, 1e-9, 'minimum 3.5 mm');
  near(out.result.maximum.value, 0.0035, 1e-9, 'maximum 3.5 mm');
  assert.equal(out.provenance.status, 'ESTIMATED', JSON.stringify(out));
});
