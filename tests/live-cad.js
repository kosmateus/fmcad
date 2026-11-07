// Opt-in real-kernel test. Never included in the offline *.test.js suite.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('./helpers/live-broker');
const { catalog } = require('../src/cad');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_CAD_TEST_' + new Date().toISOString().replace(/[:.]/g, '_');
const { fixture } = require('./helpers/live-broker');
fixture(name);
const reportPath = path.join(__dirname, 'live-cad-report.json');
const report = { name, startedAt: new Date().toISOString(), catalogCount: Object.keys(catalog).length,
  backend: require('../src/config').loadConfig({}).cfg.backend,
  scope: 'Live local integrated commands only; no cloud mutations or user-document edits',
  numericTolerance: { lengthMm: 0.001, volumeRelative: 0.00001 },
  commands: [], tests: [], measurements: [], files: [], ownedDocuments: [], remainingDocuments: 'unknown' };
let baseline;
let identity;
let currentGroup;
const tested = new Set();
const shapes = {};
function persist() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
function cli(args, expectedError) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '60000'], {
    cwd: root, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  const row = { group: currentGroup, args, outcome: 'failed', status: result.status, stdout: result.stdout,
    stderr: result.stderr, error: result.error?.message, expectedError: expectedError?.source };
  report.commands.push(row);
  persist();
  if (expectedError) {
    assert.notEqual(result.status, 0, 'Expected command rejection');
    assert.match((result.stderr || '') + (result.stdout || ''), expectedError);
    row.outcome = 'expected-error';
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  row.outcome = 'passed';
  return result.stdout;
}
function script(body, readOnly = true) {
  const source = 'import adsk.core, adsk.fusion, json, tempfile, os\n\ndef run(_context: str):\n' +
    body.split('\n').map(s => '    ' + s).join('\n');
  const text = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { readOnly, script: source } })]);
  const line = text.split(/\r?\n/).find(s => s.startsWith('LIVE_CAD '));
  assert.ok(line, text);
  return JSON.parse(line.slice(9));
}
function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents if _fmcad_live_visible(d)]
print('LIVE_CAD ' + json.dumps({"documents": docs, "tempDir": tempfile.gettempdir(), "tempExists": os.path.isdir(tempfile.gettempdir())}))`);
}
function guard(target = identity) {
  assert.ok(target, 'No verified owned identity');
  const now = state();
  assert.equal(now.documents.filter(d => d.name === target.name).length, 1, 'Ambiguous target name');
  const found = now.documents.find(d => d.name === target.name);
  assert.equal(found.creationId, target.creationId, 'Owned identity changed');
  assert.equal(found.saved, false, 'Owned document unexpectedly cloud-saved');
  return now;
}
function cad(op, data = {}, component, expectedError, target = identity, spelling) {
  assert.ok(catalog[op], 'Unknown test operation ' + op);
  if (!catalog[op].readOnly) guard(target);
  tested.add(op);
  const args = [...(spelling || op.replaceAll('.', ' ')).split(' '), '--doc', target.name,
    '--data', JSON.stringify(data), '--json'];
  if (component) args.push('--component', component);
  const text = cli(args, expectedError);
  if (expectedError) return;
  const out = JSON.parse(text);
  report.commands.at(-1).parsed = out;
  assert.equal(out.success, true);
  assert.equal(out.document, target.name);
  persist();
  return out.result;
}
function group(label, fn, enabled = true) {
  currentGroup = label;
  if (!enabled) {
    report.tests.push({ name: label, status: 'not-tested', reason: 'Dependent prerequisite failed' });
    persist();
    return false;
  }
  try {
    fn();
    report.tests.push({ name: label, status: 'passed' });
    console.log('PASS ' + label);
    persist();
    return true;
  } catch (error) {
    report.tests.push({ name: label, status: 'failed', error: error.message, stack: error.stack,
      lastCommandIndex: report.commands.length - 1, dependentSequence: 'stopped at first failure' });
    console.error('FAIL ' + label + ': ' + error.message);
    persist();
    if (identity) {
      try { report.tests.at(-1).afterFailureAudit = cad('audit'); }
      catch (diagnostic) { report.tests.at(-1).diagnosticError = diagnostic.message; }
    }
    persist();
    return false;
  }
}
function closeOwned(target) {
  guard(target);
  const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(target.name)} and d.creationId == ${JSON.stringify(target.creationId)}]
assert len(matches) == 1, 'Owned document identity ambiguous; leave open'
doc = matches[0]
assert not doc.isSaved, 'Unexpected saved document; leave open'
assert doc.close(False), 'Owned close failed'
print('LIVE_CAD ' + json.dumps({"closedCreationId": ${JSON.stringify(target.creationId)}}))`, false);
  assert.equal(result.closedCreationId, target.creationId);
  if (target.creationId === identity.creationId) fixture(name);
  assert.ok(!state().documents.some(d => d.creationId === target.creationId));
}
function near(actual, expected, tolerance, label) {
  const row = { group: currentGroup, label, actual, expected, tolerance,
    status: Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance ? 'passed' : 'failed' };
  report.measurements.push(row);
  persist();
  assert.equal(row.status, 'passed', JSON.stringify(row));
}
function physical(body, size, volume, component, target = identity) {
  const bounds = cad('measure.bounds', { ref: body, units: 'mm' }, component, null, target);
  assert.equal(bounds.units, 'mm');
  bounds.size.forEach((v, i) => near(v, size[i], 0.001, 'bounds ' + 'xyz'[i] + ' mm'));
  const measured = cad('measure.volume', { ref: body, units: 'mm3' }, component, null, target);
  assert.equal(measured.units, 'mm3');
  near(measured.value, volume, Math.max(0.001, volume * 0.00001), 'volume mm3');
}
function count(component, kind, expected) {
  const entities = cad('entity.list', { kind }, component).entities;
  assert.equal(entities.length, expected, `${component} ${kind} count`);
  return entities;
}
function params(values, overwrite = false) {
  return cad('param.apply', { parameters: Object.entries(values).map(([name, expression]) => ({ name, expression, unit: 'mm' })), overwrite });
}
function regenerate() { assert.equal(cad('history.recompute').healthy, true); }

const initialized = group('doc new and creationId ownership', () => {
  baseline = state();
  report.before = baseline;
  assert.ok(!baseline.documents.some(d => d.name === name));
  cli(['doc', 'new', '--name', name]);
  const after = state();
  const added = after.documents.filter(d => !baseline.documents.some(b => b.creationId === d.creationId));
  assert.equal(added.length, 1);
  assert.equal(added[0].name, name);
  identity = { name, creationId: added[0].creationId };
  fixture(name, identity.creationId);
  report.ownedDocuments.push(identity);
  assert.equal(guard().documents.find(d => d.creationId === identity.creationId).active, true);
  assert.equal(cad('audit').counts.bodyDefinitions, 0);
});

group('parameter apply and offset datum', () => {
  params({ datum_offset: '5 mm' });
  const plane = cad('datum.plane', { name: 'TestOffset', plane: 'XY', mode: 'offset', offset: 'datum_offset' });
  near(cad('entity.inspect', { ref: plane }).geometry.origin[2], 0.5, 1e-7, 'datum z cm');
  params({ datum_offset: '8 mm' }, true);
  regenerate();
  near(cad('entity.inspect', { ref: plane }).geometry.origin[2], 0.8, 1e-7, 'regenerated datum z cm');
  count('root', 'plane', 1);
}, initialized);

for (const kind of ['box', 'tube', 'cylinder', 'cone']) {
  shapes[kind] = { component: 'Test_' + kind };
  shapes[kind].ok = group('shape.' + kind + ' physical geometry and parameter regeneration', () => {
    const component = shapes[kind].component;
    cad('component.create', { name: component });
    count(component, 'body', 0);
    const p = kind + '_';
    params({ [p + 'h']: '20 mm', [p + 'w']: '40 mm', [p + 'd']: '30 mm', [p + 'r']: '10 mm', [p + 'i']: '6 mm', [p + 't']: '5 mm' });
    const data = { name: 'Solid_' + kind, height: p + 'h' };
    if (kind === 'box') Object.assign(data, { width: p + 'w', depth: p + 'd' });
    if (kind === 'cylinder') data.radius = p + 'r';
    if (kind === 'tube') Object.assign(data, { outerRadius: p + 'r', innerRadius: p + 'i' });
    if (kind === 'cone') Object.assign(data, { baseRadius: p + 'r', topRadius: p + 't' });
    const made = cad('shape.' + kind, data, component);
    assert.equal(made.bodies.length, 1);
    const body = made.bodies[0];
    shapes[kind].body = body;
    function verify(h, w, d, r, i, t) {
      const volume = kind === 'box' ? w * d * h : kind === 'tube' ? Math.PI * (r*r-i*i)*h :
        kind === 'cone' ? Math.PI*h*(r*r+r*t+t*t)/3 : Math.PI*r*r*h;
      physical(body, kind === 'box' ? [w,d,h] : [2*r,2*r,h], volume, component);
      if (kind !== 'box') {
        for (const radius of kind === 'tube' ? [r,i] : kind === 'cone' ? [r,t] : [r]) {
          const refs = cad('entity.find', { kind: kind === 'cone' ? 'edge' : 'face', filters: {
            geometry: kind === 'cone' ? 'circle' : 'cylinder', radius: radius + ' mm' } }, component).entities;
          assert.equal(refs.length, 1);
          near(cad('measure.radius', { ref: refs[0], units: 'mm' }, component).value, radius, 0.001, 'analytic radius mm');
        }
      }
      count(component, 'body', 1);
    }
    verify(20,40,30,10,6,5);
    params({ [p+'h']: '25 mm', [p+'w']: '50 mm', [p+'d']: '35 mm', [p+'r']: '12 mm', [p+'i']: '7 mm', [p+'t']: '6 mm' }, true);
    regenerate();
    verify(25,50,35,12,7,6);
  }, initialized);
}

const sketchOK = group('sketch geometry dimension refs and extrude regeneration', () => {
  const component = 'Test_sketch';
  cad('component.create', { name: component });
  params({ sketch_r: '8 mm', sketch_h: '12 mm' });
  const sketch = cad('sketch.create', { name: 'CircleSection', plane: 'XY' }, component).sketch;
  const circle = cad('sketch.geometry', { sketch, geometry: [{ type: 'circle', name: 'circle', center: ['0 mm','0 mm','0 mm'], radius: 'sketch_r' }] }, component).refs.circle;
  cad('sketch.dimension', { sketch, type: 'radius', entities: [circle], text: ['12 mm','12 mm','0 mm'], expression: 'sketch_r' }, component);
  const profiles = cad('sketch.inspect', { sketch }, component).profiles;
  assert.equal(profiles.length, 1);
  const made = cad('model.extrude', { name: 'ExplicitExtrude', profile: profiles[0].ref, distance: 'sketch_h' }, component);
  physical(made.bodies[0], [16,16,12], Math.PI*64*12, component);
  params({ sketch_r: '9 mm', sketch_h: '15 mm' }, true);
  regenerate();
  physical(made.bodies[0], [18,18,15], Math.PI*81*15, component);
  count(component, 'body', 1);
}, initialized);

group('bare revolve alias with explicit profile and axis refs', () => {
  const component = 'Test_revolve';
  cad('component.create', { name: component });
  params({ revolve_r: '4 mm', revolve_h: '10 mm' });
  const sketch = cad('sketch.create', { name: 'RevolveSection', plane: 'XY' }, component).sketch;
  const lines = cad('sketch.geometry', { sketch, geometry: [{ type: 'rectangle', name: 'section', start: ['0 mm','0 mm','0 mm'], end: ['revolve_r','revolve_h','0 mm'] }] }, component).refs.section;
  const inspected = cad('sketch.inspect', { sketch }, component);
  assert.equal(inspected.profiles.length, 1);
  for (const [line, expression, orientation] of [[lines[0], 'revolve_r', 'horizontal'], [lines[1], 'revolve_h', 'vertical']]) {
    cad('sketch.dimension', { sketch, type: 'distance', entities: [{ entity: line, point: 'start' }, { entity: line, point: 'end' }], text: ['12 mm','12 mm','0 mm'], expression, orientation }, component);
  }
  const profile = cad('sketch.inspect', { sketch }, component).profiles[0].ref;
  const axis = cad('entity.inspect', { ref: 'Y' }, component);
  const made = cad('model.revolve', { name: 'ExplicitRevolve', profile, axis, angle: '360 deg' }, component, null, identity, 'revolve');
  physical(made.bodies[0], [8,10,8], Math.PI*16*10, component);
  count(component, 'body', 1);
}, initialized);

group('seed hole circular pattern physical volume and count', () => {
  const component = 'Test_pattern';
  cad('component.create', { name: component });
  const body = cad('shape.cylinder', { name: 'Plate', radius: '20 mm', height: '5 mm' }, component).bodies[0];
  const plane = cad('datum.plane', { name: 'PlateTop', offset: '5 mm' }, component);
  const sketch = cad('sketch.create', { name: 'HoleSeed', plane }, component).sketch;
  const point = cad('sketch.geometry', { sketch, geometry: [{ type: 'point', name: 'seed', point: ['10 mm','0 mm','0 mm'] }] }, component).refs.seed;
  const hole = cad('model.hole', { name: 'SeedHole', points: [point], diameter: '4 mm', depth: '10 mm', participants: [body] }, component);
  physical(body, [40,40,5], Math.PI*(400-4)*5, component);
  cad('pattern.circular', { name: 'FourHoles', entities: [hole.feature], axis: 'Z', quantity: 4, angle: '360 deg' }, component);
  regenerate();
  physical(body, [40,40,5], Math.PI*(400-16)*5, component);
  assert.equal(cad('entity.find', { kind: 'face', filters: { geometry: 'cylinder', radius: '2 mm' } }, component).count, 4);
  count(component, 'body', 1);
}, initialized);

group('fillet found and resolved circular edge', () => {
  const { component, body } = shapes.cylinder;
  const edge = cad('entity.find', { kind: 'edge', filters: { geometry: 'circle', radius: '12 mm', position: ['0 mm','0 mm','25 mm'] }, unique: true }, component);
  const resolved = cad('entity.inspect', { ref: edge }, component);
  const before = cad('measure.volume', { ref: body }, component).value;
  cad('model.fillet', { name: 'TopRound', edges: [resolved], radius: '1 mm', tangentChain: false }, component);
  regenerate();
  const after = cad('measure.volume', { ref: body }, component).value;
  assert.ok(after < before && after > before * 0.95, 'Fillet must remove a small positive volume');
  cad('measure.bounds', { ref: body }, component).size.forEach((v,i) => near(v, [24,24,25][i], 0.001, 'fillet bounds mm'));
  count(component, 'body', 1);
}, shapes.cylinder.ok);

group('assembly linked occurrence shares definition and measured placement', () => {
  const { component, body } = shapes.box;
  const before = cad('audit');
  const added = cad('occurrence.add', { component, copyMode: 'linked', placement: { translation: ['100 mm','0 mm','0 mm'] } });
  const after = cad('audit');
  assert.equal(after.counts.bodyDefinitions, before.counts.bodyDefinitions);
  assert.equal(after.counts.componentDefinitions, before.counts.componentDefinitions);
  assert.equal(after.counts.occurrences, before.counts.occurrences + 1);
  const inspected = cad('component.inspect', { component });
  assert.equal(added.component.token, inspected.component.token);
  const proxy = { ...body, occurrence: added.occurrence };
  const bounds = cad('measure.bounds', { ref: proxy });
  near(bounds.min[0], 100, 0.001, 'linked occurrence min x mm');
  physical(proxy, [50,35,25], 50*35*25);
}, shapes.box.ok);

group('expected unknown field and invalid units preserve entity counts', () => {
  for (const [op, data, error] of [
    ['shape.box', { name: 'RejectUnknown', width: '1 mm', depth: '1 mm', height: '1 mm', unexpected: true }, /Unknown CAD inputs: unexpected/],
    ['shape.cylinder', { name: 'RejectUnits', radius: '2 deg', height: '5 mm' }, /Invalid or incompatible expression/],
  ]) {
    const before = cad('audit');
    cad(op, data, 'root', error);
    const after = cad('audit');
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(after.components, before.components);
  }
}, initialized);

group('expected ambiguous body rejects without duplicate entities', () => {
  const component = 'Test_ambiguity';
  cad('component.create', { name: component });
  const first = cad('shape.box', { name: 'First', width: '2 mm', depth: '3 mm', height: '4 mm' }, component).bodies[0];
  const second = cad('shape.box', { name: 'Second', width: '3 mm', depth: '4 mm', height: '5 mm' }, component).bodies[0];
  assert.notEqual(first.name, second.name);
  const aliased = cad('entity.alias', { ref: first, alias: second.name }, component);
  assert.equal(aliased.alias, second.name, 'Unicode alias must exactly round-trip');
  const before = cad('audit');
  cad('measure.bounds', { ref: { name: second.name, kind: 'body' } }, component, /expected one match, found 2/);
  const after = cad('audit');
  assert.deepEqual(after.counts, before.counts);
  assert.deepEqual(after.components, before.components);
  count(component, 'body', 2);
}, initialized);

const audited = group('full audit and recomputed timeline health', () => {
  regenerate();
  report.finalAudit = cad('audit');
  assert.deepEqual(report.finalAudit.issues, []);
}, initialized);

const exportedOK = group('local checkpoint and native export', () => {
  const now = guard();
  assert.equal(now.tempExists, true);
  const windows = path.win32;
  assert.ok(windows.isAbsolute(now.tempDir), 'Expected a Fusion Windows absolute temp path');
  for (const [operation, suffix] of [['checkpoint.create', 'checkpoint'], ['export.native', 'native']]) {
    const filename = windows.join(now.tempDir, name + '_' + suffix + '.f3d');
    const mapped = filename.replace(/^([A-Za-z]):\\/, (_, drive) => '/mnt/' + drive.toLowerCase() + '/').replaceAll('\\', '/');
    const exists = cad('export.verify', { path: filename });
    assert.equal(exists.exists, false, 'Never overwrite existing output');
    const exported = cad(operation, { path: filename });
    assert.ok(exported.exists && exported.bytes > 0);
    report.files.push({ fusionPath: filename, wslMapping: mapped, localMappingExists: fs.existsSync(mapped), bytes: exported.bytes, owned: true });
    assert.ok(cad('checkpoint.inspect', { path: filename }).bytes > 0);
    guard();
  }
}, audited);

group('owned reimport verification (opt-in isolated risk)', () => {
  for (const file of report.files.filter(f => f.owned)) {
    const before = state();
    const verified = cad('export.verify', { path: file.fusionPath, reimport: true, ref: 'root', lengthTolerance: '0.001 mm' });
    assert.equal(verified.reimported, true);
    assert.equal(verified.comparison.withinTolerance, true);
    assert.deepEqual(state().documents, before.documents, 'Verification must close only its temporary import');
  }
  const source = cad('audit');
  const sourceVolume = cad('measure.volume', { ref: 'root', units: 'mm3' }).value;
  const sourceBounds = cad('measure.bounds', { ref: 'root', units: 'mm' });
  const opened = cad('checkpoint.open', { path: report.files[0].fusionPath });
  const target = opened.document;
  assert.ok(!baseline.documents.some(d => d.creationId === target.creationId));
  assert.notEqual(target.creationId, identity.creationId);
  report.ownedDocuments.push(target);
  guard(target);
  const imported = cad('audit', {}, null, null, target);
  assert.deepEqual(imported.counts, source.counts, 'Native reimport preserves definition/history counts');
  physical('root', sourceBounds.size, sourceVolume, null, target);
  assert.deepEqual(imported.issues, []);
  closeOwned(target);
}, exportedOK && process.env.FMCAD_LIVE_REIMPORT === '1');

group('close only creationId-verified owned test document', () => closeOwned(identity), !!identity);
group('existing documents preserved and owned documents accounted for', () => {
  const after = state();
  report.after = after;
  report.remainingDocuments = after.documents.filter(d => report.ownedDocuments.some(o => o.creationId === d.creationId));
  const userDocs = after.documents.filter(d => baseline.documents.some(b => b.creationId === d.creationId));
  assert.deepEqual(userDocs, baseline.documents);
  assert.deepEqual(report.remainingDocuments, []);
}, !!baseline);
report.notTestedOperations = Object.keys(catalog).filter(op => !tested.has(op));
report.notTestedFamilies = [...new Set(report.notTestedOperations.map(op => op.split('.')[0]))];
report.coverageNote = 'An invoked operation is not all modes tested. See failed/stopped sequences and not-tested operations; no claim of all catalog commands or manufacturing acceptance.';
report.finishedAt = new Date().toISOString();
persist();
console.log('REPORT ' + reportPath);
process.exitCode = report.tests.some(t => t.status === 'failed') ? 1 : 0;
