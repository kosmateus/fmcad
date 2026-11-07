const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { main } = require('../src/cli');
const { catalog, validateCad, buildCadScript } = require('../src/cad');
const drawing = require('../src/drawing-package');
const check = require('../src/drawing-check');
const exporter = require('../src/drawing-export');

function harness() {
  const h = { out: '', err: '' };
  h.deps = { stdout: { write: v => { h.out += v; } }, stderr: { write: v => { h.err += v; } },
    loadConfig: () => assert.fail('GM35 must not load backend config'),
    McpClient: class { constructor() { assert.fail('GM35 must not connect to Fusion'); } }, setExitCode: () => {} };
  return h;
}

const root = path.resolve(__dirname, '..');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture() {
  const parent = path.join(root, '.test-artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'drawing-'));
  return { dir, parent };
}
function baseRequest(dir, out) {
  const request = structuredClone(drawing.descriptors['drawing.package'].example);
  request.out = out ? out : path.join(dir, 'package');
  return request;
}
function row(status, kind) {
  return report => report.result.checks.filter(r => r.kind === kind).map(r => r.status).includes(status);
}

test('GM35 schemas are reachable, offline and node-only with explicit native gate', () => {
  const specs = { 'drawing.package': drawing.descriptors['drawing.package'], 'drawing.check': check.descriptors['drawing.check'], 'drawing.export': exporter.descriptors['drawing.export'] };
  for (const mode of ['package', 'check', 'export']) {
    const spec = specs['drawing.' + mode];
    assert.equal(spec.offline, true);
    assert.equal(spec.nodeOnly, true);
    assert.equal(spec.requiresDoc, false);
    assert.match(JSON.stringify(spec.limitations), /native|Native/);
    assert.equal(spec.example.schemaVersion, 1);
  }
  assert.deepEqual(drawing.validate('drawing.package', drawing.descriptors['drawing.package'].example), undefined);
  assert.throws(() => drawing.validate('drawing.package', { schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => check.validate('drawing.check', { schemaVersion: 1 }), /requires package/);
  assert.throws(() => exporter.validate('drawing.export', { schemaVersion: 1, package: 'x' }), /requires formats/);
});

test('GM35 package builds a passing package with item table, balloons and semantic dimensions', () => {
  const { dir } = fixture();
  const report = drawing.execute('drawing.package', baseRequest(dir));
  assert.equal(report.status, 'pass');
  assert.equal(report.success, true);
  assert.equal(report.documentIdentity.name, 'Seal Subassembly');
  assert.equal(report.nativeAcceptance, 'notEvaluated');
  assert.equal(report.associativity, 'snapshot');
  assert.ok(row('pass', 'balloon-unique')(report));
  assert.ok(row('pass', 'balloon-item-map')(report));
  assert.ok(row('pass', 'fit-geometry')(report));
  assert.ok(row('pass', 'content-completeness')(report));
  assert.equal(report.result.checks.filter(r => r.kind === 'dimension-consistency').every(r => r.status === 'pass'), true);
  assert.equal(report.result.sourceMap.dimensions['bore-dia'].status, 'CONFIRMED');
  assert.equal(report.result.nativeDrawing.status, 'blocked');
  assert.ok(fs.existsSync(report.result.scene.path));
  assert.equal(sha(fs.readFileSync(report.result.scene.path)), report.result.scene.sha256);
  const scene = JSON.parse(fs.readFileSync(report.result.scene.path));
  assert.ok(scene.primitives.some(p => p.type === 'circle' && p.r === 3.5));
  assert.ok(scene.primitives.some(p => p.type === 'text' && p.text === '60 +0.1/-0.1'));
  assert.ok(scene.primitives.some(p => p.type === 'text' && p.text === '⌀10'));
  assert.throws(() => drawing.execute('drawing.package', baseRequest(dir)), /NEW/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 native representation is blocked, never silently replaced', () => {
  const { dir } = fixture();
  const request = baseRequest(dir, path.join(dir, 'native-out'));
  request.representation = 'native';
  const report = drawing.execute('drawing.package', request);
  assert.equal(report.status, 'blocked');
  assert.equal(report.success, false);
  assert.match(report.result.reason, /native drawing authoring is not available/);
  assert.ok(!fs.existsSync(request.out));
  assert.throws(() => drawing.execute('drawing.package', { ...request, representation: 'fake' }), /representation/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 source statuses drive blocked, unknown and tolerance policy', () => {
  const { dir } = fixture();
  const open = baseRequest(dir, path.join(dir, 'open'));
  open.dimensions[0].source.status = 'OPEN';
  open.dimensions[0].tolerance = undefined;
  const blocked = drawing.execute('drawing.package', open);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.success, false);
  assert.ok(blocked.result.checks.find(r => r.kind === 'dimension-consistency' && r.id === 'width').status === 'blocked');
  const estimated = baseRequest(dir, path.join(dir, 'estimated'));
  estimated.dimensions[0].source.status = 'ESTIMATED';
  estimated.dimensions[0].tolerance = undefined;
  const unknown = drawing.execute('drawing.package', estimated);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.success, true);
  assert.ok(unknown.result.checks.find(r => r.kind === 'dimension-consistency' && r.id === 'width').status === 'unknown');
  const tolerance = baseRequest(dir, path.join(dir, 'tol'));
  tolerance.dimensions[0].source.status = 'ESTIMATED';
  assert.throws(() => drawing.execute('drawing.package', tolerance), /must not become production tolerances/);
  assert.ok(!fs.existsSync(path.join(dir, 'tol')));
  const angle = baseRequest(dir, path.join(dir, 'angle'));
  angle.dimensions.push({ id: 'a1', view: 'front', kind: 'angle', vertex: [30, 20], a: [60, 20], b: [30, 40], value: '90 deg', tolerance: { upper: '1 deg', lower: '-1 deg' }, source: { path: 'x', status: 'CONFIRMED' } });
  assert.throws(() => drawing.execute('drawing.package', angle), /angle tolerances are not supported/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 violated geometry and fits fail with witnesses', () => {
  const { dir } = fixture();
  const bad = baseRequest(dir, path.join(dir, 'bad'));
  bad.dimensions[0].value = '55 mm';
  const fail = drawing.execute('drawing.package', bad);
  assert.equal(fail.status, 'fail');
  assert.equal(fail.success, false);
  assert.match(fail.result.checks.find(r => r.id === 'width').detail, /measured 60/);
  const fit = baseRequest(dir, path.join(dir, 'fit'));
  fit.fits[0].clearance.max = '1.95 mm';
  const fitFail = drawing.execute('drawing.package', fit);
  assert.equal(fitFail.status, 'fail');
  assert.match(fitFail.result.checks.find(r => r.id === 'seal-fit').detail, /radial clearance 2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 balloon uniqueness, item mapping and fit axis tolerance are enforced', () => {
  const { dir } = fixture();
  const dup = baseRequest(dir, path.join(dir, 'dup'));
  dup.balloons.push({ id: 'b2', view: 'front', item: 1, at: [80, 60], anchor: [60, 40] });
  assert.throws(() => drawing.execute('drawing.package', dup), /must be unique/);
  const orphan = baseRequest(dir, path.join(dir, 'orphan'));
  orphan.balloons[0].item = 9;
  assert.throws(() => drawing.execute('drawing.package', orphan), /unknown item/);
  const offAxis = baseRequest(dir, path.join(dir, 'axis'));
  offAxis.views[0].geometry[2].center = [30, 21];
  offAxis.axisTolerance = '0.5 mm';
  const axisFail = drawing.execute('drawing.package', offAxis);
  assert.equal(axisFail.status, 'fail');
  assert.match(axisFail.result.checks.find(r => r.id === 'seal-fit').detail, /radial clearance/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 sections, details, hatches and GD&T supported range render and validate', () => {
  const { dir } = fixture();
  const request = baseRequest(dir, path.join(dir, 'sections'));
  request.views.push({ id: 'sec', kind: 'section', parent: 'front', cutFrom: [30, 0], cutTo: [30, 40], scale: 2, origin: [220, 40],
    geometry: [{ kind: 'polyline', points: [[0, 0], [40, 0], [40, 20], [0, 20]], closed: true }, { kind: 'hatch', boundary: [[0, 0], [40, 0], [40, 20], [0, 20]], spacing: 3 }] });
  request.views.push({ id: 'det', kind: 'detail', parent: 'front', detailFrom: [30, 20], detailRadius: 8, scale: 4, origin: [220, 160],
    geometry: [{ kind: 'circle', id: 'bore-detail', center: [0, 0], r: 5 }] });
  request.datums = [{ id: 'A', view: 'front', kind: 'plane', at: [0, 0], source: { path: 'datum.json', status: 'CONFIRMED' } },
    { id: 'B', view: 'front', kind: 'axis', at: [30, 20], source: { path: 'datum.json', status: 'CONFIRMED' } }];
  request.controls = [{ id: 'f1', view: 'front', kind: 'position', target: 'bore', value: '0.1 mm', datums: ['A', 'B'], anchor: [30, 20], source: { path: 'gdnt.json', status: 'CONFIRMED' } }];
  const report = drawing.execute('drawing.package', request);
  assert.equal(report.status, 'pass');
  const scene = JSON.parse(fs.readFileSync(report.result.scene.path));
  assert.ok(scene.primitives.filter(p => p.type === 'line').length > 0);
  assert.ok(scene.primitives.some(p => p.type === 'text' && /SECTION SEC/.test(p.text)));
  assert.ok(scene.primitives.some(p => p.type === 'text' && /DETAIL DET/.test(p.text)));
  assert.ok(scene.primitives.some(p => p.type === 'text' && p.text === '⌖'));
  const badControl = baseRequest(dir, path.join(dir, 'ctl'));
  badControl.controls = [{ id: 'f2', view: 'front', kind: 'runout', target: 'bore', value: '0.1 mm', source: { path: 'x', status: 'CONFIRMED' } }];
  assert.throws(() => drawing.execute('drawing.package', badControl), /unsupported GD&T kind/);
  const missingDatum = baseRequest(dir, path.join(dir, 'ctl2'));
  missingDatum.controls = [{ id: 'f3', view: 'front', kind: 'position', target: 'bore', value: '0.1 mm', datums: ['Z'], source: { path: 'x', status: 'CONFIRMED' } }];
  assert.throws(() => drawing.execute('drawing.package', missingDatum), /unknown datum Z/);
  const childFirst = baseRequest(dir, path.join(dir, 'order'));
  childFirst.views = [childFirst.views[1] = { id: 'sec2', kind: 'section', parent: 'front', cutFrom: [0, 0], cutTo: [60, 0], origin: [200, 40], geometry: [{ kind: 'line', from: [0, 0], to: [10, 10] }] }, ...childFirst.views.slice(0, 1)];
  assert.throws(() => drawing.execute('drawing.package', childFirst), /must be listed earlier/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 check re-verifies the stored package and rejects stale scenes', () => {
  const { dir } = fixture();
  const report = drawing.execute('drawing.package', baseRequest(dir));
  const result = check.execute('drawing.check', { schemaVersion: 1, package: report.reportPath, out: path.join(dir, 'check') });
  assert.equal(result.status, 'pass');
  assert.equal(result.result.checks.length, report.result.checks.length);
  fs.writeFileSync(report.result.scene.path, 'tampered');
  assert.throws(() => check.execute('drawing.check', { schemaVersion: 1, package: report.reportPath, out: path.join(dir, 'check2') }), /sha256 mismatch/);
  assert.ok(!fs.existsSync(path.join(dir, 'check2')));
  assert.throws(() => check.execute('drawing.check', { schemaVersion: 1, package: path.join(dir, 'nope.json'), out: path.join(dir, 'check3') }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 export emits real SVG, PDF and DXF artifacts with verified manifest', () => {
  const { dir } = fixture();
  const report = drawing.execute('drawing.package', baseRequest(dir));
  const result = exporter.execute('drawing.export', { schemaVersion: 1, package: report.reportPath, formats: ['svg', 'pdf', 'dxf'], out: path.join(dir, 'export') });
  assert.equal(result.status, 'pass');
  const files = Object.fromEntries(result.result.files.map(f => [f.format, f]));
  assert.deepEqual(Object.keys(files).sort(), ['dxf', 'pdf', 'svg']);
  for (const file of result.result.files) {
    const content = fs.readFileSync(file.path);
    assert.equal(sha(content), file.sha256);
    assert.equal(content.length, file.sizeBytes);
  }
  const svg = fs.readFileSync(files.svg.path, 'utf8');
  assert.match(svg, /<svg /);
  assert.match(svg, /fmcad-source-map/);
  assert.match(svg, />60 \+0\.1\/-0\.1</);
  assert.match(svg, /DIA |⌀10/);
  const dxf = fs.readFileSync(files.dxf.path, 'utf8');
  assert.match(dxf, /\r\nENTITIES\r\n/);
  assert.match(dxf, /\r\nCIRCLE\r\n/);
  assert.match(dxf, /\r\nTEXT\r\n/);
  assert.match(dxf, /\r\nEOF\r\n/);
  assert.match(dxf, /DIA 10/);
  const pdf = fs.readFileSync(files.pdf.path);
  assert.match(pdf.toString('latin1'), /^%PDF-1\.4/);
  assert.match(pdf.toString('latin1'), /%%EOF\n$/);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 1190\.55 841\.89\]/);
  assert.throws(() => exporter.execute('drawing.export', { schemaVersion: 1, package: report.reportPath, formats: ['gif'], out: path.join(dir, 'bad') }), /unsupported format/);
  assert.throws(() => exporter.execute('drawing.export', { schemaVersion: 1, package: report.reportPath, formats: ['svg', 'svg'], out: path.join(dir, 'dup') }), /duplicate format/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 export inherits package uncertainty instead of hiding it', () => {
  const { dir } = fixture();
  const request = baseRequest(dir);
  request.dimensions[0].source.status = 'ESTIMATED';
  request.dimensions[0].tolerance = undefined;
  const report = drawing.execute('drawing.package', request);
  assert.equal(report.status, 'unknown');
  const result = exporter.execute('drawing.export', { schemaVersion: 1, package: report.reportPath, formats: ['svg'], out: path.join(dir, 'export') });
  assert.equal(result.status, 'unknown');
  assert.equal(result.result.packageStatus, 'unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GM35 quantity and source validation are strict', () => {
  assert.equal(drawing.length('1 in'), 25.4);
  assert.equal(drawing.quantity('90 deg', true), Math.PI / 2);
  assert.throws(() => drawing.length(25), /explicit length/);
  assert.throws(() => drawing.length('25'), /explicit length/);
  assert.throws(() => drawing.source({ path: 'x', status: 'GUESSED' }), /status/);
  assert.throws(() => drawing.source({ path: 'x', status: 'DERIVED' }), /derivedFrom/);
  assert.throws(() => drawing.source({ path: 'x', status: 'CONFIRMED', derivedFrom: ['a'] }), /derivedFrom requires DERIVED/);
  assert.throws(() => drawing.safeId('../escape'), /Invalid id/);
  assert.equal(drawing.dimensionStatus({ source: { status: 'OPEN' } }, 5), 'blocked');
  assert.equal(drawing.dimensionStatus({ source: { status: 'CONFIRMED' }, kind: 'linear', valueMm: 5 }, 5), 'pass');
  assert.equal(drawing.dimensionStatus({ source: { status: 'CONFIRMED' }, kind: 'linear', valueMm: 5, toleranceMm: { upper: 0.1, lower: -0.1 } }, 5.2), 'fail');
});

test('GM35 CLI routing, preview and help reach the registered family', async () => {
  for (const mode of ['package', 'check', 'export']) {
    const spec = catalog['drawing.' + mode];
    assert.equal(spec.offline, true);
    assert.equal(spec.requiresDoc, false);
    validateCad('drawing.' + mode, spec.example);
    const h = harness();
    assert.equal(await main(['drawing', mode, '--data', JSON.stringify(spec.example), '--preview'], h.deps), 0, h.err);
    assert.equal(JSON.parse(h.out).state, 'input-validated-only');
    const help = harness();
    assert.equal(await main(['help', 'drawing', mode], help.deps), 0, help.err);
    assert.match(help.out, /Native Drawing Gate/);
    assert.match(help.out, /nativeAcceptance/);
  }
  const script = buildCadScript('drawing.package', catalog['drawing.package'].example, { doc: 'Model' });
  assert.match(script, /CAD_HANDLERS/);
  const blocked = harness();
  const request = { ...catalog['drawing.package'].example, representation: 'native' };
  assert.equal(await main(['drawing', 'package', '--data', JSON.stringify(request)], blocked.deps), 1, blocked.err);
  assert.equal(JSON.parse(blocked.out).status, 'blocked');
});
