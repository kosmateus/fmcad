const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('../src/curve');
const { buildCadScript, executeCad, catalog } = require('../src/cad');
const base = { schemaVersion: 1, sketch: 'Profile', frame: 'sketch', plane: 'sketchXY', units: { length: 'mm' }, columns: { x: 'x', y: 'y' }, closed: false, records: [{ x: 0, y: 0 }, { x: 10, y: 5 }] };
test('GM07 adapts samples to existing geometry DSL and keeps source provenance', () => {
  const plan = prepare('curve.fit', base);
  assert.deepEqual(plan.geometry, [{ type: 'line', start: ['0 cm', '0 cm', '0 cm'], end: ['1 cm', '0.5 cm', '0 cm'] }]);
  assert.equal(plan.provenance.sha256.length, 64);
  assert.equal(plan.sampleMap[1].index, 1);
  const script = buildCadScript('curve.fit', base, { doc: 'Fixture' });
  assert.match(script, /'geometry':/);
  assert.doesNotMatch(script, /'records':/);
});
test('GM07 refuses cam chord, radial ambiguity, implicit projection and invalid budgets', () => {
  for (const patch of [{ closed: true }, { columns: { profile_x: 'x', radius: 'y' } }, { plane: 'XY' }, { maxSamples: 1 }, { units: { length: 'deg' } }, { records: [{ x: '', y: 0 }, { x: 1, y: 2 }] }]) assert.throws(() => prepare('curve.fit', { ...base, ...patch }));
  assert.throws(() => prepare('curve.fit', { ...base, columns: { x: 'x', y: 'y', z: 'z' }, records: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 2, z: 0 }] }), /not on/);
});
test('GM07 closed loops preserve original samples across winding and endpoint snap', () => {
  const p = prepare('curve.fit', { ...base, closed: true, winding: 'cw', columns: { x: 'x', y: 'y', loop: 'id' }, records: ['a', 'b'].flatMap(id => [{ x: 0, y: 0, id }, { x: 2, y: 0, id }, { x: 0, y: 2, id }, { x: .0001, y: 0, id }]) });
  assert.equal(p.loops.length, 2);
  assert.equal(p.sampleMap[0].index, 3);
  assert.equal(p.sampleMap[0].point[0], .00001);
  assert.deepEqual(p.geometry[0].start, ['0 cm', '0 cm', '0 cm']);
});
test('GM07 CSV delimiter, source rows, mapped polar units and nested JSON are host-local', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm07-'));
  try {
    fs.writeFileSync(path.join(dir, 'points.csv'), 'theta;r;state\n0;10;ESTIMATED\n90;10;CONFIRMED\n');
    const { records, ...input } = base;
    const p = prepare('curve.fit', { ...input, source: 'points.csv', baseDir: dir, delimiter: ';', columns: { angle: 'theta', radius: 'r', status: 'state' }, units: { length: 'mm', angle: 'deg' } });
    assert.equal(p.sampleMap[1].line, 3);
    assert.equal(p.sampleMap[0].status, 'ESTIMATED');
    assert.ok(Math.abs(p.sampleMap[1].point[1] - 1) < 1e-12);
    fs.writeFileSync(path.join(dir, 'points.json'), JSON.stringify({ data: records }));
    assert.equal(prepare('curve.fit', { ...input, source: 'points.json', baseDir: dir, recordsPath: 'data' }).sampleMap.length, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('GM07 preview does full file preflight without backend mutation', async () => {
  const result = await executeCad({ callTool() { throw new Error('unexpected backend'); } }, 'curve.fit', base, { preview: true });
  assert.equal(result.status, 'notEvaluated');
  for (const op of ['curve.fit', 'curve.inspect', 'curve.offset', 'curve.offset-edit', 'sketch.profile-file']) assert.ok(catalog[op]);
});
test('GM07 offset-edit routes the native dimension parameter edit through the real validator', async () => {
  const example = catalog['curve.offset-edit'].example;
  assert.deepEqual(prepare('curve.offset-edit', example), example);
  const script = buildCadScript('curve.offset-edit', example, { doc: 'Fixture' });
  assert.match(script, /"parameter": "d203"/);
  const result = await executeCad({ callTool() { throw new Error('unexpected backend'); } }, 'curve.offset-edit', example, { preview: true });
  assert.equal(result.status, 'notEvaluated');
});
test('GM07 offset-edit rejects malformed parameter targets and distances', () => {
  const example = catalog['curve.offset-edit'].example;
  for (const patch of [{ parameter: '' }, { parameter: 42 }, { parameter: { token: null } }, { distance: '' }, { distance: 8 }, { frame: 'component' }]) {
    assert.throws(() => prepare('curve.offset-edit', { ...example, ...patch }));
  }
  assert.deepEqual(prepare('curve.offset-edit', { ...example, parameter: { token: 'param-token' } }), { ...example, parameter: { token: 'param-token' } });
});
