'use strict';

// CWG governance gap tests (X-11, X-16). These run offline against the local
// engineering-fit and data-import modules and the delivered catalog, asserting
// that CWG data conflicts are flagged (OPEN/fail) rather than silently resolved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fit, definition, check } = require('../src/engineering-fit');
const dataImport = require('../src/data-import');
const { catalog } = require('../src/cad');
const engineeringLocal = require('../src/engineering-local').descriptors;

const FIX = path.join(__dirname, 'fixtures', 'cwg');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

const base = {
  schemaVersion: 1,
  identity: { model: 'cwg', revision: '1' },
  frame: 'datum:A',
  assumptions: ['Independent bounded dimensions in a common datum.'],
};
const clearance = (bore) => [
  { id: 'bore', sign: 1, nominal: bore, minus: '0 mm', plus: '0 mm' },
  { id: 'journal', sign: -1, nominal: '6 mm', minus: '0 mm', plus: '0 mm' },
];
const journalDefinition = (bore, part) => ({
  ...base, id: 'journal-fit', revision: '1', parts: ['Root/P037:1', `Root/${part}:1`],
  datums: ['A'], requirements: [{ ...base, terms: clearance(bore), minimum: '0 mm' }],
  representation: 'snapshot',
});

test('X-11: fixture carries the P037/P086/P098 interface conflict as OPEN', () => {
  const f = load('cwg-interface-conflict.json');
  assert.equal(f.status, 'OPEN');
  assert.equal(f.items.P037.interfaceRef, 'P086');
  assert.equal(f.items.P086.bore, '3.05 mm');
  assert.equal(f.items.P098.bore, '6.05 mm');
  assert.match(f.conflict.reason, /flagged/);
});

test('X-11: D6 journal vs P086 (ID3.05) is flagged fail, not silently resolved', () => {
  const declared = fit({ ...base, terms: clearance('3.05 mm'), minimum: '0 mm' });
  assert.equal(declared.status, 'fail');
  assert.ok(declared.result.nominal.value < 0); // interference
  const checked = check({ ...base, definition: journalDefinition('3.05 mm', 'P086') });
  assert.equal(checked.status, 'fail');
});

test('X-11: D6 journal vs P098 (ID6.05) passes — only the correct bushing fits', () => {
  const allocated = fit({ ...base, terms: clearance('6.05 mm'), minimum: '0 mm' });
  assert.equal(allocated.status, 'pass');
  assert.ok(allocated.result.nominal.value > 0);
  const checked = check({ ...base, definition: journalDefinition('6.05 mm', 'P098') });
  assert.equal(checked.status, 'pass');
});

test('X-11: catalog.check keeps unresolved bushing cross-sections OPEN, not pass', () => {
  const pose = { frame: 'parent', translation: ['0 mm', '0 mm', '0 mm'], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const data = { version: 1, revision: 'r1', records: [
    { id: 'P037', name: 'pan_counter_shaft', kind: 'part', quantity: 1, parent: null, placement: pose, status: 'CONFIRMED' },
    { id: 'P086', name: 'shaft_bushing', kind: 'part', quantity: 1, parent: null, placement: pose, status: 'OPEN' },
    { id: 'P098', name: 'pan_counter_bushing', kind: 'part', quantity: 1, parent: null, placement: pose, status: 'OPEN' },
  ] };
  const plan = dataImport.prepare('catalog.check', data);
  const out = dataImport.offlineResult(plan);
  assert.equal(out.status, 'unknown');
  assert.ok(out.unresolved.length > 0);
});

test('X-16: every FR-01..FR-34 maps to a delivered catalog operation', () => {
  const map = load('fr-map.json').mapping;
  const delivered = new Set([
    ...Object.keys(catalog),
    ...Object.keys(engineeringLocal),
  ]);
  const expected = Array.from({ length: 34 }, (_, i) => `FR-${String(i + 1).padStart(2, '0')}`);
  const got = map.map((r) => r.fr);
  assert.deepEqual(got.slice().sort(), expected.sort(), 'FR map must cover FR-01..FR-34');

  for (const row of map) {
    assert.ok(row.operations.length > 0, `${row.fr} has no operations`);
    for (const op of row.operations) {
      assert.ok(delivered.has(op), `${row.fr} maps to undelivered operation ${op}`);
    }
  }
});

test('X-16: no FR in the map points only at itself (each entry has a concrete op)', () => {
  const map = load('fr-map.json').mapping;
  for (const row of map) {
    assert.notEqual(row.operations[0], row.fr, `${row.fr} is self-referential`);
  }
});
