'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const api = require('../src/queue-instance');
const { firstSaveEvidence } = require('../src/queue-saved-first-save-evidence');

test('FAKE first-save ledger requires exact worker/SDK/postflight and accepted output before publication', t => {
  const f = require('./fixtures/saved-first-save-evidence.cjs')(t, path.resolve(__dirname, '..'));
  const value = firstSaveEvidence(f.dir, f.state.epoch, f.job.id);
  assert.equal(value.reply.accepted, true); assert.equal(value.reply.status, 'pending');
  assert.equal(value.job.id, f.job.id); assert.ok(value.evidence.length >= 8);
});

for (const mode of ['foreign-job', 'failed-physical', 'wrong-scope', 'postflight-doc', 'failed-envelope'])
test('FAKE first-save evidence refuses ' + mode, t => {
  const f = require('./fixtures/saved-first-save-evidence.cjs')(t, path.resolve(__dirname, '..'));
  let id = f.job.id;
  if (mode === 'foreign-job') id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if (mode === 'failed-physical') {
    const record = api.readJson(path.join(f.jobDirectory, 'rpc-1.json'));
    api.durable(record.receipt, { ...api.readJson(record.receipt), outcome: 'failed' });
  }
  if (mode === 'wrong-scope') {
    const file = path.join(f.jobDirectory, 'rpc-1.json'), record = api.readJson(file);
    record.binding.auditFirstSave = false; api.durable(file, record);
  }
  if (mode === 'postflight-doc') api.durable(path.join(f.jobDirectory, 'postflight.json'),
    { documentState: { status: 'complete', state: { identity: { creationId: 'user-file' } } } });
  if (mode === 'failed-envelope') fs.writeFileSync(path.join(f.jobDirectory, 'stdout.txt'), JSON.stringify({ success: false }));
  assert.throws(() => firstSaveEvidence(f.dir, f.state.epoch, id), { code: 'SAVED_FIRST_SAVE_EVIDENCE_REQUIRED' });
});
