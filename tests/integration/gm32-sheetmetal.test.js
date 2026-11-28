'use strict';

// Shared owned-backend extraction: tests/scenarios/gm32-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-32 (sheet metal forming/flattening/bend tables).
// The family is an external declared-segment recipe; the public native
// flat-pattern API is a gated availability and is reported blocked, never faked.

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

const PI_OVER_2 = Math.PI / 2;

// flat 20mm + 90deg bend (r 2mm, K 0.5) + flat 20mm, thickness 1mm.
function bracket() {
  return {
    schemaVersion: 1,
    thickness: '1 mm',
    segments: [
      { type: 'flat', length: '20 mm' },
      { type: 'bend', radius: '2 mm', angle: '90 deg', axis: 'y', K: 0.5 },
      { type: 'flat', length: '20 mm' },
    ],
  };
}

test('gm32: G32-01 native flat-pattern authoring is an honest blocked gate', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = cad(['sheet', 'form', '--doc', doc, '--data', JSON.stringify({
    ...bracket(),
    representation: 'native',
  })]);
  assert.equal(out.json.status, 'blocked', JSON.stringify(out.json));
  assert.equal(out.json.success, false);
  assert.equal(out.json.result.nativeFlatPattern.available, false);
});

test('gm32: G32-02 sheet.form folds the neutral axis and preserves developed length', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['sheet', 'form', '--doc', doc, '--data', JSON.stringify({
    ...bracket(),
    representation: 'external',
    fixedFace: 'base',
    reliefs: [{ kind: 'tear' }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.units, { length: 'cm', angle: 'deg' });
  near(out.result.totalDevelopedLength, 2.0 + 0.25 * PI_OVER_2 + 2.0);
  const end = out.result.formedCenterline[out.result.formedCenterline.length - 1];
  near(end[0], 2.25);
  near(end[2], -2.25);
  assert.equal(out.result.representation, 'external');
  assert.equal(out.result.nativeFlatPattern.available, false);
  assert.equal(out.result.correspondence.length, 3);
});

test('gm32: G32-03 sheet.flat lays bends straight without scaling the neutral axis', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['sheet', 'flat', '--doc', doc, '--data', JSON.stringify(bracket())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.developedEqualsFormedNeutral, true);
  assert.equal(out.result.scaled, false);
  near(out.result.totalDevelopedLength, 2.0 + 0.25 * PI_OVER_2 + 2.0);
});

test('gm32: G32-04 sheet.bends derives neutral radius and direction and never guesses allowance', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const out = fmcad(['sheet', 'bends', '--doc', doc, '--data', JSON.stringify(bracket())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.bendCount, 1);
  const row = out.result.bendTable[0];
  near(row.neutralRadius, 0.25);
  near(row.developedLength, 0.25 * PI_OVER_2);
  assert.equal(row.direction, 'up');

  const missing = cad(['sheet', 'bends', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    thickness: '1 mm',
    segments: [
      { type: 'flat', length: '20 mm' },
      { type: 'bend', radius: '2 mm', angle: '90 deg', axis: 'y' },
    ],
  })]);
  assert.notEqual(missing.code, 0);
  assert.ok((missing.stdout + missing.stderr).includes('exactly one of K'), missing.stderr);
});

test('gm32: G32-05 sheet.flat reports developed length equal to a declared bend allowance', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const allowance = 0.25 * PI_OVER_2;
  const out = fmcad(['sheet', 'flat', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    thickness: '1 mm',
    segments: [
      { type: 'flat', length: '20 mm' },
      { type: 'bend', radius: '2 mm', angle: '90 deg', axis: 'y', allowance: `${allowance * 10} mm` },
      { type: 'flat', length: '20 mm' },
    ],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.bendTable[0].allowance, allowance);
  near(out.result.totalDevelopedLength, 2.0 + allowance + 2.0);
  assert.equal(out.result.association, 'external recipe; no native flat-pattern associativity');
});

test('gm32: G32-06 native flat pattern is never faked as a static solid and FPC is not sheet metal', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  for (const operation of ['form', 'flat']) {
    const out = cad(['sheet', operation, '--doc', doc, '--data', JSON.stringify({
      ...bracket(),
      representation: 'native',
    })]);
    assert.equal(out.json.status, 'blocked', JSON.stringify(out.json));
    assert.equal(out.json.result.nativeFlatPattern.available, false);
  }

  // External is the only computed representation, and it declares the limitation.
  const external = fmcad(['sheet', 'form', '--doc', doc, '--data', JSON.stringify(bracket())]);
  assert.equal(external.status, 'pass', JSON.stringify(external));
  assert.equal(external.result.representation, 'external');
  assert.ok(external.limitations.some((l) => /arbitrary solid body is not unfolded/.test(l)));
});
