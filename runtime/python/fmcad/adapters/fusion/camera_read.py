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
    if ctx.app.activeDocument != ctx.doc:
        raise ValueError('View operations require the explicitly scoped document to already be active; activate it first')
    viewport = ctx.app.activeViewport
    if viewport.parentDocument != ctx.doc:
        raise ValueError('Active viewport does not belong to the scoped document')
    return viewport


def _io_camera_identity(ctx: "_IoCameraReadContext") -> "JsonRecord":
    return {'creationId': ctx.doc.creationId, 'name': ctx.doc.name,
            'dataFileId': ctx.doc.dataFile.id if ctx.doc.dataFile else None}


def _io_camera_state(ctx: "_IoCameraReadContext",
                     camera: "adsk.core.Camera") -> "_IoCameraState":
    types = adsk.core.CameraTypes
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    name = next((n for n in names if _cad_cast("adsk.core.CameraTypes", getattr(types, n)) == camera.cameraType), None)
    if name is None:
        raise ValueError('Unsupported camera type; cannot provide a restorable snapshot')
    camera_type_name = _cad_cast("Literal['OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType']", name)
    state = _cad_cast("_IoCameraState", {'document': _io_camera_identity(ctx), 'eye': _cad_xyz(camera.eye),
             'target': _cad_xyz(camera.target), 'up': _cad_xyz(camera.upVector),
             'cameraType': camera_type_name, 'units': 'cm'})
    if name == 'OrthographicCameraType':
        if not hasattr(camera, 'getExtents'):
            raise ValueError('Installed API lacks Camera.getExtents; update Fusion to capture restorable orthographic views')
        ok, width, height = camera.getExtents()
        _cad_require_result(ok, 'Read camera extents')
        state['extents'] = [width, height]
    else:
        state['perspectiveAngle'] = camera.perspectiveAngle
    return state


def _io_camera_save(c: "CadContext", d: "JsonObject") -> "JsonValue":
    _cad_fields(d)
    return {'state': _cad_cast("JsonRecord", _io_camera_state(c, _io_camera_viewport(c).camera))}


setattr(_io_camera_save, '__name__', '<lambda>')
