'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('terminal-kit');
const { documentLabel, sourceName, documentFields } = require('../src/console-document');
const { createUI } = require('../src/console-ui');
const { describe } = require('../src/console-details');
const { ConsoleModel } = require('../src/console-controller');
const { render } = require('../src/console-renderer');
test('document display prioritizes recorded Fusion names and marks source fallbacks explicitly', () => {
  const source = { sourcePath: '/project/fixture.py', label: 'run fixture.py' };
  assert.equal(documentLabel({ ...source, document: 'Known Fusion v2' }), 'Known Fusion v2');
  assert.equal(documentLabel(source), 'py · fixture.py');
  assert.equal(sourceName({ sourcePath: 'C:\\project\\fixture.py' }), 'fixture.py');
  assert.equal(documentLabel({ script: 'retained.py' }), 'py · retained.py');
  assert.equal(documentLabel({ label: 'run retained.py' }), 'py · retained.py');
  assert.equal(documentLabel({ label: 'doctor' }), null);
  assert.equal(documentLabel(null), null);
  assert.equal(source.document, undefined);
});
test('details use the same display value and disclose the fallback provenance', () => {
  const ui = createUI({ buffer: new kit.ScreenBuffer({ width: 100, height: 30 }), prefs: {}, language: 'en' });
  const row = { id: 'op', state: 'succeeded', sourcePath: '/project/fixture.py' };
  assert.equal(documentFields(row, ui)[0].value, documentLabel(row));
  assert.match(documentFields(row, ui)[1].value, /Fusion target not recorded/);
  const fields = describe(row, ui).fields;
  assert.equal(fields.find(field => field.label === 'Document / script').value, 'py · fixture.py');
});
test('Overview and Tasks render nonempty document cells for the same source-only row', () => {
  for (const tab of [0, 2]) for (const Class of [kit.ScreenBuffer, kit.ScreenBufferHD]) {
    const model = new ConsoleModel(); model.tab = tab;
    model.update({ mode: 'broker', project: '/fixture', available: true, broker: { state: 'STOPPED', online: false },
      operations: [{ id: 'source-only', state: 'succeeded', order: 1, label: 'run fixture.py', sourcePath: '/fixture/fixture.py' }],
      agents: [], logs: [], fusion: {}, retention: {}, capabilities: {} });
    const buffer = new Class({ width: 222, height: 58 }); buffer.draw = () => {};
    const view = render({ model, buffer, prefs: {}, language: 'en' });
    const hit = view.hits.find(hit => hit.type === 'row' && hit.id === 'source-only');
    assert.ok(hit);
    const line = y => Array.from({ length: buffer.width }, (_, x) => buffer.get({ x, y }).char).join('');
    const column = line(hit.y - 1).indexOf('DOCUMENT / SCRIPT');
    assert.ok(column >= 0, 'document/script column must be visible');
    assert.ok(line(hit.y).slice(column, column + 30).includes('py · fixture.py'), 'source must be in the document cell, not only in the command cell');
  }
});
test('document filters accept recorded target, source filename and displayed fallback', () => {
  const model = new ConsoleModel(); model.tab = 2;
  model.update({ operations: [{ id: 'source', state: 'succeeded', sourcePath: '/project/fixture.py' }, { id: 'doc', state: 'succeeded', document: 'Known Fusion' }] });
  for (const document of ['fixture.py', 'py · fixture.py']) {
    model.state.filters = { scope: 'all', document };
    assert.deepEqual(model.rows().map(row => row.id), ['source']);
  }
  model.state.filters.document = 'Known Fusion';
  assert.deepEqual(model.rows().map(row => row.id), ['doc']);
});
