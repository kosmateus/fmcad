const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocumentService } = require('../src/docops');
test('docops forwards the dedicated review shot handler without a second screenshot pipeline', () => {
  assert.equal(require('../src/docops').shotCmd, require('../src/shot').shotCmd);
});

test('typed document service dispatches actual commands without CLI imports or stdout', async () => {
  const calls = [];
  const client = { callTool: async (data, tool) => {
    calls.push({ data, tool });
    return data.queryType === 'document' ? { text: '', data: { results: [{ name: 'Part', id: 'exact-id' }] } } : { text: 'accepted' };
  } };
  const service = createDocumentService(client, value => 'W:' + value);
  assert.deepEqual(await service.execute({ kind: 'list' }), { code: 0, stdout: 'DOC name=Part id=exact-id\nDONE\n', stderr: '' });
  assert.equal((await service.execute({ kind: 'open', name: 'Part' })).code, 0);
  assert.deepEqual(calls.at(-1), { tool: 'fusion_mcp_execute', data: { featureType: 'document', object: { operation: 'open', fileId: 'exact-id' } } });
  const before = calls.length;
  assert.equal((await service.execute({ kind: 'close', save: false, discard: false })).code, 1);
  assert.equal(calls.length, before);
  await service.execute({ kind: 'close', save: false, discard: true });
  assert.deepEqual(calls.at(-1).data.object, { operation: 'close', userConfirmedCloseWithoutSave: true });
  await service.execute({ kind: 'download', name: 'Part', output: '/target.step' });
  assert.match(calls.at(-1).data.object.script, /FILE_ID = "exact-id"/);
  assert.match(calls.at(-1).data.object.script, /DIR_PATH = "W:\/target.step"/);
  assert(!Object.keys(require.cache).some(file => /\/src\/cli\.js$/.test(file)));
});
test('typed document service never retries rejected or unknown SDK mutations', async () => {
  let calls = 0;
  const failed = createDocumentService({ callTool: async () => { calls++; return { failed: true, text: 'not accepted' }; } });
  assert.equal((await failed.execute({ kind: 'save' })).code, 1); assert.equal(calls, 1);
  const unknown = createDocumentService({ callTool: async () => { calls++; throw Error('ack lost'); } });
  await assert.rejects(unknown.execute({ kind: 'save' }), /ack lost/); assert.equal(calls, 2);
});
