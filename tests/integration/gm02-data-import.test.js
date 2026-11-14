'use strict';
// Offline cases are shared with CI; keep the historical integration entrypoint complete.
require('../../dist/tests/integration/gm02-data-import-offline.test.js');

// Live integration tests for GM-02 (data imports: parameters, catalog, BOM,
// placement and COTS replacement).
//
// `catalog check` / `placement check` are local ledger/pose computations and run
// without --doc. `param import` / `catalog import` mutate the document and use
// the coordinator-provided document. COTS replacement (G02-06) requires a real
// imported STEP + expectedRevision flow and is left to the native operator.

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

const pose = (x = '0 mm', frame = 'parent') => ({
  frame,
  translation: [x, '0 mm', '0 mm'],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});

test('gm02: G02-01 param import applies parameters with units and forward references', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['param', 'import', '--doc', doc, '--data', JSON.stringify({
    version: 1, owner: 'live', revision: 'r1',
    records: [
      { name: 'gm02_inside', expression: '40 mm', unit: 'mm', status: 'ESTIMATED', source: 'live test' },
      { name: 'gm02_wall', expression: '2 mm', unit: 'mm', status: 'ESTIMATED', source: 'live test' },
      { name: 'gm02_outside', expression: 'gm02_inside + 2 * gm02_wall', unit: 'mm', status: 'ESTIMATED', source: 'live test' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
});

test('gm02: G02-02 catalog import creates an owned part definition and occurrence', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['catalog', 'import', '--doc', doc, '--data', JSON.stringify({
    version: 1, owner: 'live', revision: 'r1',
    records: [
      { id: 'plate', name: 'Plate', kind: 'part', quantity: 1, parent: null, placement: pose(), status: 'CONFIRMED', source: 'live test' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
});





test('gm02: G02-10 placement import re-places an owned, ungrounded catalog occurrence', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  // placement import only adopts occurrences owned by the same import owner, so
  // seed one with catalog import (mirrors G02-02).
  const imported = fmcad(['catalog', 'import', '--doc', doc, '--data', JSON.stringify({
    version: 1, owner: 'live', revision: 'r1',
    records: [
      { id: 'plate', name: 'Plate', kind: 'part', quantity: 1, parent: null, placement: pose(), status: 'CONFIRMED', source: 'live test' },
    ],
  })]);
  assert.equal(imported.success, true, JSON.stringify(imported));

  // Fusion defaults new occurrences to ground-to-parent, which placement import
  // refuses; clear grounding before applying the new pose.
  const ungrounded = fmcad(['assembly', 'unground', '--doc', doc, '--data', JSON.stringify({ occurrence: 'Plate:1' })]);
  assert.equal(ungrounded.success, true, JSON.stringify(ungrounded));

  const out = fmcad(['placement', 'import', '--doc', doc, '--data', JSON.stringify({
    version: 1, owner: 'live', revision: 'r2',
    records: [
      { id: 'plate:1', occurrence: 'Plate:1', placement: pose('15 mm', 'root'), status: 'CONFIRMED', source: 'live test' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.poses.length, 1, JSON.stringify(out));
  assert.equal(out.result.poses[0].id, 'plate:1', JSON.stringify(out));
  assert.ok(Math.abs(out.result.poses[0].actual[3] - 1.5) < 1e-9, JSON.stringify(out));
});
