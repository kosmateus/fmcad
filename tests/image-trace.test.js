const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { main } = require('../src/cli');
const { globalHelp } = require('../src/help');

function harness(code = 0) {
  const state = { stdout: '', stderr: '', calls: [] };
  state.deps = {
    resolvePython: ({ pythonPath }) => pythonPath || 'python3',
    loadConfig: () => assert.fail('Local command must not load Fusion config'),
    McpClient: class { constructor() { assert.fail('Local command must not connect'); } },
    stdout: { write: text => { state.stdout += text; } },
    stderr: { write: text => { state.stderr += text; } },
    setExitCode: value => { state.exitCode = value; },
    spawnImageTrace: (python, args, options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      let input = '';
      child.stdin.on('data', chunk => { input += chunk; });
      child.stdin.on('finish', () => {
        state.calls.push({ python, args, options, request: JSON.parse(input) });
        child.stdout.write('{"success":true,"operation":"image.trace","result":{"custom":1}}\n');
        child.stderr.write('worker diagnostic\n');
        child.emit('close', code, null);
      });
      return child;
    },
  };
  return state;
}

test('local trace maps every flag exactly and preserves worker JSON without backend config', async () => {
  const h = harness();
  const flags = ['--input', 'rectangle.png', '--out', 'new trace', '--palette', 'palette.json',
    '--python', '/local python/bin/python', '--json', '--blur-sigma', '0.5', '--median-size', '3', '--label-mode-size', '5',
    '--filter-speckle', '4', '--corner-threshold', '60', '--length-threshold', '4',
    '--splice-threshold', '45', '--max-iterations', '10', '--path-precision', '4',
    '--color-precision', '8', '--layer-difference', '0', '--mode', 'spline',
    '--width-mm', '50', '--mirror-x', 'false', '--trace-scale', '1', '--trace-detail-area-px2', '1024'];
  assert.equal(await main(['image', 'trace', ...flags], h.deps), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].python, '/local python/bin/python');
  assert.deepEqual(h.calls[0].options, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'linux' });
  assert.deepEqual(h.calls[0].args, ['-B', path.resolve(__dirname, '../assets/image_trace.py')]);
  assert.deepEqual(h.calls[0].request, {
    input: path.resolve('rectangle.png'), out: path.resolve('new trace'), palette: path.resolve('palette.json'),
    blurSigma: 0.5, medianSize: 3, labelModeSize: 5, filterSpeckle: 4, cornerThreshold: 60, lengthThreshold: 4,
    spliceThreshold: 45, maxIterations: 10, pathPrecision: 4, colorPrecision: 8,
    layerDifference: 0, mode: 'spline', widthMm: 50, mirrorX: false, traceScale: 1, traceDetailAreaPx2: 1024,
  });
  assert.equal(h.stdout, '{"success":true,"operation":"image.trace","result":{"custom":1}}\n');
  assert.equal(h.stderr, 'worker diagnostic\n');
});

test('file fields use cwd, additional flags work, duplicates and unknown fields do not spawn', async () => {
  // Retain every fixture under a unique repo-local directory; no cleanup or deletion.
  const parent = path.resolve(__dirname, '../.test-artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'image-trace-cli-'));
  const file = path.join(directory, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ input: 'image.png', out: 'new-run', blurSigma: 0.5, palette: 'palette.json', labelModeSize: 3 }), { flag: 'wx' });
  const h = harness();
  assert.equal(await main(['image', 'trace', '--file', file, '--mirror-x', 'true'], h.deps), 0);
  assert.equal(h.calls[0].python, 'python3');
  assert.equal(h.calls[0].request.input, path.resolve('image.png'));
  assert.equal(h.calls[0].request.out, path.resolve('new-run'));
  assert.equal(h.calls[0].request.mirrorX, true);
  assert.equal(h.calls[0].request.labelModeSize, 3);
  for (const extra of [['--blur-sigma', '1'], ['--label-mode-size', '5'], ['--input', 'other.png'], ['--file', file]]) {
    const bad = harness();
    assert.equal(await main(['image', 'trace', '--file', file, ...extra], bad.deps), 1);
    assert.match(bad.stderr, /Duplicate/);
    assert.equal(bad.calls.length, 0);
  }
  for (const [name, data] of Object.entries({ unknown: { input: 'x', out: 'y', python: 'bad' }, array: [], missing: { input: 'x' } })) {
    const invalid = path.join(directory, name + '.json');
    fs.writeFileSync(invalid, JSON.stringify(data), { flag: 'wx' });
    const bad = harness();
    assert.equal(await main(['image', 'trace', '--file', invalid], bad.deps), 1);
    assert.equal(bad.calls.length, 0);
  }
});

test('missing, duplicate and unknown flags fail before subprocess', async () => {
  for (const flags of [[], ['--input', 'x'], ['--out', 'y'], ['--input'],
    ['--input', 'x', '--out', 'y', '--input', 'z'], ['--json', '--json'],
    ['--doc', 'Model'], ['--backend', 'mcp'], ['--unknown', '1'], ['positional'],
    ['--input', 'x', '--out', 'y', '--mirror-x'], ['--label-mode-size'],
    ['--label-mode-size', '3', '--label-mode-size', '5']]) {
    const h = harness();
    assert.equal(await main(['image', 'trace', ...flags], h.deps), 1, flags.join(' '));
    assert.equal(h.calls.length, 0);
    assert.equal(h.exitCode, 1);
  }
});

test('both help routes are offline, equal, discoverable and document worker defaults', async () => {
  const outputs = [];
  for (const argv of [['image', 'trace', '--help'], ['help', 'image', 'trace']]) {
    const h = harness();
    assert.equal(await main(argv, h.deps), 0);
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(h.stdout, /Backend:|requires --doc/);
    const help = h.stdout.replace(/\s+/g, ' ');
    assert.match(help, /LOCAL/);
    assert.match(help, /--median-size: integer 0, 3, 5, 7; default 0/);
    assert.match(help, /--label-mode-size: integer 0, 3, 5, 7; default 0.*nonzero requires palette/);
    assert.match(help, /then palette classification, then optional integer-label mode filtering/);
    assert.match(help, /without generating new colors/);
    assert.match(help, /nearest RGB mapping/);
    assert.match(help, /raw_contours.svg/);
    assert.match(help, /report.rawToSnappedColors/);
    assert.match(help, /NOT the request file directory/);
    assert.match(help, /import_sketches.json/);
    outputs.push(h.stdout);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.match(globalHelp(), /image trace --input PATH --out NEWDIR/);
});

test('worker failure and missing Python report actionable local dependency setup', async () => {
  const h = harness(1);
  assert.equal(await main(['image', 'trace', '--input', 'x', '--out', 'y', '--python', '/venv/bin/python'], h.deps), 1);
  assert.match(h.stderr, /"\/venv\/bin\/python" -m pip install -r .*image_trace_requirements.txt/);
  assert.match(h.stderr, /Nothing was installed automatically/);
  const missing = harness();
  missing.deps.spawnImageTrace = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    process.nextTick(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  assert.equal(await main(['image', 'trace', '--input', 'x', '--out', 'y'], missing.deps), 1);
  assert.match(missing.stderr, /Select an installed interpreter with --python PATH/);
});

test('label mode values are forwarded with zero allowed without a palette', async () => {
  for (const size of [0, 3, 5, 7]) {
    const h = harness();
    const flags = ['--input', 'x', '--out', 'y', '--label-mode-size', String(size)];
    if (size) flags.push('--palette', 'palette.json');
    assert.equal(await main(['image', 'trace', ...flags], h.deps), 0);
    assert.equal(h.calls[0].request.labelModeSize, size);
    assert.equal(Object.hasOwn(h.calls[0].request, 'palette'), size !== 0);
  }
});

test('worker validates label mode types, sizes and palette requirement without creating outputs', async () => {
  // These requests fail before path access/dependency loading; execute no image processing.
  for (const value of ['-1', '1', '4', '3.5', 'true', '"3"', 'null', '3', '5', '7']) {
    const h = harness();
    h.deps.spawnImageTrace = (python, args, options) => spawn(python, ['-B', ...args], options);
    assert.equal(await main(['image', 'trace', '--input', 'x', '--out', 'y', '--label-mode-size', value], h.deps), 1);
    assert.match(h.stderr, ['3', '5', '7'].includes(value)
      ? /Nonzero labelModeSize requires a palette/ : /labelModeSize must be 0, 3, 5, or 7/);
    assert.equal(h.stdout, '');
  }
});

test('real subprocess transport sends only JSON stdin and forwards stdout byte-for-byte', async () => {
  const h = harness();
  h.deps.spawnImageTrace = (python, args, options) => {
    assert.equal(python, 'fake-python');
    assert.equal(args.length, 2);
    return spawn(process.execPath, ['-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({success:true,operation:"image.trace",result:JSON.parse(s)})))'], options);
  };
  assert.equal(await main(['image', 'trace', '--input', 'x', '--out', 'y', '--python', 'fake-python'], h.deps), 0);
  assert.deepEqual(JSON.parse(h.stdout), { success: true, operation: 'image.trace', result: { input: path.resolve('x'), out: path.resolve('y') } });
  assert.ok(!h.stdout.endsWith('\n'));
});
