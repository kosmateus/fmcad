const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, mapCadPaths } = require('../src/cad');
const { findCommand } = require('../src/commands');
const { validateBatch } = require('../src/batch');

test('scoped document aliases resolve without changing legacy doc save', () => {
  assert.equal(findCommand(['doc', 'save-as']).target, 'document.save_as');
  assert.equal(findCommand(['doc', 'status']).target, 'document.status');
  assert.equal(findCommand(['doc', 'save']).kind, 'docops');
});

test('motion frame destinations map like other local exports without altering tracks', () => {
  for (const operation of ['motion.sample', 'animation.joints']) {
    const input = { frameFiles: ['/mnt/c/output/frame.png'], tracks: [{ joint: { token: 'opaque' } }] };
    const mapped = mapCadPaths(operation, input);
    assert.equal(mapped.frameFiles[0], 'C:\\output\\frame.png');
    assert.deepEqual(mapped.tracks, input.tracks);
    assert.equal(input.frameFiles[0], '/mnt/c/output/frame.png');
    assert.equal(mapCadPaths(operation, { directory: '/mnt/c/output' }).directory, 'C:\\output');
  }
});

test('cloud save-as cannot be included in a modeling batch', () => {
  const result = validateBatch({ runId: 'no-cloud-save', operations: [
    { id: 'save', operation: 'document.save_as', data: catalog['document.save_as'].example },
  ] }, catalog);
  assert.equal(result.success, false);
  assert.ok(result.errors.some(error => /invoked separately/.test(error)));
});

test('simulation discovery does not advertise chargeable or preview solver operations', () => {
  assert.deepEqual(Object.keys(catalog).filter(key => key.startsWith('simulation.')), ['simulation.capabilities']);
  assert.equal(catalog['simulation.capabilities'].readOnly, true);
});
