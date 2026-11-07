'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRecoveryAudit } = require('../src/queue-atomic-recovery-audit');

test('FAKE owner audit: a new-file action uses its real parent job without inventing a prior observation job', async t => {
  const directory = fs.mkdtempSync('/tmp/opencode/saved-audit-key-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let owners = 0;
  const audit = createRecoveryAudit({ kind: 'fake-saved-key', priorObservationRequired: false,
    jobDirectory: () => directory,
    assertOwner(job, prior, client) { owners++; assert.equal(job, 'real-parent-job'); assert.equal(prior, undefined); assert.equal(client, 'owner'); },
    inspect() { throw Object.assign(new Error('Stop before SDK'), { code: 'FAKE_NO_SDK' }); } });
  await assert.rejects(audit.handle({ action: 'inspect', jobId: 'real-parent-job', requestId: 'one-explicit-read' }, 'owner'),
    { code: 'FAKE_NO_SDK' });
  assert.equal(owners, 1);
  await assert.rejects(audit.handle({ action: 'inspect', jobId: 'real-parent-job', requestId: 'one-explicit-read',
    observationJobId: 'invented-prior' }, 'owner'), { code: 'INVALID_REQUEST' });
  assert.equal(owners, 1);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('existing owner audits still require their actual prior-observation identity', async () => {
  const audit = createRecoveryAudit({});
  await assert.rejects(audit.handle({ action: 'inspect', jobId: 'real-parent-job', requestId: 'one-explicit-read' }, 'owner'),
    { code: 'INVALID_REQUEST' });
});
