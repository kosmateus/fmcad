'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../src/queue-instance');
const { savedAuditKind, savedAuditLegacyKind, assertSavedAuditPathBudget } = require('../src/queue-saved-audit-path');
const { createRecoveryAudit } = require('../src/queue-atomic-recovery-audit');

test('saved audit layout includes the existing atomic UUID temporary suffix in the Windows path budget', () => {
  const root = '\\\\wsl$\\Ubuntu\\home\\test-user\\.local\\state\\fmcad\\queue\\epoch-successions\\' + 'a'.repeat(64);
  const request = 'one-full-original-destination-request';
  const old = path.join(root, savedAuditLegacyKind('dp-', request));
  assert.throws(() => assertSavedAuditPathBudget(old), { code: 'SAVED_AUDIT_PATH_TOO_LONG' });
  const shorter = assertSavedAuditPathBudget(path.join(root, savedAuditKind('dp-', request)));
  assert.ok(shorter.atomicTempLength <= 259);
  assert.equal(savedAuditKind('dp-', request).length, 19);
  assert.notEqual(savedAuditKind('dp-', request), savedAuditKind('sr-', request));
});

test('a shortened directory collision still fails the full immutable request key before SDK', async t => {
  const root = fs.mkdtempSync('/tmp/opencode/saved-audit-collision-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kind = 'dp-same-locator', dir = path.join(root, kind); fs.mkdirSync(dir);
  api.durable(path.join(dir, 'intent.json'), { key: { jobId: 'real-parent', requestId: 'original-full-id', clientId: 'owner' } }, true);
  const control = createRecoveryAudit({ kind, priorObservationRequired: false, jobDirectory: () => root,
    assertOwner() {}, inspect() { assert.fail('Collision must reject before preparing or sending SDK'); } });
  await assert.rejects(control.handle({ action: 'inspect', jobId: 'real-parent', requestId: 'different-full-id' }, 'owner'),
    { code: 'AUDIT_ALREADY_REQUESTED' });
});
