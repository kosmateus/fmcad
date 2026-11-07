const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, ok, failed, scriptConfig, textResult, image } = require('./helpers/legacy');

// The fixture may live on a mounted drive or the WSL Linux filesystem.
function fixtureWindowsPath(file) {
  const drive = file.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  return drive ? `${drive[1].toUpperCase()}:\\${drive[2].replaceAll('/', '\\')}`
    : `\\\\wsl$\\LegacyTest${file.replaceAll('/', '\\')}`;
}

// Frozen from 9217134, deliberately independent of the migrating registry.
const doc = 'Part "quoted" \\ test';
const hub = [
  ['projects', []], ['project_create', ['Project']], ['project_create', ['Project', 'Purpose']],
  ['project_rename', ['Project', 'Renamed']], ['folder_list', ['Project']], ['folder_list', ['Project', 'A/B']],
  ['folder_create', ['Project', 'A/B']], ['folder_rename', ['Project', 'A/B', 'C']], ['folder_delete', ['Project', 'A/B']],
  ['file_rename', ['Project', '', 'Part', 'Renamed']], ['file_move', ['Project', '', 'Part', 'A/B']],
  ['file_delete', ['Project', 'A/B', 'Part']], ['tree', ['Project']], ['tree', ['Project', 'A/B']],
];
const design = [
  ['param_list', []], ['param_add', ['width', '25 mm']], ['param_add', ['width', '25 mm', '', 'outer "width"']],
  ['param_add', ['width', '25 mm', 'mm']], ['param_set', ['width', '30 mm']], ['param_rename', ['width', 'outer']],
  ['param_delete', ['width']], ['plane_list', []], ['plane_add', ['P1', 'offset', 'XY', '10 mm']],
  ['plane_add', ['P2', 'mid', 'XY', 'P1']], ['plane_add', ['P3', 'angle', 'XY', 'X', '45 deg']],
  ['plane_rename', ['P1', 'Offset']], ['plane_delete', ['P1']], ['stats', []], ['bbox', []], ['bodies', []],
  ['comp_list', []], ['comp_add', ['Motor']], ['comp_add', ['Motor', 'Housing']], ['rollback', ['2']],
  ['units', ['mm']], ['units', ['cm']], ['units', ['in']],
];
const commands = [...new Set([...hub, ...design].map(([name]) => name)), 'upload', 'file_download',
  'doc', ...['search', 'open', 'new', 'list', 'recent', 'save', 'close'].map(s => `doc ${s}`),
  'export', 'export step', 'export stl', 'shot', 'undo', 'redo', 'active', 'licensing', 'doctor', 'tools', 'call', 'run', 'init', 'help'];

for (const [name, args] of [...hub, ...design]) {
  const targetsDoc = design.some(row => row[0] === name);
  test(`legacy script ${name} ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t);
    ok(await f.run([name, ...args, ...(targetsDoc ? ['--doc', doc] : [])]));
    const calls = f.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'fusion_mcp_execute');
    assert.equal(calls[0].arguments.featureType, 'script');
    // RF01: CLI param_add now pads optional slots before the document.
    const expectedArgs = name === 'param_add' ? [...args, ...Array(4 - args.length).fill('')] : args;
    assert.deepEqual(scriptConfig(calls[0].arguments.object.script, ['OP', 'ARGS']), {
      OP: name, ARGS: targetsDoc ? [...expectedArgs, doc] : expectedArgs,
    });
    assert.equal(f.requests.length, 1, 'one admitted broker command');
    assert.equal(f.requests[0].action, 'submit');
    assert.equal(f.requests[0].request.backend, 'mcp');
    assert.equal(f.requests[0].request.cwd, f.dir);
    assert.equal(f.requests[0].config.url, f.url);
    assert.deepEqual(f.requests[0].config.headers, {
      'X-Config': 'isolated', 'X-Legacy': 'first:second', 'X-Other': 'yes',
    });
  });
}

for (const command of commands) {
  for (const args of [[...command.split(' '), '--help'], ['help', ...command.split(' ')]]) {
    test(`offline help ${args.join(' ')}`, async t => {
      const f = await fixture(t);
      const invalidConfig = path.join(f.dir, 'invalid.json');
      await fs.writeFile(invalidConfig, '{invalid');
      const result = await f.run(args, { offline: true, config: invalidConfig });
      ok(result);
      assert.match(result.stdout, /usage/i);
      assert.doesNotMatch(result.stdout, /no detailed help/i);
      assert.equal(f.requests.length, 0);
    });
  }
}

for (const args of [[], ['--help'], ['-h']]) test(`global offline help ${args.join(' ')}`, async t => {
  const f = await fixture(t);
  const result = await f.run(args, { offline: true });
  ok(result);
  assert.match(result.stdout, /usage/i);
  assert.equal(f.requests.length, 0);
});

const direct = [
  [['doc', 'search', 'Part', '--project', 'Project'], 'fusion_mcp_read', { queryType: 'document', operation: 'search', name: 'Part', project: 'Project' }],
  [['doc', 'search', 'Part'], 'fusion_mcp_read', { queryType: 'document', operation: 'search', name: 'Part' }],
  [['doc', 'list'], 'fusion_mcp_read', { queryType: 'document', operation: 'open' }],
  [['doc', 'recent'], 'fusion_mcp_read', { queryType: 'document', operation: 'recent' }],
  [['doc', 'save'], 'fusion_mcp_execute', { featureType: 'document', object: { operation: 'save' } }],
  [['doc', 'close', '--save'], 'fusion_mcp_execute', { featureType: 'document', object: { operation: 'close', userConfirmedSaveAndClose: true } }],
  [['doc', 'close', '--discard'], 'fusion_mcp_execute', { featureType: 'document', object: { operation: 'close', userConfirmedCloseWithoutSave: true } }],
  ...['undo', 'redo'].map(name => [[name], 'fusion_mcp_update', { featureType: name }]),
  [['active'], 'fusion_mcp_read', { queryType: 'activeCommand' }],
  [['licensing'], 'fusion_mcp_read', { queryType: 'licensing' }],
  [['call', 'custom_tool', '{"enabled":true,"disabled":false,"empty":null}'], 'custom_tool', { enabled: true, disabled: false, empty: null }],
];
for (const [args, name, argumentsObj] of direct) {
  test(`legacy route ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    ok(await f.run(args));
    assert.deepEqual(f.calls(), [{ name, arguments: argumentsObj }]);
  });
}

test('doc open searches then opens first returned ID', async t => {
  const f = await fixture(t);
  ok(await f.run(['doc', 'open', 'Part']));
  assert.deepEqual(f.calls(), [
    { name: 'fusion_mcp_read', arguments: { queryType: 'document', operation: 'search', name: 'Part' } },
    { name: 'fusion_mcp_execute', arguments: { featureType: 'document', object: { operation: 'open', fileId: 'local-file-1' } } },
  ]);
});

for (const name of ['', doc]) test(`doc new name ${JSON.stringify(name)}`, async t => {
  const f = await fixture(t);
  ok(await f.run(['doc', 'new', ...(name ? ['--name', name] : [])]));
  assert.equal(f.calls()[0].name, 'fusion_mcp_execute');
  assert.equal(f.calls()[0].arguments.featureType, 'script');
  assert.deepEqual(scriptConfig(f.calls()[0].arguments.object.script, ['NAME']), { NAME: name });
});

for (const fmt of ['step', 'stl']) {
  for (const explicit of [false, true]) test(`export ${fmt} explicit=${explicit}`, async t => {
    const f = await fixture(t);
    const args = ['export', fmt, '--doc', 'Part One'];
    if (explicit) args.push('--out', '/mnt/c/Exports/part.' + fmt);
    if (fmt === 'stl' && explicit) args.push('--body', 'Body One');
    ok(await f.run(args));
    assert.equal(f.calls()[0].name, 'fusion_mcp_execute');
    const out = explicit ? `C:\\Exports\\part.${fmt}` : `${fixtureWindowsPath(f.dir)}\\Part_One.${fmt}`;
    assert.deepEqual(scriptConfig(f.calls()[0].arguments.object.script, ['OP', 'ARGS']), {
      OP: 'export', ARGS: [fmt, fmt === 'stl' && explicit ? 'Body One' : '', out, 'Part One'],
    });
  });
}

for (const scoped of [false, true]) test(`upload scoped=${scoped}`, async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'notes.txt');
  await fs.writeFile(file, 'test');
  ok(await f.run(['upload', file, ...(scoped ? ['--project', 'Project', '--folder', 'A/B'] : [])]));
  assert.equal(f.calls()[0].name, 'fusion_mcp_execute');
  assert.deepEqual(scriptConfig(f.calls()[0].arguments.object.script, ['OP', 'ARGS']), {
    OP: 'upload', ARGS: [fixtureWindowsPath(file), scoped ? 'Project' : '', scoped ? 'A/B' : ''],
  });
});

for (const out of [null, '/mnt/c/Downloads', '/mnt/c/Downloads/renamed.txt']) test(`file_download out=${out}`, async t => {
  const f = await fixture(t);
  ok(await f.run(['file_download', 'Part', ...(out ? ['--out', out] : [])]));
  assert.equal(f.calls().length, 2);
  assert.deepEqual(f.calls()[0], { name: 'fusion_mcp_read', arguments: { queryType: 'document', operation: 'search', name: 'Part' } });
  assert.equal(f.calls()[1].name, 'fusion_mcp_execute');
  const expected = out === null ? `${fixtureWindowsPath(f.dir)}\\Part.txt`
    : out.endsWith('.txt') ? 'C:\\Downloads\\renamed.txt' : 'C:\\Downloads\\Part.txt';
  assert.deepEqual(scriptConfig(f.calls()[1].arguments.object.script, ['FILE_ID', 'DIR_PATH']), { FILE_ID: 'local-file-1', DIR_PATH: expected });
});

for (const explicit of [false, true]) test(`shot explicit=${explicit}`, async t => {
  const f = await fixture(t);
  ok(await f.run(['shot', ...(explicit ? ['--out', 'view.png', '--dir', 'iso-top-right', '--width', '640', '--height', '480', '--no-aa', '--transparent'] : [])]));
  assert.deepEqual(f.calls(), [{ name: 'fusion_mcp_read', arguments: explicit
    ? { queryType: 'screenshot', direction: 'iso-top-right', width: 640, height: 480, antiAliasing: false, transparentBackground: true }
    : { queryType: 'screenshot' } }]);
  const file = (await fs.readdir(f.dir)).find(name => name.endsWith('.png'));
  assert.ok(file);
  assert.deepEqual(await fs.readFile(path.join(f.dir, file)), image);
});

for (const cmd of ['doctor', 'tools']) test(cmd, async t => {
  const f = await fixture(t);
  const result = await f.run([cmd]);
  ok(result);
  assert.ok(f.calls().some(call => call.method === 'tools/list'));
  assert.equal(f.calls().filter(call => call.name).length, 0);
  assert.match(result.stdout, /fusion_mcp_execute/);
});

for (const flag of ['--list', '-l']) test(`run ${flag} offline`, async t => {
  const f = await fixture(t);
  const result = await f.run(['run', flag], { offline: true });
  ok(result);
  assert.match(result.stdout, /\bbox\b/);
  assert.equal(f.requests.length, 0);
});

for (const args of [null, [25], [true, false, null], { enabled: true, disabled: false, empty: null, nested: [true, { value: null }], text: 'quote " slash \\ newline\n' }]) {
  test(`run box injected args ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t);
    ok(await f.run(['run', 'box', '--doc', doc, '--readonly', ...(args === null ? [] : ['--args', JSON.stringify(args)])]));
    assert.equal(f.calls().length, 1);
    const call = f.calls()[0];
    assert.equal(call.name, 'fusion_mcp_execute');
    assert.equal(call.arguments.featureType, 'script');
    assert.equal(call.arguments.object.readOnly, true);
    const config = scriptConfig(call.arguments.object.script, ['ARGS', 'DOC_NAME']);
    assert.equal(config.DOC_NAME, doc);
    if (args !== null) assert.deepEqual(config.ARGS, args);
  });
}

test('run local script and user-script precedence, including top-level JSON null', async t => {
  const f = await fixture(t);
  const scripts = path.join(f.dir, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  const file = path.join(scripts, 'box.py');
  await fs.writeFile(file, 'ARGS = []\nDOC_NAME = ""\nMARKER = "user"\ndef run(context):\n    pass\n');
  for (const name of ['box', file]) {
    ok(await f.run(['run', name, '--args', 'null']));
    const call = f.calls().at(-1);
    assert.notEqual(call.arguments.object.readOnly, true);
    assert.deepEqual(scriptConfig(call.arguments.object.script, ['ARGS', 'MARKER']), { ARGS: null, MARKER: 'user' });
  }
});

test('init writes only isolated config, refuses overwrite, supports force and import', async t => {
  const f = await fixture(t);
  const config = path.join(f.dir, 'init/config.json');
  ok(await f.run(['init'], { config, offline: true }));
  const original = await fs.readFile(config, 'utf8');
  assert.deepEqual(JSON.parse(original), {
    backend: 'addin', routing: 'queue', controlCenter: {},
  });
  assert.ok((await fs.stat(path.join(f.dir, 'init/scripts'))).isDirectory());
  failed(await f.run(['init'], { config, offline: true }));
  assert.equal(await fs.readFile(config, 'utf8'), original);
  await fs.mkdir(path.join(f.dir, '.opencode'));
  await fs.writeFile(path.join(f.dir, '.opencode/opencode.jsonc'), JSON.stringify({ mcp: { fusion: { url: 'https://example.test/mcp', headers: { 'X-Imported': 'yes' }, timeout: 1234 } } }));
  ok(await f.run(['init', '--force', '--from-opencode'], { config, offline: true }));
  const imported = JSON.parse(await fs.readFile(config, 'utf8'));
  assert.equal(imported.backend, 'mcp');
  assert.equal(imported.routing, 'queue');
  assert.equal(imported.backends.mcp.url, 'https://example.test/mcp');
  assert.equal(imported.backends.mcp.headers['X-Imported'], 'yes');
  assert.equal(imported.backends.mcp.timeoutMs, 1234);
  assert.equal(f.requests.length, 0);
});

const invalid = [
  ['nonexistent'], ['doc'], ['doc', 'nonexistent'], ['export', 'obj'], ['run'], ['call'], ['call', 'tool'],
  ['call', 'tool', '{bad'], ['run', 'box', '--args', '{bad'], ['doc', 'search'], ['doc', 'open'], ['upload'], ['file_download'],
  ['doc', 'close'], ['doc', 'close', '--save', '--discard'],
  ...design.map(([name, args]) => [name, ...args]),
  ...[...hub, ...design].filter(([, args]) => args.length).map(([name]) => [name, ...(design.some(r => r[0] === name) ? ['--doc', doc] : [])]),
  ['export', 'step'], ['export', 'stl'], ['run', 'missing-script'],
  ...['--config', '--url', '--header', '--timeout'].map(flag => ['projects', flag]),
  ['projects', '--header', 'invalid'], ['projects', '--timeout', 'abc'],
  ['run', 'box', '--args'], ['run', 'box', '--doc'], ['stats', '--doc'],
  ['doc', 'search', 'Part', '--project'], ['doc', 'new', '--name'],
  ['upload', 'file.txt', '--project'], ['upload', 'file.txt', '--folder'], ['file_download', 'Part', '--out'],
  ['export', 'stl', '--doc', doc, '--body'], ['export', 'step', '--doc', doc, '--out'],
  ...['--out', '--dir', '--width', '--height'].map(flag => ['shot', flag]),
  ...[...hub, ...design].map(([name, args]) => [name, ...args, ...(design.some(r => r[0] === name) ? ['--doc', doc] : []), '--unknown']),
  ...direct.map(([args]) => [...args, '--unknown']),
  ...[['run', 'box'], ['upload', 'file.txt'], ['file_download', 'Part'], ['export', 'stl', '--doc', doc], ['shot'], ['doctor'], ['tools'], ['init']].map(args => [...args, '--unknown']),
  ['projects', 'extra'], ['doc', 'open', 'Part', 'extra'], ['doc', 'list', 'extra'], ['undo', 'extra'], ['call', 'tool', '{}', 'extra'],
];
for (const [i, args] of invalid.entries()) test(`reject invalid ${i}: ${args.join(' ')}`, async t => {
  const f = await fixture(t);
  failed(await f.run(args));
  assert.equal(f.requests.length, 0, 'invalid input must fail before contacting MCP');
});

const minimum = {
  project_create: 1, project_rename: 2, folder_list: 1, folder_create: 2, folder_rename: 3,
  folder_delete: 2, file_rename: 4, file_move: 4, file_delete: 3, tree: 1,
  param_add: 2, param_set: 2, param_rename: 2, param_delete: 1,
  plane_add: 4, plane_rename: 2, plane_delete: 1, comp_add: 1, rollback: 1, units: 1,
};
for (const [name, count] of Object.entries(minimum)) {
  const row = [...hub, ...design].find(([cmd]) => cmd === name);
  for (let supplied = 1; supplied < count; supplied++) test(`reject partial ${name}: ${supplied}/${count}`, async t => {
    const f = await fixture(t);
    failed(await f.run([name, ...row[1].slice(0, supplied), ...(design.includes(row) ? ['--doc', doc] : [])]));
    assert.equal(f.requests.length, 0);
  });
}

test('plane angle requires its fifth positional argument', async t => {
  const f = await fixture(t);
  failed(await f.run(['plane_add', 'P', 'angle', 'XY', 'X', '--doc', doc]));
  assert.equal(f.requests.length, 0);
});

for (const flag of ['--args', '--doc']) test(`run rejects injection without ${flag} config slot`, async t => {
  const f = await fixture(t);
  const script = path.join(f.dir, 'no-config.py');
  await fs.writeFile(script, 'def run(context):\n    pass\n');
  failed(await f.run(['run', script, flag, flag === '--args' ? '[]' : doc]));
  assert.equal(f.requests.length, 0);
});

const failures = [
  ['HTTP 503', { status: 503, body: { result: textResult({ success: true }) } }],
  ['RPC error', { body: { error: { code: -32000, message: 'mock failure' } } }],
  ['MCP isError', { body: { result: { isError: true, content: [{ type: 'text', text: 'mock failure' }] } } }],
  ['embedded success false', { body: { result: textResult({ success: false, message: 'mock failure' }) } }],
  ['structured success false', { body: { result: { structuredContent: { success: false }, content: [{ type: 'text', text: 'mock failure' }] } } }],
  ['ERROR text', { body: { result: { content: [{ type: 'text', text: 'ERROR mock failure' }] } } }],
];
for (const [label, response] of failures) {
  for (const args of [['projects'], ...direct.map(([args]) => args), ['run', 'box'], ['upload', 'local.txt'], ['export', 'step', '--doc', doc], ['doc', 'new'], ['shot']]) {
    test(`failure ${label}: ${args.join(' ')}`, async t => {
      const f = await fixture(t, m => m.method === 'tools/call' ? response : null);
      failed(await f.run(args));
    });
  }
  for (const args of [['doc', 'open', 'Part'], ['file_download', 'Part']]) {
    test(`second-stage failure ${label}: ${args.join(' ')}`, async t => {
      const f = await fixture(t, m => m.method === 'tools/call' && m.params.name === 'fusion_mcp_execute' ? response : null);
      failed(await f.run(args));
      assert.equal(f.calls().length, 2);
    });
  }
}
// MCP initialize negotiation belongs to the broker-owned physical client and
// remains covered by server-metadata tests. This worker issues tools/list.
for (const method of ['tools/list']) for (const cmd of ['doctor', 'tools']) {
  test(`${cmd} rejects ${method} HTTP failure`, async t => {
    const f = await fixture(t, m => m.method === method ? { status: 503, body: { result: { tools: [] } } } : null);
    failed(await f.run([cmd]));
  });
}

for (const cmd of [['doc', 'open', 'Part'], ['file_download', 'Part']]) {
  for (const success of [true, false]) test(`${cmd[0]} search success=${success} must not act on failed/empty results`, async t => {
    const f = await fixture(t, m => m.method === 'tools/call' ? {
      body: { result: textResult({ success, results: success ? [] : [{ name: 'Part', id: 'must-not-open' }] }) },
    } : null);
    failed(await f.run(cmd));
    assert.equal(f.calls().length, 1, 'must stop after failed or empty search');
  });
}

test('shot must not write image returned alongside failure', async t => {
  const f = await fixture(t, m => m.method === 'tools/call' ? { body: { result: textResult({ success: false, base64Data: image.toString('base64') }) } } : null);
  failed(await f.run(['shot', '--out', 'failed.png']));
  assert.ok(!(await fs.readdir(f.dir)).includes('failed.png'));
});
