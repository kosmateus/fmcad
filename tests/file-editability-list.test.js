const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpScript } = require('../src/ops');
const { globalHelp } = require('../src/help');
const invoke = require('./helpers/diagnostic-command');

for (const backend of ['mcp', 'addin']) {
  test(`inventory requests readOnly via ${backend} with zero or one project argument`, async () => {
    for (const args of [[], ['Project "quoted"'], ['b.project-id']]) {
      const result = await invoke(['file_editability_list', ...args], backend);
      assert.equal(result.code, 0);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.calls[0], { featureType: 'script', object: {
        script: buildOpScript('file_editability_list', args), readOnly: true,
      } });
      assert.equal(result.stderr, '');
    }
  });
}

test('inventory help is offline and documents partial counts and slot distinction', async () => {
  assert.match(globalHelp(), /file_editability_list \[project\]/);
  for (const argv of [['help', 'file_editability_list'], ['file_editability_list', '--help']]) {
    const result = await invoke(argv);
    assert.equal(result.code, 0);
    assert.equal(result.loads, 0);
    for (const pattern of [/FILE_EDITABILITY_LIST/, /scope, property, message/, /null/, /no DONE/,
      /readOnly: true/, /personal-use editable-slot membership/, /never reads personalUseLimits/]) {
      assert.match(result.stdout, pattern);
    }
  }
});

test('inventory rejects excess args and command flags before backend setup', async () => {
  for (const args of [['one', 'two'], ['--doc', 'Part'], ['--save'], ['--editable'], ['--readonly']]) {
    const result = await invoke(['file_editability_list', ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.loads, 0);
    assert.deepEqual(result.calls, []);
  }
});

test('partial inventory survives MCP parsing with nonzero status and no DONE or retry', async () => {
  const report = { files: [{ id: 'ok', name: 'Part', projectId: 'p', projectName: 'P',
    folderId: 'root', folderPath: '/', isReadOnly: false }],
  counts: { files: 1, readOnly: 0, notReadOnly: 1, unknown: 0 }, complete: false,
  errors: [{ scope: 'data.dataProjects[1]', property: 'rootFolder', message: 'unavailable' }] };
  const text = 'FILE_EDITABILITY_LIST ' + JSON.stringify(report) +
    '\nERROR file_editability_list incomplete inventory; see errors\n';
  const result = await invoke(['file_editability_list'], 'mcp', text);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, text + '\n');
  assert.doesNotMatch(result.stdout, /^DONE$/m);
});
