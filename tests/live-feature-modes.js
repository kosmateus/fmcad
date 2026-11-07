// Opt-in, exclusive Fusion test. Only the addin backend; no config reads or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createBackend } = require('./helpers/live-broker');
const { validateCad } = require('../src/cad');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(__dirname, 'live-feature-modes-report.json');
const server = { backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {}, timeoutMs: 60000,
  transport: 'windows-curl', curlPath: '/mnt/c/Windows/System32/curl.exe', protocolVersion: '2025-06-18' };
const client = createBackend(server, { command: true });
const name = 'FMCAD_GEO_' + randomUUID().replaceAll('-', '_');
const { fixture } = require('./helpers/live-broker');
fixture(name);
const prior = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { runs: [] };
const report = { name, startedAt: new Date().toISOString(), backend: server, requests: [], tests: [],
  tolerances: { lengthMm: 0.001, volumeAbsoluteMm3: 0.001, volumeRelative: 0.00001 },
  scope: 'Exclusive addin-only requests; creationId/name/active/unsaved and other-document guards inside every owned script.',
  gaps: ['No manufacturing acceptance. No automatic mutation retries. No claim of exhaustive geometry or negative-direction coverage.'] };
if (prior.runs.length) report.correction = {
  priorRun: prior.runs[prior.runs.length - 1].name,
  hypothesis: process.argv.find(arg => arg.startsWith('--note='))?.slice(7) || 'XZ sketch local +Y maps to component -Z; negate fixture Y coordinates. Hole setAllExtent changes default-direction flag; explicitly restore requested isDefaultDirection after extent setup.',
  retryPolicy: 'One correction/retest for each observed hypothesis; previous raw evidence retained, no tolerance changes.',
};
prior.runs.push(report);
let identity, baseline, current, component = 'root', uncertain = false;
const persist = () => {
  prior.latestResults = {};
  for (const run of prior.runs) for (const test of run.tests) prior.latestResults[test.name] = {
    run: run.name, status: test.status, metrics: test.metrics.length,
    failedMetrics: test.metrics.filter(metric => metric.status !== 'pass'),
    cleanupConfirmed: !!run.cleanup?.closedCreationId,
  };
  for (const review of prior.assessment?.inconclusive || []) {
    const latest = prior.latestResults[review.test];
    if (latest?.run === review.diagnosticRun) {
      latest.lastAttemptStatus = latest.status;
      latest.status = 'inconclusive';
    }
  }
  fs.writeFileSync(reportPath, JSON.stringify(prior, null, 2) + '\n');
};
const py = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const output = value => `print('FEATURE_MODES ' + json.dumps(${value}, allow_nan=False))`;
// Load exactly the installed command handlers used by this test, without rewriting them.
const cadDir = path.join(root, 'assets/cad');
const files = ['core.py', ...fs.readdirSync(cadDir).filter(f => f.endsWith('.py') && f !== 'core.py').sort()];
const bundle = files.map(f => fs.readFileSync(path.join(cadDir, f), 'utf8')).join('\n\n');
report.bundleSha256 = createHash('sha256').update(bundle).digest('hex');
const helpers = `import adsk.core, adsk.fusion, json, math
app = adsk.core.Application.get()
def documents():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified) for d in app.documents if _fmcad_live_visible(d)], key=lambda d: d['creationId'])
`;

async function script(label, body, { mutation = false, owned = true, cadBundle = false, request } = {}) {
  if (mutation && uncertain) throw new Error('Indeterminate execution: all mutations including cleanup are stopped');
  const guard = owned ? `matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1 and not matches[0].isSaved and app.activeDocument == matches[0], 'Owned active unsaved document guard failed'
doc = matches[0]
assert [d for d in documents() if d['creationId'] != doc.creationId] == ${py(baseline)}, 'Other document state changed'
` : '';
  const source = (cadBundle ? bundle + '\n\n' : '') + helpers + '\ndef run(_context: str):\n' +
    (guard + body).split('\n').map(line => '    ' + line).join('\n');
  const row = { index: report.requests.length, test: current?.name, label, mutation, request,
    body, ownedGuard: owned ? identity : null, cadBundle, startedAt: new Date().toISOString(), status: 'running' };
  report.requests.push(row);
  persist();
  let result;
  try { result = await client.callTool({ featureType: 'script', object: { script: source, readOnly: !mutation } }); }
  catch (error) {
    uncertain = true;
    row.status = 'indeterminate'; row.error = error.message; report.mutationStop = error.message; persist();
    throw error;
  }
  row.output = result;
  row.finishedAt = new Date().toISOString();
  if (result.failed) {
    row.status = 'fail'; persist();
    throw new Error(label + ': ' + result.text);
  }
  const lines = result.text.split(/\r?\n/).filter(line => line.startsWith('FEATURE_MODES '));
  try {
    assert.equal(lines.length, 1, 'No unique result marker');
    row.result = JSON.parse(lines[0].slice('FEATURE_MODES '.length));
  } catch (error) {
    uncertain = true; row.status = 'indeterminate'; report.mutationStop = error.message; persist(); throw error;
  }
  row.status = 'pass'; persist();
  return row.result;
}

async function cad(operation, data = {}, scope = component) {
  const entry = validateCad(operation, data);
  const result = await script(operation, `ctx = CadContext(${JSON.stringify(name)}, ${py(scope)})
result = ctx.call(${JSON.stringify(operation)}, ${py(data)})
${output("dict(result=_cad_json(result), created=ctx.created)")}`, {
    mutation: !entry.readOnly, cadBundle: true, request: { operation, data, component: scope },
  });
  return result.result;
}

function near(actual, expected, tolerance, label) {
  const metric = { label, actual, expected, tolerance, units: label.includes('volume') ? 'mm3' : label.includes('unit direction') ? 'unitless' : 'mm',
    requestIndex: report.requests.length - 1, status: Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance ? 'pass' : 'fail' };
  current.metrics.push(metric); persist();
  assert.equal(metric.status, 'pass', JSON.stringify(metric));
}
async function volume(body, expected) {
  const v = await cad('measure.volume', { ref: body, units: 'mm3' });
  assert.equal(v.units, 'mm3');
  near(v.value, expected, Math.max(0.001, Math.abs(expected) * 0.00001), 'volume');
}
async function bounds(body, min, max) {
  const b = await cad('measure.bounds', { ref: body, units: 'mm' });
  assert.equal(b.units, 'mm');
  min.forEach((v, i) => near(b.min[i], v, 0.001, 'bounds min ' + 'xyz'[i]));
  max.forEach((v, i) => near(b.max[i], v, 0.001, 'bounds max ' + 'xyz'[i]));
}
const xyz = (x = 0, y = 0, z = 0) => [x, y, z].map(v => v + ' mm');
const named = suffix => component + '_' + suffix;
const profileRef = sketch => ({ kind: 'profile', sketch, index: 0 });
async function plane(suffix, offset) {
  return cad('datum.plane', { name: named(suffix), mode: 'offset', plane: 'XY', offset });
}
async function parameter(key, expression, overwrite = false) {
  await cad('param.apply', { parameters: [{ name: key, expression, unit: 'mm' }], overwrite }, 'root');
}
async function section(suffix, { plane: onPlane = 'XY', rectangle, radius, point } = {}) {
  const sketch = (await cad('sketch.create', { name: named(suffix), plane: onPlane })).sketch;
  const geometry = point ? { type: 'point', point } : rectangle
    ? { type: 'rectangle', start: rectangle[0], end: rectangle[1] }
    : { type: 'circle', center: xyz(), radius: radius || '4 mm' };
  const made = await cad('sketch.geometry', { sketch, geometry: [geometry] });
  if (!point) assert.equal((await cad('sketch.inspect', { sketch })).profiles.length, 1);
  return { sketch, profile: profileRef(sketch), entities: made.entities };
}
async function line(suffix, x, height, driving) {
  const sketch = (await cad('sketch.create', { name: named(suffix), plane: 'XZ' })).sketch;
  const entity = (await cad('sketch.geometry', { sketch, geometry: [
    { type: 'line', start: xyz(x), end: xyz(x, -height) },
  ] })).entities[0];
  if (driving) {
    await cad('sketch.edit', { sketch, entities: [{ entity, point: 'start' }], fixed: true });
    await cad('sketch.constrain', { sketch, type: 'vertical', entities: [entity] });
    await cad('sketch.dimension', { sketch, type: 'distance',
      entities: [{ entity, point: 'start' }, { entity, point: 'end' }], text: xyz(x + 5, -height / 2), expression: driving });
  }
  const route = (await cad('path.create', { curves: [entity], chain: 'none' })).path;
  const ends = await script('native-line-endpoints', `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
e = ctx.resolve(${py(entity)})
${output('[ [p.x * 10, p.y * 10, p.z * 10] for p in (e.startSketchPoint.worldGeometry, e.endSketchPoint.worldGeometry) ]')}`, { cadBundle: true });
  ends[0].forEach((v, i) => near(v, [x, 0, 0][i], 0.001, 'line start ' + 'xyz'[i]));
  ends[1].forEach((v, i) => near(v, [x, 0, height][i], 0.001, 'line end ' + 'xyz'[i]));
  return { entity, path: route };
}
async function native(feature, mode) {
  const result = await script('native-feature-properties', `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
f = ctx.resolve(${py(feature)})
r = dict(name=f.name, type=f.objectType, health=int(f.healthState), message=f.errorOrWarningMessage, token=f.entityToken)
mode = ${JSON.stringify(mode)}
if mode == 'extrude':
    r['extentType'] = f.extentOne.objectType
    r['startType'] = f.startExtent.objectType
    if adsk.fusion.ToEntityExtentDefinition.cast(f.extentOne):
        r['target'] = ctx.ref(f.extentOne.entity)
        r['offset'] = f.extentOne.offset.expression
    if adsk.fusion.OffsetStartDefinition.cast(f.startExtent):
        r['startOffset'] = f.startExtent.offset.expression
elif mode == 'hole':
    r['extentType'] = f.extentDefinition.objectType
    r['defaultDirection'] = f.isDefaultDirection
    r['diameter'] = f.holeDiameter.expression
    r['direction'] = [f.direction.x, f.direction.y, f.direction.z]
    r['holeType'] = int(f.holeType)
    r['parameters'] = [dict(name=p.name, expression=p.expression, value=p.value, unit=p.unit) for p in ctx.design.allParameters if getattr(p, 'createdBy', None) == f]
    r['cylinders'] = []
    for body in f.bodies:
        for face in body.faces:
            cylinder = adsk.core.Cylinder.cast(face.geometry)
            if cylinder:
                box = face.boundingBox
                r['cylinders'].append(dict(radiusMm=cylinder.radius * 10, minZMm=box.minPoint.z * 10, maxZMm=box.maxPoint.z * 10))
elif mode == 'sweep':
    r['orientation'] = int(f.orientation)
    r['parallelEnum'] = int(adsk.fusion.SweepOrientationTypes.ParallelOrientationType)
    r['perpendicularEnum'] = int(adsk.fusion.SweepOrientationTypes.PerpendicularOrientationType)
elif mode == 'sweepRail':
    r['profileScaling'] = int(f.profileScaling)
    r['scaleEnum'] = int(adsk.fusion.SweepProfileScalingOptions.SweepProfileScaleOption)
    r['inspectionGap'] = 'guideRail getter requires timeline rollback; orientation getter is inapplicable. Neither is read by this read-only probe. Guide effect verified by separate scaling geometry test.'
elif mode == 'loft':
    r['guideCount'] = f.centerLineOrRails.count
    r['isCenterLine'] = f.centerLineOrRails.isCenterLine
${output('r')}`, { cadBundle: true, request: { feature, mode } });
  assert.equal(result.health, 0, JSON.stringify(result));
  return result;
}
async function recompute() {
  const result = await cad('history.recompute');
  assert.equal(result.recomputed, true); assert.equal(result.healthy, true, JSON.stringify(result));
}
async function test(label, fn) {
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
  if (only && !only.includes(label)) return;
  current = { name: label, status: 'running', metrics: [] };
  report.tests.push(current); persist();
  if (uncertain) { current.status = 'blocked'; persist(); return; }
  component = 'Geo_' + label;
  try {
    await cad('component.create', { name: component }, 'root');
    await fn(); current.status = 'pass'; console.log('PASS ' + label);
  } catch (error) {
    current.status = 'fail'; current.error = error.stack;
    console.error('FAIL ' + label + ': ' + error.message);
    if (!uncertain) {
      try { current.failureInspection = await cad('history.check'); }
      catch (inspectionError) { current.inspectionError = inspectionError.message; }
    }
  }
  persist();
}

async function main() {
  assert.ok(process.argv.includes('--run'), 'Explicit --run required; run exclusively');
  baseline = await script('baseline', output('documents()'), { owned: false });
  report.baseline = baseline;
  identity = await script('create-owned-document', `assert documents() == ${py(baseline)}, 'Document set changed'
assert not any(d.name == ${JSON.stringify(name)} for d in app.documents)
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = ${JSON.stringify(name)}
${output('dict(name=doc.name, creationId=doc.creationId, saved=doc.isSaved, fusionVersion=app.version)')}`, { owned: false, mutation: true });
  report.identity = identity; persist();
  fixture(name, identity.creationId);
  assert.equal(identity.name, name); assert.equal(identity.saved, false);
  assert.ok(identity.creationId && !baseline.some(d => d.creationId === identity.creationId));
  try {
    await test('extrude_throughAll', async () => {
      const h = named('height'); await parameter(h, '10 mm');
      const stock = await cad('shape.box', { name: named('stock'), width: '20 mm', depth: '20 mm', height: h });
      const other = await cad('shape.box', { name: named('other'), width: '20 mm', depth: '20 mm', height: '4 mm', plane: await plane('otherPlane', '25 mm') });
      const cut = await section('cut', { rectangle: [xyz(5, 5), xyz(10, 10)] });
      const made = await cad('model.extrude', { name: named('through'), profile: cut.profile, extent: 'throughAll', direction: 'positive', operation: 'cut', participants: [stock.bodies[0]] });
      for (const height of [10, 16, 10]) {
        if (height !== 10 || current.metrics.length) { await parameter(h, height + ' mm', true); await recompute(); }
        await volume(stock.bodies[0], 375 * height); await bounds(stock.bodies[0], [0, 0, 0], [20, 20, height]);
        await volume(other.bodies[0], 1600); await bounds(other.bodies[0], [0, 0, 25], [20, 20, 29]);
        assert.match((await native(made.feature, 'extrude')).extentType, /ThroughAll/);
      }
    });
    await test('extrude_toEntity', async () => {
      const h = named('height'); await parameter(h, '20 mm');
      const target = await plane('target', h);
      const low = await section('section', { rectangle: [xyz(), xyz(4, 3)] });
      const made = await cad('model.extrude', { name: named('to'), profile: low.profile, extent: 'toEntity', target, offset: '-1 mm', startOffset: '2 mm' });
      for (const height of [20, 26, 20]) {
        if (height !== 20 || current.metrics.length) { await parameter(h, height + ' mm', true); await recompute(); }
        await volume(made.bodies[0], 12 * (height - 3)); await bounds(made.bodies[0], [0, 0, 2], [4, 3, height - 1]);
        const props = await native(made.feature, 'extrude');
        assert.match(props.extentType, /ToEntity/); assert.match(props.startType, /OffsetStart/);
        assert.equal(props.offset.replaceAll(' ', ''), '-1mm'); assert.equal(props.startOffset.replaceAll(' ', ''), '2mm');
      }
    });
    for (const extent of ['throughAll', 'toEntity']) await test('hole_' + extent, async () => {
      const h = named('height'); await parameter(h, '10 mm');
      const stock = await cad('shape.box', { name: named('stock'), width: '20 mm', depth: '20 mm', height: h });
      const top = await plane('top', h);
      const points = await section('points', { plane: top, point: xyz(10, 10) });
      if (extent === 'throughAll') await script('hole-native-input-direction-diagnostic', `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
p = ctx.resolve(${py(points.entities[0])})
rows = []
for direction in [adsk.fusion.ExtentDirections.NegativeExtentDirection, adsk.fusion.ExtentDirections.PositiveExtentDirection]:
    inp = ctx.component.features.holeFeatures.createSimpleInput(adsk.core.ValueInput.createByString('4 mm'))
    assert inp.setPositionBySketchPoints(ctx.collection([p]))
    row = dict(directionEnum=int(direction), before=inp.isDefaultDirection)
    assert inp.setAllExtent(direction)
    row['after'] = inp.isDefaultDirection
    rows.append(row)
${output('dict(inputs=rows, point=[p.worldGeometry.x * 10, p.worldGeometry.y * 10, p.worldGeometry.z * 10])')}`, { cadBundle: true });
      const made = await cad('model.hole', { name: named('hole'), points: points.entities, diameter: '4 mm', extent,
        ...(extent === 'toEntity' ? { target: 'XY' } : { reverse: false }), participants: [stock.bodies[0]] });
      for (const height of [10, 17, 10]) {
        if (height !== 10 || current.metrics.length) { await parameter(h, height + ' mm', true); await recompute(); }
        await volume(stock.bodies[0], (400 - Math.PI * 4) * height);
        await bounds(stock.bodies[0], [0, 0, 0], [20, 20, height]);
        await native(made.feature, 'hole');
      }
    });
    for (const type of ['simple', 'counterbore', 'countersink']) await test('hole_reverse_' + type, async () => {
      const h = named('height'); await parameter(h, '10 mm');
      const stock = await cad('shape.box', { name: named('stock'), width: '20 mm', depth: '20 mm', height: h });
      const points = await section('points', { point: xyz(10, 10) });
      const extras = type === 'counterbore' ? { boreDiameter: '8 mm', boreDepth: '2 mm' }
        : type === 'countersink' ? { sinkDiameter: '8 mm', sinkAngle: '90 deg' } : {};
      const made = await cad('model.hole', { name: named('hole'), points: points.entities, diameter: '4 mm',
        extent: 'throughAll', reverse: true, type, ...extras, participants: [stock.bodies[0]] });
      const additionalRemoval = type === 'counterbore' ? Math.PI * 12 * 2 : type === 'countersink' ? Math.PI * 32 / 3 : 0;
      for (const height of [10, 17, 10]) {
        await parameter(h, height + ' mm', true); await recompute();
        const props = await native(made.feature, 'hole');
        await volume(stock.bodies[0], (400 - Math.PI * 4) * height - additionalRemoval);
        await bounds(stock.bodies[0], [0, 0, 0], [20, 20, height]);
        assert.equal(props.defaultDirection, false);
        props.direction.forEach((v, i) => near(v, [0, 0, 1][i], 0.000001, 'hole unit direction ' + 'xyz'[i]));
      }
    });
    for (const orientation of ['parallel', 'perpendicular']) await test('sweep_' + orientation, async () => {
      const h = named('length'); await parameter(h, '20 mm');
      const sectionRef = await section('section', { rectangle: [xyz(-2, -1), xyz(2, 1)] });
      const route = await line('route', 0, 20, h);
      const made = await cad('model.sweep', { name: named('sweep'), profile: sectionRef.profile, path: route.path, orientation });
      for (const length of [20, 25, 20]) {
        await parameter(h, length + ' mm', true); await recompute();
        await volume(made.bodies[0], 8 * length); await bounds(made.bodies[0], [-2, -1, 0], [2, 1, length]);
        const props = await native(made.feature, 'sweep'); assert.equal(props.orientation, props[orientation + 'Enum']);
      }
    });
    for (const orientation of ['parallel', 'perpendicular']) await test('sweep_bent_' + orientation, async () => {
      const sectionRef = await section('section', { rectangle: [xyz(-2, -1), xyz(2, 1)] });
      const sketch = (await cad('sketch.create', { name: named('arc'), plane: 'XZ' })).sketch;
      const arc = await cad('sketch.geometry', { sketch, geometry: [{ type: 'arc', center: xyz(20), start: xyz(), sweep: '45 deg' }] });
      const route = (await cad('path.create', { curves: arc.entities })).path;
      const made = await cad('model.sweep', { name: named('sweep'), profile: sectionRef.profile, path: route, orientation });
      await volume(made.bodies[0], 8 * 20 * (orientation === 'parallel' ? Math.SQRT1_2 : Math.PI / 4));
      const props = await native(made.feature, 'sweep'); assert.equal(props.orientation, props[orientation + 'Enum']);
      await bounds(made.bodies[0], [-2, -1, 0], [20 * (1 - Math.SQRT1_2) + (orientation === 'parallel' ? 2 : Math.SQRT2), 1,
        20 * Math.SQRT1_2 + (orientation === 'parallel' ? 0 : Math.SQRT2)]);
    });
    await test('sweep_guideRail', async () => {
      const h = named('length'); await parameter(h, '20 mm');
      const sectionRef = await section('section', { rectangle: [xyz(-2, -1), xyz(2, 1)] });
      const route = await line('route', 0, 20, h), rail = await line('rail', 2, 20, h);
      const made = await cad('model.sweep', { name: named('sweep'), profile: sectionRef.profile, path: route.path, guideRail: rail.path });
      for (const length of [20, 25, 20]) {
        await parameter(h, length + ' mm', true); await recompute();
        await volume(made.bodies[0], 8 * length); await bounds(made.bodies[0], [-2, -1, 0], [2, 1, length]);
        const props = await native(made.feature, 'sweepRail');
        assert.equal(props.profileScaling, props.scaleEnum);
      }
      current.inspectionGap = 'guideRail getter requires rollback; this read-only suite does not change the timeline to inspect it.';
    });
    await test('sweep_guideRail_scaling', async () => {
      const spread = named('spread'); await parameter(spread, '1 mm');
      const sectionRef = await section('section', { rectangle: [xyz(-2, -1), xyz(2, 1)] });
      const route = await line('route', 0, 20);
      const sketch = (await cad('sketch.create', { name: named('rail'), plane: 'XZ' })).sketch;
      const entity = (await cad('sketch.geometry', { sketch, geometry: [{ type: 'line', start: xyz(2), end: xyz(3, -20) }] })).entities[0];
      await cad('sketch.edit', { sketch, entities: [{ entity, point: 'start' }], fixed: true });
      for (const [orientation, expression] of [['horizontal', spread], ['vertical', '20 mm']]) {
        await cad('sketch.dimension', { sketch, type: 'distance', entities: [{ entity, point: 'start' }, { entity, point: 'end' }],
          text: xyz(5, -10), orientation, expression });
      }
      const guideRail = (await cad('path.create', { curves: [entity] })).path;
      const made = await cad('model.sweep', { name: named('sweep'), profile: sectionRef.profile, path: route.path, guideRail });
      for (const value of [1, 2, 1]) {
        await parameter(spread, value + ' mm', true); await recompute();
        const scale = 1 + value / 2;
        await volume(made.bodies[0], 8 * 20 * (1 + scale + scale * scale) / 3);
        await bounds(made.bodies[0], [-2 * scale, -scale, 0], [2 * scale, scale, 20]);
        const props = await native(made.feature, 'sweepRail'); assert.equal(props.profileScaling, props.scaleEnum);
      }
      current.inspectionGap = 'Native guideRail getter not read because it requires rollback; independent rail-only perturbation verifies geometric dependence.';
    });
    for (const guide of ['rails', 'centerLine']) await test('loft_' + guide, async () => {
      const h = named('height'); await parameter(h, '20 mm');
      const low = await section('low'), high = await section('high', { plane: await plane('top', h) });
      const rail = await line('guide', guide === 'rails' ? 4 : 0, 20, h);
      const made = await cad('model.loft', { name: named('loft'), profiles: [low.profile, high.profile],
        ...(guide === 'rails' ? { rails: [rail.path] } : { centerLine: rail.entity }) });
      for (const height of [20, 26, 20]) {
        await parameter(h, height + ' mm', true); await recompute();
        await volume(made.bodies[0], Math.PI * 16 * height); await bounds(made.bodies[0], [-4, -4, 0], [4, 4, height]);
        const props = await native(made.feature, 'loft');
        assert.equal(props.guideCount, 1); assert.equal(props.isCenterLine, guide === 'centerLine');
      }
    });
  } finally {
    current = undefined;
    if (!uncertain) {
      report.cleanup = await script('close-owned-document', `owned_id = doc.creationId
assert doc.close(False), 'Owned close failed'
assert documents() == ${py(baseline)}, 'Other documents changed or owned document remains'
${output('dict(closedCreationId=owned_id, remainingDocuments=documents())')}`, { mutation: true });
    } else report.cleanup = { status: 'blocked', remainingOwnedDocument: identity };
    report.finishedAt = new Date().toISOString(); persist();
  }
  process.exitCode = report.tests.every(t => t.status === 'pass') && report.cleanup?.closedCreationId ? 0 : 1;
}
main().catch(error => { report.error = error.stack; persist(); console.error(error); process.exitCode = 1; });
