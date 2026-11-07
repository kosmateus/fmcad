const test = require('node:test');
const assert = require('node:assert/strict');
const { execute, bindingFor } = require('../packages/core/dist/application/documents/save');

const input = { requestId: 'req', operationId: 'op', projectId: 'project', fileId: 'file', creationId: 'doc', expectedVersion: 1, reportPath: '/unused', confirm: true, timeBudgetMs: 2 };
const context = { doc: 'Part', docId: 'doc', docFileId: 'file', projectId: 'project' };
function fixture(options = {}) {
  const records = [], calls = []; let time = 0, saved = false, locked = false;
  const baseline = { name: 'Part', creationId: 'doc', fileId: 'file', projectId: 'project', version: 1, saved: true, modified: true, isComplete: true, isReadOnly: false };
  const journal = {
    load: async () => ({ records, binding: bindingFor(input) }),
    acquireSubmission: async () => { if (locked) return null; locked = true; return async () => { locked = false; if (options.cleanupFailure) throw Error('cleanup'); }; },
    submissionExists: async () => locked,
    append: async (_binding, list, result) => {
      calls.push('publish:' + result.status);
      if (result.status === options.failPublication) throw Error('disk unavailable');
      list.push({ result });
    },
  };
  const services = {
    open: async () => journal,
    status: async () => {
      calls.push('status');
      if (options.preflightFailure && !saved) throw Error('SDK unavailable');
      if (saved && options.postSaveFailure) throw Error('readback unavailable');
      return { ...baseline, ...(saved ? { version: 2, modified: false, isComplete: !options.cloudPending } : {}), ...(options.wrongDocument ? { fileId: 'other' } : {}) };
    },
    save: async () => { calls.push('save'); saved = true; if (options.ackLost) throw Error('ack lost'); return { status: 'accepted', accepted: true }; },
    now: () => time,
    sleep: async ms => { time += ms; },
  };
  return { services, calls, records };
}
for (const [name, options, expected, accepted, saves] of [
  ['before save SDK failure', { preflightFailure: true }, 'blocked', false, 0],
  ['before save intent publication failure', { failPublication: 'submit_uncertain' }, 'blocked', false, 0],
  ['wrong document', { wrongDocument: true }, 'blocked', false, 0],
  ['after save ack lost', { ackLost: true }, 'unknown', null, 1],
  ['after save receipt publication failure', { failPublication: 'accepted' }, 'unknown', true, 1],
  ['after save completion publication failure', { failPublication: 'complete' }, 'unknown', true, 1],
  ['after save getter failure', { postSaveFailure: true }, 'unknown', true, 1],
  ['cloud timeout', { cloudPending: true }, 'pending', true, 1],
  ['cleanup failure', { cleanupFailure: true }, 'unknown', true, 1],
]) test('document application: ' + name, async () => {
  const f = fixture(options);
  const out = await execute('document.save.once', input, context, f.services);
  assert.equal(out.status, expected); assert.equal(out.accepted, accepted);
  assert.equal(f.calls.filter(call => call === 'save').length, saves);
  if (saves) {
    const repeated = await execute('document.save.once', input, context, f.services);
    assert.equal(repeated.replayedReceipt, true);
    assert.equal(f.calls.filter(call => call === 'save').length, 1);
    const { confirm: _, ...observe } = input;
    await execute('document.save.observe', observe, context, f.services);
    assert.equal(f.calls.filter(call => call === 'save').length, 1);
  }
});
test('document application pins exact request scope before any effect', async () => {
  const f = fixture();
  const result = await execute('document.save.once', input, { ...context, projectId: 'other' }, f.services);
  assert.equal(result.status, 'blocked'); assert.deepEqual(f.calls, []);
});
test('document save snapshots request and target context before the first await', async () => {
  const request = { ...input }, targetContext = { ...context }, f = fixture();
  const original = f.services.open;
  f.services.open = async (...args) => {
    request.requestId = 'changed'; targetContext.docFileId = 'other';
    return original(...args);
  };
  f.services.save = async (submitted, target, selected) => {
    assert.equal(submitted.requestId, 'req'); assert.equal(selected.docFileId, 'file'); assert.equal(target.fileId, 'file');
    return { status: 'failed', accepted: false };
  };
  const result = await execute('document.save.once', request, targetContext, f.services);
  assert.equal(result.requestId, 'req'); assert.equal(result.target.fileId, 'file');
});
