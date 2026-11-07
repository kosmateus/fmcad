"""Measurements and evidence, bundled after core.py. No document activation.

API contracts reviewed: MeasureManager, TemporaryBRepManager, PhysicalProperties,
Occurrence.transform2, TimelineObject, Design.computeAll (September 2026).
Temporary B-Rep operations never add their results to a component.
"""
import inspect
import time as _measurement_time

time = _measurement_time


_MEASURE_UNITS = {
    'length': {'mm': 10.0, 'cm': 1.0, 'm': 0.01, 'in': 1 / 2.54},
    'area': {'mm2': 100.0, 'cm2': 1.0, 'm2': 0.0001},
    'volume': {'mm3': 1000.0, 'cm3': 1.0, 'm3': 0.000001},
    'mass': {'kg': 1.0, 'g': 1000.0},
    'angle': {'deg': 180 / math.pi, 'rad': 1.0},
}


# Best-effort scheduler reserve, charged inside timeBudgetMs: 1000 ms per case
# plus 250 ms per assigned parameter. Fusion calls are indivisible and unbounded.


def _measure_value(value: float, dimension: "Literal['length', 'area', 'volume', 'mass', 'angle']", data: "JsonObject") -> "JsonObject":
    units = _cad_cast(str, data.get('units', next(iter(_MEASURE_UNITS[dimension]))))
    if units not in _MEASURE_UNITS[dimension]:
        raise ValueError('Unsupported %s units: %s' % (dimension, units))
    value = float(value) * _MEASURE_UNITS[dimension][units]
    if not math.isfinite(value):
        raise ValueError('Measurement is non-finite')
    return {'value': value, 'units': units, 'dimension': dimension}


def _measure_space(ctx: "CadContext", entities: "Sequence[CadEntity]") -> "JsonObject":
    # Never compare different component-local coordinate systems implicitly.
    owners: list[adsk.fusion.Component] = []
    assembly = False
    for entity in entities:
        occurrence = _cad_cast("adsk.fusion.Occurrence | None", entity) if _cad_kind(entity) == 'occurrence' else _cad_cast(
            "adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
        if occurrence is not None:
            if occurrence not in _cad_items(ctx.root.allOccurrences):
                raise ValueError('Assembly context must be a root-context occurrence; resolve its full occurrence path, not a nested native token')
            assembly = True
        else:
            owner = _cad_owner(entity)
            if owner is not None and owner not in owners:
                owners.append(owner)
    if len(owners) > 1 or (assembly and any(o != ctx.root for o in owners)):
        raise ValueError('Mixed coordinate contexts; supply occurrence-qualified proxy refs for assembly measurements')
    return {'space': 'assembly' if assembly or owners == [ctx.root] else 'component local',
            'component': ctx.ref(owners[0]) if owners and not assembly else ctx.ref(ctx.root)}


if '_Protocol' in globals():
    class _MeasureWorldGeometry(_Protocol):
        @property
        def worldGeometry(self) -> "adsk.core.Base": ...


    class _MeasureGeometry(_Protocol):
        @property
        def geometry(self) -> "adsk.core.Base": ...


    class _MeasureLength(_Protocol):
        @property
        def length(self) -> float: ...


    class _MeasureClosable(_Protocol):
        def close(self) -> None: ...


    class _MeasureExpressionDelegate(_Protocol):
        def __call__(self, expression: object, units: str | None = None,
                     unitless: bool = False) -> tuple[str, float]: ...

    class _MeasurePropertiesProvider(_Protocol):
        def getPhysicalProperties(self, accuracy: "adsk.fusion.CalculationAccuracy") -> "adsk.fusion.PhysicalProperties": ...


def _measure_geometry(entity: "CadEntity") -> "adsk.core.Base":
    return (_cad_cast("_MeasureWorldGeometry", entity).worldGeometry if hasattr(entity, 'worldGeometry')
            else _cad_cast("_MeasureGeometry", entity).geometry)


def _measure_expression(ctx: "CadContext", expression: object, units: str | None = None,
                        unitless: bool = False) -> "tuple[str, float]":
    delegate: object = _cad_cast(object, getattr(ctx, 'expression', None))
    if callable(delegate):
        return _cad_cast("_MeasureExpressionDelegate", delegate)(expression, units, unitless)
    delegate = _cad_cast(object, getattr(ctx, '_expression'))
    return _cad_cast("_MeasureExpressionDelegate", delegate)(expression, units, unitless)


def _measure_manager_arguments(ctx: "CadContext", entities: "Sequence[CadEntity]") -> "tuple[Sequence[CadEntity], adsk.fusion.Occurrence | None]":
    # Callers validate coordinate compatibility before normalizing manager arguments.
    natives: list[CadEntity] = [e for e in entities if _cad_kind(e) != 'occurrence' and
               getattr(e, 'assemblyContext', None) is None and _cad_owner(e) not in (None, ctx.root)]
    if not natives:
        return entities, None
    owner = _cad_owner(natives[0])
    if len(natives) != len(entities) or any(_cad_owner(e) != owner for e in entities):
        raise ValueError('Manager measurements require one native component frame or explicit occurrence-qualified refs')
    matches = [o for o in _cad_items(ctx.root.allOccurrences) if o.component == owner]
    if len(matches) != 1:
        raise ValueError('Native child-component measurement requires a unique root-context occurrence; found %d. '
                         'Supply occurrence-qualified refs with a full occurrence path.' % len(matches))
    occurrence = matches[0]
    proxy = _cad_cast(
        "Callable[[CadEntity, adsk.fusion.Occurrence | None], CadEntity]",
        getattr(ctx, '_proxy'))
    return [proxy(e, occurrence) for e in entities], occurrence


def _measure_point(ctx: "CadContext", spec: "JsonValue") -> "tuple[adsk.core.Base, CadEntity | None]":
    if isinstance(spec, list):
        return ctx.point(spec), None
    entity = ctx.resolve(spec)
    geometry = _measure_geometry(entity)
    if _cad_type(geometry) != 'Point3D':
        raise ValueError('Projected/axial modes require point refs or coordinate expression arrays')
    return geometry, entity


def _measure_body(ctx: "CadContext", entity: "CadEntity") -> "adsk.fusion.BRepBody":
    if _cad_kind(entity) != 'body':
        raise ValueError('Temporary geometry operations require explicit BRepBody refs')
    entity = _cad_cast("adsk.fusion.BRepBody", entity)
    manager = adsk.fusion.TemporaryBRepManager.get()
    native = _cad_cast("adsk.core.Base", getattr(entity, 'nativeObject', None) or entity)
    body = _cad_require_result(manager.copy(native), 'Copy temporary body')
    occurrence = _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
    if occurrence is not None:
        _cad_require_result(manager.transform(body, occurrence.transform2), 'Transform temporary body into assembly context')
    return body


def _measure_frame(ctx: "CadContext", entity: "CadEntity", frame: "JsonValue") -> "JsonObject":
    actual = _measure_space(ctx, [entity])
    if isinstance(frame, str):
        if frame != actual['space']:
            raise ValueError('Geometry reference does not belong to the declared frame')
        return actual
    if not isinstance(frame, dict) or set(frame) != {'space', 'component'} or frame['space'] != actual['space']:
        raise ValueError('frame must exactly identify the measured space and component')
    declared = ctx.resolve(frame['component'], 'component')
    expected = ctx.resolve(actual['component'], 'component')
    if declared != expected:
        raise ValueError('Geometry reference does not belong to the declared frame component')
    return actual


class _MeasureTemporaryBody:
    """Trusted in-memory B-Rep copy pinned to the frame in which it was read."""
    def __init__(self, body: "adsk.fusion.BRepBody", frame: "JsonObject | str",
                 transform: "list[int | float]") -> None:
        self.body = body
        self.frame = frame
        self.transform = transform


if _CAD_TYPE_CHECKING:
    class _MeasureAssignment(_CadTypedDict):
        parameter: adsk.fusion.Parameter
        key: str
        expression: str

    class _MeasureParameterRestore(_CadTypedDict):
        parameter: adsk.fusion.Parameter
        expression: str

    class _MeasurePlannedCase(_CadTypedDict):
        id: str
        assign: list[_MeasureAssignment]
        checks: list[JsonObject]


def _measure_temporary_body(ctx: "CadContext", ref: "JsonValue", frame: "JsonValue") -> "_MeasureTemporaryBody":
    entity = ctx.resolve(ref, 'body')
    if not entity.isSolid:
        raise ValueError('Temporary body operations require a solid BRepBody')
    context = _measure_frame(ctx, entity, frame)
    if context['space'] == 'assembly':
        body = _measure_body(ctx, entity)
    else:
        native = getattr(entity, 'nativeObject', None) or entity
        body = _cad_require_result(adsk.fusion.TemporaryBRepManager.get().copy(native), 'Copy temporary body')
    if getattr(body, 'isValid', True) is False:
        raise RuntimeError('Temporary BRep copy is invalid')
    return _MeasureTemporaryBody(body, context, _measure_transform_values(entity, context))


def _measure_transform_values(entity: "CadEntity", context: "JsonObject") -> "list[float | int]":
    matrix: list[float | int] = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    if context['space'] == 'assembly':
        occurrence = _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
        if occurrence is not None:
            matrix = list(occurrence.transform2.asArray())
    return matrix


def _measure_pose_delta(matrix_a: "Sequence[float]", matrix_b: "Sequence[float]") -> "tuple[float, float]":
    rotation_a = ((matrix_a[0], matrix_a[1], matrix_a[2]),
                  (matrix_a[4], matrix_a[5], matrix_a[6]),
                  (matrix_a[8], matrix_a[9], matrix_a[10]))
    rotation_b = ((matrix_b[0], matrix_b[1], matrix_b[2]),
                  (matrix_b[4], matrix_b[5], matrix_b[6]),
                  (matrix_b[8], matrix_b[9], matrix_b[10]))
    relative = [[sum(rotation_b[k][i] * rotation_a[k][j] for k in range(3))
                 for j in range(3)] for i in range(3)]
    cosine = max(-1.0, min(1.0, (sum(relative[i][i] for i in range(3)) - 1) / 2))
    angle = math.acos(cosine)
    translation = math.sqrt(sum((matrix_a[i] - matrix_b[i]) ** 2 for i in (3, 7, 11)))
    if not math.isfinite(angle) or not math.isfinite(translation):
        raise ValueError('Body pose comparison produced a non-finite result')
    return translation, angle


def _measure_difference_volume(manager: "adsk.fusion.TemporaryBRepManager", body: "adsk.fusion.BRepBody", tool: "adsk.fusion.BRepBody", label: str) -> "tuple[float, bool]":
    result = manager.copy(body)
    _cad_require_result(result, 'Copy ' + label + ' target')
    success = manager.booleanOperation(
        result, tool, _cad_cast("adsk.fusion.BooleanTypes", adsk.fusion.BooleanTypes.DifferenceBooleanType))
    if success is not True:
        raise RuntimeError('Temporary Boolean difference failed for ' + label)
    if getattr(result, 'isValid', True) is False:
        return 0.0, True
    volume = float(result.volume)
    if not math.isfinite(volume) or volume < 0:
        raise ValueError('Temporary Boolean difference returned an invalid volume for ' + label)
    return volume, volume == 0


def _measure_frame_context(ctx: "CadContext", frame: "JsonValue", actual: "JsonObject | str") -> "JsonObject | str":
    if isinstance(frame, str):
        if isinstance(actual, str):
            if frame != actual:
                raise ValueError('Geometry reference does not belong to the declared frame')
            return actual
        if frame != actual['space']:
            raise ValueError('Geometry reference does not belong to the declared frame')
        return actual
    if isinstance(actual, str):
        raise ValueError('Serialized temporary frame cannot prove the declared component identity')
    if not isinstance(frame, dict) or set(frame) != {'space', 'component'} or frame['space'] != actual['space']:
        raise ValueError('frame must exactly identify the measured space and component')
    declared = ctx.resolve(frame['component'], 'component')
    expected = ctx.resolve(actual['component'], 'component')
    if declared != expected:
        raise ValueError('Geometry reference does not belong to the declared frame component')
    return actual


def _measure_compare_bodies(ctx: "CadContext", ref_a: "_MeasureTemporaryBody | JsonValue",
                            ref_b: "_MeasureTemporaryBody | JsonValue", frame: "JsonValue",
                            volume_tolerance: "JsonValue", linear_tolerance: "JsonValue",
                            angular_tolerance: "JsonValue") -> "JsonObject":
    def operand(value: "_MeasureTemporaryBody | JsonValue") -> "tuple[adsk.fusion.BRepBody, JsonObject | str, Sequence[float]]":
        if isinstance(value, _MeasureTemporaryBody):
            _measure_frame_context(ctx, frame, value.frame)
            return value.body, value.frame, value.transform
        entity = ctx.resolve(value, 'body')
        context = _measure_frame(ctx, entity, frame)
        if not entity.isSolid:
            raise ValueError('compare_bodies requires two solid bodies')
        temporary = _measure_temporary_body(ctx, value, frame)
        return temporary.body, context, temporary.transform

    a_body, context, transform_a = operand(ref_a)
    b_body, context_b, transform_b = operand(ref_b)
    if isinstance(context, str) and isinstance(context_b, dict):
        context = _measure_frame_context(ctx, context, context_b)
    elif isinstance(context_b, str) and isinstance(context, dict):
        context_b = _measure_frame_context(ctx, context_b, context)
    if context != context_b:
        raise ValueError('Both bodies must be measured in the same declared frame')
    for tolerance in (volume_tolerance, linear_tolerance, angular_tolerance):
        if not isinstance(tolerance, str) or not tolerance.strip():
            raise ValueError('Volume, linear and angular tolerances must be explicit dimensional expressions')
    volume_tolerance_cm3 = _measure_expression(ctx, volume_tolerance, 'cm^3')[1]
    linear_tolerance_cm = _measure_expression(ctx, linear_tolerance, 'cm')[1]
    angular_tolerance_rad = _measure_expression(ctx, angular_tolerance, 'rad')[1]
    if min(volume_tolerance_cm3, linear_tolerance_cm, angular_tolerance_rad) < 0:
        raise ValueError('Comparison tolerances must be nonnegative')
    manager = adsk.fusion.TemporaryBRepManager.get()
    a_minus_b, empty_a_minus_b = _measure_difference_volume(manager, a_body, b_body, 'a-b')
    b_minus_a, empty_b_minus_a = _measure_difference_volume(manager, b_body, a_body, 'b-a')
    translation_delta, rotation_delta = _measure_pose_delta(transform_a, transform_b)
    volume_equal = a_minus_b <= volume_tolerance_cm3 and b_minus_a <= volume_tolerance_cm3
    pose_equal = translation_delta <= linear_tolerance_cm and rotation_delta <= angular_tolerance_rad
    return {'frame': context, 'aMinusB': {'value': a_minus_b, 'units': 'cm^3'},
            'bMinusA': {'value': b_minus_a, 'units': 'cm^3'},
            'emptyDifference': {'aMinusB': empty_a_minus_b, 'bMinusA': empty_b_minus_a},
            'translationDelta': {'value': translation_delta, 'units': 'cm'},
            'rotationDelta': {'value': rotation_delta, 'units': 'rad'},
            'volumeEqual': volume_equal, 'poseEqual': pose_equal, 'equal': volume_equal and pose_equal,
            'tolerances': {'volume': volume_tolerance, 'length': linear_tolerance, 'angle': angular_tolerance}}


def _measure_scalar(ctx: "CadContext", data: "JsonObject", mode: "Literal['diameter', 'radius', 'distance', 'angle', 'length', 'area', 'volume', 'mass', 'thickness']") -> "JsonObject":
    _cad_fields(data, ('ref',), ('units',))
    entity = ctx.resolve(data['ref'])
    context = _measure_space(ctx, [entity])
    dimension = mode if mode in ('area', 'volume', 'mass') else 'length'
    _measure_value(0, dimension, data)
    method = mode
    if mode in ('radius', 'diameter'):
        geometry = _measure_geometry(entity)
        if _cad_type(geometry) not in ('Cylinder', 'Circle3D', 'Arc3D', 'Sphere'):
            raise ValueError('Radius/diameter requires an analytic cylinder, circle, arc, or sphere; never a bounding box')
        value = _cad_cast("adsk.core.Cylinder | adsk.core.Circle3D | adsk.core.Arc3D | adsk.core.Sphere", geometry).radius * (2 if mode == 'diameter' else 1)
        method = 'analytic ' + _cad_type(geometry)
    elif mode == 'length':
        if _cad_type(entity) == 'BRepEdge' or hasattr(entity, 'parentSketch') and hasattr(entity, 'length'):
            value = _cad_cast("_MeasureLength", entity).length
        else:
            raise ValueError('Length requires a BRepEdge or finite sketch curve')
    elif mode == 'area' and _cad_kind(entity) == 'face':
        value = _cad_cast("adsk.fusion.BRepFace", entity).area
    elif mode == 'area' and _cad_kind(entity) == 'profile':
        value = _cad_cast("adsk.fusion.Profile", entity).areaProperties(
            _cad_cast("adsk.fusion.CalculationAccuracy", adsk.fusion.CalculationAccuracy.HighCalculationAccuracy)).area
        method = 'profile area, high calculation accuracy'
    else:
        if _cad_kind(entity) not in ('body', 'component', 'occurrence'):
            raise ValueError(mode + ' requires a body, component, or occurrence')
        properties = _cad_cast("_MeasurePropertiesProvider", entity).getPhysicalProperties(
            _cad_cast("adsk.fusion.CalculationAccuracy", adsk.fusion.CalculationAccuracy.HighCalculationAccuracy))
        value = _cad_cast(float, getattr(properties, mode))
        method = 'physical properties, high calculation accuracy'
    result = dict(_measure_value(value, dimension, data), ref=ctx.ref(entity), method=method, context=context)
    if mode == 'mass':
        result['limitations'] = ['Uses assigned Fusion material densities, including defaults; material suitability is not verified.']
    return result


def _measure_distance(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('a', 'b'), ('mode', 'direction', 'units', 'space'))
    mode = data.get('mode', 'minimum')
    _measure_value(0, 'length', data)
    if mode == 'minimum':
        if 'direction' in data or 'space' in data:
            raise ValueError('Minimum mode uses entity contexts; direction/space only apply to point projection modes')
        a, b = [ctx.resolve(data[k]) for k in ('a', 'b')]
        context = _measure_space(ctx, [a, b])
        arguments, occurrence = _measure_manager_arguments(ctx, [a, b])
        measured = _cad_require_result(ctx.app.measureManager.measureMinimumDistance(*arguments), 'Minimum distance')
        result = _measure_value(measured.value, 'length', data)
        scale = _MEASURE_UNITS['length'][_cad_cast(str, result['units'])]
        points = [measured.positionOne.copy(), measured.positionTwo.copy()]
        if occurrence is not None:
            inverse = occurrence.transform2.copy()
            _cad_require_result(inverse.invert(), 'Invert measurement occurrence transform')
            for point in points:
                _cad_require_result(point.transformBy(inverse), 'Return closest point to component local frame')
        result.update(points=[[v * scale for v in _cad_xyz(p)] for p in points])
    elif mode in ('projected', 'axial'):
        if 'direction' not in data or data.get('space') not in ('assembly', 'component local'):
            raise ValueError('Point projection requires direction and explicit space: assembly or component local')
        points = [_measure_point(ctx, data[k]) for k in ('a', 'b')]
        entities = [e for p, e in points if e is not None]
        context = _measure_space(ctx, entities) if entities else {
            'space': data['space'], 'component': ctx.ref(ctx.root if data['space'] == 'assembly' else ctx.component)}
        if context['space'] != data['space']:
            raise ValueError('Explicit point space disagrees with reference context')
        if len(entities) < 2 and data['space'] == 'component local' and any(_cad_owner(e) != ctx.component for e in entities):
            raise ValueError('Coordinate arrays use the selected component; point refs must use that same component')
        direction = _cad_direction(data['direction'])
        delta = [b - a for a, b in zip(_cad_xyz(_cad_cast("adsk.core.Point3D", points[0][0])),
                                        _cad_xyz(_cad_cast("adsk.core.Point3D", points[1][0])))]
        signed = sum(a * b for a, b in zip(delta, direction))
        result = _measure_value(signed if mode == 'axial' else abs(signed), 'length', data)
        result['direction'] = direction
    else:
        raise ValueError('Distance mode must be minimum, projected (unsigned), or axial (signed point separation)')
    return dict(result, mode=mode, context=context)


def _measure_angle(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('a', 'b'), ('c', 'units'))
    _measure_value(0, 'angle', data)
    entities = [ctx.resolve(data[k]) for k in ('a', 'b', 'c') if k in data]
    context = _measure_space(ctx, entities)
    arguments, _ = _measure_manager_arguments(ctx, entities)
    result = _cad_require_result(ctx.app.measureManager.measureAngle(*arguments), 'Measure angle')
    return dict(_measure_value(result.value, 'angle', data), context=context,
                method='Fusion measureAngle; second point is apex for three-point input')


def _cad_brep_bounds(entity: "CadEntity", scale: float = 1.0) -> "JsonObject":
    """Union actual B-Rep bounds in the entity's frame; cm unless scaled."""
    kind = _cad_kind(entity)
    if kind not in ('body', 'face', 'edge', 'component', 'occurrence'):
        raise ValueError('Bounds requires B-Rep geometry, a component, or an occurrence (not sketch-local bounds)')
    bodies: list[adsk.fusion.BRepBody]
    if kind == 'component':
        bodies = _cad_items(_cad_cast("adsk.fusion.Component", entity).bRepBodies)
        # allOccurrences is already recursive, with proxies in this component's frame.
        for occurrence in _cad_items(_cad_cast("adsk.fusion.Component", entity).allOccurrences):
            bodies.extend(_cad_items(occurrence.bRepBodies))
    elif kind == 'occurrence':
        bodies, pending = [], [_cad_cast("adsk.fusion.Occurrence", entity)]
        while pending:
            occurrence = pending.pop()
            bodies.extend(_cad_items(occurrence.bRepBodies))
            pending.extend(_cad_items(occurrence.childOccurrences))
    else:
        bodies = [_cad_cast("adsk.fusion.BRepBody", entity)]
    if not bodies:
        raise ValueError('Bounds requires nonempty B-Rep geometry')
    low, high = None, None
    for body in bodies:
        # Query geometry in context; rotating a definition AABB need not tightly fit the body.
        box = _cad_cast("adsk.core.BoundingBox3D | None", body.boundingBox if kind in ('face', 'edge') else body.preciseBoundingBox)
        if box is None:
            raise ValueError('Bounds returned no geometric bounding box')
        a, b = [[v * scale for v in _cad_xyz(p)] for p in (box.minPoint, box.maxPoint)]
        if any(not math.isfinite(v) for v in a + b) or any(x > y for x, y in zip(a, b)):
            raise ValueError('Bounds returned invalid or non-finite geometric extents')
        low = a if low is None else [min(x, y) for x, y in zip(_cad_cast("list[float]", low), a)]
        high = b if high is None else [max(x, y) for x, y in zip(_cad_cast("list[float]", high), b)]
    size = [b - a for a, b in zip(_cad_cast("list[float]", low), _cad_cast("list[float]", high))]
    if any(not math.isfinite(v) for v in size):
        raise ValueError('Bounds returned non-finite geometric size')
    return {'min': _cad_cast("list[float]", low), 'max': _cad_cast("list[float]", high), 'size': size}


def _measure_bounds(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('ref',), ('units',))
    entity = ctx.resolve(data['ref'])
    unit = _cad_cast(str, _measure_value(0, 'length', data)['units'])
    context = _measure_space(ctx, [entity])
    bounds = _cad_brep_bounds(entity, _MEASURE_UNITS['length'][unit])
    kind = _cad_kind(entity)
    return dict(bounds, units=unit,
            context=context, method=('axis-aligned B-Rep face/edge API bounding box' if kind in ('face', 'edge') else
                'axis-aligned union of B-Rep body preciseBoundingBox in context; excludes graphics and construction geometry') +
                '; not a diameter or tight oriented envelope')


def _measure_section(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('body', 'plane'), ('units', 'mode'))
    if data.get('mode', 'curves') != 'curves':
        raise ValueError('Section supports computed intersection curves only; filled area and UI section analysis are unsupported')
    _measure_value(0, 'length', data)
    body, plane = ctx.resolve(data['body'], 'body'), ctx.resolve(data['plane'])
    context = _measure_space(ctx, [body, plane])
    geometry = _measure_geometry(plane)
    if _cad_type(geometry) != 'Plane':
        raise ValueError('Section plane must be planar')
    wire = _cad_cast("adsk.fusion.BRepBody | None", adsk.fusion.TemporaryBRepManager.get().planeIntersection(
        _measure_body(ctx, body), _cad_cast("adsk.core.Plane", geometry)))
    if wire is None:
        raise RuntimeError('Section returned no wire; no intersection or kernel failure (not reported as a verified empty section)')
    edges = _cad_items(wire.edges)
    curves: list[JsonObject] = []
    for edge in edges:
        row = _cad_geometry(edge.geometry)
        row['length'] = _measure_value(edge.length, 'length', data)
        curves.append(row)
    return {'context': context, 'method': 'temporary B-Rep plane intersection', 'curves': curves,
            'edgeCount': len(edges), 'totalLength': _measure_value(sum(e.length for e in edges), 'length', data),
            'limitations': ['Curve geometry coordinates/radii use cm and angles rad as labeled; totalLength uses requested units.',
                            'No persistent analysis, filled section area, or assumption that curves form closed loops.']}


def _measure_thickness(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('a', 'b'), ('units', 'mode', 'tolerance', 'angleTolerance'))
    if data.get('mode', 'parallelPlanes') != 'parallelPlanes':
        raise ValueError('Thickness supports selected parallel planar faces only; global minimum wall and ray sampling are unsupported')
    entities = [ctx.resolve(data[k], 'face') for k in ('a', 'b')]
    context = _measure_space(ctx, entities)
    if entities[0].body != entities[1].body:
        raise ValueError('Thickness faces must belong to the same body in the same occurrence')
    planes = [_cad_cast("adsk.core.Plane", _measure_geometry(e)) for e in entities]
    if any(_cad_type(p) != 'Plane' for p in planes):
        raise ValueError('Thickness requires planar faces')
    angle = ctx.angle(data.get('angleTolerance', '0.001 deg'))
    tolerance = ctx.length(data.get('tolerance', '0.001 mm'))
    if not 0 <= angle < math.pi / 2 or tolerance < 0:
        raise ValueError('Invalid thickness tolerances')
    normals = [_cad_direction(_cad_xyz(p.normal)) for p in planes]
    if math.acos(min(1, abs(sum(a * b for a, b in
                                _cad_cast("Iterable[tuple[float, float]]", zip(*normals)))))) > angle:
        raise ValueError('Selected faces are not parallel within angleTolerance')
    delta = [b - a for a, b in zip(_cad_xyz(planes[0].origin), _cad_xyz(planes[1].origin))]
    # Infinite-plane distance is analytic; MeasureManager accepts the finite faces only.
    value = abs(sum(a * b for a, b in zip(delta, normals[0])))
    arguments, _ = _measure_manager_arguments(ctx, entities)
    minimum = _cad_require_result(ctx.app.measureManager.measureMinimumDistance(*arguments), 'Thickness face distance').value
    if value <= tolerance or abs(minimum - value) > tolerance:
        raise ValueError('Faces are coincident or have no normal overlap within tolerance')
    return dict(_measure_value(value, 'length', data), context=context, method='selected parallel face separation',
                limitations=['Does not prove material continuity between faces or a global minimum wall thickness.'])


def _measure_pair(ctx: "CadContext", data: "JsonObject", mode: "Literal['interference', 'clearance']") -> "JsonObject":
    _cad_fields(data, ('a', 'b'), ('minimum', 'volumeTolerance'))
    entities = [ctx.resolve(data[k], 'body') for k in ('a', 'b')]
    if entities[0] == entities[1]:
        raise ValueError('Assembly checks require two distinct body instances')
    context = _measure_space(ctx, entities)
    minimum = ctx.length(data.get('minimum', '0 mm'))
    volume_tolerance = _measure_expression(ctx, data.get('volumeTolerance', '0 mm^3'), 'cm^3')[1]
    if minimum < 0 or volume_tolerance < 0:
        raise ValueError('Clearance and volume tolerance must be nonnegative')
    if mode == 'interference' and 'minimum' in data:
        raise ValueError('minimum applies only to clearance')
    bodies = [_measure_body(ctx, e) for e in entities]
    result = _measure_pair_bodies(ctx, bodies, minimum, volume_tolerance)
    return dict(result, context=context, refs=[ctx.ref(e) for e in entities],
                passed=not result['interferes'] if mode == 'interference' else result['clearancePassed'])


def _measure_pair_bodies(ctx: "CadContext", bodies: "Sequence[adsk.fusion.BRepBody]", minimum: float, volume_tolerance: float) -> "JsonObject":
    if any(not b.isSolid for b in bodies):
        raise ValueError('Interference/clearance requires solid bodies')
    manager = adsk.fusion.TemporaryBRepManager.get()
    overlap = _cad_require_result(manager.copy(bodies[0]), 'Copy interference target')
    _cad_require_result(manager.booleanOperation(overlap, bodies[1],
        _cad_cast("adsk.fusion.BooleanTypes", adsk.fusion.BooleanTypes.IntersectionBooleanType)), 'Temporary intersection')
    volume = overlap.volume
    distance = 0.0 if volume > 0 else _cad_require_result(
        ctx.app.measureManager.measureMinimumDistance(*bodies), 'Body minimum distance').value
    return {'interferes': volume > volume_tolerance, 'overlapVolume': _measure_value(volume, 'volume', {}),
            'distance': _measure_value(distance, 'length', {}), 'minimum': _measure_value(minimum, 'length', {}),
            'volumeTolerance': _measure_value(volume_tolerance, 'volume', {}),
            'clearancePassed': volume <= volume_tolerance and distance >= minimum,
            'method': 'temporary solid intersection plus unsigned minimum distance; contact is zero clearance'}


def _measure_motion(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('moving', 'obstacles', 'translations'), ('minimum', 'volumeTolerance', 'mode'))
    if data.get('mode', 'sampledTranslation') != 'sampledTranslation':
        raise ValueError('Only sampledTranslation is supported; joint solving, rotations, and continuous sweep are unsupported')
    if not isinstance(data['obstacles'], list) or not data['obstacles']:
        raise ValueError('obstacles must be a nonempty array of solid body refs')
    if not isinstance(data['translations'], list) or not data['translations']:
        raise ValueError('translations must be a nonempty array of expression coordinate arrays')
    moving = ctx.resolve(data['moving'], 'body')
    obstacles = [ctx.resolve(r, 'body') for r in data['obstacles']]
    if moving in obstacles:
        raise ValueError('Moving body cannot be its own obstacle')
    context = _measure_space(ctx, [moving] + obstacles)
    points = [ctx.point(p) for p in data['translations']]
    minimum = ctx.length(data.get('minimum', '0 mm'))
    tolerance = _measure_expression(ctx, data.get('volumeTolerance', '0 mm^3'), 'cm^3')[1]
    if minimum < 0 or tolerance < 0:
        raise ValueError('Tolerances must be nonnegative')
    manager = adsk.fusion.TemporaryBRepManager.get()
    original = _measure_body(ctx, moving)
    fixed = [_measure_body(ctx, e) for e in obstacles]
    samples: list[JsonObject] = []
    for index, point in enumerate(points):
        body = _cad_require_result(manager.copy(original), 'Copy motion sample')
        transform = adsk.core.Matrix3D.create()
        transform.translation = adsk.core.Vector3D.create(point.x, point.y, point.z)
        _cad_require_result(manager.transform(body, transform), 'Translate temporary sample')
        checks = [_measure_pair_bodies(ctx, [body, obstacle], minimum, tolerance) for obstacle in fixed]
        samples.append({'index': index, 'translation': {'xyz': [v * 10 for v in _cad_xyz(point)], 'units': 'mm'},
                        'checks': checks, 'passed': all(c['clearancePassed'] for c in checks)})
    return {'context': context, 'samples': samples, 'sampledPassed': all(s['passed'] for s in samples),
            'obstacles': [ctx.ref(e) for e in obstacles], 'continuousMotionVerified': False,
            'limitations': ['Independent translations from original pose in reported context; no joint or contact solver.',
                            'Collisions between samples are not tested. No live occurrence transforms are changed.']}


def _measure_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('measurement',), ('min', 'max', 'expected', 'tolerance', 'id', 'source'))
    spec = data['measurement']
    _cad_fields(spec, ('operation', 'data'))
    spec = _cad_cast("JsonObject", spec)
    if spec['operation'] not in _MEASURE_SCALARS:
        raise ValueError('check requires a scalar measure operation')
    if not any(k in data for k in ('min', 'max', 'expected')):
        raise ValueError('Supply min/max or expected with an optional tolerance')
    if ('expected' in data and any(k in data for k in ('min', 'max'))) or ('tolerance' in data and 'expected' not in data):
        raise ValueError('Use expected/tolerance OR min/max')
    actual = _cad_cast("JsonObject", ctx.call(_cad_cast(str, spec['operation']),
                                                _cad_cast("JsonObject", spec['data'])))
    dimension, units = _cad_cast(str, actual['dimension']), _cad_cast(str, actual['units'])
    factor = _MEASURE_UNITS[dimension][units]
    values: dict[str, float] = {k: _measure_expression(ctx, data[k], _MEASURE_INTERNAL[dimension])[1] * factor
              for k in ('min', 'max', 'expected', 'tolerance') if k in data}
    if values.get('tolerance', 0) < 0:
        raise ValueError('tolerance must be nonnegative')
    if 'expected' in values:
        low = values['expected'] - values.get('tolerance', 0)
        high = values['expected'] + values.get('tolerance', 0)
    else:
        low, high = values.get('min'), values.get('max')
    if low is not None and high is not None and low > high:
        raise ValueError('min exceeds max')
    passed = (low is None or _cad_cast(float, actual['value']) >= low) and \
             (high is None or _cad_cast(float, actual['value']) <= high)
    return {'id': data.get('id'), 'source': data.get('source'), 'actual': actual,
            'acceptance': {'min': low, 'max': high, 'units': units}, 'passed': passed,
            'status': 'pass' if passed else 'fail'}


def _measure_history_key(ctx: "CadContext", item: "CadEntity") -> str:
    try:
        kind = _cad_kind(item)
    except Exception:
        kind = None
    if kind == 'parameter':
        name = getattr(item, 'name', None)
        if isinstance(name, str) and name:
            return 'parameter:' + name
    try:
        ref: object = _cad_cast(object, ctx.ref(item))
        if isinstance(ref, dict) and _cad_cast("JsonObject", ref).get('token'):
            return 'token:' + str(_cad_cast("JsonObject", ref)['token'])
    except Exception:
        pass
    return 'object:%s' % id(item)


def _measure_health(ctx: "CadContext", items: "Sequence[adsk.fusion.TimelineObject] | None" = None,
                    owner: "adsk.fusion.Component | None" = None, recursive: bool = True,
                    allow_suppressed: "Sequence[CadEntity]" = ()) -> "list[JsonObject]":
    """Walk exposed timeline groups; never infer health for unvisited children."""
    if items is None:
        items = _cad_items(ctx.design.timeline)
    states = adsk.fusion.FeatureHealthStates
    names = ('HealthyFeatureHealthState', 'WarningFeatureHealthState', 'ErrorFeatureHealthState', 'SuppressedFeatureHealthState')
    allowed: set[str] = {_measure_history_key(ctx, item) for item in allow_suppressed}
    seen: dict[str, str] = {}
    rows: list[JsonObject] = []

    def walk(item: "adsk.fusion.TimelineObject", path: str) -> bool:
        is_group = _cad_cast(object, getattr(item, 'isGroup', False)) is True
        if is_group:
            group_state = _cad_cast(int | None, getattr(item, 'healthState', None))
            group_state_name = next((name for name in names if hasattr(states, name) and
                                     _cad_cast(int, getattr(states, name)) == group_state), 'unknown')
            group_row: JsonObject = {'index': int(path.rsplit('/', 1)[-1]), 'path': path,
                         'name': _cad_cast("JsonValue", getattr(item, 'name', None)),
                         'isGroup': True, 'healthState': int(group_state) if group_state is not None else None,
                         'state': group_state_name,
                         'message': _cad_cast("JsonValue", getattr(item, 'errorOrWarningMessage', '')),
                         'suppressed': bool(getattr(item, 'isSuppressed', False)),
                         'rolledBack': bool(getattr(item, 'isRolledBack', False))}
            child_start = len(rows)
            if recursive:
                children: list[str] = []
                for child_index in range(_cad_cast("adsk.fusion.TimelineGroup", item).count):
                    child_path = path + '/' + str(child_index)
                    if walk(_cad_cast("adsk.fusion.TimelineGroup", item).item(child_index), child_path):
                        children.append(child_path)
                group_row['visitedChildren'] = children
                group_row['childCount'] = _cad_cast("adsk.fusion.TimelineGroup", item).count
            else:
                group_row['childCount'] = _cad_cast("adsk.fusion.TimelineGroup", item).count
                group_row['unvisitedChildren'] = _cad_cast("adsk.fusion.TimelineGroup", item).count
            has_children = bool(group_row.get('visitedChildren'))
            if owner is not None and recursive and not has_children:
                del rows[child_start:]
                return False
            rows.insert(child_start, group_row)
            return has_children if recursive else True

        entity = _cad_cast("CadEntity", getattr(item, 'entity', None) or item)
        if owner is not None:
            try:
                item_owner = _cad_owner(entity)
                if item_owner not in (None, owner):
                    return False
            except Exception:
                item_owner = None
        else:
            try:
                item_owner = _cad_owner(entity)
            except Exception:
                item_owner = None
        key = _measure_history_key(ctx, entity)
        if key in seen:
            rows.append({'index': int(path.rsplit('/', 1)[-1]), 'path': path,
                         'name': _cad_cast("JsonValue", getattr(item, 'name', None)),
                         'duplicate': True, 'duplicateOf': seen[key]})
            return True
        seen[key] = path
        state = _cad_cast(int | None, getattr(item, 'healthState', None))
        state_name = next((name for name in names if hasattr(states, name) and
                           _cad_cast(int, getattr(states, name)) == state), 'unknown')
        row: JsonObject = {'index': int(path.rsplit('/', 1)[-1]), 'path': path,
               'name': _cad_cast("JsonValue", getattr(item, 'name', None)),
               'healthState': int(state) if state is not None else None,
               'state': 'unknown' if owner is not None and item_owner is None else state_name,
               'ownerUnknown': item_owner is None,
               'message': _cad_cast("JsonValue", getattr(item, 'errorOrWarningMessage', '')),
               'suppressed': bool(getattr(item, 'isSuppressed', False)),
               'rolledBack': bool(getattr(item, 'isRolledBack', False))}
        try:
            row['ref'] = ctx.ref(entity)
        except Exception:
            row['ref'] = None
        row['suppressedAllowed'] = row['suppressed'] and key in allowed
        rows.append(row)
        return True

    for index, item in enumerate(items):
        walk(item, str(index))
    return rows


def _measure_callback_result(callback: "Callable[[JsonObject, JsonObject], object]", data: "JsonObject", result_data: "JsonObject") -> bool:
    result = callback(data, result_data)
    if inspect.isawaitable(result):
        close = getattr(result, 'close', None)
        if callable(close):
            _cad_cast("_MeasureClosable", result).close()
        raise ValueError('Asynchronous parameter-test callbacks are unsupported')
    if result is None:
        return True
    if type(result) is bool:
        return result
    if not isinstance(result, dict):
        raise TypeError('parameter-test callback must return bool, an acceptance object, or None')
    result = _cad_cast("JsonObject", result)
    flags = [key for key in ('accepted', 'checkPassed', 'passed') if key in result]
    if not flags or any(type(result[key]) is not bool for key in flags):
        raise ValueError('parameter-test callback result requires boolean acceptance evidence')
    return all(result[key] for key in flags) and result.get('success') is not False and \
        result.get('status') not in ('unknown', 'missing', 'stale', 'blocked', 'error', 'fail', 'failed')


def _measure_validate_parameter_check(ctx: "CadContext", check: "JsonValue") -> None:
    if not isinstance(check, dict):
        raise ValueError('check entries must be objects')
    _cad_fields(check, ('measurement',), ('min', 'max', 'expected', 'tolerance', 'id', 'source'))
    measurement = check['measurement']
    if not isinstance(measurement, dict):
        raise ValueError('check.measurement must be an object')
    _cad_fields(measurement, ('operation', 'data'))
    if not isinstance(measurement['data'], dict) or measurement['operation'] not in _MEASURE_SCALARS:
        raise ValueError('parameter.test checks require an existing scalar measurement operation')
    if not any(key in check for key in ('min', 'max', 'expected')):
        raise ValueError('check requires min/max or expected')
    if ('expected' in check and any(key in check for key in ('min', 'max'))) or \
            ('tolerance' in check and 'expected' not in check):
        raise ValueError('Use expected/tolerance OR min/max')
    operation, payload = _cad_cast(str, measurement['operation']), measurement['data']
    inputs = {
        'measure.diameter': (('ref',), ('units',)), 'measure.radius': (('ref',), ('units',)),
        'measure.length': (('ref',), ('units',)), 'measure.area': (('ref',), ('units',)),
        'measure.volume': (('ref',), ('units',)), 'measure.mass': (('ref',), ('units',)),
        'measure.distance': (('a', 'b'), ('mode', 'direction', 'units', 'space')),
        'measure.angle': (('a', 'b'), ('c', 'units')),
        'measure.thickness': (('a', 'b'), ('units', 'mode', 'tolerance', 'angleTolerance')),
    }
    required, optional = inputs[operation]
    _cad_fields(payload, required, optional)
    dimension = _cad_cast("Literal['length', 'area', 'volume', 'mass', 'angle']", {'measure.diameter': 'length', 'measure.radius': 'length', 'measure.length': 'length',
                 'measure.area': 'area', 'measure.volume': 'volume', 'measure.mass': 'mass',
                 'measure.distance': 'length', 'measure.angle': 'angle', 'measure.thickness': 'length'}[operation])
    _measure_value(0, dimension, payload)
    for key in ('min', 'max', 'expected', 'tolerance'):
        if key in check:
            value = _measure_expression(ctx, check[key], _MEASURE_INTERNAL[dimension])[1]
            if key == 'tolerance' and value < 0:
                raise ValueError('tolerance must be nonnegative')
    if operation in ('measure.diameter', 'measure.radius', 'measure.length', 'measure.area',
                     'measure.volume', 'measure.mass'):
        entity = ctx.resolve(payload['ref'])
        kind = _cad_kind(entity)
        if operation in ('measure.diameter', 'measure.radius') and _cad_type(_measure_geometry(entity)) not in (
                'Cylinder', 'Circle3D', 'Arc3D', 'Sphere'):
            raise ValueError('Radius/diameter requires an analytic cylinder, circle, arc, or sphere')
        if operation == 'measure.length' and not (kind == 'edge' or hasattr(entity, 'parentSketch') and hasattr(entity, 'length')):
            raise ValueError('Length requires a BRepEdge or finite sketch curve')
        if operation == 'measure.area' and kind not in ('face', 'profile', 'body', 'component', 'occurrence'):
            raise ValueError('Area requires a face, profile, body, component, or occurrence')
        if operation in ('measure.volume', 'measure.mass') and kind not in ('body', 'component', 'occurrence'):
            raise ValueError(operation.split('.')[1] + ' requires a body, component, or occurrence')
        _measure_space(ctx, [entity])
    elif operation == 'measure.distance':
        mode = payload.get('mode', 'minimum')
        if mode == 'minimum':
            if 'direction' in payload or 'space' in payload:
                raise ValueError('Minimum mode uses entity contexts; direction/space only apply to point projection modes')
            entities = [ctx.resolve(payload[key]) for key in ('a', 'b')]
            _measure_space(ctx, entities)
            _measure_manager_arguments(ctx, entities)
        elif mode in ('projected', 'axial'):
            if 'direction' not in payload or payload.get('space') not in ('assembly', 'component local'):
                raise ValueError('Point projection requires direction and explicit space: assembly or component local')
            _cad_direction(payload['direction'])
            points = [_measure_point(ctx, payload[key]) for key in ('a', 'b')]
            entities = [entity for unused_point, entity in points if entity is not None]
            context = _measure_space(ctx, entities) if entities else {
                'space': payload['space'], 'component': ctx.ref(ctx.root if payload['space'] == 'assembly' else ctx.component)}
            if context['space'] != payload['space']:
                raise ValueError('Explicit point space disagrees with reference context')
        else:
            raise ValueError('Distance mode must be minimum, projected, or axial')
    elif operation == 'measure.angle':
        entities = [ctx.resolve(payload[key]) for key in ('a', 'b', 'c') if key in payload]
        _measure_space(ctx, entities)
        _measure_manager_arguments(ctx, entities)
    elif operation == 'measure.thickness':
        if payload.get('mode', 'parallelPlanes') != 'parallelPlanes':
            raise ValueError('Thickness supports selected parallel planar faces only')
        entities = [ctx.resolve(payload[key], 'face') for key in ('a', 'b')]
        if entities[0].body != entities[1].body:
            raise ValueError('Thickness faces must belong to the same body in the same occurrence')
        planes = [_cad_cast("adsk.core.Plane", _measure_geometry(entity)) for entity in entities]
        if any(_cad_type(plane) != 'Plane' for plane in planes):
            raise ValueError('Thickness requires planar faces')
        angle = ctx.angle(payload.get('angleTolerance', '0.001 deg'))
        tolerance = ctx.length(payload.get('tolerance', '0.001 mm'))
        if not 0 <= angle < math.pi / 2 or tolerance < 0:
            raise ValueError('Invalid thickness tolerances')
        normals = [_cad_direction(_cad_xyz(plane.normal)) for plane in planes]
        if math.acos(min(1, abs(sum(a * b for a, b in
                                    _cad_cast("Iterable[tuple[float, float]]", zip(*normals)))))) > angle:
            raise ValueError('Selected faces are not parallel within angleTolerance')
        _measure_space(ctx, entities)
        _measure_manager_arguments(ctx, entities)
    return None


def _measure_parameter_test_legacy(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('parameter', 'expressions', 'confirm'), ('checks',))
    ctx.require_confirm(data)
    parameter = ctx.resolve(data['parameter'], 'parameter')
    expressions = data['expressions']
    if not isinstance(expressions, list) or not expressions:
        raise ValueError('expressions must be a nonempty array')
    expressions = _cad_cast("list[str]", expressions)
    if parameter.unit.lower() == 'text':
        raise ValueError('Text parameter testing is unsupported')
    for expression in expressions:
        _measure_expression(ctx, expression, parameter.unit, unitless=parameter.unit == '')
    checks = data.get('checks', [])
    if not isinstance(checks, list):
        raise ValueError('checks must be an array of check input objects')
    for check in checks:
        _measure_validate_parameter_check(ctx, check)
    original = parameter.expression
    baseline = _measure_health(ctx)
    samples, error, restore_errors = _cad_cast(
        "tuple[list[JsonObject], str | None, list[str]]", ([], None, []))
    restored_health = _cad_cast("list[JsonObject] | None", None)
    try:
        for expression in expressions:
            parameter.expression = expression
            _cad_require_result(ctx.design.computeAll(), 'Parameter test recompute')
            health = _measure_health(ctx)
            results: list[JsonObject] = [_measure_check(ctx, _cad_cast("JsonObject", check)) for check in checks]
            samples.append({'expression': expression, 'health': health, 'checks': results,
                            'passed': _measure_health_passed(health) and all(r['passed'] for r in results)})
    except Exception as exc:
        # Failures are evidence, not success; restoration must run even after a setter failure.
        error = type(exc).__name__ + ': ' + str(exc)
    finally:
        try:
            parameter.expression = original
        except Exception as exc:
            restore_errors.append('expression: ' + type(exc).__name__ + ': ' + str(exc))
        try:
            _cad_require_result(ctx.design.computeAll(), 'Restore recompute')
        except Exception as exc:
            restore_errors.append('compute: ' + type(exc).__name__ + ': ' + str(exc))
        try:
            if parameter.expression != original:
                restore_errors.append('Restored expression differs from original')
            restored_health = _measure_health(ctx)
            if restored_health != baseline:
                restore_errors.append('Timeline health differs from baseline after restoration')
        except Exception as exc:
            restore_errors.append('verification: ' + type(exc).__name__ + ': ' + str(exc))
    passed = error is None and not restore_errors and len(samples) == len(expressions) and all(s['passed'] for s in samples)
    return {'passed': passed, 'status': 'pass' if passed else 'fail', 'samples': samples, 'error': error,
            'originalExpression': original, 'restored': not restore_errors, 'restoreErrors': restore_errors,
            'baselineHealth': baseline, 'restoredHealth': restored_health,
            'limitations': ['Restores the expression and verifies timeline health, not a transaction rollback; document may remain modified.',
                            'Warnings and unapproved suppressed features fail sampled health checks.']}


def _measure_parameter_test_v2(ctx: "CadContext", data: "JsonObject",
                               check_case: "Callable[[JsonObject, JsonObject], object] | None" = None,
                               check_restored: "Callable[[JsonObject, JsonObject], object] | None" = None) -> "JsonObject":
    _cad_fields(data, ('cases', 'confirm'), ('timeBudgetMs',))
    ctx.require_confirm(data)
    cases = data['cases']
    if not isinstance(cases, list) or not cases or len(cases) > _PARAMETER_TEST_MAX_CASES:
        raise ValueError('cases must contain 1..1000 test cases')
    time_budget_ms = data.get('timeBudgetMs', _PARAMETER_TEST_DEFAULT_BUDGET_MS)
    if type(time_budget_ms) is not int or time_budget_ms < 1:
        raise ValueError('timeBudgetMs must be a positive integer')
    if (check_case is None) != (check_restored is None):
        raise ValueError('check_case and check_restored callbacks must be supplied together')
    if check_case is not None and (not callable(check_case) or not callable(check_restored)):
        raise TypeError('parameter-test callbacks must be callable')

    start = time.monotonic()
    deadline_ms = start * 1000 + time_budget_ms
    case_ids, planned, parameters = _cad_cast(
        "tuple[set[str], list[_MeasurePlannedCase], dict[str, _MeasureParameterRestore]]", (set(), [], {}))
    assignment_count = 0
    for case in cases:
        if not isinstance(case, dict) or set(case) - {'id', 'assign', 'checks'}:
            raise ValueError('case entries accept id, assign and checks only')
        case_id = case.get('id')
        if not isinstance(case_id, str) or not case_id.strip() or case_id in case_ids:
            raise ValueError('case id must be nonempty and unique')
        case_ids.add(case_id)
        assignments = case.get('assign')
        if not isinstance(assignments, list) or not assignments:
            raise ValueError('case.assign must be a nonempty array')
        resolved, assigned_keys = _cad_cast("tuple[list[_MeasureAssignment], set[str]]", ([], set()))
        for item in assignments:
            if not isinstance(item, dict) or set(item) != {'parameter', 'expression'}:
                raise ValueError('assign entries require parameter and expression only')
            parameter = ctx.resolve(item['parameter'], 'parameter')
            if parameter.unit.lower() == 'text':
                raise ValueError('Text parameter testing is unsupported')
            expression = item['expression']
            _measure_expression(ctx, expression, parameter.unit, unitless=parameter.unit == '')
            expression = _cad_cast(str, expression)
            key = _measure_history_key(ctx, parameter)
            if key in assigned_keys:
                raise ValueError('A case cannot assign the same parameter twice')
            assigned_keys.add(key)
            if key not in parameters:
                parameters[key] = {'parameter': parameter, 'expression': parameter.expression}
            resolved.append({'parameter': parameter, 'key': key, 'expression': expression})
        assignment_count += len(resolved)
        if assignment_count > _PARAMETER_TEST_MAX_ASSIGNMENTS:
            raise ValueError('parameter.test v2 allows at most 10000 assignments')
        checks = case.get('checks', [])
        if not isinstance(checks, list):
            raise ValueError('case.checks must be an array')
        for check in checks:
            _measure_validate_parameter_check(ctx, check)
        planned.append({'id': case_id, 'assign': resolved, 'checks': _cad_cast("list[JsonObject]", checks)})

    baseline_health = _measure_health(ctx)
    reserve_by_case = [_PARAMETER_TEST_RESTORE_BASE_MS +
                       _PARAMETER_TEST_RESTORE_ASSIGNMENT_MS * len(case['assign']) for case in planned]
    reserve_planned_ms = sum(reserve_by_case)
    result_cases, restore_errors = _cad_cast("tuple[list[JsonObject], list[JsonObject]]", ([], []))
    primary_error = _cad_cast("JsonObject | None", None)
    reserve_used_ms = 0.0
    budget_exhausted = False
    budget_exceeded = time.monotonic() * 1000 > deadline_ms
    stopped_after_restore_failure = False
    reserve_remaining = reserve_planned_ms

    def elapsed_ms() -> float:
        return (time.monotonic() - start) * 1000

    for case, case_reserve in zip(planned, reserve_by_case):
        now_ms = time.monotonic() * 1000
        if stopped_after_restore_failure:
            result_cases.append({'id': case['id'], 'status': 'skipped', 'passed': False,
                                 'reason': 'previous case restoration failed'})
            continue
        if now_ms + reserve_remaining >= deadline_ms:
            budget_exhausted = True
            result_cases.append({'id': case['id'], 'status': 'skipped', 'passed': False,
                                 'reason': 'budgetExhausted'})
            reserve_remaining -= case_reserve
            continue

        case_result = _cad_cast("JsonObject", {'id': case['id'], 'status': 'fail', 'passed': False, 'checks': [], 'health': None,
                       'primaryError': None, 'restoreErrors': [], 'restored': False})
        case_primary = _cad_cast("str | None", None)
        forward_complete = True
        try:
            for item in case['assign']:
                if time.monotonic() * 1000 + reserve_remaining >= deadline_ms:
                    budget_exhausted = True
                    forward_complete = False
                    break
                item['parameter'].expression = item['expression']
            if forward_complete:
                if time.monotonic() * 1000 + reserve_remaining >= deadline_ms:
                    budget_exhausted = True
                    forward_complete = False
                else:
                    _cad_require_result(ctx.design.computeAll(), 'Parameter test recompute')
            if forward_complete:
                if time.monotonic() * 1000 + reserve_remaining >= deadline_ms:
                    budget_exhausted = True
                    forward_complete = False
                else:
                    case_result['health'] = _measure_health(ctx)
                    case_result['healthPassed'] = _measure_health_passed(case_result['health'])
            if forward_complete:
                for check in case['checks']:
                    if time.monotonic() * 1000 + reserve_remaining >= deadline_ms:
                        budget_exhausted = True
                        forward_complete = False
                        break
                    _cad_cast("list[JsonObject]", case_result['checks']).append(_measure_check(ctx, check))
                if forward_complete and check_case is not None:
                    if time.monotonic() * 1000 + reserve_remaining >= deadline_ms:
                        budget_exhausted = True
                        forward_complete = False
                    else:
                        case_result['callbackPassed'] = _measure_callback_result(check_case, data, case_result)
        except Exception as exc:
            case_primary = type(exc).__name__ + ': ' + str(exc)
            case_result['primaryError'] = case_primary
            if primary_error is None:
                primary_error = {'caseId': case['id'], 'message': case_primary}
        finally:
            restore_started = time.monotonic()
            for item in case['assign']:
                original = parameters[item['key']]['expression']
                try:
                    item['parameter'].expression = original
                except Exception as exc:
                    error = _measure_restore_error(case['id'], 'expression',
                        '%s: %s: %s' % (item['key'], type(exc).__name__, str(exc)))
                    _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                    restore_errors.append(error)
            try:
                _cad_require_result(ctx.design.computeAll(), 'Restore recompute')
            except Exception as exc:
                error = _measure_restore_error(case['id'], 'compute', type(exc).__name__ + ': ' + str(exc))
                _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                restore_errors.append(error)
            for item in case['assign']:
                expected = parameters[item['key']]['expression']
                try:
                    actual = item['parameter'].expression
                    if actual != expected:
                        error = _measure_restore_error(case['id'], 'expressionReadback',
                            '%s expected %r, got %r' % (item['key'], expected, actual))
                        _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                        restore_errors.append(error)
                except Exception as exc:
                    error = _measure_restore_error(case['id'], 'expressionReadback',
                        '%s: %s: %s' % (item['key'], type(exc).__name__, str(exc)))
                    _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                    restore_errors.append(error)
            try:
                restored_health = _measure_health(ctx)
                case_result['restoredHealth'] = restored_health
                if restored_health != baseline_health:
                    error = _measure_restore_error(case['id'], 'healthReadback', 'Timeline health differs from baseline')
                    _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                    restore_errors.append(error)
            except Exception as exc:
                error = _measure_restore_error(case['id'], 'healthReadback', type(exc).__name__ + ': ' + str(exc))
                _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                restore_errors.append(error)
            if check_restored is not None:
                try:
                    case_result['restoredCallbackPassed'] = _measure_callback_result(
                        check_restored, data, {'caseId': case['id'], 'baselineHealth': baseline_health,
                                               'restoredHealth': case_result.get('restoredHealth'),
                                               'expressions': {key: value['parameter'].expression
                                                               for key, value in parameters.items()},
                                                'restoreErrors': list(_cad_cast("list[JsonObject]", case_result['restoreErrors']))})
                    if not case_result['restoredCallbackPassed']:
                        error = _measure_restore_error(case['id'], 'callback', 'Restoration callback rejected baseline')
                        _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                        restore_errors.append(error)
                except Exception as exc:
                    error = _measure_restore_error(case['id'], 'callback', type(exc).__name__ + ': ' + str(exc))
                    _cad_cast("list[JsonObject]", case_result['restoreErrors']).append(error)
                    restore_errors.append(error)
            reserve_used_ms += (time.monotonic() - restore_started) * 1000
            case_result['restored'] = not case_result['restoreErrors']

        budget_exceeded = budget_exceeded or time.monotonic() * 1000 > deadline_ms
        checks_passed = all(check.get('passed') is True
                            for check in _cad_cast("list[JsonObject]", case_result['checks']))
        callback_passed = case_result.get('callbackPassed', True)
        case_result['passed'] = bool(forward_complete and case_primary is None and case_result.get('healthPassed', True) and
                                     checks_passed and callback_passed and case_result['restored'])
        case_result['status'] = 'pass' if case_result['passed'] else ('partial' if not forward_complete else 'fail')
        result_cases.append(case_result)
        reserve_remaining -= case_reserve
        if not case_result['restored']:
            stopped_after_restore_failure = True
        if not forward_complete:
            budget_exhausted = True
            for remaining in planned[len(result_cases):]:
                result_cases.append({'id': remaining['id'], 'status': 'skipped', 'passed': False,
                                     'reason': 'budgetExhausted'})
            break
        if budget_exceeded:
            budget_exhausted = len(result_cases) < len(planned)
            # A synchronous SDK call returned after deadline; no next case starts.
            for remaining in planned[len(result_cases):]:
                result_cases.append({'id': remaining['id'], 'status': 'skipped', 'passed': False,
                                     'reason': 'budgetExhausted'})
            break

    skipped = [case for case in result_cases if case['status'] == 'skipped']
    partial_cases = [case for case in result_cases if case['status'] == 'partial']
    all_completed = len(result_cases) == len(planned) and not skipped and not partial_cases
    passed = all_completed and not restore_errors and primary_error is None and all(case['passed'] for case in result_cases)
    status = 'pass' if passed else ('partial' if skipped or partial_cases else 'fail')
    report: JsonObject = {'version': 2, 'passed': passed, 'status': status, 'cases': result_cases,
              'primaryError': primary_error, 'restoreErrors': restore_errors,
              'restored': not restore_errors, 'timeBudgetMs': time_budget_ms,
              'restorationReserveMsPlanned': reserve_planned_ms,
              'restorationReserveMsUsed': reserve_used_ms, 'actualElapsedMs': elapsed_ms(),
              'budgetExceeded': budget_exceeded, 'budgetExhausted': budget_exhausted,
              'coverage': {'required': len(planned), 'completed': sum(c['status'] in ('pass', 'fail') for c in result_cases),
                           'skipped': len(skipped) + len(partial_cases)}}
    if budget_exhausted:
        report['continuation'] = {'reason': 'budgetExhausted'}
    report['limitations'] = ['Synchronous local parameter changes only; no save, upload or publication is performed.',
                             'Restoration reserve is a scheduling estimate, not a bound on an indivisible Fusion SDK call.',
                             'A timeout outside this live invocation does not cancel a running Fusion operation; reconcile before any new call.']
    return report


def _measure_parameter_test(ctx: "CadContext", data: "JsonObject",
                            check_case: "Callable[[JsonObject, JsonObject], object] | None" = None,
                            check_restored: "Callable[[JsonObject, JsonObject], object] | None" = None) -> "JsonObject":
    if 'cases' in data:
        if any(key in data for key in ('parameter', 'expressions', 'checks')):
            raise ValueError('parameter.test legacy expressions form and cases form are mutually exclusive')
        return _measure_parameter_test_v2(ctx, data, check_case, check_restored)
    if check_case is not None or check_restored is not None:
        raise ValueError('Callbacks are only supported by parameter.test v2 cases')
    if 'timeBudgetMs' in data:
        raise ValueError('timeBudgetMs is only supported by parameter.test v2')
    return _measure_parameter_test_legacy(ctx, data)


def _measure_snapshot(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data)
    components: list[JsonObject] = []
    for component in _cad_items(ctx.design.allComponents):
        bodies: list[JsonObject] = [{'ref': ctx.ref(b), 'isSolid': b.isSolid, 'faces': b.faces.count, 'edges': b.edges.count,
                   'volume': _measure_value(b.volume, 'volume', {}),
                   'bounds': {'min': [v * 10 for v in _cad_xyz(b.boundingBox.minPoint)],
                              'max': [v * 10 for v in _cad_xyz(b.boundingBox.maxPoint)], 'units': 'mm', 'space': 'component local'}}
                  for b in _cad_items(component.bRepBodies)]
        components.append({'ref': ctx.ref(component), 'bodies': bodies, 'sketchCount': component.sketches.count,
                           'featureCount': component.features.count})
    occurrences: list[JsonObject] = [{'ref': ctx.ref(o), 'component': ctx.ref(o.component),
                    'transform': list(o.transform2.asArray()), 'translationUnits': 'cm'}
                   for o in _cad_items(ctx.root.allOccurrences)]
    health = _measure_health(ctx)
    parameters: list[JsonObject] = [_cad_parameter_info(ctx, p) for p in _cad_items(ctx.design.allParameters)]
    return {'schema': 'fmcad.measure.snapshot.v1', 'document': {'name': ctx.doc.name, 'isModified': ctx.doc.isModified},
            'components': components, 'occurrences': occurrences, 'parameters': parameters, 'timeline': health,
            'counts': {'componentDefinitions': len(components), 'occurrences': len(occurrences),
                        'bodyDefinitions': sum(len(_cad_cast("list[JsonValue]", c['bodies'])) for c in components),
                        'sketchDefinitions': sum(_cad_cast(int, c['sketchCount']) for c in components),
                        'featureDefinitions': sum(_cad_cast(int, c['featureCount']) for c in components),
                       'parameters': len(parameters), 'timelineItems': len(health)},
             'issues': [r for r in health if not r.get('duplicate') and
                        (r['state'] != 'HealthyFeatureHealthState' or r['rolledBack'])],
            'limitations': ['Pure observation; no activation or recompute. Cached health may be stale.',
                            'Definition counts are not assembly instance quantities. Snapshot is not full topology or a geometry equivalence proof.']}


def _measure_diff(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('before',), ('after',))
    before, after = data['before'], data.get('after')
    if after is None:
        after = _measure_snapshot(ctx, {})
    if any(not isinstance(s, dict) or s.get('schema') != 'fmcad.measure.snapshot.v1' for s in (before, after)):
        raise ValueError('before/after must be snapshot data with schema fmcad.measure.snapshot.v1')
    changes: list[JsonObject] = []

    def compare(a: "JsonValue", b: "JsonValue", path: str) -> None:
        if isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(set(a) | set(b)):
                if key == 'token':
                    continue  # Fusion tokens can change for the same entity.
                child = path + '/' + key.replace('~', '~0').replace('/', '~1')
                if key not in a or key not in b:
                    changes.append({'path': child, 'change': 'added' if key in b else 'removed',
                                    'before': a.get(key), 'after': b.get(key)})
                else:
                    compare(a[key], b[key], child)
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for i, (x, y) in enumerate(zip(a, b)):
                compare(x, y, path + '/' + str(i))
        elif type(a) != type(b) or a != b:
            changes.append({'path': path, 'change': 'changed', 'before': a, 'after': b})

    compare(before, after, '')
    return {'changed': bool(changes), 'changes': changes,
            'limitations': ['Exact structural snapshot comparison, arrays in API order; tokens ignored, no topology equivalence or numeric tolerance. No files read or written.']}


def _measure_status(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data)
    snapshot = _measure_snapshot(ctx, {})
    return {'document': snapshot['document'], 'counts': snapshot['counts'], 'issues': snapshot['issues'],
            'observedHealth': 'issues' if snapshot['issues'] else 'noReportedIssues',
            'acceptance': 'notEvaluated', 'limitations': snapshot['limitations']}


def _measure_report(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, optional=('checks', 'metadata'))
    checks = data.get('checks', [])
    metadata = data.get('metadata', {})
    if not isinstance(checks, list) or not isinstance(metadata, dict):
        raise ValueError('checks must be an array; metadata must be an object')
    results: list[JsonObject] = [_measure_check(ctx, _cad_cast("JsonObject", check)) for check in checks]
    return {'status': _measure_status(ctx, {}), 'checks': results,
            'checkOutcome': ('pass' if all(r['passed'] for r in results) else 'fail') if results else 'notEvaluated',
            'userMetadata': _cad_json(metadata), 'metadataVerified': False,
            'limitations': ['Only supplied checks are evaluated; neither user metadata nor healthy timeline implies design acceptance. No files written.']}


def _measure_handler(mode: "Literal['diameter', 'radius', 'length', 'area', 'volume', 'mass']") -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return _measure_scalar(ctx, data, mode)
    return handler


def _measure_pair_handler(mode: "Literal['interference', 'clearance']") -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return _measure_pair(ctx, data, mode)
    handler.__name__ = '<lambda>'
    return handler


_MEASURE_SCALARS = {'measure.' + mode for mode in ('diameter', 'radius', 'distance', 'angle', 'length', 'area', 'volume', 'mass', 'thickness')}
CAD_HANDLERS.update({'measure.' + mode: _measure_handler(mode) for mode in ('diameter', 'radius', 'length', 'area', 'volume', 'mass')})
CAD_HANDLERS.update({
    'measure.distance': _measure_distance, 'measure.angle': _measure_angle,
    'measure.bounds': _measure_bounds, 'measure.section': _measure_section, 'measure.thickness': _measure_thickness,
    'check': _measure_check, 'parameter.test': _measure_parameter_test,
    'assembly.interference': _measure_pair_handler('interference'),
    'assembly.clearance': _measure_pair_handler('clearance'),
    'assembly.motion_check': _measure_motion, 'audit': _measure_snapshot, 'snapshot': _measure_snapshot,
    'diff': _measure_diff, 'status': _measure_status, 'report': _measure_report,
})
