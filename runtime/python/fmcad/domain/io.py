"""DTO-only rules extracted from assets/cad/io.py. No SDK or filesystem access."""

_IO_IMPORTS = {'.step': 'createSTEPImportOptions', '.stp': 'createSTEPImportOptions',
               '.f3d': 'createFusionArchiveImportOptions', '.iges': 'createIGESImportOptions',
               '.igs': 'createIGESImportOptions', '.sat': 'createSATImportOptions', '.smt': 'createSMTImportOptions'}


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

def _io_restore_raise(errors: "Sequence[_IoMapping[str, object]]", label: str) -> None:
    if any(row.get('status') == 'failed' for row in errors):
        raise RuntimeError(label + ' failed: ' + json.dumps(errors, default=str))
