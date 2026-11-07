const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const publication = require('../src/document-publication');

for (const [name, record, errorCode, expected, accepted, saves] of [
  ['intent FS failure', '00000000.json', 'EIO', 'blocked', false, 0],
  ['accepted receipt FS failure', '00000001.json', 'EIO', 'unknown', true, 1],
  ['accepted receipt exclusive target conflict', '00000001.json', 'EEXIST', 'unknown', true, 1],
  ['completion receipt FS failure', '00000002.json', 'EIO', 'unknown', true, 1],
]) test('document persistence fault: ' + name, async t => {
  const root = await fs.mkdtemp('/tmp/opencode/document-fault-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let saveCount = 0, failed = false;
  const io = { ...fs, link: async (source, destination) => {
    if (!failed && path.basename(destination) === record) {
      failed = true; throw Object.assign(Error('injected publication ' + errorCode), { code: errorCode });
    }
    return fs.link(source, destination);
  } };
  const input = { requestId: 'r', operationId: 'o', projectId: 'project', fileId: 'file', creationId: 'doc', expectedVersion: 1, reportPath: root, confirm: true, timeBudgetMs: 1 };
  const context = { doc: 'Part', docId: 'doc', docFileId: 'file', projectId: 'project' };
  const sdk = async (_client, operation) => {
    if (operation === 'document.save_native') { saveCount++; return { success: true, result: { status: 'accepted', accepted: true } }; }
    assert.equal(operation, 'document.status');
    return { success: true, result: { name: 'Part', creationId: 'doc', fileId: 'file', projectId: 'project', version: saveCount ? 2 : 1,
      saved: true, modified: !saveCount, isComplete: true, isReadOnly: false } };
  };
  const out = await publication.execute({}, 'document.save.once', input, context, sdk, { fs: io, now: () => 0 });
  assert.equal(out.status, expected); assert.equal(out.accepted, accepted); assert.equal(saveCount, saves);
  if (saves) {
    await publication.execute({}, 'document.save.once', input, context, sdk);
    const { confirm: _, ...observe } = input;
    await publication.execute({}, 'document.save.observe', observe, context, sdk);
    assert.equal(saveCount, 1);
  }
  const names = await fs.readdir(path.join(root, 'document-save'));
  const directory = path.join(root, 'document-save', names[0]);
  assert(!(await fs.readdir(directory)).some(name => name.includes('.tmp')));
});
