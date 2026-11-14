import { pythonValue } from "../../packages/node-adapters/src/python/artifact";
import { emit, program } from "./programs";
import { nativeCadRuntime } from "./native-cad-runtime";

const inventory = `import adsk.core, adsk.fusion, json, math
app = adsk.core.Application.get()
def identity(d):
    file = d.dataFile
    return dict(name=d.name, creationId=d.creationId, fileId=file.id if file else None)
def doc_rows():
    return sorted([dict(**identity(d), saved=d.isSaved, modified=d.isModified) for d in app.documents], key=lambda r: (r['creationId'], r['name']))
def checked_doc(key):
    matches = [d for d in app.documents if identity(d) == key]
    assert len(matches) == 1, 'Original document name/creationId/fileId guard failed'
    return matches[0]
def native_camera():
    c = app.activeViewport.camera
    return dict(eye=list(c.eye.asArray()), target=list(c.target.asArray()), up=list(c.upVector.asArray()), cameraType=int(c.cameraType), viewExtents=c.viewExtents, perspectiveAngle=c.perspectiveAngle)
def context(d):
    key = identity(d)
    return CadContext(d.name, doc_id=key['creationId'], doc_file_id=key['fileId'])
`;

export function captureOriginalView(strictCamera = false): string {
  return (
    nativeCadRuntime() +
    "\n" +
    program(`${inventory}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Close interactive command first'
assert app.activeDocument is not None, 'An active Design document is required for restorable camera capture'
original = app.activeDocument
ctx = context(original)
assert ctx.doc == original
before = doc_rows()
assert app.activeViewport.parentDocument == original, 'Original viewport document mismatch'
state = ctx.call('camera.save', {})['state']
assert doc_rows() == before and app.activeDocument == original
${emit("dict(documents=before, active=identity(original), workspace=app.userInterface.activeWorkspace.id, camera=state, nativeCamera=native_camera(), restorationProfile=" + pythonValue(strictCamera ? "motion-absolute-1e-7" : "style-relative-1e-5") + ")")}`)
  );
}

export function restoreOriginalView(snapshot: Record<string, unknown>): string {
  return (
    nativeCadRuntime() +
    "\n" +
    program(`${inventory}
snapshot = ${pythonValue(snapshot)}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open during restore'
assert doc_rows() == snapshot['documents'], 'Other documents changed before original view restoration'
original = checked_doc(snapshot['active'])
assert original.activate()
assert doc_rows() == snapshot['documents']
workspace = app.userInterface.workspaces.itemById(snapshot['workspace'])
assert workspace is not None
if app.userInterface.activeWorkspace.id != workspace.id:
    assert workspace.activate()
assert app.activeDocument == original and doc_rows() == snapshot['documents']
assert app.activeViewport.parentDocument == original
ctx = context(original)
ctx.call('camera.restore', dict(state=snapshot['camera']))
assert doc_rows() == snapshot['documents']
actual = ctx.call('camera.save', {})['state']
expected = snapshot['camera']
def near(a, b, absolute=1e-10):
    assert math.isfinite(a) and math.isfinite(b)
    assert abs(a-b) <= max(absolute, abs(b)*0.00001), 'Original camera readback differs'
for key in ('eye', 'target', 'up', 'extents'):
    if expected.get(key):
        assert len(actual[key]) == len(expected[key])
        for a, b in zip(actual[key], expected[key]):
            near(a, b, 1e-7)
assert actual['cameraType'] == expected['cameraType']
assert actual['document'] == expected['document']
assert actual['units'] == expected['units']
if 'perspectiveAngle' in expected:
    near(actual['perspectiveAngle'], expected['perspectiveAngle'])
native = native_camera()
if snapshot.get('restorationProfile') == 'motion-absolute-1e-7':
    def exact_numbers(a, b):
        if isinstance(b, (int, float)):
            assert math.isfinite(a) and abs(a-b) <= 1e-7, 'Original motion camera readback differs'
        elif isinstance(b, list):
            assert len(a) == len(b)
            for av, bv in zip(a, b): exact_numbers(av, bv)
        elif isinstance(b, dict):
            assert set(a) == set(b)
            for key in b: exact_numbers(a[key], b[key])
        else:
            assert a == b
    exact_numbers(native, snapshot['nativeCamera'])
assert identity(app.activeDocument) == snapshot['active']
assert app.userInterface.activeWorkspace.id == snapshot['workspace']
${emit("dict(restored=True, documents=doc_rows(), active=identity(app.activeDocument), workspace=app.userInterface.activeWorkspace.id, camera=actual, nativeCamera=native)")}`)
  );
}
