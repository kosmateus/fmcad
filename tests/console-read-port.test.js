'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConsoleReadPort } = require('../packages/node-adapters/dist/console/read-port');

test('passive read port exposes missing, stale, available and error without converting absence to zero', () => {
  const read = value => createConsoleReadPort(() => value, () => 100).read();
  assert.equal(read({ available: false, operations: null }).status, 'missing');
  const old = read({ available: false, operations: [{ id: 'old' }] });
  assert.equal(old.status, 'stale');
  assert.equal(old.value.operations[0].id, 'old');
  assert.equal(read({ available: true, observedAt: 100 }).status, 'available');
  assert.equal(read({ available: true, observedAt: 101 }).status, 'stale');
  assert.equal(read({ available: true, observedAt: -20000 }).status, 'stale');
  assert.equal(read({ available: true, observedAt: null }).status, 'stale');
  assert.equal(createConsoleReadPort(() => { throw new Error('unreadable'); }).read().status, 'error');
});

test('fresh control status is re-read immediately, even when last displayed state differs', async () => {
  const { BrokerControl } = require('../src/console-controller');
  let generation = 0, mutations = 0;
  const control = new BrokerControl(() => ({ register: async () => {}, call: async (method, payload) => {
    if (method === 'control-status') return { instanceId: 'broker', generation: generation++ };
    mutations++;
    assert.equal(payload.control.expectedGeneration, 1);
    return { instanceId: 'broker', generation: 2 };
  } }));
  await assert.rejects(control.set(true), /Read broker state/);
  await control.read();
  await control.set(true);
  assert.equal(mutations, 1);
});

test('failed authoritative refresh refuses control without a mutation or replay', async () => {
  const { BrokerControl } = require('../src/console-controller');
  let reads = 0, mutations = 0;
  const control = new BrokerControl(() => ({ register: async () => {}, call: async method => {
    if (method !== 'control-status') { mutations++; return {}; }
    if (reads++) throw new Error('offline');
    return { instanceId: 'broker', generation: 0 };
  } }));
  await control.read();
  await assert.rejects(control.set(false), /offline/);
  assert.equal(mutations, 0);
});
