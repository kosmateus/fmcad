import { pythonLiteral } from "../../packages/node-adapters/src/python/artifact";
import { emit, program } from "./programs";
import { nativeCadRuntime } from "./native-cad-runtime";

const inventory = `import adsk.core, adsk.fusion, json, math
from collections.abc import Mapping, Sequence
from typing import cast
app = adsk.core.Application.get()
def identity(d: adsk.core.Document) -> JsonRecord:
    file = d.dataFile
    return dict(name=d.name, creationId=d.creationId, fileId=file.id if file else None)
def doc_rows() -> list[JsonRecord]:
    return [dict(**identity(d), saved=d.isSaved, modified=d.isModified) for d in sorted(app.documents, key=lambda d: (d.creationId, d.name))]
def checked_doc(key: JsonValue) -> adsk.core.Document:
    matches = [d for d in app.documents if identity(d) == key]
    assert len(matches) == 1, 'Original document name/creationId/fileId guard failed'
    return matches[0]
def native_camera() -> JsonRecord:
    c = app.activeViewport.camera
    types = adsk.core.CameraTypes
    orthographic = cast(adsk.core.CameraTypes, types.OrthographicCameraType)
    perspective = cast(adsk.core.CameraTypes, types.PerspectiveCameraType)
    perspective_ortho = cast(adsk.core.CameraTypes, types.PerspectiveWithOrthoFacesCameraType)
    if c.cameraType == orthographic:
        name = 'OrthographicCameraType'
    elif c.cameraType == perspective:
        name = 'PerspectiveCameraType'
    else:
        assert c.cameraType == perspective_ortho, 'Unsupported original camera projection'
        name = 'PerspectiveWithOrthoFacesCameraType'
    result: JsonRecord = dict(eye=list(c.eye.asArray()), target=list(c.target.asArray()), up=list(c.upVector.asArray()), cameraType=name)
    if c.cameraType == orthographic:
        ok, width, height = c.getExtents()
        assert ok, 'Cannot read original camera extents'
        result['extents'] = [width, height]
    else:
        result['perspectiveAngle'] = c.perspectiveAngle
    return result
def document_context(d: adsk.core.Document) -> CadContext:
    file = d.dataFile
    return CadContext(d.name, doc_id=d.creationId, doc_file_id=file.id if file else None)
def object_value(value: JsonValue) -> Mapping[str, JsonValue]:
    assert isinstance(value, Mapping), 'Expected original view object'
    return value
def sequence_value(value: JsonValue) -> Sequence[JsonValue]:
    assert isinstance(value, Sequence) and not isinstance(value, str), 'Expected original view array'
    return value
def number_value(value: JsonValue) -> float:
    assert isinstance(value, (int, float)) and not isinstance(value, bool), 'Expected original view number'
    assert math.isfinite(value), 'Nonfinite original view number'
    return float(value)
`;

export function captureOriginalView(strictCamera = false): string {
  return (
    nativeCadRuntime(["camera.save", "camera.restore"]) +
    "\n" +
    program(`${inventory}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Close interactive command first'
assert app.activeDocument is not None, 'An active Design document is required for restorable camera capture'
original = app.activeDocument
ctx = document_context(original)
assert ctx.doc == original
before = doc_rows()
assert app.activeViewport.parentDocument == original, 'Original viewport document mismatch'
state = object_value(ctx.call('camera.save', {}))['state']
assert doc_rows() == before and app.activeDocument == original
${emit("dict(documents=before, active=identity(original), workspace=app.userInterface.activeWorkspace.id, camera=state, nativeCamera=native_camera(), restorationProfile=" + pythonLiteral(strictCamera ? "motion-absolute-1e-7" : "style-relative-1e-5") + ")")}`)
  );
}

export function restoreOriginalView(snapshot: Record<string, unknown>): string {
  return (
    nativeCadRuntime(["camera.save", "camera.restore"]) +
    "\n" +
    program(`${inventory}
snapshot: JsonRecord = ${pythonLiteral(snapshot)}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open during restore'
assert doc_rows() == snapshot['documents'], 'Other documents changed before original view restoration'
original = checked_doc(snapshot['active'])
assert original.activate()
assert doc_rows() == snapshot['documents']
workspace_id = snapshot['workspace']
assert isinstance(workspace_id, str)
workspace = app.userInterface.workspaces.itemById(workspace_id)
assert workspace is not None
if app.userInterface.activeWorkspace.id != workspace.id:
    assert workspace.activate()
assert app.activeDocument == original and doc_rows() == snapshot['documents']
assert app.activeViewport.parentDocument == original
ctx = document_context(original)
ctx.call('camera.restore', dict(state=snapshot['camera']))
assert doc_rows() == snapshot['documents']
actual = object_value(object_value(ctx.call('camera.save', {}))['state'])
expected = object_value(snapshot['camera'])
def near(a_value: JsonValue, b_value: JsonValue, absolute: float = 1e-10) -> None:
    a, b = number_value(a_value), number_value(b_value)
    assert abs(a-b) <= max(absolute, abs(b)*0.00001), 'Original camera readback differs'
for key in ('eye', 'target', 'up', 'extents'):
    if expected.get(key):
        actual_values = sequence_value(actual[key])
        expected_values = sequence_value(expected[key])
        assert len(actual_values) == len(expected_values)
        for a, b in zip(actual_values, expected_values):
            near(a, b, 1e-7)
assert actual['cameraType'] == expected['cameraType']
assert actual['document'] == expected['document']
assert actual['units'] == expected['units']
if 'perspectiveAngle' in expected:
    near(actual['perspectiveAngle'], expected['perspectiveAngle'])
native = native_camera()
if snapshot.get('restorationProfile') == 'motion-absolute-1e-7':
    def exact_numbers(a: JsonValue, b: JsonValue) -> None:
        if isinstance(b, (int, float)) and not isinstance(b, bool):
            assert abs(number_value(a)-number_value(b)) <= 1e-7, 'Original motion camera readback differs'
        elif isinstance(b, Mapping):
            actual_object = object_value(a)
            assert set(actual_object) == set(b)
            for key in b: exact_numbers(actual_object[key], b[key])
        elif isinstance(b, Sequence) and not isinstance(b, str):
            actual_values = sequence_value(a)
            assert len(actual_values) == len(b)
            for av, bv in zip(actual_values, b): exact_numbers(av, bv)
        else:
            assert a == b
    exact_numbers(native, snapshot['nativeCamera'])
assert identity(app.activeDocument) == snapshot['active']
assert app.userInterface.activeWorkspace.id == snapshot['workspace']
${emit("dict(restored=True, documents=doc_rows(), active=identity(app.activeDocument), workspace=app.userInterface.activeWorkspace.id, camera=actual, nativeCamera=native)")}`)
  );
}
