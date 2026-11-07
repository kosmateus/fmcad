const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpScript } = require('../src/ops');
const { globalHelp } = require('../src/help');
const executeDiagnostic = require('./helpers/diagnostic-command');
const invoke = (argv, backend = 'mcp', failed = false) => executeDiagnostic(argv, backend,
  failed ? 'ERROR file_editability getter failed' : 'DONE');

for (const backend of ['mcp', 'addin']) {
  test(`file_editability sends the generated read-only payload via ${backend}`, async () => {
    const result = await invoke(['file_editability'], backend);
    assert.equal(result.code, 0);
    assert.deepEqual(result.calls, [{ featureType: 'script', object: {
      script: buildOpScript('file_editability', []), readOnly: true,
    } }]);
    assert.equal(result.stderr, '');
  });
}

test('file_editability help is registered and offline', async () => {
  assert.match(globalHelp(), /^  file_editability$/m);
  for (const argv of [['help', 'file_editability'], ['file_editability', '--help']]) {
    const result = await invoke(argv);
    assert.equal(result.code, 0);
    assert.equal(result.loads, 0);
    assert.match(result.stdout, /mutationSupported: false/);
    assert.match(result.stdout, /Fusion GUI/);
    assert.match(result.stdout, /personalUseLimits: null/);
    assert.match(result.stdout, /Getter failures/);
    assert.match(result.stdout, /diagnosticsComplete: true/);
    assert.match(result.stdout, /diagnosticsComplete: false/);
    assert.match(result.stdout, /editableFiles: null/);
    assert.match(result.stdout, /never a partial list/);
    assert.doesNotMatch(result.stdout, /No detailed help/);
  }
});

test('file_editability rejects positionals and state-changing flags before backend setup', async () => {
  for (const extra of [['Part'], [''], ['--doc', 'Part'], ['--save'], ['--editable'], ['--readonly']]) {
    const result = await invoke(['file_editability', ...extra]);
    assert.equal(result.code, 1);
    assert.equal(result.loads, 0);
    assert.deepEqual(result.calls, []);
  }
});

test('file_editability propagates backend failure without retry', async () => {
  const result = await invoke(['file_editability'], 'mcp', true);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.match(result.stdout, /^ERROR file_editability/);
});

test('incomplete diagnostic plus ERROR remains nonzero through MCP text parsing', async () => {
  const report = { mutationSupported: false, diagnosticsComplete: false,
    personalUseLimits: { maxEditableFileCount: 10, editableFileCount: 6, editableFiles: null },
    errors: [{ getter: 'personalUseLimits.editableFiles', message: '2 : InternalValidationError : file' }] };
  const text = 'FILE_EDITABILITY ' + JSON.stringify(report) +
    '\nERROR file_editability personalUseLimits.editableFiles: 2 : InternalValidationError : file\n';
  const { code, calls, stdout, stderr } = await executeDiagnostic(['file_editability'], 'mcp', text);
  assert.equal(stderr, '');
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.equal(stdout, text + '\n');
  assert.doesNotMatch(stdout, /^DONE$/m);
});
