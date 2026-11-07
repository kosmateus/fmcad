'use strict';

// Live integration tests for GM-35 (drawing package/check/export). This family
// is LOCAL: it runs without --doc, produces real SVG/PDF/DXF artifacts with
// semantic dimensions and a source map, and never calls Fusion. Native Drawing
// authoring is a declared SDK gate reported as blocked, never faked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fmcad, cad } = require('./helper');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-g35-'));
}

// Canonical passing package: a front projection with a plate + concentric
// shaft/bore, two semantic dimensions, an item table, a balloon and a fit.
function request(out) {
  return {
    schemaVersion: 1,
    documentIdentity: { name: 'Seal Subassembly', revision: 'A' },
    sheet: { format: 'A3', titleBlock: { drawingNumber: 'CW-100', scale: '1:1' } },
    views: [{
      id: 'front', kind: 'projection', orientation: 'front', scale: 1, origin: [40, 40],
      geometry: [
        { id: 'plate', kind: 'polyline', points: [[0, 0], [60, 0], [60, 40], [0, 40]], closed: true },
        { id: 'bore', kind: 'circle', center: [30, 20], r: 5 },
        { id: 'shaft', kind: 'circle', center: [30, 20], r: 3 },
      ],
    }],
    dimensions: [
      { id: 'width', view: 'front', kind: 'linear', a: [0, 0], b: [60, 0], offset: -10,
        value: '60 mm', tolerance: { upper: '0.1 mm', lower: '-0.1 mm' },
        source: { path: 'specs/seal.json', status: 'CONFIRMED' } },
      { id: 'bore-dia', view: 'front', kind: 'diameter', circle: 'bore', value: '10 mm',
        source: { path: 'specs/seal.json', status: 'CONFIRMED' } },
    ],
    items: [{ item: 1, partId: 'P020', description: 'Housing', qty: 1, purchased: false,
      source: { path: 'BOM.csv', status: 'CONFIRMED' } }],
    balloons: [{ id: 'b1', view: 'front', item: 1, at: [70, 55],
      anchor: { entity: 'plate', role: 'vertex', index: 2 } }],
    fits: [{ id: 'seal-fit', view: 'front', shaft: 'shaft', bore: 'bore',
      clearance: { min: '1.9 mm', max: '2.1 mm', source: { path: 'tolerance-strategy.md', status: 'CONFIRMED' } } }],
    out,
  };
}

test('gm35: G35-01 native drawing representation is an honest blocked gate', () => {
  const base = makeDir();
  const req = { ...request(path.join(base, 'native')), representation: 'native' };
  const out = cad(['drawing', 'package', '--data', JSON.stringify(req)]);
  assert.equal(out.json.status, 'blocked', JSON.stringify(out.json));
  assert.equal(out.json.success, false);
  assert.match(out.json.result.reason, /native drawing authoring is not available/);
  assert.ok(!fs.existsSync(req.out));
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-02 drawing package builds views, semantic dimensions and a source map', () => {
  const base = makeDir();
  const out = fmcad(['drawing', 'package', '--data', JSON.stringify(request(path.join(base, 'pkg')))]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.success, true);
  assert.equal(out.documentIdentity.name, 'Seal Subassembly');
  assert.equal(out.nativeAcceptance, 'notEvaluated');
  assert.equal(out.associativity, 'snapshot');
  assert.equal(out.result.nativeDrawing.status, 'blocked');
  assert.equal(out.result.sourceMap.dimensions['bore-dia'].status, 'CONFIRMED');
  assert.ok(fs.existsSync(out.result.scene.path));
  assert.equal(out.result.scene.sha256, out.result.scene.sha256);
  assert.ok(fs.existsSync(out.reportPath));
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-03 drawing package supports tolerances, datums and GD&T in the declared range', () => {
  const base = makeDir();
  const req = request(path.join(base, 'pkg'));
  req.datums = [
    { id: 'A', view: 'front', kind: 'plane', at: [0, 0], source: { path: 'datum.json', status: 'CONFIRMED' } },
    { id: 'B', view: 'front', kind: 'axis', at: [30, 20], source: { path: 'datum.json', status: 'CONFIRMED' } },
  ];
  req.controls = [{
    id: 'f1', view: 'front', kind: 'position', target: 'bore', value: '0.1 mm',
    datums: ['A', 'B'], anchor: [30, 20], source: { path: 'gdnt.json', status: 'CONFIRMED' },
  }];
  const out = fmcad(['drawing', 'package', '--data', JSON.stringify(req)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const scene = JSON.parse(fs.readFileSync(out.result.scene.path, 'utf8'));
  assert.ok(scene.primitives.some((p) => p.type === 'text' && p.text === '⌖'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-04 drawing package carries item table, balloons and material/process notes', () => {
  const base = makeDir();
  const req = request(path.join(base, 'pkg'));
  req.notes = [{
    id: 'n1', text: 'Material: POM', kind: 'material', at: [40, 210], height: 3,
    source: { path: 'notes.md', status: 'CONFIRMED' },
  }];
  const out = fmcad(['drawing', 'package', '--data', JSON.stringify(req)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(out.result.checks.some((c) => c.kind === 'balloon-item-map' && c.status === 'pass'));
  assert.ok(out.result.checks.some((c) => c.kind === 'content-completeness' && c.status === 'pass'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-05 drawing check re-verifies the stored package and scene hashes', () => {
  const base = makeDir();
  const pkg = fmcad(['drawing', 'package', '--data', JSON.stringify(request(path.join(base, 'pkg')))]);
  const out = fmcad(['drawing', 'check', '--data', JSON.stringify({
    schemaVersion: 1,
    package: pkg.reportPath,
    out: path.join(base, 'check'),
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(out.result.checks.length > 0);
  assert.equal(out.result.checks.filter((c) => c.status !== 'pass').length, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-06 drawing export emits real SVG, PDF and DXF artifacts with a manifest', () => {
  const base = makeDir();
  const pkg = fmcad(['drawing', 'package', '--data', JSON.stringify(request(path.join(base, 'pkg')))]);
  const out = fmcad(['drawing', 'export', '--data', JSON.stringify({
    schemaVersion: 1,
    package: pkg.reportPath,
    formats: ['svg', 'pdf', 'dxf'],
    out: path.join(base, 'export'),
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const files = Object.fromEntries(out.result.files.map((f) => [f.format, f]));
  assert.deepEqual(Object.keys(files).sort(), ['dxf', 'pdf', 'svg']);
  for (const file of out.result.files) {
    assert.equal(fs.readFileSync(file.path).length, file.sizeBytes);
  }
  assert.match(fs.readFileSync(files.svg.path, 'utf8'), /fmcad-source-map/);
  assert.match(fs.readFileSync(files.dxf.path, 'utf8'), /\r\nENTITIES\r\n/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-07 drawing package handles a purchased spring item and an opening artifact', () => {
  const base = makeDir();
  const req = request(path.join(base, 'pkg'));
  req.items.push({ item: 2, partId: 'P050', description: 'Spring', qty: 1, purchased: true,
    source: { path: 'BOM.csv', status: 'CONFIRMED' } });
  req.balloons.push({ id: 'b2', view: 'front', item: 2, at: [80, 60], anchor: [60, 40] });
  const out = fmcad(['drawing', 'package', '--data', JSON.stringify(req)]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.ok(out.result.checks.some((c) => c.kind === 'fit-geometry' && c.status === 'pass'));
  assert.ok(fs.existsSync(out.result.scene.path));
  assert.ok(fs.existsSync(out.reportPath));
  fs.rmSync(base, { recursive: true, force: true });
});

test('gm35: G35-08 ESTIMATED sources stay unknown and never become production tolerances', () => {
  const base = makeDir();
  const req = request(path.join(base, 'pkg'));
  req.dimensions[0].source.status = 'ESTIMATED';
  delete req.dimensions[0].tolerance;
  const out = fmcad(['drawing', 'package', '--data', JSON.stringify(req)]);
  assert.equal(out.status, 'unknown', JSON.stringify(out));
  assert.equal(out.success, true);
  assert.equal(out.nativeAcceptance, 'notEvaluated');
  assert.ok(out.result.checks.some((c) => c.id === 'width' && c.status === 'unknown'));
  fs.rmSync(base, { recursive: true, force: true });
});
