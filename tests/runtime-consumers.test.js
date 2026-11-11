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
  fs.writeFileSync(python, `#!${path.isAbsolute(process.execPath) ? process.execPath : "/usr/bin/env node"}
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

// Execute frozen pre-extraction adapters with the same typed pipeline and ports.
// Comparing complete observations preserves bytes, interpreter selection and calls.
for (const [moduleName, exported, flags] of modules) {
  const mode = moduleName.slice('image-'.length);
  const baselinePath = path.join(__dirname, 'fixtures/public-host-baseline', moduleName + '.js.txt');
  const source = fs.readFileSync(baselinePath, 'utf8');
  const provenance = require('./fixtures/public-host-baseline/provenance.json');
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), provenance[`src/${moduleName}.js`].sha256);
  const Module = require('node:module');
  const baseline = new Module(path.resolve(__dirname, '../src', moduleName + '.js'), module);
  baseline.filename = baseline.id;
  baseline.paths = module.paths;
  baseline._compile(source, baseline.filename);
  for (const scenario of ['success', 'failure', 'signal', 'spawn-error', 'preflight-error', 'invalid-json', 'duplicate', 'detail']) {
    test(`${moduleName} preserves historical ${scenario} effects and diagnostics`, async () => {
      async function observe(fn) {
        const state = { calls: [], preflight: [], stdout: '', stderr: '' };
        const deps = {
          stdout: { write: chunk => { state.stdout += chunk; } },
          stderr: { write: chunk => { state.stderr += chunk; } },
          resolvePython: options => {
            state.preflight.push(options);
            if (scenario === 'preflight-error') throw new Error('Missing Python dependencies: fixture');
            return '/selected python/żółć';
          },
        };
        const spawnName = { trace: 'spawnImageTrace', optimize: 'spawnImageOptimize', boundaries: 'spawnImageBoundaries' }[mode];
        deps[spawnName] = (python, args, options) => {
          const child = new (require('node:events').EventEmitter)();
          const { PassThrough } = require('node:stream');
          child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
          child.exitCode = 0;
          let input = '';
          child.stdin.on('data', chunk => { input += chunk; });
          child.stdin.on('finish', () => {
            state.calls.push({ python, args, options, input });
            if (scenario === 'spawn-error') { child.emit('error', new Error('fixture spawn failed')); return; }
            child.stdout.write(scenario === 'invalid-json' ? '{"value":1e999}' : '{"success":true,"label":"żółć"}\n');
            child.stderr.write('fixture diagnostic\n');
            child.emit('close', scenario === 'failure' ? 7 : scenario === 'signal' ? null : 0, scenario === 'signal' ? 'SIGTERM' : null);
          });
          return child;
        };
        const argv = [...flags, '--python', '/requested python/żółć'];
        if (scenario === 'duplicate') argv.push('--out', 'another');
        if (scenario === 'detail' && mode === 'trace') argv.push('--trace-detail-area-px2', '12');
        try { state.code = await fn(argv, deps); }
        catch (error) { state.error = error.message; }
        return state;
      }
      const historical = await observe(baseline.exports[exported]);
      const current = await observe(require(`../src/${moduleName}`)[exported]);
      assert.deepEqual(current, historical);
      assert.equal(current.calls.length, ['preflight-error', 'duplicate'].includes(scenario) ? 0 : 1);
      if (scenario === 'preflight-error' || scenario === 'duplicate') {
        assert.equal(current.stdout, ''); assert.equal(current.stderr, '');
      }
      if (scenario === 'success') { assert.equal(current.code, 0); assert.equal(current.stdout, '{"success":true,"label":"żółć"}\n'); }
      if (scenario === 'failure' || scenario === 'signal') assert.equal(current.code, 1);
      if (scenario === 'invalid-json') { assert.match(current.error, /finite JSON/); assert.equal(current.stdout, ''); }
    });
  }
}

test('installed image adapter retains runtime assets and closed declarations outside the workspace', async t => {
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const f = fixture(t);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', f.root], { cwd: root, encoding: 'utf8' }))[0];
  execFileSync('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', f.root, path.join(f.root, packed.filename)], { cwd: f.root, encoding: 'utf8' });
  const installed = path.join(f.root, 'node_modules/fmcad');
  const adapter = path.join(installed, 'dist/src/dist/python/image-command.js');
  const ts = require('typescript');
  const entry = path.join(f.root, 'consumer.cts');
  fs.writeFileSync(entry, `import { createImageCommand, type ImageCommandOptions } from ${JSON.stringify(adapter)};\ndeclare const options: ImageCommandOptions;\nconst command = createImageCommand(options);\nvoid command;\n`);
  const program = ts.createProgram([entry], { noEmit: true, strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => f.root, getNewLine: () => '\n' }));
  fs.writeFileSync(path.join(f.root, 'invalid-config.json'), '{invalid');
  for (const [moduleName, , flags, worker] of modules) {
    assert.ok(fs.existsSync(path.join(installed, 'dist/assets', worker)));
    const run = spawnSync(process.execPath, [path.join(installed, 'dist/bin/fmcad.js'), 'image', moduleName.slice(6), ...flags, '--python', f.python], {
      cwd: f.root, encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '', FMCAD_CONFIG: path.join(f.root, 'invalid-config.json'), FMCAD_BACKEND: 'must-not-read' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).success, true);
  }
  const engineering = path.join(installed, 'dist/src/dist/composition/library-engineering.js');
  const reference = path.join(installed, 'dist/src/dist/composition/library-reference.js');
  fs.appendFileSync(entry, `import * as engineering from ${JSON.stringify(engineering)};\nimport * as reference from ${JSON.stringify(reference)};\nvoid engineering; void reference;\n`);
  const hostProgram = ts.createProgram([entry], program.getCompilerOptions());
  assert.equal(ts.getPreEmitDiagnostics(hostProgram).length, 0, 'installed host declarations must close over staged types');
  const schema = spawnSync(process.execPath, [path.join(installed, 'dist/bin/fmcad.js'), 'fit', 'stack', '--schema'], {cwd:f.root,encoding:'utf8',env:{...process.env,FMCAD_CONFIG:path.join(f.root,'invalid-config.json')}});
  assert.equal(schema.status,0,schema.stderr); assert.equal(JSON.parse(schema.stdout).operation,'fit stack');
  assert.equal((await require(reference).execute('reference.layout',{python:f.python})).success,true);
  const calls = f.calls();
  assert.equal(calls.length, 8);
  for (let i = 0; i < 8; i += 2) {
    assert.ok(calls[i].includes('-c'));
    assert.ok(calls[i + 1].some(arg => arg.startsWith(path.join(installed, 'dist/assets') + path.sep)));
  }
});

test('engineering CLI preserves historical schema, calculation, failure and publication effects', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-public-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/public-host-baseline/engineering-local.js.txt'), 'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), require('./fixtures/public-host-baseline/provenance.json')['src/engineering-local.js'].sha256);
  const Module = require('node:module');
  const baseline = new Module(path.resolve(__dirname, '../src/engineering-local.js'), module);
  baseline.filename = baseline.id; baseline.paths = module.paths; baseline._compile(source, baseline.filename);
  const current = require('../src/engineering-local');
  const payload = {schemaVersion:1, identity:{model:'żółć',revision:'1'}, frame:'datum:A', assumptions:['Explicit bounds'], terms:[{id:'gap',sign:1,nominal:'5 mm',minus:'0.4 mm',plus:'0.2 mm'}], minimum:'4 mm'};
  const input = path.join(directory, 'input żółć.json');
  const bytes = JSON.stringify(payload); fs.writeFileSync(input, bytes);
  const cases = [
    ['schema', ['--schema']], ['inline', ['--data', bytes, '--json']],
    ['file', ['--file',input]], ['unknown', ['--wat']], ['duplicate', ['--json','--json']],
    ['missing', ['--file']], ['two-inputs', ['--file',input,'--data',bytes]],
    ['schema-input', ['--schema','--data',bytes]], ['malformed-json', ['--data','{invalid']],
    ['nonfinite', ['--data',bytes.replace('"5 mm"','1e999')]],
    ['oversize', ['--data',' '.repeat(1024*1024+1)]],
    ['failed-fit', ['--data', JSON.stringify({...payload, minimum:'6 mm'})]],
  ];
  async function observe(api, argv) {
    const result = {stdout:''};
    try { result.code = await api.execute('fit stack',argv,{stdout:{write:s=>{result.stdout+=s;}},engineeringRuntime:{clock:{now:()=>0}}}); }
    catch(error) { result.error = error.message; }
    return result;
  }
  for (const [name, argv] of cases) {
    const old = await observe(baseline.exports, argv), migrated = await observe(current, argv);
    assert.deepEqual(migrated, old, name);
    if (name === 'inline') { assert.equal(migrated.code,0); assert.equal(JSON.parse(migrated.stdout).documentIdentity,null); }
    if (name === 'failed-fit') assert.equal(migrated.code,1);
    if (migrated.error) assert.equal(migrated.stdout,'');
  }
  const oldOut = path.join(directory,'old.json'), newOut = path.join(directory,'new.json');
  assert.deepEqual(await observe(current,['--file',input,'--out',newOut]),await observe(baseline.exports,['--file',input,'--out',oldOut]));
  assert.equal(fs.readFileSync(newOut,'utf8'),fs.readFileSync(oldOut,'utf8'));
  const repeat = await observe(current,['--file',input,'--out',newOut]);
  assert.match(repeat.error,/refusing to replace/); assert.equal(repeat.stdout,'');
  assert.equal(fs.readFileSync(input,'utf8'),bytes);
  assert.equal(fs.readFileSync(newOut,'utf8'),fs.readFileSync(oldOut,'utf8'));
});

test('reference wrapper preserves historical validation and synchronous preflight', async t => {
  const source = fs.readFileSync(path.join(__dirname,'fixtures/public-host-baseline/reference.js.txt'),'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), require('./fixtures/public-host-baseline/provenance.json')['src/reference.js'].sha256);
  const Module = require('node:module');
  const baseline = new Module(path.resolve(__dirname,'../src/reference.js'), module);
  baseline.filename = baseline.id; baseline.paths = module.paths; baseline._compile(source, baseline.filename);
  const current = require('../src/reference');
  for (const [operation,data] of [
    ['reference.layout',{schemaVersion:1}], ['reference.layout',{}],
    ['reference.calibrate',{schemaVersion:2}], ['reference.compare',{schemaVersion:1}],
    ['reference.image',{mode:'inspect',ref:'canvas'}], ['reference.image',{mode:'inspect',ref:'canvas',extra:1}],
    ['reference.image',{mode:'bad'}], ['reference.image',{mode:'calibrate',ref:'canvas'}],
    ['reference.image',{mode:'calibrate',ref:'canvas',segment:[],length:'10 mm',anchor:[]}],
  ]) {
    const snapshot=JSON.stringify(data);
    const observe = api => { try { api.validate(operation,data); return null; } catch(error) { return error.message; } };
    assert.equal(observe(current),observe(baseline.exports));
    assert.equal(JSON.stringify(data),snapshot);
  }
  const f = fixture(t);
  const request = {python:f.python,schemaVersion:1,out:'new output żółć'};
  assert.deepEqual(await current.execute('reference.layout',request),await baseline.exports.execute('reference.layout',request));
  assert.deepEqual(f.calls().slice(0,2),f.calls().slice(2,4));
  assert.equal(request.python,f.python);
  const missing=fixture(t,['scipy']);
  for (const api of [baseline.exports,current]) {
    // assert.throws deliberately protects the synchronous boundary.
    assert.throws(()=>api.execute('reference.layout',{python:missing.python}),/Missing Python dependencies.*scipy/);
  }
  assert.equal(missing.calls().length,2);
});
