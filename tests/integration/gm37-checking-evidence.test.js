'use strict';

// Shared owned-backend extraction: tests/scenarios/gm37-cases.ts.
// See tests/scenarios/GM25_37_DISPOSITION.md for exact CLI/native obligations.
// This retained source is not, by itself, native qualification evidence.

// Live integration tests for GM-37 (checks, evidence and release): check.set,
// evidence.package/check and deliver. These are read-only envelope commands that
// evaluate declared predicates and evidence, never mutating the document. Each
// test runs against the coordinator-provided cloud document (FMCAD_TEST_DOC)
// and relies on clear() before/after. The spec (FMCAD_GENERIC_METHODS_SPEC.md
// §4 GM-37 + docs/CHECKS.md) requires distinct outcomes: a failed test, an
// execution error, missing data and stale evidence never collapse into one
// another, and only a fully passing nonempty checklist is accepted.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'fmcad.js');

// Run the CLI synchronously and return the exit code plus parsed JSON, so tests
// can assert the spec's nonzero exit for fail/blocked/error outcomes (fmcad()
// throws on those). Mirrors helper.runRaw but never throws on a nonzero exit.
function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json', '--timeout', '60000'], {
    cwd: ROOT, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  let out = null;
  try { out = JSON.parse(result.stdout); } catch (_) { /* non-JSON error output */ }
  return { code: result.status, out, raw: result.stdout, err: result.stderr };
}

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

test('G37-01: check.set evaluates scalar/vector/count/boolean predicates distinctly', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['check', 'set', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [
      { id: 'od', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0, max: 26.0 } } },
      { id: 'axis', predicate: { kind: 'vector', actual: { components: [1, 2, 3] }, expected: { components: [1, 2, 3], tolerance: 0.1 } } },
      { id: 'holes', predicate: { kind: 'count', actual: { count: 5 }, expected: { min: 4, max: 6 } } },
      { id: 'sealed', predicate: { kind: 'boolean', actual: { value: true }, expected: true } },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.itemCount, 4, JSON.stringify(out.result));
  assert.equal(out.result.passCount, 4, JSON.stringify(out.result));
  assert.equal(out.result.checkPassed, true, JSON.stringify(out.result));
  assert.equal(out.result.executionSucceeded, true, JSON.stringify(out.result));
  assert.equal(out.result.executionSucceededIsNotCheckPassed, true, JSON.stringify(out.result));
});

test('G37-02: check.set scalar predicate reuses declared-value comparison with tolerance', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['check', 'set', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [
      { id: 'within', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { equals: 25.0 }, tolerance: 0.5 } },
      { id: 'over', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0 } } },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const within = out.result.items.find((item) => item.id === 'within');
  assert.equal(within.method, 'declared-value comparison', JSON.stringify(out.result));
  assert.equal(within.passed, true, JSON.stringify(out.result));
});

test('G37-03: check.set continues after an ordinary fail and skips dependents of an error', (t) => {
  if (skipLive(t)) return;
  const result = cli(['check', 'set', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [
      { id: 'tight', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 30.0 } } },
      { id: 'ok', predicate: { kind: 'scalar', actual: { value: 5.0 }, expected: { min: 0.0, max: 10.0 } } },
      { id: 'broken', predicate: { kind: 'bogus', actual: { value: 1 } } },
      { id: 'dep', predicate: { kind: 'scalar', actual: { value: 1 }, expected: { min: 0 } }, dependsOn: ['broken'] },
    ],
  })]);
  assert.notEqual(result.code, 0, 'blocked set must exit nonzero');
  assert.ok(result.out, 'expected a JSON envelope: ' + result.err);
  assert.equal(result.out.status, 'blocked', JSON.stringify(result.out));
  assert.equal(result.out.success, false, JSON.stringify(result.out));
  assert.equal(result.out.result.failCount, 1, JSON.stringify(result.out.result));
  assert.equal(result.out.result.passCount, 1, JSON.stringify(result.out.result));
  assert.equal(result.out.result.errorCount, 1, JSON.stringify(result.out.result));
  assert.equal(result.out.result.skippedCount, 1, JSON.stringify(result.out.result));
  const dep = result.out.result.items.find((item) => item.id === 'dep');
  assert.equal(dep.outcome, 'notEvaluated', JSON.stringify(result.out.result));
  assert.match(dep.reason, /dependency/, JSON.stringify(result.out.result));
});

test('G37-04: missing data and stale evidence are distinct from fail', (t) => {
  if (skipLive(t)) return;
  const response = cli(['check', 'set', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [
      { id: 'undeclared', predicate: { kind: 'scalar' } },
      { id: 'stale', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0, max: 26.0 } }, source: { path: 'drawing', status: 'ESTIMATED' } },
    ],
  })]);
  const out = response.out;
  assert.notEqual(response.code, 0, 'unknown evidence remains a public failure');
  assert.ok(out, 'expected a JSON envelope: ' + response.err);
  // Accepted baseline already rejected unknown outwardly; preserve informational success inside the result.
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.result.success, true, JSON.stringify(out));
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.missingCount, 1, JSON.stringify(out.result));
  assert.equal(out.result.staleCount, 1, JSON.stringify(out.result));
  const undeclared = out.result.items.find((item) => item.id === 'undeclared');
  const stale = out.result.items.find((item) => item.id === 'stale');
  assert.equal(undeclared.outcome, 'missing', JSON.stringify(out.result));
  assert.equal(stale.outcome, 'stale', JSON.stringify(out.result));
});

test('G37-05: evidence.package reports manifest, completeness and stale items', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['evidence', 'package', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    evidence: [
      { id: 'housing-drawing', kind: 'drawing', path: 'drawings/housing.svg', revision: 'B', source: { path: 'drawings', revision: 'B', status: 'CONFIRMED' } },
      { id: 'housing-model', kind: 'model', path: 'models/housing.f3d' },
      { id: 'proto-film', kind: 'film', path: 'evidence/proto.mp4', gate: 'G7', supplierApproval: { supplier: 'molder', approved: true } },
      { id: 'proto-photo', kind: 'image', path: 'evidence/proto.png' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.complete, true, JSON.stringify(out.result));
  assert.equal(out.result.itemCount, 4, JSON.stringify(out.result));
  assert.deepEqual(out.result.missing, [], JSON.stringify(out.result));
  assert.equal(out.result.manifest.length, 4, JSON.stringify(out.result));
});

test('G37-06: evidence.check marks missing required evidence unresolved, not failed', (t) => {
  if (skipLive(t)) return;
  const response = cli(['evidence', 'check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    evidence: [{ id: 'housing-model', kind: 'model', path: 'models/housing.f3d' }],
    required: ['film'],
  })]);
  const out = response.out;
  assert.notEqual(response.code, 0, 'unknown evidence remains a public failure');
  assert.ok(out, 'expected a JSON envelope: ' + response.err);
  // Accepted baseline already rejected unknown outwardly; preserve informational success inside the result.
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.result.success, true, JSON.stringify(out));
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.result.complete, false, JSON.stringify(out.result));
  assert.deepEqual(out.result.missing, [{ kind: 'film' }], JSON.stringify(out.result));
});

test('G37-07: deliver composes checks and evidence into an acceptance manifest', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['deliver', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [{ id: 'od', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0, max: 26.0 } } }],
    evidence: [{ id: 'proto-film', kind: 'film', path: 'evidence/proto.mp4', gate: 'G7', supplierApproval: { supplier: 'molder', approved: true } }],
    gate: 'G7',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.accepted, true, JSON.stringify(out.result));
  assert.equal(out.result.gate, 'G7', JSON.stringify(out.result));
  assert.equal(out.result.manifest.length, 1, JSON.stringify(out.result));
});

test('G37-08: an empty required checklist is an error, never acceptance', (t) => {
  if (skipLive(t)) return;
  const result = cli(['deliver', '--doc', docName(), '--data', JSON.stringify({ schemaVersion: 1, checks: [] })]);
  // deliver composes a required checklist; an empty one is refused with a
  // nonzero exit, never a pass (FMCAD_GENERIC_METHODS_SPEC.md §4 GM-37).
  assert.notEqual(result.code, 0, 'empty checklist must exit nonzero');
});

test('G37-09: a stale supplier approval blocks delivery (G7/G8 evidence required)', (t) => {
  if (skipLive(t)) return;
  const result = cli(['deliver', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [{ id: 'od', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0, max: 26.0 } } }],
    evidence: [{ id: 'proto-film', kind: 'film', path: 'evidence/proto.mp4', gate: 'G7', supplierApproval: { supplier: 'molder', approved: false } }],
    gate: 'G7',
  })]);
  assert.notEqual(result.code, 0, 'stale supplier approval must not be accepted');
  assert.ok(result.out, 'expected a JSON envelope: ' + result.err);
  assert.equal(result.out.status, 'unknown', JSON.stringify(result.out));
  assert.equal(result.out.result.accepted, false, JSON.stringify(result.out));
});

test('G37-10: deliver does not accept a document marked valid but unverified', (t) => {
  if (skipLive(t)) return;
  // A source marked ESTIMATED (even with a passing predicate) is stale, so a
  // deliver over it is not accepted: model acceptance is never implied.
  const result = cli(['deliver', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1,
    checks: [{ id: 'od', predicate: { kind: 'scalar', actual: { value: 25.0 }, expected: { min: 24.0, max: 26.0 } }, source: { path: 'CHECKED_DOCUMENT', status: 'ESTIMATED' } }],
    gate: 'G8',
  })]);
  assert.notEqual(result.code, 0, 'unverified document must not be accepted');
  assert.ok(result.out, 'expected a JSON envelope: ' + result.err);
  assert.equal(result.out.result.accepted, false, JSON.stringify(result.out));
});
