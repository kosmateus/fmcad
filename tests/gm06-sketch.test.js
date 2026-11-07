const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCad, buildCadScript, executeCad, catalog } = require('../src/cad');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ellipse = { type: 'ellipse', name: 'oval', center: ['-1 mm', '0 mm', '0 mm'], majorRadius: '20 mm', minorRadius: '10 mm' };
test('GM06 existing builder and all operations are parser reachable', () => {
  for (const op of ['sketch.build', 'sketch.transform', 'sketch.dimension-plan', 'sketch.dimension-apply']) {
    assert.equal(validateCad(op, catalog[op].example), catalog[op]);
  }
  validateCad('sketch.build', { name: 'Oval', plane: 'YZ', geometry: [ellipse], dimensions: [{ type: 'majorRadius', entities: ['oval'], expression: '20 mm' }] });
  validateCad('sketch.edit', { sketch: 'Oval', movePoints: [{ point: { token: 'center' }, to: ['0 mm', '-1 mm', '0 mm'] }] });
  validateCad('sketch.dimension', { sketch: 'Oval', type: 'minorRadius', entities: [{ token: 'oval' }], expression: '5 mm', text: ['0 mm', '0 mm', '0 mm'] });
});

test('GM06 rejects invalid nested payloads before SDK dispatch', () => {
  const cases = [
    ['sketch.build', { name: 'S', geometry: [ellipse, ellipse] }],
    ['sketch.geometry', { sketch: 'S', geometry: [{ ...ellipse, center: [0, '-1 mm', '0 mm'] }] }],
    ['sketch.geometry', { sketch: 'S', geometry: [{ ...ellipse, majorAxisPoint: ['0 mm', '0 mm', '0 mm'] }] }],
    ['sketch.build', { name: 'S', geometry: [ellipse], inferencePolicy: 'deleteConstraints' }],
    ['sketch.transform', { sketch: 'S', entities: ['oval'], frame: 'root', translate: ['1 mm', '0 mm', '0 mm'] }],
    ['sketch.transform', { sketch: 'S', entities: ['oval'], frame: 'sketch', rotate: { angle: '30 deg', scale: 2 } }],
    ['sketch.dimension', { sketch: 'S', type: 'majorRadius', entities: ['oval'], text: ['0 mm', '0 mm', '0 mm'], driving: false, expression: '1 mm' }],
    ['sketch.edit', { sketch: 'S', movePoints: [{ point: 'point', to: ['0 mm', '1 mm'] }] }],
    ['sketch.edit', { sketch: 'S', movePoints: [{ point: 'point', to: ['0 mm', '1 mm', '0 mm'] }], delete: true }],
    ['sketch.dimension-plan', { sketch: 'S', maxEntities: 0 }]
  ];
  for (const [op, data] of cases) assert.throws(() => validateCad(op, data), undefined, op);
});

test('dimension plan read-only and apply mutating are separate SDK dispatches', async () => {
  const requests = [];
  const client = { callTool: async request => {
    requests.push(request);
    return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true, result: {} }) };
  } };
  await executeCad(client, 'sketch.dimension-plan', { sketch: 'S' }, { doc: 'GM06' });
  await executeCad(client, 'sketch.dimension-apply', catalog['sketch.dimension-apply'].example, { doc: 'GM06' });
  assert.equal(requests[0].object.readOnly, true);
  assert.equal(requests[1].object.readOnly, false);
  const script = buildCadScript('sketch.build', { name: 'S', geometry: [ellipse] }, { doc: 'GM06' });
  assert.ok(script.includes('_shapes_prepare_sketch(ctx, spec)'));
  assert.ok(script.includes('sketchEllipses.add(*_sketch_ellipse_points'));
  assert.ok(script.indexOf('def sketch_geometry') > script.indexOf('def model_sketch_geometry'));
});

test('geometry retains existing spatial spline schema and zero/negative coordinates', () => {
  validateCad('sketch.geometry', { sketch: 'S', geometry: [{ type: 'spline', points: [['-1 mm', '0 mm', '1 mm'], ['0 mm', '0 mm', '2 mm']] }] });
});

test('all GM06 source manuals expose contracts, offline evidence and native gaps', () => {
  const { manuals } = require('../src/help-manual');
  const { detail } = require('../src/help');
  for (const operation of ['sketch.build', 'sketch.transform', 'sketch.dimension-plan', 'sketch.dimension-apply']) {
    const manual = manuals[operation];
    assert.ok(manual.sections.some(s => s.title === 'Return Contract'));
    assert.ok(manual.audit.tests.includes('tests/gm06_sketch_test.py'));
    for (const example of manual.examples) validateCad(operation, example.data);
    assert.match(detail(...operation.split('.')), /GM06/);
  }
});

test('native handoff bundles and compiles offline, refusing overwrite', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gm06-handoff-'));
  try {
    const file = path.join(folder, 'fixture.py');
    const result = spawnSync(process.execPath, ['tests/native/gm06-handoff.js', 'Disposable', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = fs.readFileSync(file, 'utf8');
    const compiled = spawnSync('python3', ['-B', '-c', 'import sys; compile(sys.stdin.read(), "gm06-native", "exec")'], { input: source, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(source, /GM06_NATIVE_RESULT/);
    assert.notEqual(spawnSync(process.execPath, ['tests/native/gm06-handoff.js', 'Disposable', file]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
