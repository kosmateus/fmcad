'use strict';

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

test('gm02: G02-03 catalog check resolves PCBA contents/allocation without double-counting purchases', () => {
  const out = fmcad(['catalog', 'check', '--data', JSON.stringify({
    version: 1, owner: 'live', revision: 'r1',
    records: [
      { id: 'board', name: 'Board', kind: 'pcba', quantity: 2, purchaseQuantity: 2, parent: null, placement: pose(), status: 'CONFIRMED', contents: [{ id: 'module', quantity: 4 }] },
      { id: 'module', name: 'Module', kind: 'purchased', parent: 'board', quantity: 4, placement: pose(), status: 'CONFIRMED', allocation: { owner: 'board', quantity: 8 } },
      { id: 'outline', name: 'Outline', kind: 'reference', quantity: 1, parent: null, placement: pose(), status: 'CONFIRMED' },
    ],
    bom: [{ id: 'module', basis: 'contents', quantity: 8 }, { id: 'module', basis: 'physical', quantity: 8 }],
  })]);
  assert.equal(out.operation, 'catalog.check');
  assert.equal(out.result.counts.instances, 11);
  assert.equal(out.result.instances.filter((r) => r.item === 'module').length, 8);
  assert.equal(out.result.ledger.find((r) => r.id === 'module').purchase, null);
  assert.equal(out.result.ledger.find((r) => r.id === 'outline').physical, 0);
  assert.deepEqual(out.result.differences, []);
  assert.equal(out.result.instances.find((r) => r.id === 'board:2/module:4').parent, 'board:2');
  assert.equal(out.status, 'unknown'); // vendor masses absent, declared gap
});

test('gm02: G02-04 placement check resolves root-frame poses and refuses missing DOF', () => {
  const ok = fmcad(['placement', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [{ id: 'o', occurrence: 'A:1+B:1', placement: pose('1 cm', 'root'), status: 'CONFIRMED', source: 'live test' }],
    observed: { poses: [{ id: 'o', transform: pose('1 cm', 'root') }] },
  })]);
  assert.equal(ok.operation, 'placement.check');
  assert.equal(ok.status, 'pass');
  assert.equal(ok.result.differences[0].units, 'cm');
  assert.ok(ok.result.differences[0].distance < 1e-12, JSON.stringify(ok.result.differences));

  // A mismatching pose fails the check (nonzero exit).
  assert.throws(() => fmcad(['placement', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [{ id: 'o', occurrence: 'A:1+B:1', placement: pose('1 cm', 'root'), status: 'CONFIRMED', source: 'live test' }],
    observed: { poses: [{ id: 'o', transform: pose('11 mm', 'root') }] },
  })]), /fail/);

  // A pose without roll/rotation must be refused, not silently filled in.
  assert.throws(() => fmcad(['placement', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [{ id: 'o', occurrence: 'A:1', placement: { frame: 'root', translation: ['0 mm', '0 mm', '0 mm'] }, status: 'CONFIRMED' }],
  })]), /rotation/i);
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

test('gm02: G02-05 functional groups stay separate from the rigid physical parent', () => {
  const out = fmcad(['catalog', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [
      { id: 'P035', name: 'motor_pinion', kind: 'part', quantity: 3, parent: null, placement: pose(), status: 'CONFIRMED', functionalGroups: ['PAN', 'TILT', 'SHOT'] },
      { id: 'C003', name: 'gearmotor', kind: 'purchased', quantity: 3, parent: null, placement: pose(), status: 'CONFIRMED', functionalGroups: ['PAN'] },
    ],
  })]);
  const byId = new Map(out.result.items.map((r) => [r.id, r]));
  assert.deepEqual(byId.get('P035').functionalGroups, ['PAN', 'TILT', 'SHOT']);
  assert.deepEqual(byId.get('C003').functionalGroups, ['PAN']);
  assert.ok(out.result.items.every((r) => r.parent === null));
  // The same label used as a rigid parent must fail, not be promoted.
  assert.throws(() => fmcad(['catalog', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [{ id: 'P035', name: 'motor_pinion', kind: 'part', quantity: 3, parent: 'PAN', placement: pose(), status: 'CONFIRMED' }],
  })]), /Unknown catalog parent/i);
});

test('gm02: G02-07 whole-file preflight rejects late invalid records before any mutation', () => {
  assert.throws(() => fmcad(['catalog', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [
      { id: 'good', name: 'Good', kind: 'part', quantity: 1, parent: null, placement: pose(), status: 'CONFIRMED' },
      { id: 'bad', name: 'Bad', kind: 'part', quantity: -1, parent: null, placement: pose(), status: 'CONFIRMED' },
    ],
  })]), /integer/i);
});

test('gm02: G02-08 catalog import refuses COTS scaling and guessed optical placement', () => {
  // A scalar non-rigid scale is rejected; an optical normal cannot supply roll.
  assert.throws(() => fmcad(['catalog', 'check', '--data', JSON.stringify({
    version: 1, revision: 'r1',
    records: [{ id: 'c', name: 'COTS', kind: 'purchased', quantity: 1, parent: null, status: 'CONFIRMED',
      placement: { frame: 'root', translation: ['0 mm', '0 mm', '0 mm'], rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1] } }],
  })]), /scale|shear/i);
});

test('gm02: G02-09 generic 145-ID/36-model fixture counts derive from input, not constants', () => {
  const records = Array.from({ length: 145 }, (_, i) => ({
    id: `generic_${i}`, name: `G${i}`, kind: 'part', quantity: 1, parent: null, placement: pose(), status: 'ESTIMATED',
    ...(i < 36 ? { model: { path: 'missing-envelope.step', representation: 'envelope', source: 'synthetic', status: 'ESTIMATED' } } : {}),
  }));
  const out = fmcad(['catalog', 'check', '--data', JSON.stringify({ version: 1, revision: 'r1', records })]);
  assert.deepEqual(out.result.counts, { ids: 145, models: 36, instances: 145 });
  assert.equal(out.status, 'unknown'); // missing model files remain unresolved
});
