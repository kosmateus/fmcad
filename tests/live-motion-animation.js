// Opt-in exclusive test. Primary runner must finish styles before starting this file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createBackend } = require('./helpers/live-broker');
const { executeCad } = require('../src/cad');

const reportPath = path.join(__dirname, 'live-motion-animation-report.json');
const server = { backend: 'addin', url: 'http://127.0.0.1:8765/mcp', headers: {},
  timeoutMs: 60000, transport: 'windows-curl', curlPath: '/mnt/c/Windows/System32/curl.exe',
  protocolVersion: '2025-06-18' };
const report = { status: 'not-run', backend: 'addin', scheduling: 'exclusive, sequential after styles',
  requests: [], tests: [], gaps: ['No continuous collision, dynamics, FEA, video or real publishing proof.',
    'PNG dimensions and geometry are evidence, not rendered-view equivalence.',
    'No global job-service query: no-job evidence is limited to dispatched operations and observed API calls.',
    'Transport ambiguity stops mutations, including cleanup; owned document identity remains in report.'] };
const name = 'FMCAD_MOTION_' + randomUUID().replaceAll('-', '_');
const { fixture: liveFixture } = require('./helpers/live-broker');
liveFixture(name);
const py = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
let client, baseline, identity, uncertain = false, fixture = [];

const helpers = `import adsk.core, adsk.fusion, json, math, os, tempfile, sys, struct, hashlib
app = adsk.core.Application.get()
def documents():
    return sorted([dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified,
                         products=[p.objectType for p in d.products]) for d in app.documents if _fmcad_live_visible(d)], key=lambda d: d['creationId'])
def camera_state():
    c = app.activeViewport.camera
    return dict(eye=list(c.eye.asArray()), target=list(c.target.asArray()), up=list(c.upVector.asArray()),
                cameraType=int(c.cameraType), viewExtents=c.viewExtents, perspectiveAngle=c.perspectiveAngle)
def environment():
    return dict(documents=documents(), active=app.activeDocument.creationId if app.activeDocument else None,
                workspace=app.userInterface.activeWorkspace.id, command=app.userInterface.activeCommand)
def pose_state():
    d = adsk.fusion.Design.cast(app.activeDocument.products.itemByProductType('DesignProductType'))
    rows = []
    for spec in FIXTURE:
        o = d.findEntityByToken(spec['occurrence']['token'])[0]
        j = d.findEntityByToken(spec['joint']['token'])[0] if spec.get('joint') else None
        m = j.jointMotion if j else None
        native = o.component.bRepBodies.item(0)
        proxy = o.bRepBodies.item(0)
        expected = []
        for vertex in native.vertices:
            p = vertex.geometry.copy()
            assert p.transformBy(o.transform2)
            expected.append(list(p.asArray()))
        actual = [list(v.geometry.asArray()) for v in proxy.vertices]
        assert len(actual) == 8 and len(expected) == 8
        assert all(any(max(abs(a-b) for a,b in zip(p,q)) < 1e-6 for q in actual) for p in expected), 'Proxy vertices disagree with occurrence transform'
        box = proxy.preciseBoundingBox
        rows.append(dict(kind=spec['kind'], matrix=list(o.transform2.asArray()), vertices=actual,
                         bounds=[list(box.minPoint.asArray()), list(box.maxPoint.asArray())],
                         volume=proxy.volume, grounded=o.isGrounded,
                         values={k:getattr(m,k) for k in ('rotationValue','slideValue') if m and hasattr(m,k)}))
    return dict(rows=rows, camera=camera_state(), workspace=app.userInterface.activeWorkspace.id)
`;

function guard() {
  return `matches = [d for d in app.documents if d.creationId == ${py(identity.creationId)}]
assert len(matches) == 1, 'Owned creationId missing or ambiguous'
doc = matches[0]
assert doc.isValid and doc.name == ${py(name)} and not doc.isSaved and app.activeDocument == doc, 'Owned active unsaved identity guard'
assert [d for d in documents() if d['creationId'] != doc.creationId] == ${py(baseline.documents)}, 'User document state changed'
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command: no mutation or cleanup'
`;
}

async function send(label, source, readOnly) {
  if (uncertain && !readOnly) throw new Error('Indeterminate prior request; mutations stopped');
  const row = { label, readOnly, source, startedAt: new Date().toISOString() };
  report.requests.push(row); persist();
  let out;
  try { out = await client.callTool({ featureType: 'script', object: { script: source, readOnly } }); }
  catch (error) { uncertain = true; row.error = error.stack; row.status = 'indeterminate'; persist(); throw error; }
  row.output = out; row.finishedAt = new Date().toISOString(); persist();
  return out;
}

function marker(out, prefix) {
  const lines = (out.text || '').split(/\r?\n/).filter(line => line.startsWith(prefix + ' '));
  if (lines.length !== 1) {
    uncertain = true;
    throw new Error('Missing unique ' + prefix + ' response: ' + out.text);
  }
  return JSON.parse(lines[0].slice(prefix.length + 1));
}

async function script(label, body, { owned = true, readOnly = true } = {}) {
  const source = helpers + `\nFIXTURE = ${py(fixture)}\ndef run(_context: str):\n` +
    ((owned ? guard() : '') + body).split('\n').map(line => '    ' + line).join('\n');
  const out = await send(label, source, readOnly);
  if (out.failed) throw new Error(label + ': ' + out.text);
  return marker(out, 'MOTION_PROBE');
}
const emit = expression => `print('MOTION_PROBE ' + json.dumps(${expression}, allow_nan=False))`;

// executeCad still compiles, maps paths and dispatches all production handlers.
// The adapter adds an in-request identity guard and a read-only Python profiler.
async function cad(operation, data = {}, component = 'root') {
  const adapter = { callTool: async request => {
    const original = request.object.script;
    const suffix = `
${helpers}
FIXTURE = ${py(fixture)}
_test_compiled_run = run
def run(_context: str):
${guard().split('\n').map(line => '    ' + line).join('\n')}
    observations, native_calls = [], []
    def observer(frame, event, arg):
        module = frame.f_globals.get('__name__', '')
        method = frame.f_code.co_name
        simulation_method = module.startswith('adsk.sim') and (method in ('get', 'create', 'solve', 'add', 'submit') or 'self' in frame.f_locals or 'cls' in frame.f_locals)
        if event == 'call' and (simulation_method or (method == 'play' and module.startswith('adsk.fusion'))):
            native_calls.append(module + '.' + method)
        if event == 'return' and method == '_measure_check' and frame.f_locals.get('data', {}).get('id') == 'pose-volume':
            observations.append(dict(check=arg, pose=pose_state()))
    previous = sys.getprofile()
    try:
        sys.setprofile(observer)
        _test_compiled_run(_context)
    finally:
        sys.setprofile(previous)
        print('MOTION_OBSERVATIONS ' + json.dumps(dict(poses=observations, nativeCalls=native_calls, mappedData=_FMCAD_REQUEST['data']), allow_nan=False))
`;
    const out = await send(operation, original + suffix, request.object.readOnly);
    // Preserve native error text, including failures without FMCAD_RESULT.
    const observations = marker(out, 'MOTION_OBSERVATIONS');
    report.requests[report.requests.length - 1].observations = observations; persist();
    return out;
  } };
  return executeCad(adapter, operation, data, { doc: name, component });
}

async function test(name, fn) {
  const row = { name, status: 'running' }; report.tests.push(row); persist();
  try { row.evidence = await fn(); row.status = 'pass'; }
  catch (error) { row.status = 'fail'; row.error = error.stack; }
  console.log((row.status === 'pass' ? 'PASS ' : 'FAIL ') + name + (row.status === 'fail' ? ': ' + row.error : ''));
  persist();
  return row.status === 'pass';
}
function closeNumbers(actual, expected, tolerance = 1e-7) {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected)) closeNumbers(actual[key], expected[key], tolerance);
  } else assert.equal(actual, expected);
}
const pose = () => script('read-actual-pose-camera', emit('pose_state()'));
const limits = axis => ({ minimumValue: axis === 'rotation' ? '-90 deg' : '-10 mm',
  maximumValue: axis === 'rotation' ? '90 deg' : '20 mm', restValue: axis === 'rotation' ? '0 deg' : '0 mm',
  isMinimumValueEnabled: true, isMaximumValueEnabled: true, isRestValueEnabled: false });

async function main() {
  assert.ok(process.argv.includes('--run'), 'Live disabled. Explicit --run required.');
  client = createBackend(server, { command: true });
  report.status = 'running'; report.liveExecuted = true; report.startedAt = new Date().toISOString(); report.name = name;
  report.bundleHashes = Object.fromEntries(['animation.py', 'assembly.py', 'simulation.py'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../assets/cad', file))).digest('hex')]));
  baseline = await script('read-only-original-and-native-temp', `assert app.userInterface.activeCommand in ('', 'SelectCommand')
assert app.userInterface.activeWorkspace is not None
temp = tempfile.gettempdir()
assert os.name == 'nt' and os.path.isabs(temp) and os.path.isdir(temp), 'Requires native Windows Temp'
${emit("dict(environment(), temp=temp, camera=camera_state() if app.activeDocument else None)")}`, { owned: false });
  report.baseline = baseline; persist();
  try {
    identity = await script('create-owned-scratch', `assert environment() == ${py({ documents: baseline.documents, active: baseline.active, workspace: baseline.workspace, command: baseline.command })}
assert not any(d.name == ${py(name)} for d in app.documents)
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = ${py(name)}
${emit('dict(creationId=doc.creationId, name=doc.name, saved=doc.isSaved)')}`, { owned: false, readOnly: false });
    report.identity = identity; persist();
    liveFixture(name, identity.creationId);
    assert.ok(identity.creationId && !baseline.documents.some(d => d.creationId === identity.creationId));
    assert.equal(identity.name, name); assert.equal(identity.saved, false);

    await test('animation-discovery-before-workspace', async () => {
      const before = await script('before-discovery', emit('environment()'));
      const capabilities = await cad('animation.capabilities');
      await assert.rejects(() => cad('animation.list'), /Storyboard access requires an active Animation workspace/);
      closeNumbers(await script('after-discovery', emit('environment()')), before);
      assert.equal(capabilities.success, true);
      assert.equal(capabilities.result.collectionAccess, 'notChecked');
      return { capabilities, inactiveListRejectedWithoutActivation: true };
    });
    await test('simulation-metadata-only', async () => {
      const before = await script('products-before-simulation', emit('environment()'));
      const result = await cad('simulation.capabilities');
      const observed = report.requests.at(-1).observations;
      const after = await script('products-after-simulation', emit('environment()'));
      assert.equal(result.success, true); assert.equal(result.result.productAccessed, false);
      assert.deepEqual(observed.nativeCalls, []); closeNumbers(after, before);
      return { before, after, result, nativeCalls: observed.nativeCalls,
        jobEvidence: 'Only metadata command dispatched; no simulation object method invoked. No external queue inspection.' };
    });

    const built = await test('root-local-rigid-and-three-as-built-joints-limits', async () => {
      for (const kind of ['anchor', 'base', 'revolute', 'slider', 'cylindrical']) {
        const made = await cad('component.create', { name: kind }); assert.equal(made.success, true);
        const box = await cad('shape.box', { name: kind + '_body', width: '8 mm', depth: '4 mm', height: '3 mm' }, made.result.component);
        assert.equal(box.success, true);
        fixture.push({ kind, occurrence: made.result.occurrence, component: made.result.component, body: box.result.bodies[0] });
      }
      await cad('assembly.ground', { occurrence: fixture[0].occurrence });
      const rigid = await cad('joint.rigid', { name: 'rigid_base', occurrenceOne: fixture[1].occurrence, occurrenceTwo: fixture[0].occurrence });
      assert.equal(rigid.result.asBuilt, true); assert.equal(rigid.result.motionType, 'RigidJointMotion');
      for (const part of fixture.slice(2)) {
        const axes = part.kind === 'cylindrical' ? ['rotation', 'slide'] : [part.kind === 'slider' ? 'slide' : 'rotation'];
        const spec = Object.fromEntries(axes.map(axis => [axis, limits(axis)]));
        const made = await cad('joint.' + part.kind, { name: part.kind + '_joint', occurrenceOne: part.occurrence,
          occurrenceTwo: fixture[1].occurrence, point: 'origin', axis: 'Z', limits: spec, confirm: true });
        assert.equal(made.result.asBuilt, true); assert.match(made.result.joint.objectType, /AsBuiltJoint$/);
        part.joint = { token: made.result.joint.token };
        const edited = await cad('joint.limits', { joint: part.joint, confirm: true,
          limits: Object.fromEntries(axes.map(axis => [axis, { restValue: axis === 'rotation' ? '10 deg' : '2 mm', isRestValueEnabled: true }])) });
        const inspected = await cad('joint.inspect', { joint: part.joint });
        closeNumbers(inspected.result.limits, edited.result.limits);
        for (const axis of axes) {
          closeNumbers(inspected.result.limits[axis], { minimumValue: axis === 'rotation' ? -Math.PI / 2 : -1,
            maximumValue: axis === 'rotation' ? Math.PI / 2 : 2, restValue: axis === 'rotation' ? Math.PI / 18 : 0.2,
            isMinimumValueEnabled: true, isMaximumValueEnabled: true, isRestValueEnabled: true, units: axis === 'rotation' ? 'rad' : 'cm' });
        }
        await cad('joint.limits', { joint: part.joint, confirm: true,
          limits: Object.fromEntries(axes.map(axis => [axis, { isRestValueEnabled: false }])) });
        await cad('joint.drive', { joint: part.joint, ...Object.fromEntries(axes.map(axis => [axis, axis === 'rotation' ? '0 deg' : '0 mm'])) });
      }
      return script('verify-native-root-local-fixture', `d = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
assert d.rootComponent.occurrences.count == 5 and d.rootComponent.asBuiltJoints.count == 4
assert d.activeComponent == d.rootComponent
for o in d.rootComponent.occurrences:
    assert o.assemblyContext is None and not o.isReferencedComponent
${emit('pose_state()')}`);
    });
    if (built) {
      const tracks = fixture.slice(2).map(p => ({ joint: p.joint,
        ...(p.kind !== 'slider' ? { rotation: { from: '0 deg', to: '60 deg' } } : {}),
        ...(p.kind !== 'revolute' ? { slide: { from: '0 mm', to: '10 mm' } } : {}) }));
      const check = { id: 'pose-volume', measurement: { operation: 'measure.volume', data: { ref: fixture[4].occurrence, units: 'mm3' } },
        expected: '96 mm^3', tolerance: '0.001 mm^3' };
      await test('out-of-limits-rejected-before-any-pose-change', async () => {
        const before = await pose(), errors = [];
        for (const part of fixture.slice(2)) for (const axis of part.kind === 'cylindrical' ? ['rotation', 'slide'] : [part.kind === 'slider' ? 'slide' : 'rotation']) {
          for (const value of axis === 'rotation' ? ['-91 deg', '91 deg'] : ['-11 mm', '21 mm']) {
            await assert.rejects(() => cad('joint.drive', { joint: part.joint,
              ...(part.kind === 'cylindrical' ? { rotation: '15 deg', slide: '5 mm' } : {}), [axis]: value }), error => {
              errors.push(error.message); return /outside joint limits/.test(error.message);
            });
            closeNumbers(await pose(), before);
          }
        }
        await assert.rejects(() => cad('motion.sample', { tracks: [...tracks.slice(0, 2), { joint: fixture[4].joint, rotation: { from: '0 deg', to: '91 deg' } }], frameCount: 5, confirm: true }), /outside joint limits/);
        closeNumbers(await pose(), before);
        return { before, errors, after: await pose() };
      });
      for (const mode of ['directory', 'frameFiles', 'forced-negative']) await test('five-frame-' + mode, async () => {
        const before = await pose();
        const prefix = name + '_' + mode.replaceAll('-', '_');
        const nativePaths = Array.from({ length: 5 }, (_, i) => path.win32.join(baseline.temp, `${prefix}-${String(i).padStart(3, '0')}.png`));
        // Both inputs are native values received from the read-only Windows Temp probe.
        const output = mode === 'directory' ? { directory: baseline.temp, prefix } : mode === 'frameFiles' ? { frameFiles: nativePaths } : {};
        const result = await cad('motion.sample', { tracks, frameCount: 5, confirm: true, restore: true,
          checks: [{ ...check, ...(mode === 'forced-negative' ? { expected: '97 mm^3' } : {}) }],
          ...output, ...(mode !== 'forced-negative' ? { width: 320, height: 240 } : {}) });
        const evidence = report.requests.at(-1).observations;
        for (const [key, value] of Object.entries(output)) assert.deepEqual(evidence.mappedData[key], value, 'Native path mapping must preserve probe-provided input');
        const after = await pose(); closeNumbers(after, before);
        assert.equal(result.success, mode !== 'forced-negative');
        assert.equal(result.result.passed, mode !== 'forced-negative');
        assert.equal(result.result.status, mode === 'forced-negative' ? 'fail' : 'pass');
        assert.equal(result.result.restored, true); assert.deepEqual(result.result.restoreErrors, []);
        assert.equal(result.result.error, null); assert.equal(result.result.samples.length, 5);
        assert.equal(evidence.poses.length, 6); // Initial preflight, then five in-pose checks.
        for (let i = 0; i < 5; i++) {
          const sample = result.result.samples[i], observed = evidence.poses[i + 1].pose;
          closeNumbers(sample.fraction, i / 4);
          closeNumbers(observed.rows.slice(0, 2), before.rows.slice(0, 2));
          for (let j = 0; j < 3; j++) {
            const row = observed.rows[j + 2], values = sample.joints[j];
            closeNumbers(row.volume, 0.096, 1e-6);
            for (const key of Object.keys(row.values)) {
              closeNumbers(row.values[key], values[key]);
              closeNumbers(values[key], key === 'rotationValue' ? Math.PI / 3 * i / 4 : i / 4);
            }
            const m = row.matrix;
            // Axis is Z at root origin; sign can depend on native joint orientation.
            closeNumbers((m[0] + m[5] + m[10] - 1) / 2, Math.cos(row.values.rotationValue || 0), 1e-6);
            closeNumbers(Math.abs(m[11]), row.values.slideValue || 0, 1e-6);
            if (i > 0) assert.notDeepEqual(row.vertices, before.rows[j + 2].vertices, 'Actual body geometry must move');
          }
          assert.equal(sample.checks[0].passed, mode !== 'forced-negative');
          closeNumbers(sample.checks[0].actual.value, 96, 0.001);
        }
        let files = [];
        if (mode !== 'forced-negative') {
          assert.deepEqual(result.result.frameFiles.map(p => path.win32.normalize(p)), nativePaths);
          files = await script('read-only-png-file-proof', `rows = []
for filename in ${py(nativePaths)}:
    assert os.path.dirname(filename) == ${py(baseline.temp)}
    with open(filename, 'rb') as stream:
        content = stream.read()
    assert content[:8] == b'\\x89PNG\\r\\n\\x1a\\n' and content[12:16] == b'IHDR'
    width, height = struct.unpack('>II', content[16:24])
    assert (width, height) == (320, 240) and len(content) > 24
    rows.append(dict(path=filename, bytes=len(content), width=width, height=height, sha256=hashlib.sha256(content).hexdigest()))
${emit('rows')}`);
        }
        return { before, result, evidence, after, files, videoPublish: false };
      });
    } else report.tests.push({ name: 'motion-cases', status: 'blocked', reason: 'Fixture creation failed; no speculative motion.' });

    await test('native-workspace-storyboard-create-inspect-seek-empty-play-rejection', async () => {
      const activated = await cad('animation.workspace', { confirm: true });
      assert.equal(activated.result.workspaceActive, true);
      const made = await cad('animation.create', { confirm: true, clean: true });
      const list = await cad('animation.list');
      const ref = list.result.storyboards.find(b => b.ref.index === made.result.ref.index)?.ref;
      assert.ok(ref); assert.equal(ref.document, identity.creationId);
      await cad('animation.activate', { storyboard: ref, confirm: true });
      const inspected = await cad('animation.inspect', { storyboard: ref });
      assert.equal(inspected.result.end, 0, 'Clean storyboard must be empty; never play nonempty native actions');
      const seek = await cad('animation.seek', { storyboard: ref, seconds: 0, confirm: true });
      assert.equal(seek.result.playheadPosition, 0);
      await assert.rejects(() => cad('animation.play', { storyboard: ref, begin: 0, end: 0, confirm: true }), /Playback requires 0 <= begin < end <= storyboard.end/);
      const calls = report.requests.at(-1).observations.nativeCalls;
      assert.deepEqual(calls, [], 'Empty playback must reject before native play');
      const after = await cad('animation.inspect', { storyboard: ref });
      assert.equal(after.result.isInPlayMode, false); assert.equal(after.result.playheadPosition, 0);
      return { activated, made, list, inspected, seek, after, nativePlayCalls: calls };
    });
  } finally {
    if (identity && !uncertain) {
      await test('restore-original-workspace-before-owned-close', async () => {
        const cleanup = await script('SDK-UI-workspace-restore-and-close-owned-only', `workspace = app.userInterface.workspaces.itemById(${py(baseline.workspace)})
assert workspace is not None and workspace.isValid, 'Original workspace unavailable'
if app.userInterface.activeWorkspace != workspace:
    assert workspace.activate(), 'SDK UI workspace activation failed'
${guard()}
assert app.userInterface.activeWorkspace.id == ${py(baseline.workspace)}
closed_id = doc.creationId
assert doc.close(False), 'Owned close failed'
assert documents() == ${py(baseline.documents)}, 'User document state differs after close'
original = [d for d in app.documents if d.creationId == ${py(baseline.active)}]
if original:
    assert len(original) == 1 and original[0].isValid
    if app.activeDocument != original[0]:
        assert original[0].activate(), 'Restore original active document failed'
assert (app.activeDocument.creationId if app.activeDocument else None) == ${py(baseline.active)}
assert app.userInterface.activeWorkspace.id == ${py(baseline.workspace)}
assert documents() == ${py(baseline.documents)}
${emit('dict(closedCreationId=closed_id, environment=environment(), camera=camera_state() if app.activeDocument else None)')}`, { readOnly: false });
        report.cleanup = cleanup;
        closeNumbers(cleanup.camera, baseline.camera);
        return cleanup;
      });
    } else report.cleanup = { status: 'blocked', identity: identity || null,
      reason: uncertain ? 'Indeterminate request; no unsafe retry/close' : 'No confirmed owned creationId' };
    report.status = report.tests.every(t => t.status === 'pass') && report.cleanup?.closedCreationId ? 'pass' : 'fail';
    report.finishedAt = new Date().toISOString(); persist();
    process.exitCode = report.status === 'pass' ? 0 : 1;
  }
}

if (require.main === module) {
  // No network, report overwrite, or Fusion work without explicit opt-in.
  if (!process.argv.includes('--run')) {
    console.error('Not run: explicit --run required. Use the runner to select queue or direct scheduling.');
    process.exitCode = 2;
  } else main().catch(error => {
    report.status = 'fail'; report.error = error.stack; persist(); console.error(error); process.exitCode = 1;
  });
}
