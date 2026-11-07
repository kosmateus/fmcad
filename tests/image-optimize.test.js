const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { main } = require('../src/cli');
const { globalHelp } = require('../src/help');
const { findCommand } = require('../src/commands');

const required = ['--input', 'image.png', '--out', 'new search', '--palette', 'palette.json'];
function harness(code = 0) {
  const h = { stdout: '', stderr: '', calls: [] };
  h.deps = {
    resolvePython: ({ pythonPath }) => pythonPath || 'python3',
    loadConfig: () => assert.fail('Must not load config'),
    McpClient: class { constructor() { assert.fail('Must not connect'); } },
    stdout: { write: text => { h.stdout += text; } },
    stderr: { write: text => { h.stderr += text; } },
    setExitCode: value => { h.exitCode = value; },
    spawnImageOptimize: (python, args, options) => {
      h.calls.push({ python, args, options });
      return spawn(process.execPath, ['-e', `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({success:true,operation:'image.optimize',result:{request:JSON.parse(s),best:null,status:'no_eligible_candidate'}}));process.stderr.write('worker diagnostic\\n');process.exitCode=${code};});`], options);
    },
  };
  return h;
}
function fixture(data) {
  const parent = require('node:os').tmpdir();
  const directory = fs.mkdtempSync(path.join(parent, 'image-optimize-cli-'));
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'request.json');
  fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx' });
  return file;
}

test('all optimize flags map exactly through real JSON stdin subprocess transport without config', async () => {
  const h = harness();
  const base = { mode: 'spline', mirrorX: false };
  const search = { blurSigma: [0, 1] };
  const regions = [{ name: 'detail', bounds: [1, 2, 30, 40], weight: 2 }];
  const weights = { boundary: 1, overlap: 2, corners: 3, roughness: 4, complexity: 5, gaps: 75, overlaps: 125 };
  assert.equal(await main(['image', 'optimize', ...required, '--reference', 'ref.png',
    '--base', JSON.stringify(base), '--search', JSON.stringify(search), '--regions', JSON.stringify(regions),
    '--weights', JSON.stringify(weights), '--trials', '24', '--seed', '-17', '--top-k', '3',
    '--min-feature-area', '64', '--python', '/local python/bin/python', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [{ python: '/local python/bin/python',
    args: ['-B', path.resolve(__dirname, '../assets/image_optimize.py')],
    options: { shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'linux' } }]);
  const request = { input: path.resolve('image.png'), out: path.resolve('new search'), palette: path.resolve('palette.json'),
    reference: path.resolve('ref.png'), base, search, regions, weights, trials: 24, seed: -17, topK: 3, minFeatureArea: 64 };
  assert.equal(h.stdout, JSON.stringify({ success: true, operation: 'image.optimize', result: { request, best: null, status: 'no_eligible_candidate' } }));
  assert.equal(h.stderr, 'worker diagnostic\n');
});

test('file paths use cwd; defaults remain worker-owned; every duplicate field/flag is rejected', async () => {
  const data = { input: 'x', out: 'y', palette: 'p', reference: 'r', base: {}, search: {}, regions: [], weights: {}, trials: 24, seed: 17, topK: 3, minFeatureArea: 64 };
  const file = fixture(data);
  const h = harness();
  assert.equal(await main(['image', 'optimize', '--file', file, '--json'], h.deps), 0);
  assert.equal(h.calls[0].python, 'python3');
  const expected = { ...data };
  for (const key of ['input', 'out', 'palette', 'reference']) expected[key] = path.resolve(data[key]);
  assert.deepEqual(JSON.parse(h.stdout).result.request, expected);
  for (const [field, value] of Object.entries(data)) {
    const flag = '--' + field.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    for (const args of [['--file', file, flag, encoded], [...required, flag, encoded, flag, encoded]]) {
      const bad = harness();
      assert.equal(await main(['image', 'optimize', ...args], bad.deps), 1);
      assert.match(bad.stderr, /Duplicate/);
      assert.equal(bad.calls.length, 0);
    }
  }
  const partial = fixture({ input: 'x', palette: 'p' });
  const supplemented = harness();
  assert.equal(await main(['image', 'optimize', '--file', partial, '--out', 'new'], supplemented.deps), 0);
  assert.deepEqual(JSON.parse(supplemented.stdout).result.request, { input: path.resolve('x'), palette: path.resolve('p'), out: path.resolve('new') });
});

test('strict fields, required paths, malformed JSON and known global/trace flags fail before spawning', async () => {
  for (const data of [null, [], 3, { input: 'x', out: 'y' }, { input: '', out: 'y', palette: 'p' },
    ...['python', 'file', 'json', 'doc', 'top-k', 'blurSigma', 'unknown'].map(key => ({ input: 'x', out: 'y', palette: 'p', [key]: 1 })),
    { input: 'x', out: 'y', palette: 'p', reference: null }]) {
    const h = harness();
    assert.equal(await main(['image', 'optimize', '--file', fixture(data)], h.deps), 1);
    assert.equal(h.calls.length, 0);
  }
  for (const args of [[], ['--input', 'x'], ...['--input', '--out', '--palette', '--reference', '--base', '--search', '--regions', '--weights', '--trials', '--seed', '--top-k', '--min-feature-area', '--python', '--file'].map(flag => [...required, flag]),
    ...['--doc', '--backend', '--config', '--url', '--header', '--timeout', '--transport', '--curl-path', '--blur-sigma', '--unknown'].map(flag => [...required, flag, 'x']),
    [...required, 'positional'], [...required, '--json', '--json'], [...required, '--python', 'p', '--python', 'p'],
    [...required, '--file', 'x', '--file', 'x'], [...required, '--base', '{'], [...required, '--trials', 'NaN'],
    ['--config', 'missing.json', 'image', 'optimize', ...required]]) {
    const h = harness();
    const argv = args[0] === '--config' ? args : ['image', 'optimize', ...args];
    assert.equal(await main(argv, h.deps), 1, argv.join(' '));
    assert.equal(h.calls.length, 0);
    assert.equal(h.exitCode, 1);
  }
});

test('worker and interpreter failures preserve output and give local installation guidance', async () => {
  const h = harness(7);
  assert.equal(await main(['image', 'optimize', ...required, '--python', '/venv/bin/python'], h.deps), 1);
  assert.equal(JSON.parse(h.stdout).result.best, null);
  assert.match(h.stderr, /worker failed \(7\)/);
  assert.match(h.stderr, /"\/venv\/bin\/python" -m pip install -r .*image_optimize_requirements.txt/);
  assert.match(h.stderr, /Nothing was installed automatically/);
  const missing = harness();
  missing.deps.spawnImageOptimize = (_python, args, options) => spawn(path.join(path.dirname(fixture({})), 'missing-python'), args, options);
  assert.equal(await main(['image', 'optimize', ...required], missing.deps), 1);
  assert.match(missing.stderr, /Select an installed interpreter with --python EXE/);
  assert.match(missing.stderr, /image_optimize_requirements.txt/);
});

test('known JSON values reach worker validation unchanged, without duplicating range limits', async () => {
  const h = harness(1);
  assert.equal(await main(['image', 'optimize', ...required, '--trials', '1', '--top-k', '11',
    '--min-feature-area', '0', '--base', '[]'], h.deps), 1);
  const request = JSON.parse(h.stdout).result.request;
  assert.equal(request.trials, 1);
  assert.equal(request.topK, 11);
  assert.equal(request.minFeatureArea, 0);
  assert.deepEqual(request.base, []);
  assert.equal(h.calls.length, 1);
});

test('help aliases share the registered usage without starting subprocesses', async () => {
  const outputs = [];
  for (const argv of [['image', 'optimize', '--help'], ['image', 'optimize', '-h'], ['help', 'image', 'optimize']]) {
    const h = harness();
    assert.equal(await main(argv, h.deps), 0);
    assert.equal(h.calls.length, 0);
    assert.ok(h.stdout.includes(findCommand(['image', 'optimize']).usage));
    outputs.push(h.stdout);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[1], outputs[2]);
  assert.equal(findCommand(['image', 'optimize']).kind, 'local');
  assert.match(globalHelp(), /image optimize --input PATH --out NEWDIR --palette JSON/);
});

test('documented request and weights pass actual worker pre-image schema checks', async () => {
  const guide = fs.readFileSync(path.resolve(__dirname, '../docs/IMAGE_OPTIMIZE.md'), 'utf8').replace(/\r\n?/g, '\n');
  const example = JSON.parse(guide.match(/```json\n([^]*?)\n```/)[1]);
  const h = harness();
  assert.equal(await main(['image', 'optimize', '--file', fixture(example), '--out', 'example-search'], h.deps), 0);
  assert.deepEqual(JSON.parse(h.stdout).result.request.weights, { overlap: 10, gaps: 100, overlaps: 100 });
  const file = fixture({ background: '#FFFFFF', colors: [{ name: 'Ink', color: '#000000' }],
    rules: [{ color: 'Ink', ranges: { luma: [0, 127] } }] });
  const request = { ...example, input: file, palette: file, out: path.join(path.dirname(file), 'uncreated') };
  // Stop at image decoding: exercise real request/weight validation without optional image dependencies.
  const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('optimizer_contract', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class ImageReached(Exception): pass
class Image:
    @staticmethod
    def open(_): raise ImageReached()
request = json.load(sys.stdin)
for weights in (request['weights'], {}, {'overlap': 0, 'gaps': 75, 'overlaps': 125}):
    try:
        worker.prepare(dict(request, weights=weights), (None, Image, None, None, None))
    except ImageReached:
        pass
    else:
        raise AssertionError('Expected image decoding boundary')
for weights in ({'gap': 100}, {'gaps': -1}, {'overlaps': True}):
    try:
        worker.prepare(dict(request, weights=weights), (None, Image, None, None, None))
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid weights accepted')
print(json.dumps(worker.DEFAULT_WEIGHTS))
`;
  const result = spawnSync('python3', ['-B', '-c', script, path.resolve(__dirname, '../assets/image_optimize.py')],
    { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { boundary: 1, overlap: 10, corners: 1, roughness: 1, complexity: 0.02, gaps: 100, overlaps: 100 });
  assert.equal(fs.existsSync(request.out), false);
});

test('actual optimizer main emits compact best refs and boundary metrics, passed through unchanged', async () => {
  const metrics = { fullImage: { rasterScale: 1, alphaThreshold: 128, gapFraction: 0, overlapFraction: 0 } };
  for (const best of [{ id: 'candidate_000', path: '/local/candidate_000', score: 0, settings: '/local/best_settings.json' }, null]) {
    const report = { status: best ? 'completed' : 'no_eligible_candidate', best, evaluated: 2,
      candidates: [{ eligible: !!best, parameters: { widthMm: 50 }, scopes: {} }, { eligible: false }],
      regional: [], baselineBoundaryMetrics: metrics, bestBoundaryMetrics: best ? metrics : null,
      files: { report: '/local/report.json', bestSettings: '/local/best_settings.json' }, geometryValidated: false };
    const h = harness();
    const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('optimizer_contract', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
report = json.loads(sys.argv[2])
worker.execute = lambda request: dict(success=True, operation='image.optimize', result=report)
sys.exit(worker.main())
`;
    h.deps.spawnImageOptimize = (python, args, options) => spawn(python, ['-B', '-c', script, args[1], JSON.stringify(report)], options);
    assert.equal(await main(['image', 'optimize', ...required], h.deps), 0, h.stderr);
    assert.deepEqual(JSON.parse(h.stdout), { success: true, operation: 'image.optimize', result: {
      status: report.status, best, evaluatedTrials: 2, eligibleCount: best ? 1 : 0, regions: [],
      baselineBoundaryMetrics: metrics, bestBoundaryMetrics: best ? metrics : null,
      files: report.files, geometryValidated: false } });
    assert.equal(h.stderr, '');
  }
});
