'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, missing = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad consumer żółć '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'selected python');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(python, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args.includes('-c')) process.stdout.write(JSON.stringify({implementation:'CPython',version:[3,12],missing:${JSON.stringify(missing)}}));
else {process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({success:true,operation:'stub',result:{}})));}
`, { mode: 0o700 });
  return { root, python, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

const modules = [
  ['image-trace', 'traceImage', ['--input', 'source.png', '--out', 'new'], 'image_trace.py'],
  ['image-optimize', 'optimizeImage', ['--input', 'source.png', '--out', 'new', '--palette', 'palette.json'], 'image_optimize.py'],
  ['image-boundaries', 'boundariesImage', ['--svg', 'source.svg', '--reference', 'ref.png', '--palette', 'palette.json', '--out', 'new'], 'image_boundaries.py'],
];

for (const [module, exported, flags, worker] of modules) {
  test(`${module} actual consumer preflights explicit interpreter before spawning packaged helper`, async t => {
    const f = fixture(t);
    const consumer = require(`../src/${module}`);
    const fn = consumer[exported];
    assert.equal(typeof fn, 'function', exported);
    let output = '';
    assert.equal(await fn([...flags, '--python', f.python], { stdout: { write: s => { output += s; } }, stderr: { write() {} } }), 0);
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('-c'));
    assert.equal(calls[1][0], '-B');
    assert.equal(calls[1][1], path.resolve(__dirname, '../assets', worker));
    assert.equal(JSON.parse(output).success, true);
  });
  test(`${module} missing dependencies refuse before helper execution`, async t => {
    const f = fixture(t, ['numpy']);
    await assert.rejects(require(`../src/${module}`)[exported]([...flags, '--python', f.python], {}), /Missing Python dependencies.*numpy/);
    assert.equal(f.calls().length, 1);
  });
}

test('reference actual consumer preflights dependencies before helper execution', async t => {
  const f = fixture(t);
  assert.equal((await require('../src/reference').execute('reference.layout', { python: f.python })).success, true);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls()[1].includes(path.resolve(__dirname, '../assets/reference_images.py')));
  const missing = fixture(t, ['scipy']);
  assert.throws(() => require('../src/reference').execute('reference.layout', { python: missing.python }), /Missing Python dependencies.*scipy/);
  assert.equal(missing.calls().length, 1);
});

test('formatter preflight preserves original source when selected environment lacks dependencies', async t => {
  const f = fixture(t, ['black']);
  const source = path.join(f.root, 'source.py');
  fs.writeFileSync(source, 'x=1\n');
  const preview = await require('../src/console-source').openSource({ sourcePath: source }, { pythonPath: f.python });
  assert.equal(preview.formatted, 'x=1\n');
  assert.equal(preview.formatter.applied, false);
  assert.match(preview.formatter.error, /Missing Python dependencies.*black/);
  assert.equal(f.calls().length, 1);
});

test('config loading and init share custom config and scripts under foreign cwd and clean HOME', t => {
  const f = fixture(t);
  const env = { PATH: process.env.PATH, HOME: f.root, FMCAD_CONFIG: 'custom space/config.json' };
  const config = path.resolve(__dirname, '../src/config.js');
  const result = spawnSync(process.execPath, ['-e', `
    const c = require(${JSON.stringify(config)});
    const initial = c.loadConfig();
    const created = c.initConfig();
    const paths = c.resolveRuntimePaths();
    process.stdout.write(JSON.stringify({initial:initial.path,created:created.path,paths}));
  `], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.initial, path.join(f.root, '.config/custom space/config.json'));
  assert.equal(actual.created, actual.initial);
  assert.equal(actual.paths.scripts, path.join(f.root, '.config/custom space/scripts'));
  assert.ok(fs.statSync(actual.paths.scripts).isDirectory());
});

test('run uses selected configuration scripts and retains source hash provenance', t => {
  const f = fixture(t);
  const config = path.join(f.root, 'custom config/config.json');
  const scripts = path.join(path.dirname(config), 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const file = path.join(scripts, 'box.py');
  const source = 'ARGS = []\nDOC_NAME = ""\nMARKER = "selected config"\n';
  fs.writeFileSync(file, source);
  const run = require('../src/run');
  assert.equal(run.resolveScript('box', { config }), file);
  assert.equal(run.userScriptsDir({ config }), scripts);
  assert.ok(run.listScripts({ config }).some(entry => entry.name === 'box' && entry.dir === scripts));
  const provenance = {};
  const built = require('../src/invocation').context.run(provenance, () => run.buildRunScript('box', [42], true, '', {}, undefined, [], { config }));
  assert.match(built, /ARGS = .*\[42\]/);
  assert.equal(provenance.sourcePath, file);
  assert.equal(provenance.sourceHash, require('node:crypto').createHash('sha256').update(source).digest('hex'));
  const queued = require('../src/queue-client');
  assert.deepEqual(queued.pinCommand(['run', 'box'], { config }), ['run', file]);
  assert.deepEqual(queued.inputFiles(['run', 'box'], f.root, { config }), [{ path: file, sha256: provenance.sourceHash }]);
});

test('CLI run --list honors --config offline without reading Fusion configuration', t => {
  const f = fixture(t);
  const scripts = path.join(f.root, 'config space/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'my_unique_script.py'), '# selected config\n');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/fmcad.js'), '--config', path.join(f.root, 'config space/config.json'), 'run', '--list'], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`my_unique_script (${scripts})`));
});

test('CAD, queue receipt and CLI consumers refuse fictional Windows paths on plain Linux', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    assert.throws(() => require(${JSON.stringify(path.resolve(__dirname, '../src/cad.js'))}).mapCadPaths('export.step', { path: '/home/local/file.step' }), { code: 'FMCAD_UNSUPPORTED_PLATFORM' });
    assert.throws(() => require(${JSON.stringify(path.resolve(__dirname, '../src/queue-instance.js'))}).fusionPath('/home/local/receipt.json'), { code: 'FMCAD_UNSUPPORTED_PLATFORM' });
  `], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/fmcad.js'), 'upload', 'file.step'], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root }, encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Unsupported fmcad platform.*detected WSL/);
  assert.doesNotMatch(cli.stderr, /Ubuntu|wsl\$/);
});

test('queue directory normalizes relative XDG state against HOME rather than cwd', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.resolve(__dirname, '../src/queue-connection.js'))}).queueDirectory())`], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: f.root, XDG_STATE_HOME: 'relative state' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(f.root, 'relative state/fmcad/queue'));
});
