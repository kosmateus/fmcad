const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, offlineResult, transform, multiply, inverse, csv, descriptors } = require('../src/data-import');
const { buildCadScript, executeCad } = require('../src/cad');
const { main } = require('../src/cli');
const restorePlatform = require('./fixtures/fake-wsl-platform.cjs')();
test.after(restorePlatform);

const base = process.env.FMCAD_DATA_IMPORT_TEST_ROOT || os.tmpdir();
const directory = fs.mkdtempSync(path.join(base, 'data_import-'));
test.after(() => fs.rmSync(directory, { recursive: true }));
const pose = (x = '0 mm', frame = 'parent') => ({ frame, translation: [x, '0 mm', '0 mm'], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
const item = (id, changes = {}) => ({ id, name: id, quantity: 1, parent: null, kind: 'part', placement: pose(), status: 'CONFIRMED', ...changes });
const adapter = records => ({ version: 1, owner: 'offline-fixture', revision: 'r1', records });
function source(name, contents) { const file = path.join(directory, name); fs.writeFileSync(file, contents, { flag: 'wx' }); return file; }

test('CSV accepts multiline quoted fields and rejects malformed headers, quotes and row lengths', () => {
  assert.deepEqual(csv('id,comment\r\na,"one\r\ntwo ""quoted"""\r\n'), [{ value: { id: 'a', comment: 'one\r\ntwo "quoted"' }, line: 2 }]);
  for (const input of ['a,a\n1,2', 'a,b\n1', 'a\n"no end', 'a\n"x"bad', 'a\nx"y']) assert.throws(() => csv(input));
});

test('CSV/JSON column mapping, defaults, line/hash provenance and explicit CLI base directory', () => {
  source('parameters.csv', 'symbol;value;units;note\r\nw;2;mm;"two\nlines"\r\nn;4;;count\r\n');
  const request = { version: 1, owner: 'fixture', revision: 'A', source: 'parameters.csv', baseDir: directory,
    schema: { delimiter: ';', columns: { name: 'symbol', expression: 'value', unit: 'units', comment: 'note' }, defaults: { status: 'ESTIMATED' } } };
  const p = prepare('param.import', request);
  assert.equal(p.result.parameters[0].comment, 'two\nlines');
  assert.equal(p.result.parameters[1].unit, '');
  assert.equal(p.result.parameters[1].provenance.row, 4);
  assert.equal(p.result.parameters[0].provenance.status, 'ESTIMATED');
  assert.match(p.provenance.sha256, /^[a-f0-9]{64}$/);
  const file = source('mapped.json', JSON.stringify({ table: [{ part: { code: 'G', label: 'Generic' }, number: 2 }] }));
  const c = prepare('catalog.check', { version: 1, source: file, schema: { recordsPath: 'table', columns: { id: 'part.code', name: 'part.label', quantity: 'number' }, defaults: { kind: 'part', parent: null } } });
  assert.equal(c.result.counts.instances, 2);
  assert.equal(offlineResult(c).status, 'unknown');
  assert.throws(() => prepare('catalog.check', { version: 1, source: file, baseDir: 'relative' }), /absolute/);
});

test('whole-file preflight rejects late invalid records before config/backend construction', async () => {
  let backend = 0, stderr = '';
  const request = adapter([item('good'), item('bad', { quantity: -1 })]);
  const code = await main(['catalog', 'import', '--doc', 'Scoped', '--data', JSON.stringify(request), '--json'], {
    loadConfig() { backend++; throw new Error('must not load config'); }, setExitCode() {}, stdout: { write() {} }, stderr: { write(s) { stderr += s; } },
  });
  assert.equal(code, 1); assert.equal(backend, 0); assert.match(stderr, /integer/);
});

test('all six public operations dispatch; checks and previews stay offline without global config', async () => {
  for (const [operation, descriptor] of Object.entries(descriptors)) {
    const result = await executeCad(null, operation, descriptor.example, { doc: 'Scoped', preview: true });
    assert.equal(result.mutation, false); assert.equal(result.modelValidated, false);
    assert.notEqual(result.status, 'pass');
    assert.ok(buildCadScript(operation, descriptor.example, { doc: 'Scoped' }).includes("'documentIdentity'"));
  }
  let configLoads = 0;
  let stdout = '';
  const code = await main(['catalog', 'check', '--data', JSON.stringify(adapter([item('one')]))], {
    loadConfig() { configLoads++; throw new Error('offline check loaded config'); }, setExitCode() {},
    stdout: { write(text) { stdout += text; } }, stderr: { write() {} },
  });
  assert.equal(code, 1, 'Missing source provenance remains unresolved, not passing.');
  assert.equal(configLoads, 0, 'Offline catalog check must not load backend configuration.');
  const result = JSON.parse(stdout);
  assert.equal(result.operation, 'catalog.check');
  assert.equal(result.status, 'unknown');
  assert.equal(result.mutation, false);
});

test('rigid transforms reject reflections, shear, scales, missing roll/offset, nonfinite and unframed positions', () => {
  assert.equal(transform(pose('1 in')).matrix[3], 2.54);
  for (const value of [
    { frame: 'root', translation: ['0 mm', '0 mm', '0 mm'], opticalNormal: [0, 0, 1] },
    { frame: 'root', rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...pose(), frame: undefined }, { ...pose(), translation: [0, 0, 0] },
    { ...pose(), rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...pose(), rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...pose(), rotation: [1, 0.1, 0, 0, 1, 0, 0, 0, 1] },
    { ...pose(), rotation: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] },
    { frame: 'root', matrix: Array(16).fill(0), unit: 'mm' },
  ]) assert.throws(() => transform(value));
  const a = transform({ frame: 'root', translation: ['2 cm', '-1 cm', '3 cm'], rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1] }).matrix;
  const local = transform(pose('4 cm')).matrix;
  assert.deepEqual(multiply(a, local).filter((_, i) => [3, 7, 11].includes(i)), [2, 3, 3]);
  assert.ok(multiply(inverse(a), multiply(a, local)).every((v, i) => Math.abs(v - local[i]) < 1e-12));
});

test('catalog repeated nested definitions, PCBA contents/allocation and purchase ledgers remain separate', () => {
  const records = [item('board', { kind: 'pcba', quantity: 2, purchaseQuantity: 2, contents: [{ id: 'module', quantity: 4 }], functionalGroups: ['optics'], motionMembership: ['pan'] }),
    item('module', { kind: 'purchased', parent: 'board', quantity: 4, allocation: { owner: 'board', quantity: 8 } }),
    item('outline', { kind: 'reference', quantity: 1 })];
  const p = prepare('catalog.check', { ...adapter(records), bom: [{ id: 'module', basis: 'contents', quantity: 8 }, { id: 'module', basis: 'physical', quantity: 8 }] });
  assert.equal(p.result.counts.instances, 11);
  assert.equal(p.result.instances.filter(r => r.item === 'module').length, 8);
  assert.equal(p.result.ledger.find(r => r.id === 'module').purchase, null);
  assert.equal(p.result.ledger.find(r => r.id === 'outline').physical, 0);
  assert.deepEqual(p.result.differences, []);
  assert.equal(p.result.instances.find(r => r.id === 'board:2/module:4').parent, 'board:2');
  assert.equal(offlineResult(p).status, 'unknown'); // Vendor masses absent.
  assert.throws(() => prepare('catalog.check', adapter([records[0], { ...records[1], allocation: undefined }])), /allocation/);
  assert.throws(() => prepare('catalog.check', adapter([records[0], { ...records[1], purchaseQuantity: 8 }])), /standalone purchases/);
});

test('catalog rejects duplicate IDs, cycles, missing parents and inconsistent linked subtrees', () => {
  for (const records of [[item('a'), item('a')], [item('a', { parent: 'b' })], [item('a', { parent: 'b' }), item('b', { parent: 'a' })],
    [item('a', { contents: [{ id: 'b', quantity: 1 }] }), item('b', { contents: [{ id: 'a', quantity: 1 }] })]]) assert.throws(() => prepare('catalog.check', adapter(records)));
  assert.throws(() => prepare('catalog.check', { ...adapter([item('a', { quantity: 2 }), item('b', { parent: 'a' })]), instances: [
    { id: 'a1', item: 'a', parent: null, localKey: 'a1' }, { id: 'a2', item: 'a', parent: null, localKey: 'a2' }, { id: 'b1', item: 'b', parent: 'a1', localKey: 'b' },
  ] }), /inconsistent|quantity per parent/);
  assert.throws(() => prepare('catalog.check', { ...adapter([item('a', { quantity: 100 }), item('b', { parent: 'a', quantity: 100 })]), maxItems: 100 }), /maxItems/);
});

test('offline BOM/observed check detects actual mismatches and never fills missing quantities with zero', () => {
  const p = prepare('catalog.check', { ...adapter([item('a')]), bom: [{ id: 'a', basis: 'physical', quantity: 2 }, { id: 'a', basis: 'purchase', quantity: 0 }], observed: { instances: [] } });
  const result = offlineResult(p);
  assert.equal(result.success, false); assert.equal(result.status, 'fail');
  assert.equal(result.result.differences[1].actual, null); assert.equal(result.result.differences[1].status, 'unknown');
  assert.equal(result.result.differences[2].status, 'fail');
});

test('BOM CSV adapter and explicit enum mapping retain independent source provenance', () => {
  source('bom.csv', 'part,qty,kind\na,2,physical\n');
  const p = prepare('catalog.check', { ...adapter([item('a', { quantity: 2, kind: 'CUSTOM' })]),
    schema: { values: { kind: { CUSTOM: 'part' } } }, baseDir: directory,
    bom: { source: 'bom.csv', schema: { columns: { id: 'part', quantity: 'qty', basis: 'kind' } } } });
  assert.deepEqual(p.result.differences, []);
  assert.equal(p.result.bomProvenance.path, path.join(directory, 'bom.csv'));
  assert.throws(() => prepare('catalog.check', { ...adapter([item('a')]), schema: { values: { kind: { unknown: 'part' } } } }), /unmapped/);
  const absent = prepare('catalog.check', adapter([item('board', { quantity: 0, contents: [{ id: 'module', quantity: 4 }] }), item('module', { quantity: 0 })]));
  assert.equal(absent.result.ledger.find(r => r.id === 'module').contents, null);
});

test('explicit instances cannot silently override catalog quantities; missing observations and mass stay unknown', () => {
  assert.throws(() => prepare('catalog.check', { ...adapter([item('a', { quantity: 2 })]), instances: [{ id: 'one', item: 'a', localKey: 'one', parent: null }] }), /quantity per parent/);
  const p = prepare('placement.check', adapter([{ id: 'a', occurrence: 'A:1', placement: pose(), status: 'CONFIRMED', source: 'fixture' }]));
  assert.equal(offlineResult(p).status, 'unknown');
  assert.throws(() => prepare('catalog.check', adapter([item('a', { mass: { value: 0, unit: 'g' } })])), /positive/);
  assert.deepEqual(transform(pose('1 mm', { datum: 'mount', component: 'root' })).frame, { datum: 'mount', component: 'root' });
});

test('offline placement checks retain units/frames and identify translation and rotation error', () => {
  const data = adapter([{ id: 'o', occurrence: 'A:1+B:1', placement: pose('1 cm', 'root'), status: 'CONFIRMED' }]);
  const p = prepare('placement.check', { ...data, observed: { poses: [{ id: 'o', transform: pose('11 mm', 'root') }] } });
  const r = offlineResult(p); assert.equal(r.status, 'fail'); assert.ok(Math.abs(r.result.differences[0].distance - 0.1) < 1e-12);
  assert.equal(r.result.differences[0].units, 'cm');
  assert.throws(() => offlineResult(prepare('placement.check', { ...data, observed: { poses: [{ id: 'o', transform: pose('1 cm', 'parent') }] } })), /frame mismatch/);
  assert.equal(offlineResult(prepare('placement.check', { ...data, observed: { poses: [] } })).status, 'unknown');
});

test('COTS replacement checks model hashes and preserves multiple datum frames without scaling', () => {
  const file = source('new.step', 'ISO-10303-21;\nEND-ISO-10303-21;\n');
  const data = structuredClone(descriptors['cots.replace'].example);
  data.model.path = file;
  data.datumMap = [{ name: 'mount', old: pose('10 mm', 'component'), new: pose('2 mm', 'component') },
    { name: 'lens', old: pose('20 mm', 'component'), new: pose('12 mm', 'component') }];
  const p = prepare('cots.replace', data);
  assert.ok(Math.abs(p.result.delta[3] - 0.8) < 1e-12);
  assert.equal(p.result.model.representation, 'envelope'); assert.equal(p.result.mass, null);
  assert.ok(p.unresolved.some(r => r.field === 'replacement.mass'));
  assert.throws(() => prepare('cots.replace', { ...data, model: { ...data.model, sha256: '0'.repeat(64) } }), /SHA256/);
  data.datumMap[1].new = pose('11 mm', 'component');
  assert.throws(() => prepare('cots.replace', data), /inconsistent/);
});

test('generic 145-ID/36-model data fixture: counts are inputs, not implementation constants', () => {
  const file = source('fixture-envelope.step', 'ISO-10303-21;\nEND-ISO-10303-21;\n');
  const records = Array.from({ length: 145 }, (_, i) => item(`generic_${i}`, i < 36 ? { model: { path: file, representation: 'envelope', status: 'ESTIMATED', source: 'synthetic file, not kernel fixture' } } : {}));
  const result = prepare('catalog.check', adapter(records));
  assert.deepEqual(result.result.counts, { ids: 145, models: 36, instances: 145 });
  assert.deepEqual(prepare('catalog.check', adapter(records.slice(0, 7))).result.counts, { ids: 7, models: 7, instances: 7 });
});

test('functional-group labels resolve separately from the rigid parent (CWG pattern)', () => {
  const catalog = source('cwg-catalog.json', JSON.stringify([
    { id: 'P001', name: 'base_chassis', qty: 1, parent: 'BASE', type: 'Custom', path: 'parts/P001.md' },
    { id: 'P035', name: 'motor_pinion', qty: 3, parent: 'PAN;TILT;SHOT', type: 'Custom', path: 'parts/P035.md' },
    { id: 'C003', name: 'gearmotor', qty: 3, parent: 'PAN', type: 'COTS', path: 'cots/C003.md' },
  ]));
  const schema = { columns: { id: 'id', name: 'name', kind: 'type', quantity: 'qty', functionalGroups: 'parent', source: 'path' },
    values: { kind: { Custom: 'part', COTS: 'purchased' } }, defaults: { status: 'OPEN', parent: null } };
  const p = prepare('catalog.check', { version: 1, source: catalog, schema });
  assert.equal(p.result.counts.ids, 3);
  const byId = new Map(p.result.items.map(r => [r.id, r]));
  assert.deepEqual(byId.get('P001').functionalGroups, ['BASE']);
  assert.deepEqual(byId.get('P035').functionalGroups, ['PAN', 'TILT', 'SHOT']);
  assert.deepEqual(byId.get('C003').functionalGroups, ['PAN']);
  assert.ok(p.result.items.every(r => r.parent === null));
  // The same source column mapped to the rigid parent still fails loudly: a
  // functional label is never silently promoted to a physical parent.
  assert.throws(() => prepare('catalog.check', { version: 1, source: catalog,
    schema: { columns: { id: 'id', name: 'name', quantity: 'qty', parent: 'parent' }, defaults: { kind: 'part', status: 'OPEN' } } }), /Unknown catalog parent/);
});

test('scalar model path maps to an envelope model; non-path placeholders carry no model', () => {
  const step = source('cwg-envelope.step', 'ISO-10303-21;\nEND-ISO-10303-21;\n');
  const catalog = source('cwg-model.json', JSON.stringify([
    { id: 'C001', name: 'esp32', qty: 8, type: 'COTS', path: 'cots/C001.md', cad: 'cwg-envelope.step' },
    { id: 'C002', name: 'camera', qty: 9, type: 'COTS', path: 'cots/C002.md', cad: 'cwg-envelope.step' },
    { id: 'P001', name: 'base_chassis', qty: 1, type: 'Custom', path: 'parts/P001.md', cad: 'Do utworzenia w Fusion' },
  ]));
  const schema = { columns: { id: 'id', name: 'name', kind: 'type', quantity: 'qty', source: 'path', model: 'cad' },
    values: { kind: { Custom: 'part', COTS: 'purchased' } }, defaults: { status: 'OPEN', parent: null } };
  const p = prepare('catalog.check', { version: 1, source: catalog, baseDir: directory, schema });
  assert.equal(p.result.counts.ids, 3);
  assert.equal(p.result.counts.models, 2); // derived from the source, not a constant
  const byId = new Map(p.result.items.map(r => [r.id, r]));
  assert.equal(byId.get('C001').model.representation, 'envelope');
  assert.ok(byId.get('C001').model.path.endsWith('cwg-envelope.step'));
  assert.match(byId.get('C001').model.sha256, /^[a-f0-9]{64}$/);
  assert.equal(byId.get('P001').model, null);
  assert.equal(step, path.join(directory, 'cwg-envelope.step'));
});

test('native handoff generator creates only new offline inputs, never fake STEP geometry or overwritten evidence', () => {
  const out = path.join(directory, 'handoff');
  const result = require('./data_import-fixtures').generate(out);
  assert.equal(result.nativeExecuted, false);
  assert.equal(fs.existsSync(path.join(out, 'old.step')), false);
  assert.throws(() => require('./data_import-fixtures').generate(out), /EEXIST/);
  const input = JSON.parse(fs.readFileSync(path.join(out, 'replace-board-preserve.json'), 'utf8'));
  assert.equal(prepare('cots.replace', input).result.childrenPolicy, 'preserve');
  const csvInput = JSON.parse(fs.readFileSync(path.join(out, 'param-csv.json'), 'utf8'));
  assert.equal(prepare('param.import', csvInput).result.parameters[1].unit, '');
});

test('generated adapter request compiles, carries normalized model paths, and passes document identity at execution', () => {
  const script = buildCadScript('catalog.import', adapter([item('a')]), { doc: 'Fixture', docId: 'creation', docFileId: 'cloud' });
  const result = spawnSync('python3', ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: script, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(script, /ctx.assert_identity\(\)/);
  assert.equal(require('./helpers/legacy').scriptConfig(script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST.docFileId, 'cloud');
});
