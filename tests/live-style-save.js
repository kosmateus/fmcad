// Exclusive, opt-in addin test. No cloud save, library download, or config writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createBackend } = require('./helpers/live-broker');
const { executeCad, buildCadScript } = require('../src/cad');
const { pythonValue: py } = require('../src/python');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(__dirname, 'live-style-save-report.json');
const name = 'FMCAD_STYLE_' + randomUUID().replaceAll('-', '_');
const { fixture: liveFixture } = require('./helpers/live-broker');
liveFixture(name);
const server = { backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {},
  timeoutMs: 60000, transport: 'windows-curl', curlPath: '/mnt/c/Windows/System32/curl.exe',
  protocolVersion: '2025-06-18' };
const report = { status: 'running', name, startedAt: new Date().toISOString(), backend: server,
  requests: [], tests: [], ownedFiles: [],
  tolerances: { relative: 0.00001, massAbsoluteKg: 1e-10, volumeAbsoluteCm3: 1e-8 },
  limitations: ['Run exclusively, with no interactive command or concurrent document edits.',
    'No cloud persistence, rendered-pixel equivalence, pricing, licensing, or solver testing.',
    'Transport ambiguity stops all mutations, including cleanup; no automatic retry.',
    'Material inheritance is not inferred from equal IDs. F3D roundtrip compares stored styles and physical properties.'] };
let backend, baseline, owned, uncertain = false;
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const bundle = buildCadScript('document.status', {}, { doc: name, component: 'root' }).split('\n_FMCAD_REQUEST: ')[0];
report.bundleSha256 = createHash('sha256').update(bundle).digest('hex');

const helpers = `
import tempfile
app = adsk.core.Application.get()
def doc_rows():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified) for d in app.documents if _fmcad_live_visible(d)], key=lambda r: (r['creationId'], r['name']))
def identity(d):
    return dict(name=d.name, creationId=d.creationId)
def same_doc(d, key):
    return d.name == key['name'] and d.creationId == key['creationId']
def checked_doc(key):
    matches = [d for d in app.documents if same_doc(d, key)]
    assert len(matches) == 1, 'Document name/creationId guard failed'
    return matches[0]
def guard(key, original):
    d = checked_doc(key)
    assert app.activeDocument == d and not d.isSaved, 'Owned document must be active and unsaved'
    assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open'
    remaining = [r for r in doc_rows() if not (r['name'] == key['name'] and r['creationId'] == key['creationId'])]
    assert remaining == original, 'Other document states changed'
    return d
def density_metadata(material):
    matches = [p for p in material.materialProperties if 'density' in p.id.casefold() and adsk.core.FloatProperty.cast(p)]
    if len(matches) != 1:
        return None
    p = matches[0]
    value = getattr(p, 'value', None)
    units = getattr(p, 'units', None)
    expression_units = {'KilogramPerCubicMeter': 'kg / m^3', 'GramPerCubicCentimeter': 'g / cm^3'}.get(units)
    return dict(id=p.id, name=p.name, value=value if type(value) in (int, float) and math.isfinite(value) else None,
                units=units, expressionUnits=expression_units, type=p.objectType)
def colors(appearance):
    if appearance is None:
        return None
    rows = []
    for p in appearance.appearanceProperties:
        color = adsk.core.ColorProperty.cast(p)
        if color and not color.hasMultipleValues:
            v = color.value
            rows.append(dict(id=p.id, rgba=[v.red, v.green, v.blue, v.opacity]))
    return sorted(rows, key=lambda r: r['id'])
def native_state(ctx, refs):
    rows = []
    for ref in refs:
        e = ctx.resolve(ref)
        kind = _cad_kind(e)
        m = e.body.material if kind == 'face' else e.component.material if kind == 'occurrence' else e.material
        a = getattr(e, 'appearance', None)
        row = dict(kind=kind, name=getattr(e, 'name', None), material=_io_style_value(m),
                   appearance=_io_style_value(a), colors=colors(a), source=getattr(e, 'appearanceSourceType', None))
        if row['source'] is not None:
            row['source'] = int(row['source'])
        if kind == 'body':
            assert e.nativeObject is None and e.assemblyContext is None and not e.isTransient
            p = e.physicalProperties
            row['physicalProperties'] = dict(mass=p.mass, density=p.density, volume=p.volume,
                                            units=dict(mass='kg', density='kg/cm3', volume='cm3'))
            metadata = density_metadata(m)
            converted = None
            if metadata and metadata['value'] is not None and metadata['expressionUnits']:
                converted = ctx.design.unitsManager.convert(metadata['value'], metadata['expressionUnits'], 'kg / cm^3')
                assert math.isfinite(converted) and converted > 0, 'Density unit conversion failed'
            row['sourceMaterial'] = dict(id=m.id, name=m.name, density=metadata, densityKgPerCm3=converted)
            row['materialAppearance'] = _io_style_value(m.appearance)
        rows.append(row)
    return rows
`;

function guardCode() {
  assert.ok(owned && baseline, 'No owned document identity');
  return `doc = guard(${py(owned)}, ${py(baseline.documents)})\n`;
}

async function send(label, request) {
  assert.ok(!uncertain || request.object.readOnly, 'Indeterminate execution: mutations stopped');
  const row = { label, readOnly: request.object.readOnly, startedAt: new Date().toISOString(), status: 'running' };
  report.requests.push(row); persist();
  try {
    const out = await backend.callTool(request);
    row.output = out;
    row.status = out.failed ? 'fail' : 'returned';
    persist();
    return out;
  } catch (error) {
    uncertain = true;
    row.status = 'indeterminate'; row.error = error.stack;
    persist(); throw error;
  }
}

async function probe(label, code, { mutation = false, guarded = true } = {}) {
  const body = (guarded ? guardCode() : '') + code;
  const script = bundle + '\n' + helpers + '\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const out = await send(label, { featureType: 'script', object: { script, readOnly: !mutation } });
  assert.ok(!out.failed, label + ': ' + out.text);
  const lines = out.text.split(/\r?\n/).filter(line => line.startsWith('STYLE_SAVE '));
  if (lines.length !== 1) { uncertain = true; throw new Error('Missing/ambiguous probe result: ' + label); }
  try { return JSON.parse(lines[0].slice('STYLE_SAVE '.length)); }
  catch (error) { uncertain = true; throw error; }
}
const emit = expression => `print('STYLE_SAVE ' + json.dumps(_cad_json(${expression}), allow_nan=False))`;
const contextCode = () => `ctx = CadContext(${py(owned.name)})\n`;

async function cad(operation, data = {}, component = 'root') {
  // Inject only the ownership precondition, before executeCad's possible activation.
  // The generated request and production handlers are otherwise unchanged.
  const client = { callTool: request => {
    const needle = 'def run(_context: str):\n';
    assert.equal(request.object.script.split(needle).length, 2);
    const script = request.object.script.replace(needle,
      helpers + '\n' + needle + guardCode().split('\n').filter(Boolean).map(s => '    ' + s + '\n').join(''));
    return send(operation, { ...request, object: { ...request.object, script } });
  } };
  const result = await executeCad(client, operation, data, { doc: owned.name, component });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.result;
}

async function test(label, fn) {
  const row = { name: label, status: 'running', requestStart: report.requests.length };
  report.tests.push(row); persist();
  try { row.evidence = await fn(); row.status = 'pass'; }
  catch (error) { row.status = error.message.includes('BLOCKED:') ? 'blocked' : 'fail'; row.error = error.stack; throw error; }
  finally { row.requestEnd = report.requests.length; persist(); }
}

function near(actual, expected, absolute = 1e-10) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected));
  assert.ok(Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * 0.00001),
    `Expected ${actual} near ${expected}`);
}
function physicalUnchanged(before, after) {
  assert.equal(after.length, before.length);
  before.forEach((row, i) => {
    assert.deepEqual(after[i].material, row.material);
    if (row.physicalProperties) for (const key of ['mass', 'density', 'volume']) {
      near(after[i].physicalProperties[key], row.physicalProperties[key]);
    }
  });
}
async function snapshot(refs) {
  return probe('native-style-and-physical-readback', contextCode() + emit(`native_state(ctx, ${py(refs)})`));
}
async function rejection(operation, data, refs, pattern) {
  const before = await snapshot(refs);
  const result = await probe('prevalidate-' + operation, contextCode() + `
styles_before = dict(materials=[_io_style_value(v) for v in ctx.design.materials], appearances=[_io_style_value(v) for v in ctx.design.appearances])
error = None
try:
    ctx.call(${py(operation)}, ${py(data)})
except ValueError as exc:
    error = str(exc)
assert error is not None, 'Expected handler ValueError'
assert styles_before == dict(materials=[_io_style_value(v) for v in ctx.design.materials], appearances=[_io_style_value(v) for v in ctx.design.appearances]), 'Unexpected style copy'
assert not doc.isSaved and doc.dataFile is None
${emit('dict(error=error, saved=doc.isSaved)')}`, { mutation: true });
  assert.match(result.error, pattern);
  assert.deepEqual(await snapshot(refs), before, 'Rejected mixed refs performed earlier writes');
  return result;
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Not run. Execute exclusively: node tests/live-style-save.js --run');
    return;
  }
  persist();
  await test('offline-valid-cloud-save-mocks', async () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'document_save_test.py'],
      { cwd: root, encoding: 'utf8', timeout: 60000 });
    report.offline = { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
    assert.equal(result.status, 0, JSON.stringify(report.offline));
    const preview = await executeCad({ callTool() { throw new Error('Preview must not access backend'); } },
      'document.save_as', { name, project: 'OFFLINE_PLACEHOLDER_NOT_A_DESTINATION', folder: '', confirm: true },
      { doc: name, preview: true });
    assert.equal(preview.mutation, false);
    assert.equal(preview.state, 'input-validated-only');
    return { mocks: report.offline, preview, actualCloudSave: 'not attempted; user has not selected a project/folder' };
  });
  backend = createBackend(server, { command: true });
  baseline = await probe('capture-user-state', `
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Close interactive command first'
assert app.activeDocument is not None, 'An active Design document is required for restorable camera capture'
ctx = CadContext(app.activeDocument.name)
assert ctx.doc == app.activeDocument
${emit("dict(documents=doc_rows(), active=identity(ctx.doc), workspace=app.userInterface.activeWorkspace.id, camera=ctx.call('camera.save', {})['state'])")}`, { guarded: false });
  report.baseline = baseline; persist();
  try {
    owned = await probe('create-owned-scratch', `
assert doc_rows() == ${py(baseline.documents)}
assert same_doc(app.activeDocument, ${py(baseline.active)})
assert app.userInterface.activeWorkspace.id == ${py(baseline.workspace)}
assert not any(d.name == ${py(name)} for d in app.documents)
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
key = identity(doc)
assert checked_doc(key) == doc and app.activeDocument == doc and not doc.isSaved
assert not any(same_doc(doc, r) for r in ${py(baseline.documents)})
doc.name = ${py(name)}
assert doc.name == ${py(name)}
${emit('identity(doc)')}`, { guarded: false, mutation: true });
    report.owned = owned; persist();
    liveFixture(name, owned.creationId);
    const made = await cad('component.create', { name: 'StyleDefinition' });
    const component = made.component;
    const box = await cad('shape.box', { name: 'StyleBody', width: '10 mm', depth: '10 mm', height: '10 mm' }, component);
    const body = box.bodies[0];
    const otherBox = await cad('shape.box', { name: 'OtherBody', width: '5 mm', depth: '5 mm', height: '5 mm' }, component);
    const other = otherBox.bodies[0];
    const linked = await cad('occurrence.add', { component, copyMode: 'linked' });
    const fixture = await probe('native-fixture-refs', contextCode() + `
b = ctx.resolve(${py(body)})
c = ctx.resolve(${py(component)})
assert b.parentComponent == c and b.faces.count == 6
b.name = 'StyleBody'
ctx.resolve(${py(other)}).name = 'OtherBody'
assert ctx.resolve(${py(made.occurrence)}).component == ctx.resolve(${py(linked.occurrence)}).component
assert not ctx.design.snapshots.hasPendingSnapshot
${emit("dict(face=ctx.ref(b.faces.item(0)), enums={n: int(getattr(adsk.core.AppearanceSourceTypes, n)) for n in ('MaterialAppearanceSource', 'BodyAppearanceSource', 'OccurrenceAppearanceSource', 'FaceAppearanceSource', 'OverrideAppearanceSource')})")}`, { mutation: true });
    const refs = [body, other, fixture.face, made.occurrence, linked.occurrence, component];
    report.fixture = { component, body, other, ...fixture, occurrences: [made.occurrence, linked.occurrence] };
    near((await snapshot([body]))[0].physicalProperties.volume, 1, 1e-8);

    let selected;
    await test('discover-loaded-styles-and-density-metadata', async () => {
      const local = await cad('material.list');
      const catalogs = [];
      for (const lib of local.libraries) catalogs.push(await cad('material.list', { library: lib.id }));
      selected = await probe('choose-materials-by-metadata', contextCode() + `
local = list(ctx.design.materials)
candidates = []
for catalog in ${py(catalogs)}:
    lib = app.materialLibraries.itemById(catalog['library'])
    for item in catalog['items']:
        m = lib.materials.itemById(item['id'])
        if any(v.id == m.id or v.name == m.name for v in local):
            continue
        density = density_metadata(m)
        if density and density['value'] is not None and density['value'] > 0:
            candidates.append(dict(id=m.id, name=m.name, library=lib.id, density=density))
pair = next(([a, b] for a in candidates for b in candidates if a['id'] != b['id'] and a['name'] != b['name'] and a['density']['units'] == b['density']['units'] and abs(a['density']['value'] / b['density']['value'] - 1) > 0.1), None)
assert pair is not None, 'BLOCKED: no two collision-free loaded materials with differing density metadata'
${emit('dict(materials=pair, candidateCount=len(candidates))')}`);
      return { local, catalogs, selected };
    });
    let materialA, materialB, massA, massB;
    await test('component-and-native-body-physical-material', async () => {
      const a = selected.materials[0], b = selected.materials[1];
      materialA = await cad('material.assign', { refs: [component], id: a.id, library: a.library });
      assert.equal((await snapshot([component]))[0].material.id, materialA.id);
      const componentInspection = await cad('material.inspect', { refs: [component] });
      assert.equal(componentInspection.items[0].material.id, materialA.id);
      assert.equal(componentInspection.items[0].materialSource, 'Component.material');
      await cad('material.assign', { refs: [body, other], id: materialA.id });
      massA = (await snapshot([body]))[0];
      materialB = await cad('material.assign', { refs: [body], id: b.id, library: b.library });
      massB = (await snapshot([body]))[0];
      assert.equal(massB.material.id, materialB.id);
      for (const row of [massA, massB]) {
        const p = row.physicalProperties;
        assert.ok(p.mass > 0 && p.density > 0);
        near(p.mass, p.density * p.volume);
        assert.ok(row.sourceMaterial.density?.value > 0, 'Assigned body material density property unavailable');
        if (row.sourceMaterial.densityKgPerCm3 !== null) {
          near(p.density, row.sourceMaterial.densityKgPerCm3);
          near(p.mass, row.sourceMaterial.densityKgPerCm3 * p.volume);
        }
      }
      near(massB.physicalProperties.volume, massA.physicalProperties.volume, 1e-8);
      const ratio = b.density.value / a.density.value;
      near(massB.physicalProperties.mass / massA.physicalProperties.mass, ratio);
      near(massB.physicalProperties.density / massA.physicalProperties.density, ratio);
      near(massA.sourceMaterial.density.value, a.density.value);
      near(massB.sourceMaterial.density.value, b.density.value);
      assert.ok(Math.abs(massA.physicalProperties.mass / massB.physicalProperties.mass - 1) > 0.1);
      const measured = await cad('measure.mass', { ref: body, units: 'kg' });
      near(measured.value, massB.physicalProperties.mass);
      const bodyInspection = await cad('material.inspect', { refs: [body, fixture.face] });
      assert.equal(bodyInspection.items[0].material.id, materialB.id);
      assert.equal(bodyInspection.items[0].materialSource, 'BRepBody.material');
      return { selected, materialA, materialB, massA, massB, measured, componentInspection, bodyInspection,
        expectedMassRatio: ratio, densityUnitsGap: massB.sourceMaterial.densityKgPerCm3 === null
          ? 'Metadata units absent; density ratio and native mass=density*volume checked, absolute metadata conversion not claimed' : null };
    });

    await test('physical-face-and-invalid-mixed-ref-prevalidation', async () => {
      const face = await rejection('material.assign', { refs: [body, fixture.face], id: materialA.id }, refs, /native Component or BRepBody|appearance.assign/);
      const invalid = await rejection('material.assign', { refs: [body, { kind: 'body', name: 'invalid_' + name }], id: materialA.id }, refs, /match|resolve|Reference/i);
      return { face, invalid };
    });

    let visual;
    await test('appearance-cascade-face-instance-and-clear', async () => {
      const local = await cad('appearance.list');
      const catalogs = [];
      for (const lib of local.libraries) catalogs.push(await cad('appearance.list', { library: lib.id }));
      const choice = await probe('choose-loaded-colored-appearance', contextCode() + `
local = list(ctx.design.appearances)
chosen = None
for catalog in ${py(catalogs)}:
    lib = app.materialLibraries.itemById(catalog['library'])
    for item in catalog['items']:
        a = lib.appearances.itemById(item['id'])
        if not any(v.id == a.id or v.name == a.name for v in local) and colors(a):
            chosen = dict(id=a.id, name=a.name, library=lib.id, colors=colors(a))
            break
    if chosen:
        break
assert chosen is not None, 'BLOCKED: no collision-free loaded appearance with readable colors'
${emit('chosen')}`);
      const before = await snapshot(refs);
      visual = await cad('appearance.assign', { refs: [component], id: choice.id, library: choice.library });
      assert.equal(visual.count, 2);
      assert.equal(visual.mapping[0].scope, 'component-body-cascade');
      let state = await snapshot(refs);
      physicalUnchanged(before, state);
      for (const i of [0, 1]) {
        assert.equal(state[i].appearance.id, visual.id);
        assert.equal(state[i].source, fixture.enums.BodyAppearanceSource);
        assert.deepEqual(state[i].colors, choice.colors);
      }
      const cascadeInspect = await cad('appearance.inspect', { refs: [body, other, fixture.face] });
      for (const i of [0, 1]) {
        assert.equal(cascadeInspect.items[i].appearanceSource, 'BodyAppearanceSource');
        assert.equal(cascadeInspect.items[i].appearanceOverride, true);
      }
      assert.equal(cascadeInspect.items[2].appearanceSource, 'BodyAppearanceSource');
      assert.equal(cascadeInspect.items[2].appearanceOverride, false, 'Inherited body appearance is not a face override');
      const localId = { id: visual.id };
      const instanceId = before[0].materialAppearance.id;
      assert.notEqual(instanceId, visual.id, 'Instance test needs a distinct actual style');
      const localStyles = (await cad('appearance.list')).items;
      assert.ok(localStyles.some(item => item.id === instanceId));
      const faceId = localStyles.find(item => item.id !== visual.id && item.id !== instanceId)?.id;
      assert.ok(faceId, 'BLOCKED: face test needs a local appearance distinct from body override and underlying material appearance');
      await cad('appearance.assign', { refs: [fixture.face], id: faceId });
      physicalUnchanged(before, await snapshot(refs));
      await cad('appearance.assign', { refs: [made.occurrence], id: instanceId });
      state = await snapshot(refs);
      physicalUnchanged(before, state);
      assert.equal(state[2].appearance.id, faceId);
      assert.equal(state[2].source, fixture.enums.FaceAppearanceSource);
      const faceInspect = await cad('appearance.inspect', { refs: [fixture.face] });
      assert.equal(faceInspect.items[0].appearanceSource, 'FaceAppearanceSource');
      assert.equal(faceInspect.items[0].appearanceOverride, true);
      assert.equal(state[3].appearance.id, instanceId);
      assert.deepEqual(state[4], before[4], 'Other instance changed');
      assert.deepEqual(state[5], before[5], 'Component definition changed');
      const instanceInspect = await cad('appearance.inspect', { refs: [made.occurrence, linked.occurrence] });
      assert.equal(instanceInspect.items[0].appearanceSource, 'OccurrenceOverride');
      assert.equal(instanceInspect.items[0].appearanceOverride, true);
      assert.equal(instanceInspect.items[1].appearanceOverride, false);
      const masked = await snapshot(refs);
      await cad('appearance.clear', { refs: [component] });
      state = await snapshot(refs);
      physicalUnchanged(before, state);
      for (const i of [0, 1]) {
        assert.equal(state[i].source, fixture.enums.OccurrenceAppearanceSource);
        assert.equal(state[i].appearance.id, instanceId);
      }
      assert.deepEqual(state[2], masked[2], 'Component clear removed face override');
      assert.deepEqual(state[3], masked[3], 'Component clear removed instance override');
      await cad('appearance.clear', { refs: [fixture.face, made.occurrence] });
      state = await snapshot(refs);
      physicalUnchanged(before, state);
      for (const i of [0, 1]) {
        assert.equal(state[i].source, fixture.enums.MaterialAppearanceSource);
        assert.equal(state[i].appearance.id, state[i].materialAppearance.id);
      }
      assert.equal(state[2].appearance.id, state[0].appearance.id);
      assert.equal(state[2].source, fixture.enums.MaterialAppearanceSource);
      assert.equal(state[3].appearance, null);
      assert.deepEqual(state[4], before[4]);
      const cleared = await cad('appearance.inspect', { refs: [body, fixture.face, made.occurrence] });
      for (const i of [0, 1]) {
        assert.equal(cleared.items[i].appearanceSource, 'MaterialAppearanceSource');
        assert.equal(cleared.items[i].appearanceOverride, false);
      }
      assert.equal(cleared.items[2].appearanceOverride, false);
      await rejection('appearance.assign', { refs: [body, { kind: 'body', name: 'invalid_' + name }], ...localId }, refs, /match|resolve|Reference/i);
      await rejection('appearance.assign', { refs: [body], id: choice.id, library: choice.library }, refs, /collision/i);
      // Leave three distinct override scopes in the archive, then check every visual-only step.
      await cad('appearance.assign', { refs: [body], ...localId });
      physicalUnchanged(before, await snapshot(refs));
      await rejection('appearance.clear', { refs: [body, { kind: 'body', name: 'invalid_' + name }] }, refs, /match|resolve|Reference/i);
      await cad('appearance.assign', { refs: [fixture.face], id: faceId });
      physicalUnchanged(before, await snapshot(refs));
      const beforeInstance = await snapshot(refs);
      await cad('appearance.assign', { refs: [made.occurrence], id: instanceId });
      const final = await snapshot(refs);
      physicalUnchanged(before, final);
      assert.equal(final[0].appearance.id, visual.id);
      assert.equal(final[0].source, fixture.enums.BodyAppearanceSource);
      assert.equal(final[2].appearance.id, faceId);
      assert.equal(final[2].source, fixture.enums.FaceAppearanceSource);
      assert.equal(final[3].appearance.id, instanceId);
      for (const i of [0, 2, 4, 5]) assert.deepEqual(final[i], beforeInstance[i], 'Instance override changed an explicit override or another instance');
      assert.equal(final[1].source, fixture.enums.OccurrenceAppearanceSource);
      assert.equal(final[1].appearance.id, instanceId);
      return { choice, actualLocalId: visual.id, faceId, instanceId, before, final, cascadeInspect, faceInspect, instanceInspect, cleared };
    });

    await test('unsaved-status-and-no-cloud-destination', async () => {
      const before = await cad('document.status');
      assert.equal(before.saved, false); assert.equal(before.fileId, null);
      const confirm = await rejection('document.save_as', { name, project: 'NOT_SELECTED', folder: '', confirm: false }, refs, /confirm/i);
      const missing = await rejection('document.save_as', { name, confirm: true }, refs, /Missing inputs/);
      const after = await cad('document.status');
      assert.deepEqual(after, before);
      return { before, confirm, missing, after };
    });

    await test('local-f3d-style-and-mass-roundtrip', async () => {
      const checkpoint = await probe('reserve-known-checkpoint-path', `
p = Path(tempfile.gettempdir()) / ${py(name + '.f3d')}
assert p.parent.is_dir() and not p.exists() and not p.is_symlink()
${emit('str(p)')}`);
      report.ownedFiles.push(checkpoint); persist();
      const saved = await cad('checkpoint.create', { path: checkpoint });
      assert.equal(saved.exists, true); assert.ok(saved.bytes > 0); assert.equal(saved.userDocumentSaved, false);
      assert.equal((await cad('document.status')).saved, false);
      const before = await snapshot(refs);
      // Use the real checkpoint.open handler, but retain the returned document object
      // in this one request so copies sharing a creationId cannot be mistaken for ours.
      const roundtrip = await probe('guarded-checkpoint-open-and-compare', contextCode() + `
assert hasattr(app.importManager, 'createFusionArchiveImportOptions') and hasattr(app.importManager, 'importToNewDocument'), 'BLOCKED: safe archive import API unavailable'
source = doc
prior_docs = list(app.documents)
result = ctx.call('checkpoint.open', dict(path=${py(checkpoint)}))
new_docs = [d for d in app.documents if d not in prior_docs]
assert len(new_docs) == 1, 'Import ownership ambiguous; do not close unknown documents'
imported = new_docs[0]
key = result['document']
assert same_doc(imported, key) and imported != source and not imported.isSaved
assert not any(d.name == ${py(name + '_REIMPORT')} for d in app.documents)
# A copied archive may share creationId; object provenance plus returned name is required.
assert same_doc(imported, key) and imported not in prior_docs
imported.name = ${py(name + '_REIMPORT')}
key = identity(imported)
try:
    assert checked_doc(key) == imported and app.activeDocument == imported
    ic = CadContext(imported.name)
    c = ic.resolve(dict(kind='component', name='StyleDefinition'))
    b = _cad_unique([b for b in c.bRepBodies if b.name == 'StyleBody'], 'Imported body')
    other = _cad_unique([b for b in c.bRepBodies if b.name == 'OtherBody'], 'Imported other body')
    occurrences = list(ic.root.allOccurrences)
    assert len(occurrences) == 2 and all(o.component == c for o in occurrences)
    first = _cad_unique([o for o in occurrences if o.appearance is not None], 'Styled occurrence')
    second = _cad_unique([o for o in occurrences if o.appearance is None], 'Unstyled occurrence')
    face = _cad_unique([f for f in b.faces if f.appearanceSourceType == adsk.core.AppearanceSourceTypes.FaceAppearanceSource], 'Styled face')
    actual = native_state(ic, [ic.ref(e) for e in (b, other, face, first, second, c)])
finally:
    assert checked_doc(key) == imported and imported not in prior_docs and not imported.isSaved
    assert [d for d in app.documents if d != imported] == prior_docs
    assert imported.close(False), 'Close imported owned document failed'
    assert checked_doc(${py(owned)}) == source and not source.isSaved
    assert source.activate()
${emit('dict(imported=key, actual=actual, closed=True)')}`, { mutation: true });
      physicalUnchanged(before, roundtrip.actual);
      for (let i = 0; i < before.length; i++) {
        assert.deepEqual(roundtrip.actual[i].appearance, before[i].appearance);
        assert.deepEqual(roundtrip.actual[i].colors, before[i].colors);
        assert.equal(roundtrip.actual[i].source, before[i].source);
      }
      assert.equal((await cad('document.status')).saved, false);
      return { checkpoint: saved, before, roundtrip };
    });
    report.status = 'pass';
  } finally {
    if (owned && !uncertain) {
      try {
        report.cleanup = await probe('cleanup-only-owned-files-document-and-restore-user-view', `
for filename in ${py(report.ownedFiles)}:
    guard(${py(owned)}, ${py(baseline.documents)})
    p = Path(filename)
    assert p.parent == Path(tempfile.gettempdir()) and p.name == ${py(name + '.f3d')} and not p.is_symlink()
    if p.exists():
        assert p.is_file()
        p.unlink()
guard(${py(owned)}, ${py(baseline.documents)})
assert doc.close(False)
assert doc_rows() == ${py(baseline.documents)}
original = checked_doc(${py(baseline.active)})
assert original.activate()
assert doc_rows() == ${py(baseline.documents)}
workspace = app.userInterface.workspaces.itemById(${py(baseline.workspace)})
assert workspace is not None
if app.userInterface.activeWorkspace.id != workspace.id:
    assert workspace.activate()
assert app.activeDocument == original and doc_rows() == ${py(baseline.documents)}
ctx = CadContext(original.name)
ctx.call('camera.restore', dict(state=${py(baseline.camera)}))
assert doc_rows() == ${py(baseline.documents)}
${emit("dict(closed=True, documents=doc_rows(), active=identity(app.activeDocument), workspace=app.userInterface.activeWorkspace.id, camera=ctx.call('camera.save', {})['state'], filesRemoved=" + py(report.ownedFiles) + ')')}`, { mutation: true });
        assert.deepEqual(report.cleanup.active, baseline.active);
        assert.equal(report.cleanup.workspace, baseline.workspace);
        const actual = report.cleanup.camera;
        for (const key of ['eye', 'target', 'up', 'extents']) if (baseline.camera[key]) {
          baseline.camera[key].forEach((v, i) => near(actual[key][i], v, 1e-7));
        }
        assert.equal(actual.cameraType, baseline.camera.cameraType);
        if (baseline.camera.perspectiveAngle !== undefined) near(actual.perspectiveAngle, baseline.camera.perspectiveAngle);
      } catch (error) { report.cleanupError = error.stack; report.status = 'fail'; }
    } else {
      report.cleanup = { status: 'blocked', reason: 'No confirmed ownership or indeterminate execution; no blind cleanup', owned };
      report.status = 'fail';
    }
    report.finishedAt = new Date().toISOString(); persist();
  }
  assert.equal(report.status, 'pass', 'See ' + reportPath);
  console.log('PASS ' + reportPath);
}

if (require.main === module) main().catch(error => {
  report.status = 'fail'; report.error = error.stack; report.finishedAt = new Date().toISOString();
  persist(); console.error(error); process.exitCode = 1;
});
