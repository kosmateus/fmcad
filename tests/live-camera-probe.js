// Explicit opt-in, addin-only, isolated native camera experiment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('./helpers/live-broker');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(__dirname, 'live-camera-probe.json');
const fixtureOnly = process.argv[2] === '--fixture';
const history = fixtureOnly ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
const report = { name: 'FMCAD_CAMERA_' + randomUUID().replaceAll('-', '_'), commands: [], variations: [] };
const { fixture: liveFixture } = require('./helpers/live-broker');
liveFixture(report.name);
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(history ? {
  ...history, fixtureRuns: [...(history.fixtureRuns || []), report],
} : report, null, 2) + '\n');
let identity;
let uncertain = false;
const helpers = `import adsk.core, adsk.fusion, json, math, os, tempfile
app = adsk.core.Application.get()
def docs():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified) for d in app.documents if _fmcad_live_visible(d)], key=lambda d: d['creationId'])
def xyz(v):
    return [v.x, v.y, v.z]
def state(c):
    result = dict(eye=xyz(c.eye), target=xyz(c.target), up=xyz(c.upVector), projection=int(c.cameraType), fit=c.isFitView, smooth=c.isSmoothTransition)
    result['fov'] = c.perspectiveAngle if c.cameraType != adsk.core.CameraTypes.OrthographicCameraType else None
    result['extents'] = list(c.getExtents()) if c.cameraType == adsk.core.CameraTypes.OrthographicCameraType else None
    return result
def quiet(c):
    c.isFitView = False
    c.isSmoothTransition = False
    return c
def pose(c, s):
    c.target = adsk.core.Point3D.create(*s['target'])
    c.eye = adsk.core.Point3D.create(*s['eye'])
    c.upVector = adsk.core.Vector3D.create(*s['up'])
`;
function script(label, body, mutation = false, guarded = true) {
  if (mutation && uncertain) throw new Error('Indeterminate transport: mutations stopped');
  const guard = guarded ? `matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)} and d.name == ${JSON.stringify(identity.name)}]
assert len(matches) == 1 and not matches[0].isSaved and app.activeDocument == matches[0], 'Owned active document guard failed'
doc = matches[0]
assert [d for d in docs() if d['creationId'] != doc.creationId] == json.loads(${JSON.stringify(JSON.stringify(report.baseline))}), 'Other document state changed'
vp = app.activeViewport
assert vp.parentDocument == doc, 'Viewport ownership mismatch'
` : '';
  const source = helpers + '\ndef run(_context):\n' + (guard + body).split('\n').map(s => '    ' + s).join('\n');
  const result = spawnSync(process.execPath, ['bin/fmcad.js', '--backend', 'addin', 'call', 'fusion_mcp_execute',
    JSON.stringify({ featureType: 'script', object: { script: source, readOnly: !mutation } }), '--timeout', '60000'],
  { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const row = { label, source, status: result.status, stdout: result.stdout, stderr: result.stderr };
  report.commands.push(row);
  persist();
  const lines = (result.stdout || '').split(/\r?\n/).filter(s => s.startsWith('CAMERA_PROBE '));
  if (result.error || result.signal || result.status === null || (result.status === 0 && lines.length !== 1)) {
    uncertain = true;
    throw new Error('Indeterminate transport: ' + label);
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(lines.length, 1, result.stdout);
  row.result = JSON.parse(lines[0].slice('CAMERA_PROBE '.length));
  persist();
  return row.result;
}
const output = expression => `print('CAMERA_PROBE ' + json.dumps(${expression}))`;

function fixture() {
  const bundle = ['core.py', 'io.py'].map(f => fs.readFileSync(path.join(root, 'assets/cad', f), 'utf8')).join('\n\n');
  const setup = `ns = {}
exec(${JSON.stringify(bundle)}, ns)
ctx = ns['CadContext'](${JSON.stringify(identity.name)}, 'root')
`;
  const cad = (op, data = {}) => script(op, setup + `result = ns['CAD_HANDLERS'][${JSON.stringify(op)}](ctx, json.loads(${JSON.stringify(JSON.stringify(data))}))
${output('result')}`, op !== 'camera.save');
  const equal = (actual, expected) => {
    assert.equal(actual.cameraType, expected.cameraType);
    for (const key of ['eye', 'target', 'up', 'extents']) {
      if (expected[key]) expected[key].forEach((v, i) => assert.ok(Math.abs(actual[key][i] - v) <= 0.00001,
        `${key}[${i}]: ${actual[key][i]} vs ${v}`));
    }
    if (expected.perspectiveAngle !== undefined) assert.ok(Math.abs(actual.perspectiveAngle - expected.perspectiveAngle) <= 0.00001);
  };
  const original = cad('camera.save').state;
  report.fixtureOriginal = original;
  try {
    report.perspective = cad('camera.set', { projection: 'perspective', perspectiveAngle: '40 deg',
      eye: ['80 mm', '60 mm', '50 mm'], target: ['10 mm', '6 mm', '5 mm'], up: [0, 0, 1], fit: false });
    const changed = cad('camera.save').state;
    report.perspectiveLater = changed;
    equal(changed, { cameraType: 'PerspectiveCameraType', eye: [8, 6, 5], target: [1, 0.6, 0.5],
      up: [0, 0, 1], perspectiveAngle: 40 * Math.PI / 180 });
    report.paths = script('allocate-image-paths', `paths = [os.path.join(tempfile.gettempdir(), ${JSON.stringify(report.name)} + '_' + label + '.png') for label in ('front', 'iso')]
assert not any(os.path.lexists(p) for p in paths)
${output('paths')}`);
    report.shots = cad('shot.pack', { shots: ['front', 'iso-top-right'].map((orientation, i) => ({
      path: report.paths[i], camera: { orientation, fit: true }, width: 640, height: 480,
    })) });
    equal(cad('camera.save').state, changed);
    report.pngs = script('verify-owned-images', `import struct
result = []
for p in json.loads(${JSON.stringify(JSON.stringify(report.paths))}):
    with open(p, 'rb') as f:
        header = f.read(24)
    assert header[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10])
    dimensions = struct.unpack('>II', header[16:24])
    assert dimensions == (640, 480)
    result.append(dict(path=p, bytes=os.path.getsize(p), dimensions=dimensions))
${output('result')}`);
    report.fixtureStatus = 'pass';
  } finally {
    report.finalRestore = cad('camera.restore', { state: original });
    report.finalRestoreLater = cad('camera.save').state;
    equal(report.finalRestoreLater, original);
  }
}

function main() {
  assert.ok(fixtureOnly || process.argv[2] === '--run', 'Explicit --run or --fixture required');
  report.baseline = script('baseline', output('docs()'), false, false);
  identity = script('create-owned-document', `assert docs() == json.loads(${JSON.stringify(JSON.stringify(report.baseline))})
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = ${JSON.stringify(report.name)}
${output("dict(name=doc.name, creationId=doc.creationId)")}`, true, false);
  report.identity = identity;
  liveFixture(identity.name, identity.creationId);
  try {
    report.original = script('initialize-owned-box', `design = adsk.fusion.Design.cast(app.activeProduct)
root = design.rootComponent
sketch = root.sketches.add(root.xYConstructionPlane)
sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0,0,0), adsk.core.Point3D.create(2,1.2,0))
root.features.extrudeFeatures.addSimple(sketch.profiles.item(0), adsk.core.ValueInput.createByReal(1), adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
c.isFitView = True
vp.camera = c
vp.refresh()
${output('state(vp.camera)')}`, true);
    const wanted = { eye: [8, 6, 5], target: [1, 0.6, 0.5], up: [0, 0, 1] };
    if (fixtureOnly) fixture();
    for (let variant = 1; !fixtureOnly && variant <= 6; variant++) {
      const row = { variant };
      report.variations.push(row);
      row.apply = script('variation-' + variant, `saved = json.loads(${JSON.stringify(JSON.stringify(report.original))})
wanted = json.loads(${JSON.stringify(JSON.stringify(wanted))})
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
vp.camera = c
c = quiet(vp.camera)
assert c.setExtents(*saved['extents'][1:])
pose(c, saved)
vp.camera = c
vp.refresh()
log = dict(before=state(vp.camera))
variant = ${variant}
c = quiet(adsk.core.Camera.create() if variant == 2 else vp.camera)
if variant == 3:
    pose(c, wanted)
c.cameraType = adsk.core.CameraTypes.PerspectiveCameraType
if variant in (4, 5):
    if variant == 5:
        c.perspectiveAngle = math.radians(40)
    log['stagePrepared'] = state(c)
    vp.camera = c
    log['stageApplied'] = state(vp.camera)
    c = quiet(vp.camera)
if variant != 5:
    c.perspectiveAngle = math.radians(40)
if variant != 3:
    pose(c, wanted)
log['prepared'] = state(c)
vp.camera = c
log['immediate'] = state(vp.camera)
if variant == 6:
    c = quiet(vp.camera)
    pose(c, wanted)
    log['repeatPrepared'] = state(c)
    vp.camera = c
    log['repeatApplied'] = state(vp.camera)
vp.refresh()
adsk.doEvents()
log['settled'] = state(vp.camera)
${output('log')}`, true);
      row.later = script('variation-' + variant + '-later', output('state(vp.camera)'));
      row.restore = script('variation-' + variant + '-restore', `saved = json.loads(${JSON.stringify(JSON.stringify(report.original))})
log = dict(before=state(vp.camera))
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
vp.camera = c
log['projectionApplied'] = state(vp.camera)
c = quiet(vp.camera)
assert c.setExtents(*saved['extents'][1:])
pose(c, saved)
log['prepared'] = state(c)
vp.camera = c
log['immediate'] = state(vp.camera)
vp.refresh()
adsk.doEvents()
log['settled'] = state(vp.camera)
${output('log')}`, true);
      row.restoreLater = script('variation-' + variant + '-restore-later', output('state(vp.camera)'));
      persist();
      console.log(JSON.stringify({ variant, eye: row.later.eye, fov: row.later.fov, restoredExtents: row.restoreLater.extents }));
    }
  } finally {
    if (!uncertain) report.cleanup = script('close-owned-document', `for p in json.loads(${JSON.stringify(JSON.stringify(report.paths || []))}):
    assert os.path.dirname(p) == tempfile.gettempdir() and os.path.basename(p).startswith(${JSON.stringify(report.name)} + '_')
    if os.path.isfile(p):
        os.remove(p)
assert doc.close(False)
${output('docs()')}`, true);
    report.uncertain = uncertain;
    persist();
  }
  assert.deepEqual(report.cleanup, report.baseline);
  if (fixtureOnly) console.log(JSON.stringify({ fixtureStatus: report.fixtureStatus, eye: report.perspectiveLater.eye,
    extents: report.finalRestoreLater.extents, pngs: report.pngs, cleanup: report.cleanup }));
}
try { main(); } catch (error) { report.error = error.stack; persist(); console.error(error.message); process.exitCode = 1; }
