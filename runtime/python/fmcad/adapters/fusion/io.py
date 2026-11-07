"""Document-scoped I/O. Paths are local to the machine running Fusion.

API reference: Autodesk Fusion API Camera/Viewport, SectionAnalyses.createInput,
Canvas.transform (Matrix2D), ImportManager, ExportManager, Materials.addByCopy,
Appearances.addByCopy. No UI text commands, downloads, or implicit document saves.
"""
import os.path as _io_os_path
from collections.abc import Mapping as _IoMapping, Sequence as _IoSequence
from pathlib import Path as _IoPath
from typing import NotRequired as _io_NotRequired


if _CAD_TYPE_CHECKING:
    class _IoCameraState(_CadTypedDict):
        document: JsonRecord
        eye: list[float]
        target: list[float]
        up: list[float]
        cameraType: Literal['OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType']
        units: Literal['cm']
        extents: _io_NotRequired[list[float]]
        perspectiveAngle: _io_NotRequired[float]

    class _IoVisibilityRow(_CadTypedDict):
        ref: JsonValue
        isLightBulbOn: bool

    class _IoVisibilityState(_CadTypedDict):
        document: JsonRecord
        items: list[_IoVisibilityRow]

    class _IoShot(_CadTypedDict):
        path: JsonValue
        camera: _io_NotRequired[JsonValue]
        width: _io_NotRequired[JsonValue]
        height: _io_NotRequired[JsonValue]
        visibility: _io_NotRequired[JsonValue]
        sections: _io_NotRequired[JsonValue]
        activeComponent: _io_NotRequired[JsonValue]

    class _IoSectionRow(_CadTypedDict):
        name: str
        isLightBulbOn: bool

    class _IoPixelFrame(_CadTypedDict):
        name: str
        path: str
        width: int | None
        height: int | None
        direction: list[float]

    class _IoReadbackRecord(_CadTypedDict, total=False):
        name: str
        status: str
        expected: object
        observed: object
        type: str
        message: str
        steps: "_IoSequence[JsonRecord | _IoReadbackRecord]"

    class _IoBounds(_CadTypedDict):
        min: list[float]
        max: list[float]
        size: list[float]

    class _IoStyleRef(_CadTypedDict):
        id: str
        name: str

    class _IoStyleResolution(_CadTypedDict):
        selected: _IoStyleRef
        candidates: list[_IoStyleRef]
        ambiguous: bool
        precedence: str

    class _IoStyleState(_CadTypedDict):
        ref: JsonRecord
        scope: str
        definition: JsonRecord | None
        appearance: _IoStyleRef | None
        appearanceSource: str | None
        appearanceOverride: bool | None
        appearanceOverrideScope: str | None
        material: _IoStyleRef | None
        materialReadFrom: JsonRecord
        materialSource: str
        materialInheritance: str

    class _IoLightBulb(_Protocol):
        @property
        def isLightBulbOn(self) -> bool: ...

        @isLightBulbOn.setter
        def isLightBulbOn(self, value: bool) -> None: ...


def _io_json_object(value: "JsonValue", label: str) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    entries = _cad_cast("dict[object, JsonValue]", value)
    if any(not isinstance(key, str) for key in entries):
        raise ValueError(label + ' keys must be strings')
    return _cad_cast("JsonObject", entries)


def _io_camera_vector(value: "JsonValue", label: str, count: int) -> "list[float]":
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(label + ' must contain ' + str(count) + ' finite numbers')
    result: list[float] = []
    for coordinate in value:
        if type(coordinate) not in (int, float):
            raise ValueError(label + ' must contain ' + str(count) + ' finite numbers')
        number = _cad_cast("int | float", coordinate)
        if not math.isfinite(number):
            raise ValueError(label + ' must contain ' + str(count) + ' finite numbers')
        result.append(float(number))
    return result


def _io_camera_snapshot(value: "JsonValue | _IoCameraState") -> "_IoCameraState":
    state = _io_json_object(_cad_cast("JsonValue", value), 'Camera state')
    _cad_fields(state, ('document', 'eye', 'target', 'up', 'cameraType', 'units'),
                ('extents', 'perspectiveAngle'))
    document = _io_json_object(state['document'], 'Camera state document')
    eye = _io_camera_vector(state['eye'], 'Snapshot points', 3)
    target = _io_camera_vector(state['target'], 'Snapshot points', 3)
    up = _io_camera_vector(state['up'], 'Snapshot up vector', 3)
    camera_type = state['cameraType']
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    if not isinstance(camera_type, str) or camera_type not in names:
        raise ValueError('Unsupported snapshot cameraType')
    if state['units'] != 'cm':
        raise ValueError('Camera snapshot units must be cm')
    if camera_type == 'OrthographicCameraType':
        extents_value = state.get('extents')
        if extents_value is None:
            raise ValueError('Camera extents must be two positive finite cm values')
        extents = _io_camera_vector(extents_value, 'Camera extents', 2)
        if any(extent <= 0 for extent in extents):
            raise ValueError('Camera extents must be two positive finite cm values')
        state['extents'] = extents
    else:
        angle = state.get('perspectiveAngle')
        if angle is None or type(angle) not in (int, float):
            raise ValueError('Perspective angle must be between zero and pi radians')
        angle_value = _cad_cast("int | float", angle)
        if not math.isfinite(angle_value) or not 0 < angle_value < math.pi:
            raise ValueError('Perspective angle must be between zero and pi radians')
        state['perspectiveAngle'] = float(angle_value)
    state.update(document=document, eye=eye, target=target, up=up, units='cm')
    return _cad_cast("_IoCameraState", state)


def _io_visibility_row(value: "JsonValue") -> "_IoVisibilityRow":
    row = _io_json_object(value, 'Visibility row')
    _cad_fields(row, ('ref', 'isLightBulbOn'))
    if type(row['isLightBulbOn']) is not bool:
        raise ValueError('Visibility rows require isLightBulbOn:boolean')
    return _cad_cast("_IoVisibilityRow", row)


def _io_section_row(value: "JsonValue") -> "_IoSectionRow":
    row = _io_json_object(value, 'Section row')
    _cad_fields(row, ('name', 'isLightBulbOn'))
    name, visible = row['name'], row['isLightBulbOn']
    if not isinstance(name, str) or type(visible) is not bool:
        raise ValueError('Section rows require {name, isLightBulbOn:boolean}')
    return {'name': name, 'isLightBulbOn': visible}


def _io_pair_lengths(ctx: "CadContext", value: "JsonValue", label: str) -> "list[float]":
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(label + ' must contain two length expressions')
    return [ctx.length(coordinate) for coordinate in value]


def _io_shot(value: "JsonValue") -> "_IoShot":
    shot = _io_json_object(value, 'shot')
    _cad_fields(shot, ('path',), ('camera', 'width', 'height', 'visibility', 'sections', 'activeComponent'))
    return _cad_cast("_IoShot", shot)


def _io_visibility_state(value: "JsonValue") -> "_IoVisibilityState":
    state = _io_json_object(value, 'Visibility state')
    _cad_fields(state, ('document', 'items'))
    document = _io_json_object(state['document'], 'Visibility state document')
    if not isinstance(state['items'], list):
        raise ValueError('Visibility state items must be an array')
    rows = [_io_visibility_row(item) for item in state['items']]
    return _cad_cast("_IoVisibilityState", {'document': document, 'items': rows})


def _io_style_value(value: "_CadStyle | None") -> "_IoStyleRef | None":
    return {'id': value.id, 'name': value.name} if value is not None else None


def _io_path(ctx: "CadContext", data: "JsonObject", key: str = 'path',
             output: bool = False, suffixes: "tuple[str, ...] | None" = None) -> _IoPath:
    value = data[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(key + ' must be a nonempty absolute Fusion-machine path')
    path = _IoPath(value)
    if not path.is_absolute():
        raise ValueError('Use an absolute path on the machine running Fusion; the integrator maps client paths')
    if suffixes and path.suffix.lower() not in suffixes:
        raise ValueError('Expected extension: ' + ', '.join(suffixes))
    if output:
        if not path.parent.is_dir():
            raise ValueError('Output parent directory must already exist on the Fusion machine')
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('Output must be a regular file, not a directory or symbolic link')
        if path.exists():
            if data.get('overwrite') is not True:
                raise ValueError('Existing output requires overwrite: true and confirm: true')
            ctx.require_confirm(data)
    elif not path.is_file():
        raise ValueError('Input file does not exist on the machine running Fusion: ' + str(path))
    return path


def _io_file(path: _IoPath) -> "JsonRecord":
    exists = path.is_file()
    return {'path': str(path), 'exists': exists, 'bytes': path.stat().st_size if exists else None,
            'pathHost': 'machine running Fusion', 'geometryVerified': False}


def _io_viewport(ctx: "CadContext") -> "adsk.core.Viewport":
    if ctx.app.activeDocument != ctx.doc:
        raise ValueError('View operations require the explicitly scoped document to already be active; activate it first')
    viewport = ctx.app.activeViewport
    if viewport.parentDocument != ctx.doc:
        raise ValueError('Active viewport does not belong to the scoped document')
    return viewport


def _io_identity(ctx: "CadContext") -> "JsonRecord":
    return {'creationId': ctx.doc.creationId, 'name': ctx.doc.name,
            'dataFileId': ctx.doc.dataFile.id if ctx.doc.dataFile else None}


def _io_state_doc(ctx: "CadContext", state: "_IoVisibilityState | _IoCameraState") -> None:
    if state.get('document') != _io_identity(ctx):
        raise ValueError('State belongs to a different document; recapture state for this document')


def _io_visibility(ctx: "CadContext", data: "JsonObject", action: str) -> "JsonRecord":
    _cad_fields(data, ('state',) if action == 'restore' else ('refs',),
                ('scope',) if action == 'isolate' else ())
    if action == 'restore':
        state = _io_visibility_state(data['state'])
        _io_state_doc(ctx, state)
        rows = state['items']
        entities = [ctx.resolve(r['ref']) for r in rows]
        values = [r['isLightBulbOn'] for r in rows]
    else:
        if not isinstance(data['refs'], list) or not data['refs']:
            raise ValueError('refs must be a nonempty array')
        selected = [ctx.resolve(r) for r in data['refs']]
        entities = selected
        values = [action == 'show'] * len(entities)
        if action == 'isolate':
            if not isinstance(data.get('scope'), list) or not data['scope']:
                raise ValueError('isolate requires explicit scope refs; use sibling bodies or sibling occurrences')
            scope = _cad_cast("list[JsonValue]", data['scope'])
            entities = [ctx.resolve(ref) for ref in scope]
            if any(e not in entities for e in selected):
                raise ValueError('Every selected ref must be in isolate scope')
            values = [e in selected for e in entities]
        if any(not hasattr(e, 'isLightBulbOn') for e in entities):
            raise ValueError('Target lacks isLightBulbOn; select bodies, occurrences, sketches, or construction geometry')
    targets = [_cad_cast("_IoLightBulb", entity) for entity in entities]
    before = {'document': _io_identity(ctx), 'items': [
        {'ref': ctx.ref(entity), 'isLightBulbOn': target.isLightBulbOn}
        for entity, target in zip(entities, targets)]}
    for entity, value in zip(targets, values):
        entity.isLightBulbOn = value
    return {'restoreState': before, 'items': [
        {'ref': ctx.ref(entity), 'isLightBulbOn': target.isLightBulbOn,
         'isVisible': getattr(entity, 'isVisible', None)}
        for entity, target in zip(entities, targets)],
        'limitations': ['Only specified light bulbs change; ancestor and folder visibility can still hide entities.']}


def _io_camera_state(ctx: "CadContext", camera: "adsk.core.Camera") -> "_IoCameraState":
    types = adsk.core.CameraTypes
    names = ('OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType')
    name = next((n for n in names if _cad_cast("adsk.core.CameraTypes", getattr(types, n)) == camera.cameraType), None)
    if name is None:
        raise ValueError('Unsupported camera type; cannot provide a restorable snapshot')
    camera_type_name = _cad_cast("Literal['OrthographicCameraType', 'PerspectiveCameraType', 'PerspectiveWithOrthoFacesCameraType']", name)
    state = _cad_cast("_IoCameraState", {'document': _io_identity(ctx), 'eye': _cad_xyz(camera.eye),
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


def _io_camera_from_state(ctx: "CadContext", value: "JsonValue | _IoCameraState",
                          validate_only: bool = False) -> "adsk.core.Camera | None":
    state = _io_camera_snapshot(value)
    _io_state_doc(ctx, state)
    camera_type = _cad_cast("adsk.core.CameraTypes", getattr(adsk.core.CameraTypes, state['cameraType']))
    points: list[adsk.core.Point3D] = []
    for xyz in (state['eye'], state['target']):
        point = adsk.core.Point3D.create(*xyz)
        if point is None:
            raise ValueError('Snapshot points must contain three finite numbers')
        points.append(point)
    direction = _cad_direction([b - a for a, b in zip(state['eye'], state['target'])])
    up = _cad_direction(state['up'])
    if abs(sum(a * b for a, b in zip(direction, up))) > 1 - 1e-9:
        raise ValueError('Camera up must not be parallel to sight direction')
    extents = state.get('extents')
    angle = state.get('perspectiveAngle')
    if state['cameraType'] == 'OrthographicCameraType':
        if extents is None or any(not math.isfinite(value) or value <= 0 for value in extents):
            raise ValueError('Camera extents must be two positive finite cm values')
    else:
        if angle is None or not 0 < angle < math.pi:
            raise ValueError('Perspective angle must be between zero and pi radians')
    if validate_only:
        return
    # Validation must not exercise native camera setters.
    camera = _io_viewport(ctx).camera
    camera.isFitView = False
    camera.isSmoothTransition = False
    if camera.cameraType != camera_type:
        camera.cameraType = camera_type
    if state['cameraType'] == 'OrthographicCameraType':
        if extents is None:
            raise ValueError('Camera extents must be two positive finite cm values')
        _cad_require_result(camera.setExtents(*extents), 'Set camera extents')
    elif angle is not None and camera.perspectiveAngle != angle:
        camera.perspectiveAngle = angle
    # Projection/framing setters can adjust the pose. Explicit pose takes precedence.
    camera.target = points[1]
    camera.eye = points[0]
    camera.upVector = adsk.core.Vector3D.create(*up)
    camera.isFitView = False
    camera.isSmoothTransition = False
    return camera


def _io_camera_apply(ctx: "CadContext", state: "_IoCameraState",
                     orientation: "adsk.core.ViewOrientations | None" = None,
                     fit: bool = False) -> None:
    viewport = _io_viewport(ctx)
    before = _io_camera_state(ctx, viewport.camera)
    _io_camera_from_state(ctx, state, validate_only=True)

    def apply(snapshot: "_IoCameraState", view: "adsk.core.ViewOrientations | None" = None,
              fit_view: bool = False) -> None:
        current = viewport.camera
        camera_type = _cad_cast("adsk.core.CameraTypes", getattr(adsk.core.CameraTypes, snapshot['cameraType']))
        projection_changed = current.cameraType != camera_type
        perspective = snapshot['cameraType'] != 'OrthographicCameraType'
        perspective_angle = snapshot.get('perspectiveAngle')
        if perspective and perspective_angle is None:
            raise ValueError('Perspective angle must be between zero and pi radians')
        if perspective:
            if perspective_angle is None:
                raise ValueError('Perspective angle must be between zero and pi radians')
            if projection_changed or current.perspectiveAngle != perspective_angle:
                current.isFitView = False
                current.isSmoothTransition = False
                if projection_changed:
                    current.cameraType = camera_type
                current.perspectiveAngle = perspective_angle
                viewport.camera = current
        elif projection_changed:
            current.isFitView = False
            current.isSmoothTransition = False
            current.cameraType = camera_type
            viewport.camera = current
            # Native projection/FOV application can move the eye. Read back the
            # settled lens before applying explicit pose and orthographic extents.
        prepared = _cad_require_result(_io_camera_from_state(ctx, snapshot), 'Prepare camera snapshot')
        if view is not None:
            prepared.viewOrientation = view
        prepared.isFitView = fit_view
        viewport.camera = prepared

    try:
        apply(state, orientation, fit)
    except Exception as error:
        try:
            apply(before)
        except Exception as restore_error:
            raise RuntimeError('Camera apply failed: ' + str(error) +
                               '; camera rollback also failed: ' + str(restore_error)) from error
        raise


def _io_camera(ctx: "CadContext", data: "JsonObject", action: str) -> "JsonRecord":
    if action == 'save':
        _cad_fields(data)
        return {'state': _cad_cast("JsonRecord", _io_camera_state(ctx, _io_viewport(ctx).camera))}
    _cad_fields(data, ('state',) if action == 'restore' else (),
                () if action == 'restore' else ('orientation', 'eye', 'target', 'up', 'projection', 'extents', 'perspectiveAngle', 'fit'))
    viewport = _io_viewport(ctx)
    before = _io_camera_state(ctx, viewport.camera)
    orientation = None
    fit = False
    if action == 'restore':
        state = _io_camera_snapshot(data['state'])
    else:
        state = _cad_cast("_IoCameraState", dict(before))
        if not data:
            raise ValueError('camera.set requires at least one camera setting')
        for key in ('eye', 'target'):
            if key in data:
                state[key] = _cad_xyz(ctx.point(data[key]))
        if 'up' in data:
            state['up'] = _io_camera_vector(data['up'], 'Snapshot up vector', 3)
        if 'projection' in data:
            projections: dict[str, Literal['OrthographicCameraType', 'PerspectiveCameraType']] = {
                'orthographic': 'OrthographicCameraType', 'perspective': 'PerspectiveCameraType'}
            projection = data['projection']
            if not isinstance(projection, str) or projection not in projections:
                raise ValueError('projection must be orthographic or perspective')
            state['cameraType'] = projections[projection]
        if 'extents' in data:
            extent_values = data['extents']
            if not isinstance(extent_values, list) or len(extent_values) != 2:
                raise ValueError('Camera extents must be two positive finite cm values')
            state['extents'] = [ctx.length(value) for value in extent_values]
        if state['cameraType'] == 'OrthographicCameraType' and 'extents' not in state:
            raise ValueError('Switching to orthographic requires extents')
        if 'perspectiveAngle' in data:
            state['perspectiveAngle'] = ctx.angle(data['perspectiveAngle'])
        if state['cameraType'] != 'OrthographicCameraType' and 'perspectiveAngle' not in state:
            raise ValueError('Switching to perspective requires perspectiveAngle')
        if state['cameraType'] == 'OrthographicCameraType' and 'perspectiveAngle' in data:
            raise ValueError('perspectiveAngle requires perspective projection')
        if state['cameraType'] != 'OrthographicCameraType' and 'extents' in data:
            raise ValueError('extents requires orthographic projection')
        if 'orientation' in data:
            if any(k in data for k in ('eye', 'up')):
                raise ValueError('orientation cannot be combined with eye or up (a named orientation fixes the direction and up); use target, extents, fit, projection and perspectiveAngle for framing')
            orientations = {'front': 'Front', 'back': 'Back', 'top': 'Top', 'bottom': 'Bottom',
                            'left': 'Left', 'right': 'Right', 'iso-top-left': 'IsoTopLeft',
                            'iso-top-right': 'IsoTopRight', 'iso-bottom-left': 'IsoBottomLeft',
                            'iso-bottom-right': 'IsoBottomRight'}
            orientation_name = data['orientation']
            if not isinstance(orientation_name, str) or orientation_name not in orientations:
                raise ValueError('Unsupported orientation: ' + str(orientation_name))
            orientation = _cad_cast("adsk.core.ViewOrientations",
                                    getattr(adsk.core.ViewOrientations, orientations[orientation_name] + 'ViewOrientation'))
        fit_value = data.get('fit', False)
        if type(fit_value) is not bool:
            raise ValueError('fit must be boolean')
        fit = fit_value
    _io_camera_apply(ctx, state, orientation, fit)
    return {'restoreState': _cad_cast("JsonRecord", before),
            'state': _cad_cast("JsonRecord", _io_camera_state(ctx, viewport.camera)),
            'limitations': ['Restoring to a different viewport aspect ratio can change framing.']}


def _io_cleanup(primary: "BaseException | None",
                actions: "Sequence[tuple[str, Callable[[], object]]]") -> None:
    """Attempt each cleanup; retain a pending failure as the aggregate's cause."""
    errors: list[JsonRecord] = []
    first_error: BaseException | None = None
    for action, cleanup in actions:
        try:
            cleanup()
        except Exception as error:
            if first_error is None:
                first_error = error
            errors.append({'action': action, 'type': type(error).__name__, 'message': str(error)})
    if errors:
        payload = {'primaryError': None if primary is None else {
            'type': type(primary).__name__, 'message': str(primary)}, 'cleanupErrors': errors}
        raise RuntimeError('I/O cleanup failed: ' + json.dumps(payload)) from (
            primary if primary is not None else first_error)


def _io_vis_chain(entity: "CadEntity") -> "list[CadEntity]":
    chain: list[CadEntity] = [entity]
    seen: set[int] = {id(entity)}
    current: CadEntity = entity
    while True:
        parent = _cad_cast("adsk.fusion.Occurrence | None", getattr(current, 'assemblyContext', None))
        if parent is None or id(parent) in seen:
            break
        chain.append(parent)
        seen.add(id(parent))
        current = parent
    return chain


def _io_capture_bulbs(entities: "Iterable[CadEntity]") -> "list[tuple[CadEntity, bool | None, bool, bool]]":
    rows: list[tuple[CadEntity, bool | None, bool, bool]] = []
    seen: list[CadEntity] = []
    for entity in entities:
        for target in _io_vis_chain(entity):
            if not any(target is other for other in seen):
                seen.append(target)
                try:
                    value = _cad_cast("_IoLightBulb", target).isLightBulbOn
                    rows.append((target, _cad_cast("bool | None", value), True, True))
                except AttributeError:
                    rows.append((target, None, False, False))
                except Exception:
                    rows.append((target, None, True, False))
    return rows


def _io_apply_bulb(target: "CadEntity", value: bool) -> "JsonRecord":
    try:
        _cad_cast("_IoLightBulb", target).isLightBulbOn
    except AttributeError:
        return {'status': 'unsupported'}
    except Exception:
        return {'status': 'unknown'}
    try:
        _cad_cast("_IoLightBulb", target).isLightBulbOn = value
        observed = _cad_cast("bool | None", _cad_cast("_IoLightBulb", target).isLightBulbOn)
    except AttributeError:
        return {'status': 'unsupported'}
    except Exception as error:
        return {'status': 'failed', 'error': {
            'type': type(error).__name__, 'message': str(error)}}
    return {'status': capture_apply_status(value, observed),
            'expected': value, 'observed': observed}


def _io_restore_bulbs(rows: "Iterable[tuple[CadEntity, bool | None, bool, bool]]") -> "list[JsonRecord]":
    results: list[JsonRecord] = []
    for target, value, supported, readable in rows:
        if not supported:
            results.append({'status': 'unsupported'})
            continue
        if not readable or value is None:
            results.append({'status': 'unknown'})
            continue
        try:
            _cad_cast("_IoLightBulb", target).isLightBulbOn = value
            observed = _cad_cast("bool | None", _cad_cast("_IoLightBulb", target).isLightBulbOn)
            results.append({'status': capture_restore_status(value, observed),
                            'expected': value, 'observed': observed})
        except AttributeError:
            results.append({'status': 'unsupported'})
        except Exception as error:
            results.append({'status': 'failed', 'error': {
                'type': type(error).__name__, 'message': str(error)}})
    return results


def _io_section_by_name(ctx: "CadContext", name: str) -> "adsk.fusion.SectionAnalysis":
    sections = ctx.design.analyses.sectionAnalyses
    return _cad_unique([s for s in _cad_items(sections) if s.name == name], 'Section name')


def _io_restore_raise(errors: "Sequence[_IoMapping[str, object]]", label: str) -> None:
    if any(row.get('status') == 'failed' for row in errors):
        raise RuntimeError(label + ' failed: ' + json.dumps(errors, default=str))


def _io_activate_component(ctx: "CadContext", entity: "CadEntity") -> bool:
    """Activate a component/occurrence through the public SDK.

    Fusion has no ``Component.activate``; the root component is activated via
    ``Design.activateRootComponent`` and a nested component is activated through
    its placed ``Occurrence.activate``. A bare non-root component definition with
    no placed occurrence cannot be activated and is refused honestly.
    """
    if _cad_kind(entity) == 'occurrence':
        return _cad_cast("adsk.fusion.Occurrence", entity).activate()
    if entity == ctx.root:
        return ctx.design.activateRootComponent()
    for occurrence in _cad_items(ctx.root.allOccurrences):
        if getattr(occurrence, 'component', None) is entity:
            return occurrence.activate()
    raise ValueError('activeComponent resolves to a non-root component with no placed occurrence; '
                     'the public SDK cannot activate a bare component definition')


def _io_shot_presentation(ctx: "CadContext", shot: "_IoShot",
                          restore_actions: "list[tuple[str, Callable[[], object]]]",
                          captured: "dict[str, object]",
                          application_results: "list[_IoReadbackRecord]",
                          restoration_results: "list[_IoReadbackRecord]") -> None:
    if 'visibility' in shot:
        visibility = shot['visibility']
        if not isinstance(visibility, list) or not visibility:
            raise ValueError('visibility must be a nonempty array of {ref, isLightBulbOn}')
        entities: list[CadEntity] = []
        values: list[bool] = []
        for row_value in visibility:
            row = _io_visibility_row(row_value)
            entities.append(ctx.resolve(row['ref']))
            values.append(row['isLightBulbOn'])
        bulbs = _io_capture_bulbs(entities)
        captured['bulbs'] = bulbs
        def restore_visibility(bulbs: "list[tuple[CadEntity, bool | None, bool, bool]]" = bulbs,
                               results: "list[_IoReadbackRecord]" = restoration_results) -> None:
            restore_record: "_IoReadbackRecord" = {
                'name': 'visibility', 'steps': _io_restore_bulbs(bulbs)}
            results.append(restore_record)
        restore_actions.append(('Restore presentation visibility', restore_visibility))
        applied: list[JsonRecord] = []
        for entity, value in zip(entities, values):
            applied.append(_io_apply_bulb(entity, value))
        visibility_record: "_IoReadbackRecord" = {'name': 'visibility', 'steps': applied}
        application_results.append(visibility_record)
    if 'sections' in shot:
        sections = shot['sections']
        if not isinstance(sections, list) or not sections:
            raise ValueError('sections must be a nonempty array of {name, isLightBulbOn}')
        analyses = ctx.design.analyses
        section_rows: list[tuple[adsk.fusion.SectionAnalysis, bool]] = []
        for row_value in sections:
            row = _io_section_row(row_value)
            section_rows.append((_io_section_by_name(ctx, row['name']), row['isLightBulbOn']))
        section_before = _io_capture_bulbs([section for section, _ in section_rows])
        analyses_before = _io_capture_bulbs([analyses])
        captured['sections'] = {'rows': [(row[0], row[1]) for row in section_before],
                                'analyses': analyses_before[0][1]}
        def restore_sections(
                rows: "list[tuple[CadEntity, bool | None, bool, bool]]" = section_before,
                folder: "list[tuple[CadEntity, bool | None, bool, bool]]" = analyses_before,
                 results: "list[_IoReadbackRecord]" = restoration_results) -> None:
            outcomes = _io_restore_bulbs(rows)
            outcomes.extend(_io_restore_bulbs(folder))
            section_record: "_IoReadbackRecord" = {'name': 'sections', 'steps': outcomes}
            results.append(section_record)
            _io_restore_raise(outcomes, 'Section visibility')
        restore_actions.append(('Restore section visibility', restore_sections))
        analyses_record: "_IoReadbackRecord" = {
            'name': 'analyses-folder', 'steps': [_io_apply_bulb(analyses, True)]}
        application_results.append(analyses_record)
        for section, value in section_rows:
            section_record: "_IoReadbackRecord" = {
                'name': 'section:' + section.name, 'steps': [_io_apply_bulb(section, value)]}
            application_results.append(section_record)
    if 'activeComponent' in shot:
        previous_active = _cad_cast("CadEntity", ctx.design.activeComponent)
        captured['activeComponent'] = previous_active
        target = ctx.resolve(shot['activeComponent'])
        if _cad_kind(target) not in ('component', 'occurrence'):
            raise ValueError('activeComponent must resolve to a component or occurrence')
        def restore_active(previous: "CadEntity" = previous_active,
                           results: "list[_IoReadbackRecord]" = restoration_results) -> None:
            detail: "_IoReadbackRecord"
            try:
                _cad_require_result(_io_activate_component(ctx, previous), 'Restore active component')
                observed = ctx.design.activeComponent
                status = capture_restore_status(previous, observed)
            except Exception as error:
                status = 'failed'
                detail = _cad_cast("_IoReadbackRecord", {
                    'type': type(error).__name__, 'message': str(error)})
            else:
                detail = _cad_cast("_IoReadbackRecord", {
                    'expected': previous, 'observed': observed})
            restore_step = _cad_cast("_IoReadbackRecord", {'status': status, **detail})
            outcome: "_IoReadbackRecord" = {'name': 'activeComponent', 'steps': [restore_step]}
            results.append(outcome)
            _io_restore_raise(outcome['steps'], 'Active component restoration')
        restore_actions.append(('Restore active component', restore_active))
        try:
            _cad_require_result(_io_activate_component(ctx, target), 'Activate component')
            observed = ctx.design.activeComponent
            status = capture_apply_status(target, observed)
            detail = {'expected': target, 'observed': observed}
        except Exception as error:
            status = 'unknown'
            detail = {'type': type(error).__name__, 'message': str(error)}
        active_record = _cad_cast("_IoReadbackRecord", {
            'name': 'activeComponent', 'steps': [{'status': status, **detail}]})
        application_results.append(active_record)


def _io_shots(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('shots',), ('overwrite', 'confirm'))
    shots_value = data['shots']
    if not isinstance(shots_value, list) or not shots_value:
        raise ValueError('shots must be a nonempty array')
    viewport = _io_viewport(ctx)
    pending: list[tuple[_IoPath, _IoShot, int, int]] = []
    for shot_value in shots_value:
        shot = _io_shot(shot_value)
        path_data: JsonObject = dict(data)
        path_data['path'] = shot['path']
        path = _io_path(ctx, path_data, output=True, suffixes=('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'))
        width, height = shot.get('width', 0), shot.get('height', 0)
        if type(width) is not int or type(height) is not int or not 0 <= width <= 16384 or not 0 <= height <= 16384:
            raise ValueError('Image width/height must be integers from 0 to 16384')
        pending.append((path, shot, width, height))
    if len({_io_os_path.normcase(str(p.resolve())) for p, _, _, _ in pending}) != len(pending):
        raise ValueError('Shot output paths must be distinct')
    before = _io_camera_state(ctx, viewport.camera)
    images: list[JsonRecord] = []
    primary: BaseException | None = None
    restore_actions: list[tuple[str, Callable[[], object]]] = [
        ('Restore original camera', lambda: _io_camera_apply(ctx, before))]
    captured: dict[str, object] = {}
    pixel_frames: list[_IoPixelFrame] = []
    unsupported_pixel_files: list[str] = []
    application_results: list[_IoReadbackRecord] = []
    restoration_results: list[_IoReadbackRecord] = []
    try:
        for path, shot, width, height in pending:
            if 'camera' in shot:
                _io_camera(ctx, _io_json_object(shot['camera'], 'camera'), 'set')
            _io_shot_presentation(ctx, shot, restore_actions, captured,
                                  application_results, restoration_results)
            _cad_require_result(viewport.saveAsImageFile(str(path), width, height), 'Save image ' + str(path))
            row: JsonRecord = _io_file(path)
            if not row['exists'] or not row['bytes']:
                raise RuntimeError('Image API reported success but output is missing or empty: ' + str(path))
            camera_snapshot = _io_camera_state(ctx, viewport.camera)
            row['camera'] = _cad_cast("JsonRecord", camera_snapshot)
            images.append(row)
            if path.suffix.lower() == '.png':
                with open(str(path), 'rb') as stream:
                    header = stream.read(24)
                if (len(header) >= 24 and header[:8] == b'\x89PNG\r\n\x1a\n' and
                        header[12:16] == b'IHDR'):
                    image_width, image_height = struct.unpack('>II', header[16:24])
                    if image_width * image_height > PIXEL_POLICY['thresholds']['maxPixels']:
                        unsupported_pixel_files.append(path.name)
                        continue
                pixel_frames.append({
                    'name': path.name, 'path': str(path),
                    'width': width if width else None,
                    'height': height if height else None,
                    'direction': [a - b for a, b in zip(
                        camera_snapshot['eye'], camera_snapshot['target'])],
                })
            else:
                unsupported_pixel_files.append(path.name)
    except BaseException as error:
        primary = error
        raise
    finally:
        _io_cleanup(primary, list(reversed(restore_actions)))

    def read_pixel_frames() -> "Iterable[_CaptureFrame]":
        for frame in pixel_frames:
            with open(frame['path'], 'rb') as stream:
                yield _cad_cast("_CaptureFrame", dict(frame, bytes=stream.read()))
    pixel_integrity: JsonRecord = analyze_capture_pixels(read_pixel_frames())
    if pixel_integrity['status'] == 'failed':
        raise RuntimeError('Shot pixel integrity policy failed: ' + json.dumps(pixel_integrity))
    if unsupported_pixel_files:
        pixel_integrity['status'] = 'unsupported'
        pixel_integrity['unsupportedFiles'] = unsupported_pixel_files
        pixel_integrity['message'] = 'Pixel analysis is available only for PNG captures.'

    application_rows: list[dict[str, JsonValue]] = []
    for group in application_results:
        for status_step in _cad_cast("list[_IoReadbackRecord]", group.get('steps', [])):
            status_value = status_step.get('status', 'unknown')
            application_status_record: dict[str, JsonValue] = {
                'status': 'restored' if status_value == 'verified' else status_value}
            application_rows.append(application_status_record)
    restoration_rows: list[dict[str, JsonValue]] = []
    for group in restoration_results:
        for status_step in _cad_cast("list[_IoReadbackRecord]", group.get('steps', [])):
            status_value = status_step.get('status', 'unknown')
            restoration_status_record: dict[str, JsonValue] = {'status': status_value}
            restoration_rows.append(restoration_status_record)
    application_status = capture_aggregate_status(application_rows)
    restoration_status = capture_aggregate_status(restoration_rows)
    presentation_restored = (
        True if restoration_status == 'restored' else
        False if restoration_status == 'failed' else None)
    result: dict[str, object] = {
        'images': images,
        'restoreState': before,
        'cameraRestored': True,
        'presentationRestored': presentation_restored,
        'presentationRestoration': {
            'status': restoration_status,
            'steps': restoration_results,
        },
        'presentationCapture': {
            'status': application_status,
            'steps': application_results,
        },
        'pixelIntegrity': pixel_integrity,
        'requiresVisualReview': True,
    }
    if (application_status in ('unsupported', 'unknown') or
            restoration_status in ('unsupported', 'unknown')):
        result['status'] = 'unknown'
    elif application_status == 'failed' or restoration_status == 'failed':
        result['status'] = 'failed'
    elif pixel_integrity['status'] == 'unsupported':
        result['status'] = 'unknown'
    return _cad_cast("JsonRecord", result)


def _io_compare(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('left', 'right'), ('mode',))
    if data.get('mode', 'pair') != 'pair':
        raise ValueError('Overlay compositing is not provided by the Fusion API; use mode pair and composite returned images externally')
    images = [_io_path(ctx, data, key, suffixes=('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')) for key in ('left', 'right')]
    return {'mode': 'pair', 'images': [_io_file(p) for p in images], 'metricVerification': False,
            'limitations': ['Visual pairing only; no registration, pixel overlay, dimensions, or geometric comparison.']}


def _io_section(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('mode', 'name'), ('plane', 'offset', 'visible'))
    mode = data['mode']
    if not isinstance(data['name'], str) or not data['name'].strip():
        raise ValueError('name must be nonempty')
    if mode == 'helper':
        _cad_fields(data, ('mode', 'name', 'plane', 'offset'))
        result = ctx.call('datum.plane', {k: data[k] for k in ('name', 'plane', 'offset')})
        return {'representation': 'construction plane helper, NOT a clipping section', 'entity': result}
    if mode not in ('create', 'show', 'hide'):
        raise ValueError('mode must be create (real section), show, hide, or helper (no clipping)')
    if not hasattr(ctx.design, 'analyses') or not hasattr(ctx.design.analyses, 'sectionAnalyses'):
        raise ValueError('Installed API cannot access sections; update Fusion or use Inspect > Section Analysis in the UI')
    analyses = ctx.design.analyses
    sections = analyses.sectionAnalyses
    if mode == 'create':
        _cad_fields(data, ('mode', 'name', 'plane'), ('offset', 'visible'))
        if not hasattr(sections, 'createInput') or not hasattr(sections, 'add'):
            raise ValueError('Installed API cannot create sections; update Fusion or create one via Inspect > Section Analysis, then use show')
        if any(s.name == data['name'] for s in _cad_items(sections)):
            raise ValueError('Section name already exists')
        visible = data.get('visible', True)
        if type(visible) is not bool:
            raise ValueError('visible must be boolean')
        plane = ctx.resolve(data['plane'])
        if _cad_kind(plane) not in ('plane', 'face'):
            raise ValueError('Section plane must be a construction plane or planar face')
        inp = _cad_require_result(sections.createInput(plane, ctx.length(data.get('offset', '0 mm'))), 'Define real section')
        section = _cad_require_result(sections.add(inp), 'Create real section')
        section.name = data['name']
        ctx.created.append(ctx.ref(section))
    else:
        _cad_fields(data, ('mode', 'name'))
        section = _cad_unique([s for s in _cad_items(sections) if s.name == data['name']], 'Section name')
        visible = mode == 'show'
    before = {'section': section.isLightBulbOn, 'analyses': analyses.isLightBulbOn}
    section.isLightBulbOn = visible
    # Do not turn on unrelated analyses by toggling their shared parent folder.
    return {'representation': 'real section analysis', 'ref': ctx.ref(section), 'previousVisibility': before,
            'isVisible': section.isVisible, 'limitations': ['If the Analyses folder is hidden, enable it in the browser to see this section.']}


def _io_reference_image(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    if data.get('mode') == 'inspect' or 'source' in data:
        # The sibling adapter returns the DTO assembled by its existing contract.
        return _cad_cast("JsonRecord", _reference_image(ctx, data))
    _cad_fields(data, ('mode',), ('ref', 'segment', 'length', 'anchor', 'angle'))
    if data['mode'] != 'calibrate':
        raise ValueError('Canvas insertion is not exposed by the documented API used here. Insert > Canvas locally, then use mode calibrate with its token')
    _cad_fields(data, ('mode', 'ref', 'segment', 'length', 'anchor'), ('angle',))
    resolved = ctx.resolve(data['ref'])
    if _cad_type(resolved) != 'Canvas':
        raise ValueError('ref must be an existing Canvas token')
    canvas = _cad_cast("adsk.fusion.Canvas", resolved)
    segment = data['segment']
    if not isinstance(segment, list) or len(segment) != 2 or any(
            not isinstance(point, list) or len(point) != 2 for point in segment):
        raise ValueError('segment must contain two current canvas-plane points, each with two length expressions (not pixels)')
    p = _io_pair_lengths(ctx, segment[0], 'segment point')
    q = _io_pair_lengths(ctx, segment[1], 'segment point')
    if not isinstance(data['anchor'], list) or len(data['anchor']) != 2:
        raise ValueError('anchor must contain two canvas-plane length expressions')
    anchor = _io_pair_lengths(ctx, data['anchor'], 'anchor')
    distance = math.hypot(q[0] - p[0], q[1] - p[1])
    length = ctx.length(data['length'])
    if distance <= 0 or length <= 0:
        raise ValueError('Known and measured segment lengths must be positive')
    angle = ctx.angle(data.get('angle', '0 deg')) - math.atan2(q[1] - p[1], q[0] - p[0])
    a, b = length / distance * math.cos(angle), length / distance * math.sin(angle)
    tx, ty = anchor[0] - a * p[0] + b * p[1], anchor[1] - b * p[0] - a * p[1]
    old = canvas.transform
    # Left-compose the plane-space similarity using cells, avoiding ambiguous transformBy order.
    matrix = adsk.core.Matrix2D.create()
    transform: tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]] = (
        (a, -b, tx), (b, a, ty), (0, 0, 1))
    for row in range(3):
        for col in range(3):
            _cad_require_result(matrix.setCell(row, col, sum(transform[row][k] * old.getCell(k, col) for k in range(3))), 'Define calibrated canvas transform')
    previous = list(old.asArray())
    canvas.transform = matrix
    return {'ref': ctx.ref(canvas), 'previousTransform': previous, 'transform': list(canvas.transform.asArray()),
            'calibration': {'lengthCm': length, 'scaleFactor': length / distance, 'anchorCm': anchor},
            'metricVerification': False, 'limitations': ['Uses caller-measured current plane coordinates, not pixels. No image distortion correction or independent measurement verification.']}


def _io_style_state(ctx: "CadContext", entity: "CadEntity") -> "_IoStyleState":
    kind = _cad_kind(entity)
    owner = _cad_owner(entity)
    appearance = _cad_cast("adsk.core.Appearance | None", getattr(entity, 'appearance', None))
    source = _cad_cast("adsk.core.AppearanceSourceTypes | None", getattr(entity, 'appearanceSourceType', None))
    names = ('MaterialAppearanceSource', 'BodyAppearanceSource', 'OccurrenceAppearanceSource',
             'FaceAppearanceSource', 'OverrideAppearanceSource')
    enum_type = _cad_cast("object | None", getattr(adsk.core, 'AppearanceSourceTypes', None))
    source_name = next((n for n in names if source is not None and enum_type is not None and
                        hasattr(enum_type, n) and source == _cad_cast(
                            "adsk.core.AppearanceSourceTypes", getattr(enum_type, n))), None)
    proxy = (getattr(entity, 'assemblyContext', None) is not None or
             getattr(entity, 'nativeObject', None) is not None)
    # Typed sources identify the override's owner, not just the inspected entity.
    own_source = {'body': 'BodyAppearanceSource', 'face': 'FaceAppearanceSource'}.get(kind)
    override = (source_name == 'OverrideAppearanceSource' or source_name == own_source) if source_name else None
    override_scope = ('native-definition' if proxy else 'definition') if override else None
    if proxy and source_name == 'OverrideAppearanceSource':
        override_scope = 'proxy-context-unspecified'
    if kind == 'occurrence':
        override = appearance is not None
        source_name = 'OccurrenceOverride' if override else 'Contents (no occurrence override)'
        override_scope = 'instance' if override else None
    if kind == 'face':
        material_entity = _cad_cast("adsk.fusion.BRepFace", entity).body
    elif kind == 'occurrence':
        material_entity = _cad_cast("adsk.fusion.Occurrence", entity).component
    else:
        material_entity = entity
    return {'ref': ctx.ref(entity), 'scope': 'instance' if kind == 'occurrence' else
            'proxy-read-only' if proxy else 'definition',
            'definition': ctx.ref(owner) if owner is not None else None,
            'appearance': _io_style_value(appearance), 'appearanceSource': source_name,
            'appearanceOverride': override, 'appearanceOverrideScope': override_scope,
            'material': _io_style_value(_cad_cast("adsk.core.Material | None", getattr(material_entity, 'material', None))),
            'materialReadFrom': ctx.ref(material_entity),
            'materialSource': 'BRepBody.material' if _cad_kind(material_entity) == 'body' else 'Component.material',
            'materialInheritance': 'Not exposed by this API; equal IDs do not establish inheritance'}


def _io_style(ctx: "CadContext", data: "JsonObject",
              kind: "Literal['appearance', 'material']",
              action: "Literal['list', 'assign', 'inspect', 'clear']") -> "JsonRecord":
    if action == 'list':
        _cad_fields(data, (), ('library', 'search'))
    elif action == 'assign':
        _cad_fields(data, ('refs', 'id'), ('library', 'includeChildren') if kind == 'appearance' else ('library',))
    else:
        _cad_fields(data, ('refs',), ('includeChildren',) if kind == 'appearance' else ())
    library: adsk.core.MaterialLibrary | None = None
    if 'library' in data:
        library_value = data['library']
        if not isinstance(library_value, str) or not library_value:
            raise ValueError('library must be an exact loaded library ID')
        library = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries)
                               if lib.id == library_value], 'Loaded library ID')
    collection: "_CadItemCollection[adsk.core.Appearance] | _CadItemCollection[adsk.core.Material]"
    if kind == 'appearance':
        collection = _cad_cast("_CadItemCollection[adsk.core.Appearance]",
                               library.appearances if library is not None else ctx.design.appearances)
    else:
        collection = _cad_cast("_CadItemCollection[adsk.core.Material]",
                               library.materials if library is not None else ctx.design.materials)
    if action == 'list':
        search_value = data.get('search', '')
        if not isinstance(search_value, str):
            raise ValueError('search must be a name substring string')
        search = search_value
        if kind == 'appearance':
            styles = _cad_items(_cad_cast("_CadItemCollection[adsk.core.Appearance]", collection))
        else:
            styles = _cad_items(_cad_cast("_CadItemCollection[adsk.core.Material]", collection))
        items: list[JsonRecord] = []
        for style in styles:
            if search.casefold() in style.name.casefold():
                items.append(_cad_cast("JsonRecord", _io_style_value(style)))
        libraries = [{'id': lib.id, 'name': lib.name} for lib in _cad_items(ctx.app.materialLibraries)]
        return {'kind': kind, 'items': items, 'library': data.get('library'),
                'libraries': libraries, 'affected': [], 'count': 0}
    refs_value = data['refs']
    if not isinstance(refs_value, list) or not refs_value:
        raise ValueError('refs must be a nonempty array')
    refs = refs_value
    children_value = data.get('includeChildren', False)
    if type(children_value) is not bool:
        raise ValueError('includeChildren must be boolean')
    children = children_value
    selected: list[CadEntity] = [ctx.resolve(ref) for ref in refs]
    if 'includeChildren' in data and not any(_cad_kind(e) == 'component' for e in selected):
        raise ValueError('includeChildren applies only to component definition selections')
    entities: list[CadEntity] = []
    mappings: list[JsonRecord] = []
    for selected_entity in selected:
        if not getattr(selected_entity, 'isValid', True):
            raise ValueError('Style targets must be valid persistent entities')
        targets: list[CadEntity] = [selected_entity]
        if kind == 'appearance' and _cad_kind(selected_entity) == 'component':
            components = [_cad_cast("adsk.fusion.Component", selected_entity)]
            if children:
                for component in components:
                    for occurrence in _cad_items(component.occurrences):
                        if occurrence.component not in components:
                            components.append(occurrence.component)
            targets = [body for component in components for body in _cad_items(component.bRepBodies)]
        for entity in targets:
            entity_kind = _cad_kind(entity)
            allowed = ('component', 'body') if kind == 'material' and action == 'assign' else ('component', 'body', 'face', 'occurrence')
            if entity_kind not in allowed:
                raise ValueError('Physical material requires native Component or BRepBody; for a face use appearance.assign'
                                 if kind == 'material' else 'Appearance requires Component, BRepBody, BRepFace, or Occurrence')
            body = _cad_cast("adsk.fusion.BRepFace", entity).body if entity_kind == 'face' else entity
            if getattr(body, 'isTransient', False) or not getattr(entity, 'isValid', True):
                raise ValueError('Style targets must be valid persistent entities')
            native = getattr(entity, 'nativeObject', None)
            if action != 'inspect' and (getattr(entity, 'assemblyContext', None) is not None or
                                        (native is not None and native != entity)):
                raise ValueError('Proxy mutation is unsupported; select the native definition, or a native occurrence for an instance appearance')
            if action != 'inspect' and not hasattr(entity, kind):
                raise ValueError('Installed API lacks writable ' + kind + ' for selected target')
            if entity not in entities:
                entities.append(entity)
        mappings.append({'selected': ctx.ref(selected_entity), 'scope': 'component-body-cascade' if
                         kind == 'appearance' and _cad_kind(selected_entity) == 'component' else
                         'instance' if _cad_kind(selected_entity) == 'occurrence' else 'definition',
                         'targets': [ctx.ref(e) for e in targets], 'count': len(targets)})
    item: "adsk.core.Appearance | adsk.core.Material | None" = None
    resolution: _IoStyleResolution | None = None
    style_id: str | None = None
    if action == 'assign':
        style_id_value = data['id']
        if not isinstance(style_id_value, str) or not style_id_value:
            raise ValueError('id must be an exact ID from ' + kind + '.list')
        style_id = style_id_value
        if kind == 'appearance':
            candidates = [style for style in _cad_items(_cad_cast(
                "_CadItemCollection[adsk.core.Appearance]", collection)) if style.id == style_id]
            selected_style, raw_resolution = _cad_style_resolve(
                candidates, 'appearance ID', ctx.design.appearances, style_id)
            item = selected_style
            local_styles = _cad_items(ctx.design.appearances)
        else:
            candidates = [style for style in _cad_items(_cad_cast(
                "_CadItemCollection[adsk.core.Material]", collection)) if style.id == style_id]
            selected_style, raw_resolution = _cad_style_resolve(
                candidates, 'material ID', ctx.design.materials, style_id)
            item = selected_style
            local_styles = _cad_items(ctx.design.materials)
        resolution = _cad_cast("_IoStyleResolution", raw_resolution)
        if library is not None:
            if any(style.id == item.id or style.name == item.name for style in local_styles):
                raise ValueError('Design-local ID/name collision: no equivalence assumed. Use ' + kind +
                                 '.list and explicitly select the local id without library; nothing was copied or assigned')
    # Capture actual getters, including unchanged overrides that can mask definition edits.
    observed: list[CadEntity] = list(entities)
    definitions: list[adsk.fusion.Component] = []
    for entity in entities:
        owner = _cad_owner(entity)
        if _cad_kind(entity) != 'occurrence' and owner is not None and owner not in definitions:
            definitions.append(owner)
        if _cad_kind(entity) == 'component':
            component = _cad_cast("adsk.fusion.Component", entity)
            for body in _cad_items(component.bRepBodies):
                if body not in observed:
                    observed.append(body)
    for entity in list(observed):
        if _cad_kind(entity) == 'body' and hasattr(entity, 'faces'):
            body = _cad_cast("adsk.fusion.BRepBody", entity)
            for face in _cad_items(body.faces):
                if face not in observed:
                    observed.append(face)
    for occurrence in _cad_items(ctx.root.allOccurrences):
        if occurrence.component in definitions and occurrence not in observed:
            observed.append(occurrence)
    before = [_io_style_state(ctx, e) for e in observed]
    result: JsonRecord = {'kind': kind, 'action': action, 'count': len(entities), 'mapping': mappings,
              'affectedDefinitions': [ctx.ref(e) for e in definitions],
              'affectedDefinitionCount': len(definitions), 'includeChildren': children,
              'atomic': False, 'limitations': [
                  'Appearance is visual only: no physical material or coating thickness is assigned.' if kind == 'appearance' else
                  'Physical material can affect inherited appearance; existing visual overrides are retained.',
                  'Definition changes are shared by all occurrences. Existing face and occurrence overrides are not cleared unless explicitly selected.',
                  'Component appearance expands to current direct BRepBodies, not a component appearance property or future bodies.',
                  'Material getters do not expose inheritance provenance. Use a separate measure command for mass; no physical validation is performed.',
                  'Prevalidation is not a transaction; runtime failures may leave copied styles or earlier assignments. No automatic rollback.']}
    previous: list[JsonRecord] = []
    for state in before[:len(entities)]:
        style_state = state['appearance'] if kind == 'appearance' else state['material']
        previous.append({'ref': state['ref'], 'id': style_state['id'] if style_state is not None else None})
    if action == 'assign':
        if style_id is None:
            raise RuntimeError('Style assignment lost its validated ID')
        result['requested'] = {'id': style_id, 'library': data.get('library')}
        result['copiedStyle'] = None
        if resolution is None:
            raise RuntimeError('Style assignment has no resolution result')
        result['resolution'] = _cad_cast("JsonRecord", resolution)
        if resolution['ambiguous']:
            result['warnings'] = [
                '%s ID %r is not unique; deterministically resolved to %r (precedence %s) among %d candidates'
                % (kind, style_id, resolution['selected']['name'], resolution['precedence'],
                   len(resolution['candidates']))]
    try:
        if action == 'assign' and library is not None and entities:
            if item is None:
                raise RuntimeError('Style assignment has no resolved style')
            if kind == 'appearance':
                appearance = _cad_cast("adsk.core.Appearance", item)
                item = _cad_require_result(ctx.design.appearances.addByCopy(appearance, appearance.name),
                                           'Copy appearance')
            else:
                material = _cad_cast("adsk.core.Material", item)
                item = _cad_require_result(ctx.design.materials.addByCopy(material, material.name),
                                           'Copy material')
            result['copiedStyle'] = _cad_cast("JsonRecord", _io_style_value(item))
        if action != 'inspect':
            for entity in entities:
                setattr(entity, kind, item)
    except Exception as error:
        result['error'] = str(error)
        result['affected'] = [{'ref': ctx.ref(entity), 'before': _cad_cast("JsonRecord", state),
                               'after': _cad_cast("JsonRecord", _io_style_state(ctx, entity))}
                              for entity, state in zip(observed, before)]
        raise RuntimeError('Style operation failed without rollback: ' + json.dumps(result)) from error
    result['affected'] = [{'ref': ctx.ref(entity), 'before': _cad_cast("JsonRecord", state),
                           'after': _cad_cast("JsonRecord", _io_style_state(ctx, entity))}
                          for entity, state in zip(observed, before)]
    affected_rows = _cad_cast("list[JsonRecord]", result['affected'])
    result['items'] = [row['after'] for row in affected_rows]
    if action == 'assign':
        if item is None:
            raise RuntimeError('Style assignment has no resolved style')
        result.update(id=item.id, assigned=[ctx.ref(e) for e in entities], previous=previous)
    return result


def _io_import_options(ctx: "CadContext", path: _IoPath) -> "adsk.core.ImportOptions":
    method = _IO_IMPORTS.get(path.suffix.lower())
    if method is None:
        raise ValueError('Supported local imports: STEP, F3D, IGES, SAT, SMT. F3Z needs explicit cloud upload; mesh imports do not reconstruct parametric history')
    manager = ctx.app.importManager
    if not hasattr(manager, method):
        raise ValueError('Installed Fusion lacks ' + method + '; update Fusion or import using the UI')
    if method == 'createSTEPImportOptions':
        options = manager.createSTEPImportOptions(str(path))
    elif method == 'createFusionArchiveImportOptions':
        options = manager.createFusionArchiveImportOptions(str(path))
    elif method == 'createIGESImportOptions':
        options = manager.createIGESImportOptions(str(path))
    elif method == 'createSATImportOptions':
        options = manager.createSATImportOptions(str(path))
    else:
        options = manager.createSMTImportOptions(str(path))
    return _cad_require_result(options, 'Create import options')


def _io_import(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('path', 'mode'))
    if data['mode'] not in ('new', 'component'):
        raise ValueError('mode must be new or component')
    path = _io_path(ctx, data)
    options = _io_import_options(ctx, path)
    if data['mode'] == 'new':
        doc = _cad_require_result(ctx.app.importManager.importToNewDocument(options), 'Import to new document')
        return {'document': {'name': doc.name, 'creationId': doc.creationId}, 'sourceDocument': _io_identity(ctx),
                'newUnsavedDocument': True, 'pathHost': 'machine running Fusion', 'historyReconstructed': False}
    if ctx.occurrence is not None:
        raise ValueError('Component import requires a native component context, not an occurrence')
    results = _cad_require_result(ctx.app.importManager.importToTarget2(options, ctx.component), 'Import to component')
    refs = [ctx.ref(e) for e in _cad_items(results)]
    ctx.created.extend(refs)
    return {'created': refs, 'document': _io_identity(ctx), 'historyReconstructed': False,
            'limitations': ['Neutral formats bring geometry, not original feature history; F3D retains only history present in the archive.']}


def _io_export_plan(ctx: "CadContext", data: "JsonObject",
                    kind: "Literal['native', 'step', 'mesh']") -> "tuple[_IoPath, adsk.fusion.ExportOptions]":
    _cad_fields(data, ('path',), ('ref', 'overwrite', 'confirm', 'units') +
                (('surfaceDeviation',) if kind == 'mesh' else ()))
    suffixes = {'native': ('.f3d',), 'step': ('.step', '.stp'), 'mesh': ('.stl', '.3mf')}
    output_name = data['path']
    if not isinstance(output_name, str):
        raise ValueError('path must be a nonempty absolute Fusion-machine path')
    if kind == 'native' and _IoPath(output_name).suffix.lower() == '.f3z':
        raise ValueError('F3Z packaging is not exposed by ExportManager; use Fusion UI export for externally referenced assemblies')
    path = _io_path(ctx, data, output=True, suffixes=suffixes[kind])
    geometry = ctx.resolve(data['ref']) if 'ref' in data else ctx.component
    allowed = ('component',) if kind in ('native', 'step') else ('component', 'body', 'occurrence')
    if _cad_kind(geometry) not in allowed:
        raise ValueError(kind + ' export requires ' + ', '.join(allowed))
    if kind != 'mesh' and 'units' in data:
        raise ValueError('units input is supported for STL only')
    if kind == 'native':
        if not hasattr(ctx.doc, 'allDocumentReferences') or any(
                not hasattr(o, 'isReferencedComponent') for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('Installed API cannot certify external-reference status; update Fusion or use UI F3Z export')
        if ctx.doc.allDocumentReferences.count or any(o.isReferencedComponent for o in _cad_items(ctx.root.allOccurrences)):
            raise ValueError('Design has external references and cannot be certified self-contained as F3D. Use UI F3Z export; references will not be broken automatically')
        if geometry != ctx.root:
            raise ValueError('Native archive export requires root component to preserve the whole design history; use ref root')
    surface_deviation: float | None = None
    unit_name: str | None = None
    if kind == 'mesh':
        units: dict[str, str] = {'mm': 'MillimeterDistanceUnits', 'cm': 'CentimeterDistanceUnits',
                                 'in': 'InchDistanceUnits'}
        if path.suffix.lower() == '.3mf':
            if 'units' in data or 'surfaceDeviation' in data:
                raise ValueError('3MF does not support units or surfaceDeviation overrides; omit both')
        else:
            units_value = data.get('units')
            if not isinstance(units_value, str) or units_value not in units:
                raise ValueError('STL requires explicit units: mm, cm, or in; STL itself does not encode units')
            unit_name = units[units_value]
            if 'surfaceDeviation' in data:
                surface_deviation = ctx.length(data['surfaceDeviation'])
                if surface_deviation <= 0:
                    raise ValueError('surfaceDeviation must be a positive length expression')
    manager = ctx.design.exportManager
    options: adsk.fusion.ExportOptions
    if kind == 'native':
        options = manager.createFusionArchiveExportOptions(str(path), geometry)
    elif kind == 'step':
        options = manager.createSTEPExportOptions(str(path), geometry)
    else:
        if path.suffix.lower() == '.stl':
            method = 'createSTLExportOptions'
            if not hasattr(manager, method):
                raise ValueError('Installed Fusion lacks ' + method + '; update Fusion or export STL')
            mesh_options = _cad_require_result(
                manager.createSTLExportOptions(geometry, str(path)), 'Create mesh export options')
        else:
            method = 'createC3MFExportOptions'
            if not hasattr(manager, method):
                raise ValueError('Installed Fusion lacks ' + method + '; update Fusion or export STL')
            mesh_options = _cad_require_result(
                manager.createC3MFExportOptions(geometry, str(path)), 'Create mesh export options')
        mesh_options.sendToPrintUtility = False
        mesh_options.isOneFilePerBody = False
        if path.suffix.lower() == '.stl':
            if not hasattr(mesh_options, 'unitType'):
                raise ValueError('Installed API lacks STL unitType; update Fusion to export with explicit units')
            if unit_name is None:
                raise ValueError('STL requires explicit units: mm, cm, or in; STL itself does not encode units')
            stl_options = _cad_cast("adsk.fusion.STLExportOptions", mesh_options)
            stl_options.unitType = _cad_cast("adsk.fusion.DistanceUnits",
                                             getattr(adsk.fusion.DistanceUnits, unit_name))
            if surface_deviation is not None:
                # SDK setter takes cm and automatically selects MeshRefinementCustom.
                stl_options.surfaceDeviation = surface_deviation
        options = mesh_options
    return path, _cad_require_result(options, 'Create export options')


def _io_export_execute(ctx: "CadContext", path: _IoPath,
                       options: "adsk.fusion.ExportOptions") -> "JsonRecord":
    _cad_require_result(ctx.design.exportManager.execute(options), 'Export ' + str(path))
    result = _io_file(path)
    if not result['exists'] or not result['bytes']:
        raise RuntimeError('Export reported success but file is missing or empty: ' + str(path))
    return result


def _io_design_from_product(product: object) -> "adsk.fusion.Design":
    design_cast = _cad_cast("Callable[[object], adsk.fusion.Design | None]",
                            getattr(adsk.fusion.Design, 'cast'))
    design = design_cast(product)
    if design is None:
        raise ValueError('Reimport did not produce a Design product')
    return design


def _io_export(ctx: "CadContext", data: "JsonObject",
               kind: "Literal['native', 'step', 'mesh']") -> "JsonRecord":
    path, options = _io_export_plan(ctx, data, kind)
    result = _io_export_execute(ctx, path, options)
    if kind == 'mesh' and path.suffix.lower() == '.stl' and 'surfaceDeviation' in data:
        stl_options = _cad_cast("adsk.fusion.STLExportOptions", options)
        result['tessellation'] = {'surfaceDeviation': data['surfaceDeviation'],
                                  'surfaceDeviationCm': stl_options.surfaceDeviation,
                                  'meshRefinement': _cad_cast(int, stl_options.meshRefinement)}
    return result


def _io_parts(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('parts',), ('overwrite', 'confirm'))
    parts_value = data['parts']
    if not isinstance(parts_value, list) or not parts_value:
        raise ValueError('parts must be a nonempty array with explicit ref, format, and path per part')
    plans: list[tuple[_IoPath, adsk.fusion.ExportOptions]] = []
    for part_value in parts_value:
        part = _io_json_object(part_value, 'part')
        _cad_fields(part, ('ref', 'format', 'path'), ('units',))
        part_format = part['format']
        if not isinstance(part_format, str) or part_format not in ('step', 'mesh'):
            raise ValueError('Part format must be step or mesh')
        spec: JsonObject = {key: value for key, value in part.items() if key != 'format'}
        for key in ('overwrite', 'confirm'):
            if key in data:
                spec[key] = data[key]
        plans.append(_io_export_plan(ctx, spec, part_format))
    if len({_io_os_path.normcase(str(p.resolve())) for p, _ in plans}) != len(plans):
        raise ValueError('Part output paths must be distinct')
    return {'files': [_io_export_execute(ctx, *plan) for plan in plans], 'atomic': False,
            'limitations': ['STEP parts use component-local coordinates; mesh occurrence exports use their assembly context.']}


def _io_verify(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('path',), ('reimport', 'ref', 'volumeTolerance', 'lengthTolerance'))
    if type(data.get('reimport', False)) is not bool:
        raise ValueError('reimport must be boolean')
    # Missing files are reported, not confused with a failed geometric comparison.
    value = data['path']
    if not isinstance(value, str) or not _IoPath(value).is_absolute():
        raise ValueError('path must be absolute on the machine running Fusion')
    path = _IoPath(value)
    result = _io_file(path)
    if not data.get('reimport', False):
        if any(k in data for k in ('ref', 'volumeTolerance', 'lengthTolerance')):
            raise ValueError('Comparison inputs require reimport: true')
        return result
    if not result['exists'] or not result['bytes']:
        raise ValueError('Cannot reimport a missing or empty file')
    if 'volumeTolerance' in data:
        raise ValueError('Volume comparison is not implemented; omit volumeTolerance and use bounding-box comparison')
    source = ctx.resolve(data['ref'], 'component') if 'ref' in data else ctx.component
    tolerance = ctx.length(data.get('lengthTolerance', '0.01 mm'))
    if tolerance < 0:
        raise ValueError('lengthTolerance must be nonnegative')
    options = _io_import_options(ctx, path)
    # The sibling bounds helper validates finite nonempty min/max/size vectors.
    source_box = _cad_cast("_IoBounds", _cad_brep_bounds(source))
    source_values = source_box['min'] + source_box['max']
    active_before = _cad_cast("adsk.core.Document | None", ctx.app.activeDocument)
    imported: adsk.core.Document | None = None
    primary: BaseException | None = None
    try:
        imported = _cad_require_result(ctx.app.importManager.importToNewDocument(options), 'Verification reimport')
        design = _io_design_from_product(
            imported.products.itemByProductType('DesignProductType'))
        box = _cad_cast("_IoBounds", _cad_brep_bounds(design.rootComponent))
        values = box['min'] + box['max']
        deltas = [abs(a - b) for a, b in zip(source_values, values)]
        result['comparison'] = {'method': 'axis-aligned bounding box only', 'units': 'cm',
                                'source': source_values, 'reimport': values, 'absoluteDeltas': deltas,
                                'tolerance': tolerance, 'withinTolerance': max(deltas) <= tolerance}
        result['reimported'] = True
        result['limitations'] = ['Bounding-box agreement is not shape, topology, volume, mass, or feature-history equivalence.',
                                'Uses B-Rep body preciseBoundingBox unions in component-local frames; includes hidden bodies, excludes graphics and construction geometry.']
    except BaseException as error:
        primary = error
        raise
    finally:
        actions: list[tuple[str, Callable[[], object]]] = []
        if imported is not None:
            actions.append(('Close verification-owned temporary document', lambda: _cad_require_result(
                imported.close(False), 'Close verification-owned temporary document')))
        if active_before is not None:
            actions.append(('Restore previously active document', lambda: _cad_require_result(
                active_before.activate(), 'Restore previously active document')))
        _io_cleanup(primary, actions)
    return result


def _io_checkpoint(ctx: "CadContext", data: "JsonObject", action: str) -> "JsonRecord":
    if action == 'create':
        _cad_fields(data, ('path',), ('overwrite', 'confirm'))
        result = _io_export(ctx, dict(data, ref='root'), 'native')
        return dict(result, checkpointType='local self-contained F3D snapshot', document=_io_identity(ctx),
                    userDocumentSaved=False)
    if action == 'list':
        _cad_fields(data, ('directory',))
        directory = data['directory']
        if not isinstance(directory, str):
            raise ValueError('directory must be absolute text')
        path = _IoPath(directory)
        if not path.is_absolute() or not path.is_dir():
            raise ValueError('directory must exist on the Fusion machine and be absolute')
        return {'checkpoints': [_io_file(p) for p in sorted(path.iterdir()) if p.is_file() and p.suffix.lower() == '.f3d'],
                'limitations': ['Lists local F3D candidates, not authenticated provenance or cloud versions.']}
    _cad_fields(data, ('path',))
    path = _io_path(ctx, data, suffixes=('.f3d',))
    if action == 'inspect':
        return dict(_io_file(path), modifiedUnix=path.stat().st_mtime,
                    limitations=['File metadata only; archive contents and geometry are not inspected.'])
    # Always import as a separate unsaved document; never replace, save, or close ctx.doc.
    return _io_import(ctx, {'path': str(path), 'mode': 'new'})


_IO_HANDLERS: dict[str, "CadHandler"] = {
    'visibility.show': lambda c, d: _io_visibility(c, d, 'show'),
    'visibility.hide': lambda c, d: _io_visibility(c, d, 'hide'),
    'visibility.restore': lambda c, d: _io_visibility(c, d, 'restore'),
    'visibility.isolate': lambda c, d: _io_visibility(c, d, 'isolate'),
    'camera.save': lambda c, d: _io_camera(c, d, 'save'),
    'camera.restore': lambda c, d: _io_camera(c, d, 'restore'),
    'camera.set': lambda c, d: _io_camera(c, d, 'set'),
    'shot.pack': _io_shots, 'view.compare': _io_compare, 'section.view': _io_section,
    'reference.image': _io_reference_image,
    'appearance.list': lambda c, d: _io_style(c, d, 'appearance', 'list'),
    'appearance.assign': lambda c, d: _io_style(c, d, 'appearance', 'assign'),
    'appearance.inspect': lambda c, d: _io_style(c, d, 'appearance', 'inspect'),
    'appearance.clear': lambda c, d: _io_style(c, d, 'appearance', 'clear'),
    'material.list': lambda c, d: _io_style(c, d, 'material', 'list'),
    'material.assign': lambda c, d: _io_style(c, d, 'material', 'assign'),
    'material.inspect': lambda c, d: _io_style(c, d, 'material', 'inspect'),
    'import.file': _io_import,
    'checkpoint.create': lambda c, d: _io_checkpoint(c, d, 'create'),
    'checkpoint.list': lambda c, d: _io_checkpoint(c, d, 'list'),
    'checkpoint.inspect': lambda c, d: _io_checkpoint(c, d, 'inspect'),
    'checkpoint.open': lambda c, d: _io_checkpoint(c, d, 'open'),
    'export.native': lambda c, d: _io_export(c, d, 'native'),
    'export.step': lambda c, d: _io_export(c, d, 'step'),
    'export.mesh': lambda c, d: _io_export(c, d, 'mesh'),
    'export.parts': _io_parts, 'export.verify': _io_verify,
}
CAD_HANDLERS.update(_IO_HANDLERS)
