'use strict';

// Exercises the real CLI catalog preflight only; no Fusion client is invoked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCad } = require('../src/cad');

test('nested occurrence destination fields pass CLI catalog preflight for add and duplicate', () => {
  assert.doesNotThrow(() => validateCad('occurrence.add', {
    component: { token: 'component' }, copyMode: 'linked', destination: { token: 'parent' },
    placement: { translation: ['1 cm', '0 cm', '0 cm'] }, placementSpace: 'parent',
    sharedParentPolicy: 'allInstances',
  }));
  assert.doesNotThrow(() => validateCad('occurrence.duplicate', {
    occurrence: { token: 'source' }, copyMode: 'independent', destination: { token: 'parent' },
    sharedParentPolicy: 'allInstances',
  }));
});

test('nested occurrence CLI preflight rejects unregistered and missing required fields', () => {
  assert.throws(() => validateCad('occurrence.add', {
    component: 'component', copyMode: 'linked', destination: 'root', inventedOption: true,
  }), /Unknown CAD inputs: inventedOption/);
  assert.throws(() => validateCad('occurrence.duplicate', {
    occurrence: 'source', destination: 'root',
  }), /Missing CAD inputs: copyMode/);
});
