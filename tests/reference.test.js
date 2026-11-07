const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../src/cli');
const { catalog, validateCad, buildCadScript } = require('../src/cad');

const root = path.resolve(__dirname, '..');
const python = process.env.FMCAD_REFERENCE_PYTHON || path.join(root, '.venv/bin/python');
const available = spawnSync(python, ['-B', '-c', 'import PIL, numpy, scipy']).status === 0;
function harness() {
  const h = { out: '', err: '' };
  h.deps = { stdout: { write: v => { h.out += v; } }, stderr: { write: v => { h.err += v; } },
    loadConfig: () => assert.fail('GM05 must not load backend config'),
    McpClient: class { constructor() { assert.fail('GM05 must not connect to Fusion'); } }, setExitCode: () => {} };
  return h;
}

test('GM05 methods, help, preview, schemas and existing image contract remain reachable', async () => {
  for (const mode of ['layout', 'calibrate', 'compare']) {
    const spec = catalog['reference.' + mode];
    assert.equal(spec.offline, true);
    assert.equal(spec.requiresDoc, false);
    validateCad('reference.' + mode, spec.example);
    const h = harness();
    assert.equal(await main(['reference', mode, '--data', JSON.stringify(spec.example), '--preview'], h.deps), 0);
    assert.equal(JSON.parse(h.out).state, 'input-validated-only');
    const help = harness();
    assert.equal(await main(['help', 'reference', mode], help.deps), 0);
    assert.match(help.out, /Local Return Contract/);
    assert.match(help.out, /nativeAcceptance/);
  }
  validateCad('reference.image', catalog['reference.image'].example);
  validateCad('reference.image', { mode: 'inspect', ref: { token: 'canvas' } });
  assert.throws(() => validateCad('reference.image', { mode: 'inspect', ref: 'canvas', length: '1 mm' }), /only mode\/ref/);
  assert.throws(() => validateCad('reference.image', { mode: 'calibrate', ref: 'canvas' }), /requires segment/);
  const script = buildCadScript('reference.image', { mode: 'inspect', ref: 'canvas' }, { doc: 'Model' });
  assert.match(script, /'reference\.image': _io_reference_image/);
  assert.match(script, /"operation": "reference\.image"/);
  assert.doesNotMatch(script, /import numpy|from PIL/);
});

test('GM05 real CLI pipeline processes actual synthetic files offline', { skip: !available }, async t => {
  const parent = path.join(root, '.test-artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'reference-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'source.png');
  const fixture = spawnSync(python, ['-B', '-c', 'from PIL import Image; import sys; Image.new("RGB",(100,200),"white").save(sys.argv[1])', original]);
  assert.equal(fixture.status, 0);
  const layout = structuredClone(catalog['reference.layout'].example);
  Object.assign(layout, { original: { path: original, status: 'ESTIMATED', uncertaintyPx: 1 }, out: path.join(dir, 'layout'), python });
  const req = path.join(dir, 'request.json');
  fs.writeFileSync(req, JSON.stringify(layout));
  const h = harness();
  assert.equal(await main(['reference', 'layout', '--file', req, '--json'], h.deps), 0, h.err);
  const report = JSON.parse(h.out);
  assert.equal(report.operation, 'reference.layout');
  assert.equal(report.documentIdentity, null);
  assert.equal(report.nativeAcceptance, 'notEvaluated');
  assert.deepEqual(fs.readFileSync(report.result.originalCopy.path), fs.readFileSync(original));
  const calibration = structuredClone(catalog['reference.calibrate'].example);
  Object.assign(calibration, { layout: report.reportPath, out: path.join(dir, 'calibration'), python });
  const c = harness();
  assert.equal(await main(['reference', 'calibrate', '--data', JSON.stringify(calibration)], c.deps), 0, c.err);
  assert.equal(JSON.parse(c.out).status, 'unknown');
  const compare = structuredClone(catalog['reference.compare'].example);
  Object.assign(compare, { calibration: JSON.parse(c.out).reportPath, out: path.join(dir, 'compare'), python });
  compare.comparisons[0].render = report.result.views[0].path;
  const d = harness();
  assert.equal(await main(['reference', 'compare', '--data', JSON.stringify(compare)], d.deps), 0, d.err);
  assert.equal(JSON.parse(d.out).result.comparisons[0].metrics[0].deviationPx, 0);
  assert.equal(JSON.parse(d.out).result.comparisons[0].metrics[0].projectedDeviationMm, null);
  calibration.out = path.join(dir, 'blocked');
  calibration.dimension.source.status = 'OPEN';
  const blocked = harness();
  assert.equal(await main(['reference', 'calibrate', '--data', JSON.stringify(calibration)], blocked.deps), 1);
  assert.equal(JSON.parse(blocked.out).status, 'blocked');
});

test('GM05 worker failures are local and do not publish outputs', { skip: !available }, async () => {
  const request = { ...catalog['reference.layout'].example, python, schemaVersion: 1, original: { path: 'missing-gm05-image.png', status: 'OPEN', uncertaintyPx: 0 } };
  const h = harness();
  assert.equal(await main(['reference', 'layout', '--data', JSON.stringify(request)], h.deps), 1);
  assert.match(h.err, /Local reference worker failed/);
  const invalid = harness();
  assert.equal(await main(['reference', 'layout', '--data', JSON.stringify({ ...request, schemaVersion: 2 })], invalid.deps), 1);
  assert.match(invalid.err, /schemaVersion/);
});
