'use strict';

// Live integration tests for GM-34 (markings and labels). Markings are
// declared-geometry evaluations: annotation descriptors, gated emboss/engrave
// recipes, and checks that MIN/MAX derive from a liquid level, arrows derive
// from a defined flow, and no mark lands in an optical/seal protected zone.
// User text is preserved verbatim and geometry is never swapped for an image.

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

test('gm34: G34-01 marking.create returns an annotation descriptor with verbatim content', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['marking', 'create', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [{
      id: 'level-max', kind: 'text', representation: 'annotation', content: 'MAX 50%',
      position: ['0 mm', '20 mm', '0 mm'], dimensions: { height: '3 mm', width: '8 mm' },
      font: 'ISO3098', source: { item: 'tank', level: 'max', status: 'CONFIRMED' },
    }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const mark = out.result.marks[0];
  assert.equal(mark.content, 'MAX 50%');
  assert.equal(mark.nativeAcceptance, 'annotation');
  assert.ok(mark.annotation);
  assert.equal(mark.geometryRecipe, null);
  assert.equal(out.result.annotationCount, 1);
  assert.equal(out.result.geometryRecipeCount, 0);
});

test('gm34: G34-02 emboss/engrave marks are gated geometry recipes, never images', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['marking', 'create', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [
      { id: 'logo', kind: 'text', representation: 'emboss', content: 'LOGO',
        position: ['0 mm', '0 mm', '0 mm'], dimensions: { height: '5 mm' }, depth: '0.5 mm' },
      { id: 'eng', kind: 'symbol', representation: 'engrave', content: 'CE',
        position: ['10 mm', '0 mm', '0 mm'], dimensions: { height: '5 mm' }, depth: '0.2 mm' },
    ],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const emboss = out.result.marks[0];
  assert.equal(emboss.nativeAcceptance, 'notEvaluated');
  assert.equal(emboss.geometryRecipe.representation, 'emboss');
  assert.equal(emboss.annotation, null);
  assert.equal(out.result.geometryRecipeCount, 2);
});

test('gm34: G34-03 marking.check verifies MIN/MAX derivation against a computed level', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['marking', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [{
      id: 'level-max', kind: 'text', representation: 'annotation', content: 'MAX',
      position: ['0 mm', '20 mm', '0 mm'], dimensions: { height: '3 mm' },
      reference: { kind: 'liquid-level', bound: 'max' }, levelValue: '20 mm',
    }],
    levels: { min: '0 mm', max: '20 mm' },
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.marks[0].passed, true);
  assert.equal(out.result.marks[0].checks[0].check, 'level-derivation');
  assert.equal(out.result.marks[0].checks[0].passed, true);
});

test('gm34: G34-04 marking.check enforces flow-derived arrows and protected zones', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const arrow = fmcad(['marking', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [{
      id: 'flow-arrow', kind: 'arrow', representation: 'annotation',
      position: ['0 mm', '0 mm', '0 mm'], dimensions: { height: '5 mm' }, direction: [1, 0, 0],
    }],
    flows: [{ id: 'pump-out', direction: [1, 0, 0] }],
  })]);
  assert.equal(arrow.status, 'pass', JSON.stringify(arrow));
  assert.equal(arrow.result.marks[0].checks[0].matched, 'pump-out');

  const zone = cad(['marking', 'create', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [{
      id: 'badge', kind: 'text', representation: 'annotation', content: 'BADGE',
      position: ['0 mm', '0 mm', '0 mm'], dimensions: { height: '10 mm' },
    }],
    zones: [{
      name: 'lens', kind: 'optical',
      region: { min: ['-5 mm', '-5 mm', '-5 mm'], max: ['5 mm', '5 mm', '5 mm'] },
    }],
  })]);
  assert.equal(zone.json.status, 'fail', JSON.stringify(zone.json));
  assert.deepEqual(zone.json.result.marks[0].zoneViolations, ['lens']);
});

test('gm34: G34-05 marking.create preserves user content and source item/BOM association', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const content = 'MAX 50% — no translation';
  const out = fmcad(['marking', 'create', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1,
    marks: [{
      id: 'level-max', kind: 'text', representation: 'annotation', content,
      position: ['0 mm', '20 mm', '0 mm'], dimensions: { height: '3 mm' },
      source: { item: 'tank', level: 'max', status: 'CONFIRMED' },
    }],
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const mark = out.result.marks[0];
  assert.equal(mark.content, content);
  assert.deepEqual(mark.source, { item: 'tank', level: 'max', status: 'CONFIRMED' });
});
