// Opt-in real Fusion CLI suite. Run alone, after all other live suites finish.
// No imports, reimports, checkpoint opens, cloud saves, mocks, or global undo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_EXT_' + randomUUID().replaceAll('-', '_');
const { fixture } = require('./helpers/live-broker');
fixture(name);
const reportPath = path.join(__dirname, 'live-extended-report.json');
const report = {
  name, startedAt: new Date().toISOString(), tests: [], commands: [], measurements: [],
  guards: [], files: [], ownedDocuments: [], remainingDocuments: 'unknown',
  tolerances: { lengthMm: 0.001, volumeRelative: 0.00001, cameraInternal: 0.00001 },
  scope: 'Sequential real CLI commands in one new unsaved creationId-verified document; run exclusively.',
  limitations: [
    'CLI document selection is name-based. Fresh creationId checks are not an interprocess lock; never run alongside another suite or edit Fusion during this run.',
    'Groups have independent components and names, but share design-wide timeline health. An unhealthy failed group can affect later recompute/parameter tests.',
    'An empty, malformed-success, or indeterminate transport result latches a stop on ALL subsequent Fusion mutations, including cleanup. Inspect reported leftovers manually; no automatic retries.',
    'Other documents are observed for identity/name/saved/modified changes, never activated, saved, edited or closed explicitly. Native new/close changes active-document selection.',
    'Analytic fixture checks are not manufacturing acceptance or exhaustive coverage of every operation mode.',
  ],
  coverageGaps: [
    'Import, reimport and checkpoint.open deliberately excluded while the primary suite diagnoses MCP lifecycle issues.',
    'Sweep guide/twist/taper variants, loft continuity/closed variants, outside shell, draft reverse/symmetric and non-body pattern selections are not exercised.',
    'Generated slot cut/join/intersect and existing-profile alternatives are not exercised; generated newBody geometry is checked.',
    'Bolt-circle depth regeneration uses through-cut material; hole-tip depth geometry is not certified.',
    'Slider/cylindrical joints, motion limits, continuous collision and nested assemblies are not exercised.',
    'Style coverage is appearance.list/material.list, not assignments. Shot files are checked as PNGs, not pixel-equivalent renderings.',
  ],
};
let identity;
let baseline;
let stopped;
let current;
let component;
let batchDirectory;
const attempted = new Set();
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, (_, value) => value instanceof Set ? [...value] : value, 2) + '\n');

function stop(reason) {
  stopped ||= reason;
  report.mutationStop = stopped;
  persist();
  throw new Error(stopped);
}

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '60000'], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const row = { group: current?.name, args, exitCode: result.status, stdout: result.stdout || '',
    stderr: result.stderr || '', error: result.error?.message, status: 'fail' };
  report.commands.push(row);
  persist();
  // Broker receipts contain fields such as timeoutMs even on success. Keep the
  // full evidence above, but do not classify metadata as a transport timeout.
  const text = row.stdout + row.stderr.split(/\r?\n/)
    .filter(line => !line.startsWith('FMCAD_QUEUE_') && !line.startsWith('QUEUE ')).join('\n');
  if (result.error || result.signal || result.status === null || !text.trim() ||
      /empty response|timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|MCP_ERROR|HTTP [45]\d\d/i.test(text)) {
    stop('Indeterminate CLI execution; no further mutations: ' + (row.error || text || 'empty result'));
  }
  // executeCad strips the missing FMCAD_RESULT marker into this error; do not
  // mistake an empty successful script return for an isolated kernel rejection.
  const scriptTail = text.includes('Inspect before retry.') ? text.split('Inspect before retry.').slice(1).join('Inspect before retry.').trim() : undefined;
  const substantiveTail = scriptTail?.split(/\r?\n/).filter(line => !line.startsWith('FMCAD_PROGRESS ')).join('\n').trim();
  const explicitScriptFailure = /Traceback|[A-Za-z]+Error:|Exception:|\bERROR\b|script execution failed/i.test(substantiveTail || '');
  if ((scriptTail !== undefined && !explicitScriptFailure) || /empty script|no script result/i.test(text)) {
    stop('Empty script result; no further mutations: ' + text);
  }
  return row;
}

function script(body, readOnly = true) {
  if (!readOnly && stopped) throw new Error(stopped);
  const source = 'import adsk.core, adsk.fusion, json, os, tempfile\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_EXT '));
  if (lines.length !== 1) stop('Probe/lifecycle script has no unambiguous JSON result; no further mutations. See command ' + (report.commands.length - 1));
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_EXT '.length)); }
  catch { stop('Malformed probe/lifecycle JSON; no further mutations'); }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  row.parsed = value;
  row.status = 'pass';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents if _fmcad_live_visible(d)]
print('LIVE_EXT ' + json.dumps({"documents": docs, "tempDir": tempfile.gettempdir(), "tempExists": os.path.isdir(tempfile.gettempdir())}))`);
}

function unchangedOthers(now) {
  const stable = docs => docs.map(({ active, ...doc }) => doc).sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));
  assert.deepEqual(stable(now.documents.filter(d => d.creationId !== identity?.creationId)), stable(baseline.documents),
    'Non-fixture document set or saved/modified/name state changed; refuse mutations');
}

function guard() {
  if (stopped) throw new Error(stopped);
  try {
    assert.ok(identity?.creationId, 'No verified owned creationId');
    const now = state();
    unchangedOthers(now);
    const matches = now.documents.filter(d => d.name === identity.name);
    assert.equal(matches.length, 1, 'Owned name ambiguous or missing');
    assert.equal(matches[0].creationId, identity.creationId, 'Owned name now refers to a different document');
    assert.equal(matches[0].saved, false, 'Fixture unexpectedly saved; do not discard it');
    assert.equal(matches[0].active, true, 'Fixture is not active; do not switch away from another document');
    report.guards.push({ group: current?.name, beforeCommandIndex: report.commands.length, ...matches[0] });
    persist();
    return now;
  } catch (error) { stop('Ownership verification failed: ' + error.message); }
}

function cad(operation, data = {}, scope = component || 'root', expectedFailure = false) {
  const spec = validateCad(operation, data);
  assert.ok(!['import.file', 'checkpoint.open'].includes(operation));
  assert.ok(!data.reimport, 'Reimport forbidden in this fixture');
  if (!spec.readOnly) guard();
  attempted.add(operation);
  current?.operations.add(operation);
  const row = cli([...operation.split('.'), '--doc', name, '--component', scope, '--data', JSON.stringify(data), '--json']);
  let output;
  try { output = JSON.parse(row.stdout); }
  catch {
    if (row.exitCode === 0) stop('CAD command returned no valid JSON despite success: ' + operation);
    throw new Error(operation + ': ' + (row.stderr || row.stdout));
  }
  row.parsed = output;
  if (!output || typeof output !== 'object' || !Object.keys(output).length) stop('Empty CLI JSON envelope: ' + operation);
  // A batch can embed an empty-result/timeout exception in otherwise valid JSON.
  for (const step of output.steps || []) {
    if (step.status === 'unknown') stop('Batch execution uncertain; no further mutations: ' + JSON.stringify(step));
  }
  assert.equal(output.operation, operation);
  if (!spec.nodeOnly) {
    assert.equal(output.document, name);
    if (!output.result || typeof output.result !== 'object' || !Object.keys(output.result).length) {
      stop('Empty CAD result object: ' + operation);
    }
  }
  assert.equal(row.exitCode, expectedFailure ? 1 : 0, row.stderr || row.stdout);
  assert.equal(output.success, !expectedFailure, row.stdout);
  row.status = 'pass';
  row.expectedFailure = expectedFailure;
  persist();
  return spec.nodeOnly ? output : output.result;
}

function test(label, operations, fn, { fixture = true, enabled = true, reason = 'Fixture initialization failed' } = {}) {
  const row = { name: label, status: 'not-tested', requestedOperations: operations, operations: new Set(), metrics: [] };
  report.tests.push(row);
  current = row;
  component = undefined;
  if (!enabled || stopped) {
    row.reason = stopped || reason;
    row.operations = [];
    row.notTestedOperations = operations;
    persist();
    return false;
  }
  try {
    if (fixture) {
      component = 'Ext_' + label.replace(/[^A-Za-z0-9_]/g, '_');
      row.component = component;
      cad('component.create', { name: component }, 'root');
    }
    fn();
    row.status = 'pass';
    console.log('PASS ' + label);
  } catch (error) {
    row.status = 'fail';
    row.error = error.message;
    row.stack = error.stack;
    row.lastCommandIndex = report.commands.length - 1;
    console.error('FAIL ' + label + ': ' + error.message);
  } finally {
    row.operations = [...row.operations];
    row.notTestedOperations = operations.filter(op => !row.operations.includes(op));
    persist();
  }
  return row.status === 'pass';
}

function near(actual, expected, tolerance, label) {
  const row = { group: current.name, label, commandIndex: report.commands.length - 1,
    actual, expected, tolerance, status: Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance ? 'pass' : 'fail' };
  current.metrics.push(label);
  report.measurements.push(row);
  persist();
  assert.equal(row.status, 'pass', JSON.stringify(row));
}
const mm = n => n + ' mm';
const xyz = (x = 0, y = 0, z = 0) => [x, y, z].map(mm);
const named = suffix => component + '_' + suffix;
function volume(ref, expected, scope = component) {
  const result = cad('measure.volume', { ref, units: 'mm3' }, scope);
  assert.equal(result.units, 'mm3');
  near(result.value, expected, Math.max(0.001, Math.abs(expected) * 0.00001), 'measure.volume ' + (ref.name || ref) + ' mm3');
}
function bounds(ref, size, min, scope = component) {
  const result = cad('measure.bounds', { ref, units: 'mm' }, scope);
  assert.equal(result.units, 'mm');
  size.forEach((v, i) => near(result.size[i], v, 0.001, 'measure.bounds size ' + 'xyz'[i] + ' mm'));
  if (min) min.forEach((v, i) => near(result.min[i], v, 0.001, 'measure.bounds min ' + 'xyz'[i] + ' mm'));
  return result;
}
function bodies(expected) {
  const found = cad('entity.list', { kind: 'body' }).entities;
  near(found.length, expected, 0, 'entity.list body count');
  return found;
}
function box(suffix, w = 20, d = 12, h = 10, plane) {
  return cad('shape.box', { name: named(suffix), width: typeof w === 'string' ? w : mm(w), depth: mm(d),
    height: typeof h === 'string' ? h : mm(h), ...(plane ? { plane } : {}) });
}
function plane(suffix, offset, base = 'XY') {
  return cad('datum.plane', { name: named(suffix), plane: base, mode: 'offset', offset: typeof offset === 'string' ? offset : mm(offset) });
}
function face(axis, position) {
  return cad('entity.find', { kind: 'face', filters: { geometry: 'plane', axis, position: xyz(...position) }, unique: true });
}
function circleProfile(suffix, radius, onPlane = 'XY') {
  const sketch = cad('sketch.create', { name: named(suffix), plane: onPlane }).sketch;
  cad('sketch.geometry', { sketch, geometry: [{ type: 'circle', name: named(suffix + '_circle'), center: xyz(), radius: mm(radius) }] });
  const profiles = cad('sketch.inspect', { sketch }).profiles;
  assert.equal(profiles.length, 1);
  return profiles[0].ref;
}
function linePath(suffix, onPlane, start, end) {
  const sketch = cad('sketch.create', { name: named(suffix), plane: onPlane }).sketch;
  const geometry = cad('sketch.geometry', { sketch, geometry: [{ type: 'line', name: named(suffix + '_line'), start, end }] });
  const made = cad('path.create', { curves: geometry.entities, chain: 'none', name: named(suffix + '_path') });
  assert.equal(cad('path.inspect', made.path).count, 1);
  return made.path;
}
function parameters(values, overwrite = false) {
  cad('param.apply', { parameters: Object.entries(values).map(([name, [expression, unit = 'mm']]) => ({ name, expression, unit })), overwrite }, 'root');
}
function recompute() {
  const result = cad('history.recompute');
  assert.equal(result.recomputed, true);
  assert.equal(result.healthy, true, JSON.stringify(result));
}

const initialized = test('new_document_ownership', [], () => {
  baseline = state();
  report.before = baseline;
  assert.ok(!baseline.documents.some(doc => doc.name === name));
  // Check the entire document set again inside creation, before touching anything.
  const created = script(`app = adsk.core.Application.get()
assert sorted([d.creationId for d in app.documents if _fmcad_live_visible(d)]) == sorted(${JSON.stringify(baseline.documents.map(d => d.creationId))}), 'Document set changed before creation'
assert not any(d.name == ${JSON.stringify(name)} for d in app.documents), 'Fixture name already exists'
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = ${JSON.stringify(name)}
print('LIVE_EXT ' + json.dumps({"name": doc.name, "creationId": doc.creationId, "saved": doc.isSaved}))`, false);
  assert.equal(created.name, name);
  assert.ok(created.creationId);
  assert.ok(!baseline.documents.some(doc => doc.creationId === created.creationId));
  identity = { name, creationId: created.creationId };
  fixture(name, identity.creationId);
  report.ownedDocuments.push(identity);
  guard();
  assert.equal(cad('audit').counts.bodyDefinitions, 0);
}, { fixture: false });

// Run design-wide health/restoration tests first so unrelated kernel failures in
// later groups cannot hide parameter.test's own restoration behavior.
test('section_thickness_check_parameter_restoration', ['measure.section', 'measure.thickness', 'check', 'parameter.test'], () => {
  const width = named('width');
  parameters({ [width]: ['20 mm'] });
  const body = box('block', width).bodies[0];
  const mid = plane('mid', 5);
  const section = cad('measure.section', { body, plane: mid, mode: 'curves', units: 'mm' });
  near(section.edgeCount, 4, 0, 'measure.section rectangle edge count');
  near(section.totalLength.value, 64, 0.001, 'measure.section perimeter mm');
  assert.equal(section.totalLength.units, 'mm');
  const thickness = { a: face([0, 0, 1], [0, 0, 0]), b: face([0, 0, 1], [0, 0, 10]), mode: 'parallelPlanes', units: 'mm' };
  near(cad('measure.thickness', thickness).value, 10, 0.001, 'measure.thickness parallel faces mm');
  const check = { id: named('volume_check'), source: '20 x 12 x 10 mm analytic fixture',
    measurement: { operation: 'measure.volume', data: { ref: body, units: 'mm3' } }, expected: '2400 mm^3', tolerance: '0.01 mm^3' };
  assert.equal(cad('check', check).passed, true);
  const before = cad('param.inspect', { names: [width] });
  for (const fail of [false, true]) {
    const result = cad('parameter.test', { parameter: width, expressions: ['22 mm', '25 mm'], confirm: true,
      checks: [{ ...check, expected: fail ? '1 mm^3' : width + ' * 12 mm * 10 mm' }] }, component, fail);
    assert.equal(result.passed, !fail);
    assert.equal(result.error, null);
    assert.equal(result.restored, true);
    assert.deepEqual(result.restoreErrors, []);
    assert.deepEqual(result.restoredHealth, result.baselineHealth);
    assert.equal(result.samples.length, 2);
    result.samples.forEach((sample, i) => {
      assert.equal(sample.checks[0].passed, !fail);
      near(sample.checks[0].actual.value, [22, 25][i] * 120, 0.01, 'parameter.test sample volume mm3');
    });
    assert.deepEqual(cad('param.inspect', { names: [width] }), before, 'parameter.test restores expression and value');
    volume(body, 2400);
    bounds(body, [20, 12, 10], [0, 0, 0]);
  }
}, { enabled: initialized });

test('sweep', ['model.sweep'], () => {
  // YZ section is normal to +X; the XY path starts at its center.
  const profile = circleProfile('section', 3, 'YZ');
  const route = linePath('route', 'XY', xyz(), xyz(20));
  const body = cad('model.sweep', { name: named('sweep'), profile, path: route, operation: 'newBody' }).bodies[0];
  volume(body, Math.PI * 9 * 20);
  bounds(body, [20, 6, 6], [0, -3, -3]);
  bodies(1);
}, { enabled: initialized });

test('loft', ['model.loft'], () => {
  const low = circleProfile('low', 8);
  const high = circleProfile('high', 4, plane('top', 15));
  const body = cad('model.loft', { name: named('loft'), profiles: [low, high], operation: 'newBody', closed: false }).bodies[0];
  volume(body, Math.PI * 15 * (64 + 32 + 16) / 3);
  bounds(body, [16, 16, 15], [-8, -8, 0]);
  bodies(1);
}, { enabled: initialized });

test('shell', ['model.shell'], () => {
  const body = box('block').bodies[0];
  cad('model.shell', { name: named('shell'), entities: [face([0, 0, 1], [0, 0, 10])], thickness: '2 mm', tangentChain: false });
  volume(body, 20 * 12 * 10 - 16 * 8 * 8);
  bounds(body, [20, 12, 10], [0, 0, 0]);
  bodies(1);
}, { enabled: initialized });

test('chamfer', ['model.chamfer'], () => {
  const body = box('block').bodies[0];
  const top = face([0, 0, 1], [0, 0, 10]);
  cad('model.chamfer', { name: named('chamfer'), edges: [top], distance: '1 mm', tangentChain: false });
  // Four equal-distance top-edge chamfers: integrate the inset rectangle over depth.
  const expected = t => 2400 - ((20 + 12) * t * t - 4 * t * t * t / 3);
  volume(body, expected(1));
  bounds(body, [20, 12, 10], [0, 0, 0]);
  bodies(1);
}, { enabled: initialized });

test('feature_edit_suppress', ['feature.list', 'feature.inspect', 'feature.edit', 'feature.suppress', 'feature.unsuppress'], () => {
  const height = named('height');
  parameters({ [height]: ['10 mm'] });
  const made = box('extrude', 20, 12, height);
  const body = made.bodies[0];
  const inspected = cad('feature.inspect', { feature: made.feature });
  assert.equal(inspected.feature.isSuppressed, false);
  const distances = inspected.parameters.filter(p => p.expression.replaceAll(' ', '') === height);
  assert.equal(distances.length, 1, 'Discover actual extrusion distance by its retained expression; never guess dN');
  const parameter = distances[0];
  assert.ok(parameter.unit);
  assert.ok(cad('feature.list').features.some(f => f.name === named('extrude')));
  cad('feature.edit', { feature: made.feature, name: named('edited'), parameters: { [parameter.name]: height + ' * 2' } });
  volume(body, 4800);
  bounds(body, [20, 12, 20], [0, 0, 0]);
  assert.equal(cad('feature.inspect', { feature: made.feature }).feature.name, named('edited'));
  let suppressed = false;
  try {
    const result = cad('feature.suppress', { feature: made.feature });
    suppressed = true;
    assert.equal(result.feature.isSuppressed, true);
    bodies(0);
  } finally {
    if (suppressed && !stopped) cad('feature.unsuppress', { feature: made.feature });
  }
  assert.equal(cad('feature.inspect', { feature: made.feature }).feature.isSuppressed, false);
  const restored = bodies(1)[0];
  volume(restored, 4800);
  bounds(restored, [20, 12, 20], [0, 0, 0]);
}, { enabled: initialized });

for (const operation of ['join', 'cut', 'intersect']) {
  test('combine_' + operation, ['model.combine'], () => {
    const target = box('target', 10, 10, 10).bodies[0];
    const tool = box('tool', 10, 10, 10, plane('offset', 5)).bodies[0];
    cad('model.combine', { name: named('boolean'), target, tools: [tool], operation, keepTools: false });
    const body = bodies(1)[0];
    volume(body, operation === 'join' ? 1500 : 500);
    bounds(body, [10, 10, operation === 'join' ? 15 : 5], [0, 0, operation === 'intersect' ? 5 : 0]);
  }, { enabled: initialized });
}

test('split', ['model.split'], () => {
  const body = box('block').bodies[0];
  cad('model.split', { name: named('split'), bodies: [body], tool: plane('mid', 4), extend: true });
  const pieces = bodies(2).map(ref => ({ ref, bounds: cad('measure.bounds', { ref, units: 'mm' }) })).sort((a, b) => a.bounds.min[2] - b.bounds.min[2]);
  pieces.forEach(({ ref }, i) => {
    volume(ref, 20 * 12 * [4, 6][i]);
    bounds(ref, [20, 12, [4, 6][i]], [0, 0, [0, 4][i]]);
  });
}, { enabled: initialized });

test('draft', ['model.draft'], () => {
  const body = box('block').bodies[0];
  const side = face([1, 0, 0], [20, 0, 0]);
  cad('model.draft', { name: named('draft'), faces: [side], plane: 'XY', angle: '5 deg', reverse: false, symmetric: false, tangentChain: false });
  const faces = cad('entity.list', { kind: 'face' }).entities;
  const candidates = faces.filter(f => f.geometry?.normal && Math.abs(f.geometry.normal[0]) > 0.9 && Math.abs(f.geometry.normal[2]) > 0.01);
  assert.equal(candidates.length, 1, 'One drafted planar side');
  const n = candidates[0].geometry.normal;
  // Signed slope comes from the measured normal, not a guessed Fusion draft sign.
  near(Math.abs(Math.atan(n[2] / n[0])) * 180 / Math.PI, 5, 0.001, 'model.draft side inclination deg');
  const delta = -10 * n[2] / n[0];
  volume(body, 12 * 10 * (20 + delta / 2));
  bounds(body, [20 + Math.max(0, delta), 12, 10], [0, 0, 0]);
  bodies(1);
}, { enabled: initialized });

for (const distanceType of ['spacing', 'extent']) {
  test('rectangular_' + distanceType, ['pattern.rectangular'], () => {
    const seed = box('seed', 2, 3, 4).bodies[0];
    cad('pattern.rectangular', { name: named('pattern'), entities: [seed], direction: 'X', quantity: 3,
      distance: distanceType === 'spacing' ? '10 mm' : '20 mm', distanceType,
      directionTwo: 'Y', quantityTwo: 2, distanceTwo: '12 mm' });
    const refs = bodies(6);
    refs.forEach(ref => {
      volume(ref, 24);
      bounds(ref, [2, 3, 4]);
    });
    const starts = refs.map(ref => cad('measure.bounds', { ref, units: 'mm' }).min).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const expected = [0, 10, 20].flatMap(x => [[x, 0, 0], [x, 12, 0]]);
    starts.forEach((p, i) => p.forEach((v, j) => near(v, expected[i][j], 0.001, 'pattern.rectangular instance ' + i + ' ' + 'xyz'[j] + ' mm')));
    volume(component, 144);
    bounds(component, [22, 15, 4], [0, 0, 0]);
  }, { enabled: initialized });

  test('path_pattern_' + distanceType, ['pattern.path'], () => {
    const seed = box('seed', 2, 3, 4).bodies[0];
    const route = linePath('route', 'XY', xyz(), xyz(40));
    cad('pattern.path', { name: named('pattern'), entities: [seed], path: route, quantity: 3,
      distance: distanceType === 'spacing' ? '10 mm' : '20 mm', distanceType });
    const refs = bodies(3);
    refs.forEach(ref => {
      volume(ref, 24);
      bounds(ref, [2, 3, 4]);
    });
    const starts = refs.map(ref => cad('measure.bounds', { ref, units: 'mm' }).min[0]).sort((a, b) => a - b);
    starts.forEach((v, i) => near(v, i * 10, 0.001, 'pattern.path instance x mm'));
    volume(component, 72);
  }, { enabled: initialized });
}

test('mirror', ['model.mirror'], () => {
  const seed = box('seed', 2, 3, 4).bodies[0];
  cad('model.mirror', { name: named('mirror'), entities: [seed], plane: plane('mirror_plane', 5, 'YZ') });
  const refs = bodies(2);
  refs.forEach(ref => volume(ref, 24));
  bounds(component, [10, 3, 4], [0, 0, 0]);
  const mins = refs.map(ref => cad('measure.bounds', { ref, units: 'mm' }).min[0]).sort((a, b) => a - b);
  mins.forEach((v, i) => near(v, [0, 8][i], 0.001, 'model.mirror instance min x mm'));
}, { enabled: initialized });

test('generated_slot_regeneration', ['shape.slot', 'param.apply', 'history.recompute'], () => {
  const p = suffix => named(suffix);
  parameters({ [p('length')]: ['30 mm'], [p('width')]: ['6 mm'], [p('height')]: ['3 mm'],
    [p('x')]: ['10 mm'], [p('y')]: ['-5 mm'], [p('z')]: ['2 mm'], [p('angle')]: ['0 deg', 'deg'] });
  const made = cad('shape.slot', { name: named('slot'), length: p('length'), width: p('width'), thickness: p('height'),
    position: [p('x'), p('y'), p('z')], angle: p('angle'), operation: 'newBody', symmetric: true });
  assert.equal(made.recipe, 'slot');
  assert.ok(made.slotGeometry.length >= 4);
  const body = bodies(1)[0];
  volume(body, ((30 - 6) * 6 + Math.PI * 9) * 3);
  bounds(body, [30, 6, 3], [-5, -8, 0.5]);
  parameters({ [p('length')]: ['40 mm'], [p('width')]: ['8 mm'], [p('height')]: ['4 mm'],
    [p('x')]: ['-7 mm'], [p('y')]: ['9 mm'], [p('z')]: ['-3 mm'], [p('angle')]: ['90 deg', 'deg'] }, true);
  recompute();
  volume(body, ((40 - 8) * 8 + Math.PI * 16) * 4);
  bounds(body, [8, 40, 4], [-11, -11, -5]);
  const caps = cad('entity.find', { kind: 'face', filters: { geometry: 'cylinder', radius: '4 mm' } }).entities;
  assert.equal(caps.length, 2);
  caps.forEach(ref => near(cad('measure.radius', { ref, units: 'mm' }).value, 4, 0.001, 'shape.slot regenerated cap radius mm'));
}, { enabled: initialized });

test('generated_bolt_circle_regeneration', ['shape.bolt_circle', 'param.apply', 'history.recompute'], () => {
  const p = suffix => named(suffix);
  parameters({ [p('pitch')]: ['20 mm'], [p('diameter')]: ['4 mm'], [p('depth')]: ['8 mm'],
    [p('phase')]: ['0 deg', 'deg'], [p('quantity')]: ['4', ''] });
  const plate = cad('shape.cylinder', { name: named('plate'), radius: '30 mm', height: '5 mm' }).bodies[0];
  const made = cad('shape.bolt_circle', { name: named('holes'), pitchDiameter: p('pitch'), diameter: p('diameter'),
    depth: p('depth'), phase: p('phase'), quantity: p('quantity'), participants: [plate], reverse: true });
  assert.equal(made.recipe, 'bolt_circle');
  assert.ok(made.seed.feature.token);
  function verify(pitch, diameter, quantity, phase) {
    volume(plate, Math.PI * (900 - quantity * diameter * diameter / 4) * 5);
    bounds(plate, [60, 60, 5], [-30, -30, 0]);
    const cylinders = cad('entity.find', { kind: 'face', filters: { geometry: 'cylinder', radius: mm(diameter / 2) } }).entities;
    assert.equal(cylinders.length, quantity);
    for (let i = 0; i < quantity; i++) {
      const angle = (phase + i * 360 / quantity) * Math.PI / 180;
      const found = cad('entity.find', { kind: 'face', filters: { geometry: 'cylinder', radius: mm(diameter / 2),
        axis: [0, 0, 1], position: xyz(pitch / 2 * Math.cos(angle), pitch / 2 * Math.sin(angle), 0) }, unique: true });
      near(cad('measure.diameter', { ref: found, units: 'mm' }).value, diameter, 0.001, 'shape.bolt_circle hole ' + i + ' diameter mm');
      const origin = found.geometry.origin;
      near(Math.hypot(origin[0], origin[1]) * 10, pitch / 2, 0.001, 'shape.bolt_circle hole axis pitch radius mm');
    }
    bodies(1);
  }
  verify(20, 4, 4, 0);
  parameters({ [p('pitch')]: ['30 mm'], [p('diameter')]: ['6 mm'], [p('depth')]: ['10 mm'],
    [p('phase')]: ['30 deg', 'deg'], [p('quantity')]: ['6', ''] }, true);
  recompute();
  verify(30, 6, 6, 30);
}, { enabled: initialized });

for (const type of ['rigid', 'revolute']) {
  test('joint_' + type, ['joint.' + type, 'joint.inspect', 'joint.edit', 'assembly.ground', 'assembly.unground', ...(type === 'revolute' ? ['joint.drive'] : [])], () => {
    const baseName = named('base');
    const armName = named('arm');
    const base = cad('component.create', { name: baseName }, 'root').occurrence;
    const arm = cad('component.create', { name: armName }, 'root').occurrence;
    cad('shape.box', { name: baseName + '_body', width: '4 mm', depth: '4 mm', height: '2 mm' }, baseName);
    const body = cad('shape.box', { name: armName + '_body', width: '20 mm', depth: '4 mm', height: '2 mm' }, armName).bodies[0];
    const proxy = { ...body, occurrence: arm };
    assert.equal(cad('assembly.ground', { occurrence: base }, 'root').grounded, true);
    const before = cad('measure.bounds', { ref: proxy, units: 'mm' }, 'root');
    const made = cad('joint.' + type, { name: named('joint'), occurrenceOne: base, occurrenceTwo: arm,
      ...(type === 'revolute' ? { point: 'origin', axis: 'Z' } : {}) }, 'root');
    assert.equal(made.asBuilt, true);
    assert.equal(made.type, type);
    assert.match(made.joint.objectType, /AsBuiltJoint$/);
    const after = cad('measure.bounds', { ref: proxy, units: 'mm' }, 'root');
    for (const field of ['min', 'max', 'size']) {
      before[field].forEach((value, i) => near(after[field][i], value, 0.001, 'joint.' + type + ' as-built ' + field + ' ' + 'xyz'[i] + ' mm'));
    }
    const joint = made.joint;
    const inspected = cad('joint.inspect', { joint }, 'root');
    assert.equal(inspected.motionType, type === 'rigid' ? 'RigidJointMotion' : 'RevoluteJointMotion');
    assert.equal(inspected.occurrences.length, 2);
    cad('joint.edit', { joint, name: named('renamed') }, 'root');
    assert.equal(cad('joint.inspect', { joint }, 'root').joint.name, named('renamed'));
    let suppressed = false;
    try {
      const result = cad('joint.edit', { joint, suppressed: true }, 'root');
      suppressed = true;
      assert.equal(result.joint.isSuppressed, true);
    } finally {
      if (suppressed && !stopped) cad('joint.edit', { joint, suppressed: false }, 'root');
    }
    assert.equal(cad('joint.inspect', { joint }, 'root').joint.isSuppressed, false);
    if (type === 'revolute') {
      try {
        const driven = cad('joint.drive', { joint, rotation: '90 deg' }, 'root');
        near(driven.rotationValue, Math.PI / 2, 0.00001, 'joint.drive actual radians');
        near(cad('joint.inspect', { joint }, 'root').rotationValue, Math.PI / 2, 0.00001, 'joint.inspect driven radians');
        // Sign depends on joint frame convention; a 90-degree turn must still
        // exchange the non-square arm's world X/Y extents, not just set a scalar.
        bounds(proxy, [4, 20, 2], undefined, 'root');
        volume(proxy, 160, 'root');
      } finally {
        if (!stopped) cad('joint.drive', { joint, rotation: '0 deg' }, 'root');
      }
      bounds(proxy, [20, 4, 2], [0, 0, 0], 'root');
    } else {
      bounds(proxy, [20, 4, 2], [0, 0, 0], 'root');
      volume(proxy, 160, 'root');
    }
    assert.equal(cad('assembly.unground', { occurrence: base }, 'root').grounded, false);
  }, { enabled: initialized });
}

test('assembly_interference_clearance', ['assembly.interference', 'assembly.clearance'], () => {
  const aName = named('a');
  const bName = named('b');
  const a = cad('component.create', { name: aName }, 'root').occurrence;
  const b = cad('component.create', { name: bName, placement: { translation: xyz(5) } }, 'root').occurrence;
  const refs = [aName, bName].map((scope, i) => ({ ...cad('shape.box', { name: scope + '_box', width: '10 mm', depth: '10 mm', height: '10 mm' }, scope).bodies[0], occurrence: [a, b][i] }));
  const data = { a: refs[0], b: refs[1] };
  const overlap = cad('assembly.interference', data, 'root', true);
  assert.equal(overlap.interferes, true);
  near(overlap.overlapVolume.value, 500, 0.001, 'assembly.interference overlap mm3');
  near(overlap.distance.value, 0, 0.001, 'assembly.interference overlapping distance mm');
  assert.equal(cad('assembly.clearance', { ...data, minimum: '1 mm' }, 'root', true).passed, false);
  cad('occurrence.transform', { occurrence: b, placement: { translation: xyz(13) } }, 'root');
  const clear = cad('assembly.clearance', { ...data, minimum: '2 mm' }, 'root');
  near(clear.distance.value, 3, 0.001, 'assembly.clearance separated distance mm');
  near(clear.overlapVolume.value, 0, 0.001, 'assembly.clearance no overlap mm3');
  assert.equal(clear.passed, true);
  assert.equal(cad('assembly.interference', data, 'root').interferes, false);
  assert.equal(cad('assembly.clearance', { ...data, minimum: '4 mm' }, 'root', true).passed, false);
  refs.forEach(ref => volume(ref, 1000, 'root'));
}, { enabled: initialized });

test('batch_run_and_failed_gate', ['batch.run', 'check'], () => {
  batchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), name + '_batch_'));
  report.batchDirectory = batchDirectory;
  const data = { name: named('batch_box'), width: '2 mm', depth: '3 mm', height: '4 mm' };
  const check = { id: named('batch_volume'), measurement: { operation: 'measure.volume', data: {
    ref: { $ref: 'seed.result.bodies.0' }, units: 'mm3' } }, expected: '24 mm^3', tolerance: '0.001 mm^3' };
  // Exactly one potential mutation per batch, guarded immediately before launch.
  const passed = cad('batch.run', { runId: named('pass'), reportPath: path.join(batchDirectory, 'pass'), operations: [
    { id: 'seed', operation: 'shape.box', data },
    { id: 'gate', operation: 'check', data: check },
  ] });
  assert.equal(passed.status, 'success');
  assert.deepEqual(passed.steps.map(step => step.status), ['success', 'success']);
  near(passed.steps[1].output.result.actual.value, 24, 0.001, 'batch.run resolved reference volume mm3');
  const body = bodies(1)[0];
  volume(body, 24);
  const before = cad('component.inspect');
  // Per-step failed-check output is the non-atomic contract; atomic rollback
  // reports this failure through step.error instead.
  const failed = cad('batch.run', { runId: named('fail'), reportPath: path.join(batchDirectory, 'fail'), atomic: false, operations: [
    { id: 'gate', operation: 'check', data: { ...check, measurement: { operation: 'measure.volume', data: { ref: body, units: 'mm3' } }, expected: '999 mm^3' } },
    { id: 'must_not_run', operation: 'shape.box', data: { ...data, name: named('FORBIDDEN') } },
  ] }, component, true);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.steps.map(step => step.status), ['failed', 'skipped']);
  assert.equal(failed.steps[0].output.operation, 'check');
  assert.equal(failed.steps[0].output.result.passed, false, 'Must fail the measured gate, not operation dispatch');
  near(failed.steps[0].output.result.actual.value, 24, 0.001, 'batch failed gate actual volume mm3');
  assert.equal(failed.steps[1].request, undefined, 'Next mutation must not even start');
  assert.equal(failed.steps[1].output, undefined);
  assert.deepEqual(cad('component.inspect'), before);
  assert.ok(!cad('feature.list').features.some(f => f.name === named('FORBIDDEN')));
  bodies(1);
  volume(body, 24);
}, { enabled: initialized });

function cameraEqual(actual, expected) {
  assert.deepEqual(actual.document, expected.document);
  assert.equal(actual.cameraType, expected.cameraType);
  assert.equal(actual.units, expected.units);
  for (const field of ['eye', 'target', 'up', 'extents']) {
    if (expected[field]) {
      assert.equal(actual[field].length, expected[field].length);
      expected[field].forEach((v, i) => near(actual[field][i], v, 0.00001, 'camera restored ' + field + '[' + i + '] internal units'));
    }
  }
  if (expected.perspectiveAngle !== undefined) near(actual.perspectiveAngle, expected.perspectiveAngle, 0.00001, 'camera restored perspective rad');
}

test('visibility', ['visibility.hide', 'visibility.show', 'visibility.restore', 'visibility.isolate'], () => {
  const first = box('one', 2, 3, 4).bodies[0];
  const second = box('two', 2, 3, 4, plane('offset', 10)).bodies[0];
  let restore;
  try {
    const hidden = cad('visibility.hide', { refs: [first, second] });
    restore = hidden.restoreState;
    assert.deepEqual(hidden.items.map(item => item.isLightBulbOn), [false, false]);
    assert.deepEqual(cad('visibility.show', { refs: [first, second] }).items.map(item => item.isLightBulbOn), [true, true]);
    assert.deepEqual(cad('visibility.isolate', { refs: [first], scope: [first, second] }).items.map(item => item.isLightBulbOn), [true, false]);
  } finally {
    if (restore && !stopped) {
      const restored = cad('visibility.restore', { state: restore });
      assert.deepEqual(restored.items.map(item => item.isLightBulbOn), restore.items.map(item => item.isLightBulbOn));
    }
  }
  volume(first, 24);
  volume(second, 24);
}, { enabled: initialized });

test('style_lists', ['appearance.list', 'material.list'], () => {
  box('block');
  for (const kind of ['appearance', 'material']) {
    const local = cad(kind + '.list');
    assert.equal(local.kind, kind);
    assert.ok(Array.isArray(local.items));
    assert.ok(Array.isArray(local.libraries));
    for (const row of [...local.items, ...local.libraries]) {
      assert.equal(typeof row.id, 'string');
      assert.ok(row.id.length);
      assert.equal(typeof row.name, 'string');
    }
    if (local.libraries.length) {
      const library = cad(kind + '.list', { library: local.libraries[0].id });
      assert.equal(library.library, local.libraries[0].id);
      assert.ok(Array.isArray(library.items));
    }
  }
}, { enabled: initialized });

test('camera_and_shot_pack', ['camera.save', 'camera.set', 'camera.restore', 'shot.pack'], () => {
  const body = box('block').bodies[0];
  const original = cad('camera.save').state;
  try {
    cad('camera.set', { eye: xyz(80, 60, 50), target: xyz(10, 6, 5), up: [0, 0, 1],
      projection: 'perspective', perspectiveAngle: '40 deg', fit: false });
    const changed = cad('camera.save').state;
    assert.equal(changed.cameraType, 'PerspectiveCameraType');
    near(changed.perspectiveAngle, 40 * Math.PI / 180, 0.00001, 'camera.set perspective rad');
    [8, 6, 5].forEach((v, i) => near(changed.eye[i], v, 0.00001, 'camera.set eye cm'));
    const now = guard();
    assert.ok(now.tempExists && path.win32.isAbsolute(now.tempDir), 'Require existing Fusion Windows temp directory from read-only probe');
    const files = ['front', 'iso-top-right'].map(label => ({
      path: path.win32.join(now.tempDir, name + '_' + label + '.png'),
      camera: { orientation: label, fit: true }, width: 640, height: 480,
    }));
    const present = script(`paths = ${JSON.stringify(files.map(file => file.path))}
print('LIVE_EXT ' + json.dumps([os.path.lexists(p) for p in paths]))`);
    assert.deepEqual(present, [false, false], 'Never overwrite an existing image');
    report.files.push(...files.map(file => ({ fusionPath: file.path, absentBefore: true, writeAttempted: true })));
    const shots = cad('shot.pack', { shots: files });
    assert.equal(shots.images.length, 2);
    assert.equal(shots.cameraRestored, true);
    cameraEqual(cad('camera.save').state, changed);
    for (let i = 0; i < shots.images.length; i++) {
      const image = shots.images[i];
      assert.equal(path.win32.normalize(image.path), files[i].path);
      assert.ok(image.exists && image.bytes > 24);
      const mapped = image.path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => '/mnt/' + drive.toLowerCase() + '/').replaceAll('\\', '/');
      const bytes = fs.readFileSync(mapped);
      assert.equal(bytes.length, image.bytes);
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
      near(bytes.readUInt32BE(16), 640, 0, 'shot.pack PNG width pixels');
      near(bytes.readUInt32BE(20), 480, 0, 'shot.pack PNG height pixels');
      Object.assign(report.files.find(file => file.fusionPath === files[i].path), { bytes: image.bytes, wslPath: mapped, verifiedPNG: true });
    }
  } finally {
    if (!stopped) {
      cad('camera.restore', { state: original });
      cameraEqual(cad('camera.save').state, original);
    }
  }
  volume(body, 2400);
}, { enabled: initialized });

test('final_audit', ['audit', 'history.check'], () => {
  report.finalAudit = cad('audit');
  const health = cad('history.check');
  assert.equal(health.healthy, true, JSON.stringify(health));
  assert.deepEqual(report.finalAudit.issues, []);
}, { fixture: false, enabled: initialized });

test('cleanup_owned_images', [], () => {
  for (const file of report.files) {
    guard();
    const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity?.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1 and not matches[0].isSaved and matches[0] == app.activeDocument, 'Owned identity changed before file cleanup'
p = ${JSON.stringify(file.fusionPath)}
assert os.path.dirname(p) == tempfile.gettempdir() and os.path.basename(p).startswith(${JSON.stringify(name + '_')}), 'Not a fixture temp path'
assert not os.path.islink(p), 'Refuse symbolic link cleanup'
if os.path.exists(p):
    assert os.path.isfile(p), 'Not a regular file'
    os.remove(p)
print('LIVE_EXT ' + json.dumps({"path": p, "removed": not os.path.lexists(p)}))`, false);
    assert.equal(result.removed, true);
    file.removed = true;
  }
}, { fixture: false, enabled: !!identity });

test('cleanup_owned_document', [], () => {
  guard();
  const closed = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity?.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1, 'Owned identity ambiguous; leave open'
doc = matches[0]
assert not doc.isSaved and doc == app.activeDocument, 'Saved or inactive fixture; leave open'
assert doc.close(False), 'Owned close failed'
print('LIVE_EXT ' + json.dumps({"closedCreationId": ${JSON.stringify(identity?.creationId)}}))`, false);
  assert.equal(closed.closedCreationId, identity.creationId);
  fixture(name);
  report.documentClosed = true;
}, { fixture: false, enabled: !!identity });

// This final probe is read-only even after a safety stop. Never recover a missing
// identity by name and then close it; report ambiguous/unknown leftovers instead.
current = { name: 'final_read_only_accounting', operations: new Set(), metrics: [] };
try {
  report.after = state();
  report.remainingDocuments = report.after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
  if (baseline) unchangedOthers(report.after);
  assert.deepEqual(report.remainingDocuments, [], 'Owned or potentially owned document remains; inspect manually');
  report.tests.push({ name: current.name, status: 'pass', operations: [] });
} catch (error) {
  report.tests.push({ name: current.name, status: 'fail', error: error.message, operations: [] });
}
// Local batch artifacts belong to the exact mkdtemp directory, never a shared run.
if (batchDirectory && !stopped) {
  try {
    fs.rmSync(batchDirectory, { recursive: true });
    report.batchDirectoryRemoved = true;
  } catch (error) {
    report.tests.push({ name: 'cleanup_local_batch_reports', status: 'fail', error: error.message });
  }
} else if (batchDirectory) {
  report.batchDirectoryRemoved = false;
  report.batchDirectoryRetainedReason = 'Safety stop; retain durable batch evidence for manual inspection';
}
report.operationCoverage = Object.keys(catalog).map(operation => ({ operation,
  status: report.tests.some(test => test.status === 'pass' && test.operations?.includes(operation)) ? 'pass' :
    attempted.has(operation) ? 'fail' : 'not-tested',
  note: 'Operation invocation coverage only; inspect group status, requested modes and numeric measurement rows.',
}));
report.finishedAt = new Date().toISOString();
persist();
console.log('REPORT ' + reportPath);
process.exitCode = report.tests.some(test => test.status !== 'pass') || stopped ? 1 : 0;
