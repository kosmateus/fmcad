"""Read-only camera snapshot handler."""


if _CAD_TYPE_CHECKING:
    from typing import Literal as _IoCameraLiteral
    from typing import NotRequired as _IoCameraNotRequired

    class _IoCameraReadContext(_CadProtocol):
        app: adsk.core.Application
        doc: adsk.core.Document

    class _IoCameraState(_CadTypedDict):
        document: JsonRecord
        eye: list[float]
        target: list[float]
        up: list[float]
        cameraType: _IoCameraLiteral['OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType']
        units: _IoCameraLiteral['cm']
        extents: _IoCameraNotRequired[list[float]]
        perspectiveAngle: _IoCameraNotRequired[float]


def _io_camera_viewport(ctx: "_IoCameraReadContext") -> "adsk.core.Viewport":
    return _camera_active_viewport(ctx.app, ctx.doc)


def _camera_active_viewport(app: "adsk.core.Application", doc: "adsk.core.Document") -> "adsk.core.Viewport":
    if app.activeDocument != doc:
        raise ValueError('View operations require the explicitly scoped document to already be active; activate it first')
    viewport = app.activeViewport
    if viewport.parentDocument != doc:
        raise ValueError('Active viewport does not belong to the scoped document')
    return viewport


def _io_camera_identity(ctx: "_IoCameraReadContext") -> "JsonRecord":
    return _camera_document_identity(ctx.doc)


def _camera_document_identity(doc: "adsk.core.Document") -> "JsonRecord":
    file = doc.dataFile
    return {'creationId': doc.creationId, 'name': doc.name,
            'dataFileId': file.id if file else None}


def _io_camera_state(ctx: "_IoCameraReadContext",
                     camera: "adsk.core.Camera") -> "_IoCameraState":
    return _camera_pose(ctx.doc, camera)


def _camera_pose(doc: "adsk.core.Document", camera: "adsk.core.Camera") -> "_IoCameraState":
    types = adsk.core.CameraTypes
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    projection = camera.cameraType
    name = next((n for n in names if _cad_cast("adsk.core.CameraTypes", getattr(types, n)) == projection), None)
    if name is None:
        raise ValueError('Unsupported camera type; cannot provide a restorable snapshot')
    state = _cad_cast("_IoCameraState", {'document': _camera_document_identity(doc), 'eye': _cad_xyz(camera.eye),
             'target': _cad_xyz(camera.target), 'up': _cad_xyz(camera.upVector),
             'cameraType': name, 'units': 'cm'})
    if name == 'OrthographicCameraType':
        if not hasattr(camera, 'getExtents'):
            raise ValueError('Installed API lacks Camera.getExtents; update Fusion to capture restorable orthographic views')
        ok, width, height = camera.getExtents()
        if not ok:
            raise RuntimeError('Read camera extents failed; inspect the document for partial changes')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def _camera_read(app: "adsk.core.Application", doc: "adsk.core.Document") -> "JsonRecord":
    return {'state': _cad_cast("JsonRecord", _camera_pose(doc, _camera_active_viewport(app, doc).camera))}


def _io_camera_save(c: "CadContext", d: "JsonObject") -> "JsonValue":
    _cad_fields(d)
    return _camera_read(c.app, c.doc)


setattr(_io_camera_save, '__name__', '<lambda>')
