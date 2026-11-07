"""Fusion adapter: GM04 datums and frame conversion; rigid math lives in entity.py.

SDK contracts checked against installed Autodesk 2026 headers/Python definitions.
Native execution acceptance remains pending; see docs/GM04.md.
"""
from typing import TYPE_CHECKING as _GeometryDatum_TYPE_CHECKING, Protocol as _GeometryDatumProtocol
from typing import Callable as _GeometryDatumCallable, cast as _geometry_datum_adapter_cast


if _GeometryDatum_TYPE_CHECKING:
    class _GeometryDatumPathCurve(_GeometryDatumProtocol):
        @property
        def assemblyContext(self) -> "adsk.fusion.Occurrence | None": ...

        @property
        def nativeObject(self) -> "adsk.core.Base | None": ...


    class _GeometryDatumWorldCurve(_GeometryDatumProtocol):
        @property
        def worldGeometry(self) -> "adsk.core.Curve3D": ...


    class _GeometryDatumJointOccurrences(_GeometryDatumProtocol):
        @property
        def occurrenceOne(self) -> "adsk.fusion.Occurrence | None": ...

        @property
        def occurrenceTwo(self) -> "adsk.fusion.Occurrence | None": ...


    class _GeometryDatumJointTransforms(_GeometryDatumProtocol):
        @property
        def geometryOneTransform(self) -> "adsk.core.Matrix3D | None": ...

        @property
        def geometryTwoTransform(self) -> "adsk.core.Matrix3D | None": ...


    class _GeometryDatumAsBuiltGeometry(_GeometryDatumProtocol):
        @property
        def geometry(self) -> "adsk.fusion.JointGeometry | None": ...


    class _GeometryDatumRotationAxis(_GeometryDatumProtocol):
        @property
        def rotationAxisVector(self) -> "adsk.core.Vector3D | None": ...


    class _GeometryDatumSlideDirection(_GeometryDatumProtocol):
        @property
        def slideDirectionVector(self) -> "adsk.core.Vector3D | None": ...


    class _GeometryDatumPathDistanceTypes(_GeometryDatumProtocol):
        ProportionalPathDistanceType: int
        PhysicalPathDistanceType: int


    class _GeometryDatumFusionPathDistance(_GeometryDatumProtocol):
        PathDistanceTypes: _GeometryDatumPathDistanceTypes


    class _GeometryDatumPathInput(_GeometryDatumProtocol):
        def setByPath(self, path: "adsk.fusion.Path", distanceType: int,
                      distance: "adsk.core.ValueInput") -> bool: ...




def _geometry_datum_expression(ctx: "CadContext", expression: object,
                              units: str | None = None, unitless: bool = False) -> "tuple[str, float]":
    evaluate = _geometry_datum_adapter_cast(
        "_GeometryDatumCallable[[object, str | None, bool], tuple[str, float]]",
        getattr(ctx, '_expression'))
    return evaluate(expression, units, unitless)


def _datum_contract(ctx: "CadContext", operation: str, result: "JsonObject",
                    association: str = 'snapshot', frame: "JsonValue" = 'component',
                    limitations: "Sequence[str]" = ()) -> "JsonObject":
    ctx.assert_identity()
    result.update(schemaVersion=1, operation=operation, success=True, status='pass',
                  documentIdentity=_io_identity(ctx), units={'length': 'cm', 'angle': 'rad', 'vector': 'unitless'},
                  frame=frame, associativity=association, warnings=[], method='Fusion SDK / shared GM03 rigid frames',
                  provenance={'inputs': 'caller', 'nativeAcceptance': 'pending'},
                   limitations=list(_geometry_datum_adapter_cast('Iterable[str]', result.get('limitations', []))) + list(limitations))
    return result


def _datum_world(ctx: "CadContext", frame: "JsonValue") -> "list[int | float]":
    if frame == 'root':
        return list(_ENTITY_IDENTITY)
    if frame in ('component', 'context'):
        return _entity_owner_matrix(ctx, ctx.component, ctx.occurrence)
    owner, occurrence, local, _ = _entity_frame_target(ctx, frame)
    return _entity_matrix(_entity_multiply(_entity_owner_matrix(ctx, owner, occurrence), local))


def _datum_between(ctx: "CadContext", source: "JsonValue", target: "JsonValue") -> "list[int | float]":
    # Preserve same-definition conversions without choosing an arbitrary instance.
    source = 'component' if source == 'context' else source
    target = 'component' if target == 'context' else target
    if source == target and source in ('root', 'component', 'context'):
        return list(_ENTITY_IDENTITY)
    if source == 'component':
        return _entity_frame(ctx, _geometry_datum_adapter_cast('str | JsonObject', target), ctx.component, ctx.occurrence)[0]
    if target == 'component':
        return _entity_inverse(_entity_frame(ctx, _geometry_datum_adapter_cast('str | JsonObject', source), ctx.component, ctx.occurrence)[0])
    if isinstance(source, dict):
        owner, occurrence, local, _ = _entity_frame_target(ctx, source)
        conversion, _ = _entity_frame(ctx, _geometry_datum_adapter_cast('str | JsonObject', target), owner, occurrence)
        return _entity_matrix(_entity_multiply(conversion, local))
    return _entity_matrix(_entity_multiply(_entity_inverse(_datum_world(ctx, target)), _datum_world(ctx, source)))




def _datum_basis(origin: "Sequence[int | float]", x: "Sequence[int | float]",
                 y: "Sequence[int | float]") -> "list[int | float]":
    x, y = _cad_direction(x), _cad_direction(y)
    if abs(sum(a * b for a, b in zip(x, y))) > 1e-9:
        raise ValueError('Frame axes must be perpendicular')
    z = [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]]
    return _entity_matrix([v for r in range(3) for v in (x[r], y[r], z[r], origin[r])] + [0, 0, 0, 1])


def _datum_transform(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _datum_version(data)
    _cad_fields(data, ('from', 'to'), ('schemaVersion', 'points', 'vectors', 'differences'))
    matrix = _datum_between(ctx, data['from'], data['to'])
    result: JsonObject = {'matrix': matrix, 'from': data['from'], 'to': data['to'], 'matrixConvention': 'row-major; column vectors; inverse(toToRoot) * fromToRoot'}
    for key in ('points', 'vectors', 'differences'):
        values = data.get(key, [])
        if not isinstance(values, list):
            raise ValueError(key + ' must be an array')
        result[key] = []
        for value in values:
            if key == 'differences':
                _cad_fields(_geometry_datum_adapter_cast('JsonObject', value), ('from', 'to'))
                a, b = [_cad_xyz(ctx.point(_geometry_datum_adapter_cast('JsonObject', value)[k])) for k in ('from', 'to')]
                xyz = [b[i] - a[i] for i in range(3)]
            else:
                xyz = _datum_vector(value) if key == 'vectors' else _cad_xyz(ctx.point(value))
            _geometry_datum_adapter_cast('list[JsonValue]', result[key]).append(_entity_xyz(matrix, xyz, vector=key != 'points'))
    return _datum_contract(ctx, 'datum.transform', result, frame=data['to'],
                           limitations=['Snapshot conversion; vectors and point differences are not normalized. Differences have length units.'])


def _datum_frame(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _datum_version(data)
    _cad_fields(data, ('name', 'origin', 'xAxis', 'yAxis'), ('schemaVersion', 'mode', 'confirm', 'frame', 'onExisting'))
    name = _assembly_name(_geometry_datum_adapter_cast('str', data['name']))
    if data.get('mode', 'metadata') != 'metadata':
        raise ValueError('Only frame mode metadata is supported')
    m = _datum_between(ctx, data.get('frame', 'component'), 'component')
    origin = _entity_xyz(m, _cad_xyz(ctx.point(data['origin'])))
    x = _entity_xyz(m, _datum_vector(data['xAxis']), True)
    y = _entity_xyz(m, _datum_vector(data['yAxis']), True)
    result = {'schemaVersion': 1, 'name': name, 'kind': 'frame', 'representation': 'named transform metadata',
              'component': ctx.ref(ctx.component), 'matrix': _datum_basis(origin, x, y), 'lengthUnits': 'cm',
              'space': 'component local', 'parametric': False, 'associativity': 'snapshot',
              'originExpressions': data['origin'], 'xAxis': _cad_direction(x), 'yAxis': _cad_direction(y),
              'sourceFrame': data.get('frame', 'component')}
    policy = data.get('onExisting', 'error')
    if policy not in ('error', 'reuse', 'update'):
        raise ValueError('onExisting must be error, reuse or update')
    old = ctx.component.attributes.itemByName(_CAD_FRAME_GROUP, _geometry_datum_adapter_cast('str', data['name']))
    record: JsonObject | None = None
    if old:
        record = _geometry_datum_adapter_cast('JsonObject', json.loads(old.value))
        if record.get('representation') != 'named transform metadata' or record.get('lengthUnits') != 'cm' or ctx.resolve(record['component'], 'component') != ctx.component:
            raise ValueError('Existing frame metadata ownership, units or representation mismatch')
    if old and policy == 'error':
        raise ValueError('Datum frame already exists; choose reuse or confirmed update')
    if policy == 'update':
        ctx.require_confirm(data)
    if old and record == result:
        changed = False
    else:
        if old:
            if policy == 'reuse':
                raise ValueError('Frame reuse mismatch; confirm an explicit update')
            ctx.require_confirm(data)
        _cad_require_result(ctx.component.attributes.add(_CAD_FRAME_GROUP, name, json.dumps(result)), 'Store frame metadata')
        if not old:
            ctx.created.append({'kind': 'frame', 'name': name, 'component': ctx.ref(ctx.component), 'representation': result['representation']})
        changed = True
    return _datum_contract(ctx, 'datum.frame', dict(result, changed=changed), limitations=['Not a native coordinate-system feature. Reapply explicit inputs to update; parameter/placement changes invalidate this metadata snapshot.'])


@_cad_scoped_step('datum')
def _datum_existing(ctx: "CadContext", data: "JsonObject", mode: "str") -> "JsonObject":
    _datum_version(data)
    data = dict(data)
    data.pop('schemaVersion', None)
    snapshot = False
    if mode == 'point' and 'frame' in data:
        if data.get('mode', 'coordinates') != 'coordinates' or data.pop('associativity', None) != 'snapshot':
            raise ValueError('Cross-frame coordinates require associativity:snapshot')
        matrix = _datum_between(ctx, data.pop('frame'), 'component')
        data['point'] = [str(v) + ' cm' for v in _entity_xyz(matrix, _cad_xyz(ctx.point(data['point'])))]
        snapshot = True
    if mode in ('axis', 'plane') and data.get('mode') == 'frame':
        _cad_fields(data, ('name', 'mode', 'frame', 'associativity'))
        if data['associativity'] != 'snapshot':
            raise ValueError('Frame geometry requires associativity:snapshot')
        local = _datum_between(ctx, data['frame'], 'component')
        origin = _entity_xyz(local, [0, 0, 0])
        directions = (2,) if mode == 'axis' else (0, 1)
        coordinates = [origin] + [[origin[r] + local[4*r+c] for r in range(3)] for c in directions]
        collection = ctx.component.constructionAxes if mode == 'axis' else ctx.component.constructionPlanes
        _cad_datum_name(ctx, data, collection)
        names = [_geometry_datum_adapter_cast('str', data['name']) + '__p' + str(i) for i in range(len(coordinates))]
        for name in names:
            _cad_datum_name(ctx, {'name': name}, ctx.component.constructionPoints)
            for suffix in ('x', 'y', 'z'):
                _cad_datum_name(ctx, {'name': name + '__' + suffix}, ctx.component.constructionPlanes)
        refs = [_cad_datum_point(ctx, {'name': n, 'point': [str(v) + ' cm' for v in p]}) for n, p in zip(names, coordinates)]
        result: JsonRecord
        if mode == 'axis':
            result = _geometry_datum_adapter_cast('JsonRecord', _cad_datum_axis(
                ctx, {'name': _geometry_datum_adapter_cast('str', data['name']), 'mode': 'twoPoints', 'point1': refs[0], 'point2': refs[1]}))
        else:
            inp = _geometry_datum_adapter_cast('adsk.fusion.ConstructionPlanes', collection).createInput()
            if ctx.occurrence is not None:
                inp.creationOccurrence = ctx.occurrence
            _cad_require_result(inp.setByThreePoints(*[ctx.resolve(r) for r in refs]), 'Define frame plane')
            result = _cad_datum_finish(ctx, _geometry_datum_adapter_cast('adsk.fusion.ConstructionPlanes', collection).add(inp),
                                       _geometry_datum_adapter_cast('str', data['name']))
        result['helpers'] = refs
        snapshot = True
    else:
        result = _geometry_datum_adapter_cast('JsonRecord',
                                      {'plane': _cad_datum_plane, 'axis': _cad_datum_axis, 'point': _cad_datum_point}[mode](ctx, data))
    association = 'snapshot' if snapshot or ctx.design.designType != _geometry_datum_adapter_cast(
        'adsk.fusion.DesignTypes', adsk.fusion.DesignTypes.ParametricDesignType) else (
        'nativeExpression' if mode == 'point' and data.get('mode', 'coordinates') == 'coordinates' or mode == 'plane' and data.get('mode', 'offset') in ('offset', 'angle') else 'nativeReference')
    return _datum_contract(ctx, 'datum.' + mode, result, association,
                           limitations=['Frame-derived helper geometry is constant; regenerate explicitly after source frame changes.'] if snapshot else [])


def _datum_path_position(ctx: "CadContext", path: "adsk.fusion.Path", position: "JsonObject") -> "tuple[float, float, list[tuple[adsk.core.CurveEvaluator3D, float, float, float, adsk.fusion.PathEntity]]]":
    _cad_fields(position, ('mode', 'value'))
    mode = position['mode']
    if mode not in ('proportional', 'length'):
        raise ValueError('Position mode must be proportional or length')
    value = (_geometry_datum_expression(ctx, position['value'], '', True)[1]
             if mode == 'proportional' else ctx.length(position['value']))
    segments: list[tuple[adsk.core.CurveEvaluator3D, float, float, float, adsk.fusion.PathEntity]] = []
    for item in _cad_items(path):
        evaluator = item.curve.evaluator
        ok, start, end = evaluator.getParameterExtents()
        _cad_require_result(ok, 'Path parameter extents')
        ok, length = evaluator.getLengthAtParameter(start, end)
        _cad_require_result(ok, 'Path segment length')
        if not math.isfinite(length) or length <= 0:
            raise ValueError('Path has a zero or invalid length segment')
        segments.append((evaluator, start, end, length, item))
    length = sum(s[3] for s in segments)
    if not segments or not math.isfinite(value) or value < 0 or value > (1 if mode == 'proportional' else length):
        raise ValueError('Position outside path endpoints; automatic clamping is forbidden')
    return value, length, segments


@_cad_scoped_step('datum.plane-on-path')
def _datum_plane_on_path(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _datum_version(data)
    _cad_fields(data, ('name', 'path', 'position'), ('schemaVersion', 'orientation', 'representation'))
    if data.get('representation', 'native') != 'native':
        raise ValueError('plane-on-path representation must be native')
    planes = ctx.component.constructionPlanes
    name = _cad_datum_name(ctx, data, planes)
    inp = planes.createInput()
    if not hasattr(inp, 'setByPath') or not hasattr(adsk.fusion, 'PathDistanceTypes'):
        return dict(_datum_contract(ctx, 'datum.plane-on-path', {}), success=False, status='blocked',
                    limitations=['Installed SDK lacks ConstructionPlaneInput.setByPath; no silent fallback.'])
    path = _model_path(ctx, data['path'])
    value, length, segments = _datum_path_position(ctx, path, _geometry_datum_adapter_cast('JsonObject', data['position']))
    seed = ctx.resolve(_geometry_datum_adapter_cast(
        'list[JsonValue]', _geometry_datum_adapter_cast('JsonObject', data['path'])['curves'])[0])
    source = {'occurrence': ctx.ref(_geometry_datum_adapter_cast('adsk.fusion.Occurrence',
                                                         _geometry_datum_adapter_cast('_GeometryDatumPathCurve', seed).assemblyContext))
              } if getattr(seed, 'assemblyContext', None) else {
        'component': ctx.ref(_geometry_datum_adapter_cast('adsk.fusion.Component', _cad_owner(seed)))}
    conversion = _datum_between(ctx, source, 'component')
    if getattr(seed, 'assemblyContext', None) is not None:
        _entity_occurrence_matrix(ctx, _geometry_datum_adapter_cast('adsk.fusion.Occurrence',
                                                            _geometry_datum_adapter_cast('_GeometryDatumPathCurve', seed).assemblyContext))
    distance = value * length if _geometry_datum_adapter_cast('JsonObject', data['position'])['mode'] == 'proportional' else value
    at_end = value == (1 if _geometry_datum_adapter_cast('JsonObject', data['position'])['mode'] == 'proportional' else length)
    for index, (evaluator, start, end, segment_length, item) in enumerate(segments):
        if distance <= segment_length or at_end and index == len(segments) - 1:
            # Sample native geometry, not the arbitrary proxy that createPath
            # may return for a component definition. Only fresh whole-entity
            # paths are accepted by the existing _model_path descriptor.
            native = getattr(_geometry_datum_adapter_cast('_GeometryDatumPathCurve', item.entity), 'nativeObject', None) or item.entity
            evaluator = (_geometry_datum_adapter_cast('adsk.fusion.BRepEdge', native).evaluator
                         if _cad_type(native) == 'BRepEdge'
                         else _geometry_datum_adapter_cast('_GeometryDatumWorldCurve', native).worldGeometry.evaluator)
            ok, start, end = evaluator.getParameterExtents()
            _cad_require_result(ok, 'Native path parameter extents')
            opposed = item.isOpposedToEntity
            if at_end and index == len(segments) - 1:
                parameter = start if opposed else end
            else:
                ok, parameter = evaluator.getParameterAtLength(end if opposed else start, -distance if opposed else distance)
                _cad_require_result(ok, 'Path position parameter')
            ok, tangent = evaluator.getTangent(parameter)
            _cad_require_result(ok, 'Path tangent')
            tangent = _cad_direction(_entity_xyz(conversion, _cad_xyz(tangent), True))
            if opposed:
                tangent = [-v for v in tangent]
            ok, point = evaluator.getPointAtParameter(parameter)
            _cad_require_result(ok, 'Path position point')
            expected_point = _entity_xyz(conversion, _cad_xyz(point))
            break
        distance -= segment_length
    else:
        raise ValueError('Position outside path endpoints; automatic clamping is forbidden')
    direction: list[float] | None = None
    orientation = data.get('orientation')
    if orientation is not None:
        _cad_fields(_geometry_datum_adapter_cast('JsonObject', orientation), ('direction', 'frame'))
        direction = _cad_direction(_entity_xyz(_datum_between(
            ctx, _geometry_datum_adapter_cast('JsonObject', orientation)['frame'], 'component'),
            _datum_vector(_geometry_datum_adapter_cast('JsonObject', orientation)['direction']), True))
        # Validate against the tangent before creating a feature. The section roll
        # is reported as metadata; setByPath has no in-plane orientation argument.
        if abs(sum(a*b for a, b in zip(direction, tangent))) > 1 - 1e-9:
            raise ValueError('Section orientation direction is parallel to path tangent')
    if ctx.occurrence is not None:
        inp.creationOccurrence = ctx.occurrence
    enum = (_geometry_datum_adapter_cast('_GeometryDatumFusionPathDistance', adsk.fusion).PathDistanceTypes.ProportionalPathDistanceType
            if _geometry_datum_adapter_cast('JsonObject', data['position'])['mode'] == 'proportional'
            else _geometry_datum_adapter_cast('_GeometryDatumFusionPathDistance', adsk.fusion).PathDistanceTypes.PhysicalPathDistanceType)
    _cad_require_result(_geometry_datum_adapter_cast('_GeometryDatumPathInput', inp).setByPath(
        path, enum, adsk.core.ValueInput.createByString(
        _geometry_datum_adapter_cast('str', _geometry_datum_adapter_cast('JsonObject', data['position'])['value']))),
        'Define native plane on path')
    plane = _cad_require_result(planes.add(inp), 'Create native plane on path')
    result = _cad_datum_finish(ctx, plane, name)
    geometry = plane.geometry
    normal = _cad_direction(_cad_xyz(geometry.normal))
    actual_origin = _cad_xyz(geometry.origin)
    normal_dot = sum(a*b for a, b in zip(normal, tangent))
    plane_distance = abs(sum(normal[i] * (expected_point[i] - actual_origin[i]) for i in range(3)))
    result.update(path=data['path'], pathLength=length, position=data['position'], actualPlane={'origin': actual_origin, 'normal': normal},
                  expectedPoint=expected_point, tangent=tangent, normalDotTangent=normal_dot, distanceResidual=plane_distance,
                  endpointPolicy='error', atomic=False)
    if orientation is not None and direction is not None and abs(normal_dot) >= 1 - 1e-8 and plane_distance <= 1e-6:
        dot = sum(a*b for a, b in zip(direction, normal))
        x = _cad_direction([direction[i] - dot * normal[i] for i in range(3)])
        y = [normal[1]*x[2]-normal[2]*x[1], normal[2]*x[0]-normal[0]*x[2], normal[0]*x[1]-normal[1]*x[0]]
        result['sectionFrame'] = {'matrix': _datum_basis(expected_point, x, y), 'associativity': 'snapshot', 'frame': 'component'}
    result = _datum_contract(ctx, 'datum.plane-on-path', result,
                           'nativeExpression' if ctx.design.designType == _geometry_datum_adapter_cast(
                               'adsk.fusion.DesignTypes', adsk.fusion.DesignTypes.ParametricDesignType) else 'snapshot',
                           limitations=['Section roll is snapshot metadata, not native plane or sketch roll control.',
                                        'Future parameter/path edits can invoke native physical-distance clamping; rerun preflight after edits.'])
    if abs(normal_dot) < 1 - 1e-8 or plane_distance > 1e-6:
        result.update(success=False, status='fail', warnings=['Native plane differs from the sampled path section; plane retained for inspection.'])
    return result


def _datum_occurrence_ref(ctx: "CadContext", ref: object) -> "adsk.fusion.Occurrence":
    occurrence = ctx.resolve(ref, 'occurrence')
    for depth in range(1, len(occurrence.fullPathName.split('+')) + 1):
        path = '+'.join(occurrence.fullPathName.split('+')[:depth])
        ancestor = _cad_unique([o for o in _cad_items(ctx.root.allOccurrences) if o.fullPathName == path], 'Occurrence ' + path)
        if ancestor.isReferencedComponent:
            raise ValueError('External referenced occurrence or ancestor is unsupported')
    _entity_occurrence_matrix(ctx, occurrence)
    return occurrence


def _datum_placement(ctx: "CadContext", placement: "JsonValue") -> "list[int | float]":
    if 'matrix' not in _geometry_datum_adapter_cast('JsonObject', placement):
        return _entity_matrix(_assembly_matrix(ctx, _geometry_datum_adapter_cast('JsonObject', placement)).asArray())
    _cad_fields(_geometry_datum_adapter_cast('JsonObject', placement), ('matrix', 'translationUnits'))
    matrix = _entity_matrix(_geometry_datum_adapter_cast('Iterable[object]', _geometry_datum_adapter_cast('JsonObject', placement)['matrix']))
    unit = _geometry_datum_adapter_cast('JsonObject', placement)['translationUnits']
    if unit not in ('mm', 'cm', 'm', 'in', 'ft'):
        raise ValueError('translationUnits must be mm, cm, m, in or ft')
    matrix = list(matrix)
    for i in (3, 7, 11):
        matrix[i] = ctx.length(str(matrix[i]) + ' ' + unit)
    return matrix


def _datum_occurrence(ctx: "CadContext", data: "JsonObject", mode: "str") -> "JsonObject":
    _datum_version(data)
    _cad_fields(data, ('occurrence', 'placement') if mode == 'transform' else ('occurrence', 'target'),
                ('schemaVersion', 'frame', 'source', 'sharedParentPolicy'))
    if mode == 'align' and 'frame' in data or mode == 'transform' and 'source' in data:
        raise ValueError('frame is for transform; source is for align')
    occurrence = _datum_occurrence_ref(ctx, data['occurrence'])
    native = getattr(occurrence, 'nativeObject', None) or occurrence
    # Native nested isGrounded is unavailable; use its root-context occurrence.
    if occurrence.isGrounded or getattr(native, 'isGroundToParent', False):
        raise ValueError('Unground occurrence before placement')
    affected = [o for o in _cad_items(ctx.root.allOccurrences) if (getattr(o, 'nativeObject', None) or o) == native]
    if data.get('sharedParentPolicy', 'error') not in ('error', 'allInstances'):
        raise ValueError('sharedParentPolicy must be error or allInstances')
    if len(affected) > 1 and data.get('sharedParentPolicy') != 'allInstances':
        raise ValueError('Nested placement affects repeated parent definitions; require sharedParentPolicy:allInstances')
    before = _entity_occurrence_matrix(ctx, occurrence)
    if mode == 'transform':
        requested = _entity_multiply(_datum_world(ctx, data.get('frame', 'root')), _datum_placement(ctx, data['placement']))
    else:
        target = data['target']
        target_frame = target if isinstance(target, dict) and any(
            k in target for k in ('datum', 'sketch', 'component', 'occurrence')) and 'token' not in target else {'occurrence': target}
        target_world = _datum_world(ctx, target_frame)
        source = data.get('source')
        source_local = _ENTITY_IDENTITY if source is None else _entity_multiply(_entity_inverse(before), _datum_world(ctx, source))
        if source is not None:
            owner, source_occurrence, _, _ = _entity_frame_target(ctx, source)
            if owner != occurrence.component or source_occurrence != occurrence:
                raise ValueError('Alignment source must explicitly identify the moved occurrence')
        requested = _entity_multiply(target_world, _entity_inverse(source_local))
    requested = _entity_matrix(requested)
    def parent_matrix(item: "adsk.fusion.Occurrence") -> "list[int | float]":
        path = item.fullPathName.rsplit('+', 1)
        return (_datum_world(ctx, {'occurrence': path[0]}) if len(path) == 2 else list(_ENTITY_IDENTITY))
    parent_world = parent_matrix(occurrence)
    local = _entity_matrix(_entity_multiply(_entity_inverse(parent_world), requested))
    planned = [(item, _entity_multiply(parent_matrix(item), local)) for item in affected]
    parametric = _assembly_capture_ready(ctx)
    for item, target_matrix in planned:
        matrix = adsk.core.Matrix3D.create()
        _cad_require_result(matrix.setWithArray(_geometry_datum_adapter_cast('list[float]', target_matrix)),
                            'Occurrence root transform')
        item.transform2 = matrix
    snapshot = _assembly_capture(ctx, parametric)
    actual = _entity_occurrence_matrix(ctx, occurrence)
    affected_poses: list[JsonObject] = [{'occurrence': ctx.ref(item), 'requested': target_matrix,
                       'actual': _entity_occurrence_matrix(ctx, item)} for item, target_matrix in planned]
    for pose in affected_poses:
        pose['residual'] = max(abs(a - b) for a, b in zip(
            _geometry_datum_adapter_cast('list[int | float]', pose['actual']),
            _geometry_datum_adapter_cast('list[int | float]', pose['requested'])))
    residual = max(_geometry_datum_adapter_cast('float', pose['residual']) for pose in affected_poses)
    if 'schemaVersion' not in data and '+' not in occurrence.fullPathName and not any(k in data for k in ('source', 'frame', 'sharedParentPolicy')) and (mode == 'align' and isinstance(data['target'], str) or mode == 'transform' and 'matrix' not in _geometry_datum_adapter_cast('JsonObject', data['placement'])):
        return {'occurrence': ctx.describe(occurrence), 'snapshot': snapshot,
                'parametricExpressions': False, 'relationship': 'one-time absolute root-frame placement, not a joint'}
    result = _datum_contract(ctx, 'occurrence.' + mode, {'occurrence': ctx.describe(occurrence), 'path': occurrence.fullPathName,
        'before': before, 'requested': requested, 'actual': actual, 'localTransform': local, 'snapshot': snapshot,
        'affected': [ctx.ref(o) for o in affected], 'affectedPoses': affected_poses, 'residual': residual, 'atomic': False,
        'parametricExpressions': False, 'relationship': 'one-time absolute placement, not a joint'}, frame='root')
    if residual > 1e-8:
        result.update(success=False, status='fail', warnings=['Actual pose differs from request; inspect joint/grounding constraints before retry.'])
    return result


def _datum_joint_frame(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _datum_version(data)
    _cad_fields(data, ('joint',), ('schemaVersion', 'to'))
    joint = ctx.resolve(data['joint'])
    if _cad_type(joint) not in ('Joint', 'AsBuiltJoint'):
        raise ValueError('joint must resolve to Joint or AsBuiltJoint')
    joint = _geometry_datum_adapter_cast('adsk.fusion.Joint | adsk.fusion.AsBuiltJoint', joint)
    native = getattr(joint, 'nativeObject', None) or joint
    owner = _cad_owner(native)
    occurrence = getattr(joint, 'assemblyContext', None)
    output = data.get('to', 'root')
    target = output
    if output in ('component', 'context'):
        target = {'occurrence': ctx.ref(ctx.occurrence)} if ctx.occurrence else {'component': ctx.ref(ctx.component)}
    conversion, label = _entity_frame(ctx, _geometry_datum_adapter_cast('str | JsonObject', target), owner, occurrence)
    frames: list[JsonObject] = []
    if _cad_type(native) == 'Joint':
        matrices = [('One', _geometry_datum_adapter_cast('_GeometryDatumJointTransforms', native).geometryOneTransform),
                    ('Two', _geometry_datum_adapter_cast('_GeometryDatumJointTransforms', native).geometryTwoTransform)]
        for side, matrix in matrices:
            frames.append({'side': side, 'matrix': _entity_multiply(conversion, _entity_matrix(matrix.asArray())) if matrix is not None else None})
    else:
        geometry = _geometry_datum_adapter_cast('_GeometryDatumAsBuiltGeometry', native).geometry
        if geometry is not None:
            local = _datum_basis(_cad_xyz(geometry.origin), _cad_xyz(geometry.secondaryAxisVector), _cad_xyz(geometry.thirdAxisVector))
            # primary=Z, secondary=X, third=Y; never exchange primary and X.
            z = [local[2], local[6], local[10]]
            if sum(a*b for a, b in zip(z, _cad_xyz(geometry.primaryAxisVector))) < 1 - 1e-8:
                raise ValueError('Joint geometry axes are not right handed')
            frames.append({'side': 'asBuilt', 'matrix': _entity_multiply(conversion, local)})
    motion = native.jointMotion
    axes: JsonObject = {}
    for prop in ('rotationAxisVector', 'slideDirectionVector'):
        if hasattr(motion, prop):
            vector = (_geometry_datum_adapter_cast('_GeometryDatumRotationAxis', motion).rotationAxisVector
                      if prop == 'rotationAxisVector'
                      else _geometry_datum_adapter_cast('_GeometryDatumSlideDirection', motion).slideDirectionVector)
            axes[prop] = _cad_direction(_entity_xyz(conversion, _cad_xyz(vector), True)) if vector is not None else None
    result = _datum_contract(ctx, 'joint.frame', {'joint': ctx.ref(joint), 'frames': frames,
        'motionAxes': axes, 'limits': _geometry_datum_adapter_cast('JsonObject', _assembly_limits_read(motion)),
        'occurrences': [ctx.ref(o) if o is not None else None for o in (
            _geometry_datum_adapter_cast('_GeometryDatumJointOccurrences', joint).occurrenceOne,
            _geometry_datum_adapter_cast('_GeometryDatumJointOccurrences', joint).occurrenceTwo)],
        'axisConvention': 'geometry primary=Z, secondary=X, third=Y; signed motion axes reported separately'}, frame=label,
        limitations=['Frames and limits are current snapshots; rigid as-built or inferred joint geometry can be unavailable. Native frame/sign acceptance pending.'])
    if not frames or any(f['matrix'] is None for f in frames):
        result['status'] = 'unknown'
    return result


def _datum_joint_create(ctx: "CadContext", data: "JsonObject", mode: "str") -> "JsonObject":
    if any(k in data for k in ('point', 'axis')) or mode == 'rigid':
        raise ValueError('frame replaces point/axis for revolute, slider or cylindrical joints')
    if data.get('associativity') != 'snapshot':
        raise ValueError('Joint from metadata frame requires associativity:snapshot for helper placement')
    # Resolve the complete request before helper creation, including limits against
    # a throwaway input using the root origin geometry.
    prepared = {k: v for k, v in data.items() if k not in ('frame', 'associativity')}
    prepared['schemaVersion'] = 1
    one, two = [_datum_occurrence_ref(ctx, data[k]) for k in ('occurrenceOne', 'occurrenceTwo')]
    if one == two or one.fullPathName.startswith(two.fullPathName + '+') or two.fullPathName.startswith(one.fullPathName + '+'):
        raise ValueError('Joint requires distinct non-ancestor occurrences')
    name = _assembly_name(_geometry_datum_adapter_cast('str', data['name']))
    if any(j.name == name for j in _cad_items(ctx.root.asBuiltJoints)):
        raise ValueError('Joint name already exists')
    matrix = _datum_world(ctx, data['frame'])
    if 'confirm' in data or 'limits' in data:
        ctx.require_confirm(data)
    if 'limits' in data:
        geometry = adsk.fusion.JointGeometry.createByPoint(ctx.root.originConstructionPoint)
        inp = ctx.root.asBuiltJoints.createInput(one, two, geometry)
        if mode == 'revolute':
            _cad_require_result(inp.setAsRevoluteJointMotion(_geometry_datum_adapter_cast(
                'adsk.fusion.JointDirections', adsk.fusion.JointDirections.ZAxisJointDirection)), 'Preflight joint motion')
        elif mode == 'slider':
            _cad_require_result(inp.setAsSliderJointMotion(_geometry_datum_adapter_cast(
                'adsk.fusion.JointDirections', adsk.fusion.JointDirections.ZAxisJointDirection)), 'Preflight joint motion')
        elif mode == 'cylindrical':
            _cad_require_result(inp.setAsCylindricalJointMotion(_geometry_datum_adapter_cast(
                'adsk.fusion.JointDirections', adsk.fusion.JointDirections.ZAxisJointDirection)), 'Preflight joint motion')
        else:
            raise ValueError('Frame-derived helper geometry requires a revolute, slider or cylindrical joint')
        _assembly_limits_plan(ctx, inp.jointMotion, _geometry_datum_adapter_cast('JsonObject', data['limits']))
    _assembly_capture_ready(ctx)
    saved = ctx.component, ctx.occurrence
    ctx.component, ctx.occurrence = ctx.root, None
    try:
        names = [name + '__origin', name + '__axisEnd']
        for n in names:
            _cad_datum_name(ctx, {'name': n}, ctx.root.constructionPoints)
            for suffix in ('x', 'y', 'z'):
                _cad_datum_name(ctx, {'name': n + '__' + suffix}, ctx.root.constructionPlanes)
        _cad_datum_name(ctx, {'name': name + '__axis'}, ctx.root.constructionAxes)
        origin = _entity_xyz(matrix, [0, 0, 0])
        end = _entity_xyz(matrix, [0, 0, 1])
        points = [_cad_datum_point(ctx, {'name': n, 'point': [str(v) + ' cm' for v in p]}) for n, p in zip(names, (origin, end))]
        axis = _cad_datum_axis(ctx, {'name': name + '__axis', 'mode': 'twoPoints', 'point1': points[0], 'point2': points[1]})
        prepared.update(point=points[0], axis={'ref': axis})
        result = _assembly_joint(ctx, prepared, mode)
        helpers = points + [axis]
        if result.get('directionEntity'):
            for entity in _geometry_datum_adapter_cast('list[JsonObject]', result['directionEntity']):
                helpers += [_geometry_datum_adapter_cast('JsonRecord', entity['origin']),
                            _geometry_datum_adapter_cast('JsonRecord', entity['plane']),
                            _geometry_datum_adapter_cast('JsonRecord', entity['sketch']),
                            _geometry_datum_adapter_cast('JsonRecord', entity['line'])] + _geometry_datum_adapter_cast(
                                'list[JsonRecord]', entity['points'])
        result.update(helpers=helpers, helperAssociativity='snapshot', sourceFrame=data['frame'])
        _geometry_datum_adapter_cast('list[str]', result['limitations']).append(
            'Native joint references constant helpers; metadata frame edits do not update these helpers.')
        return result
    finally:
        ctx.component, ctx.occurrence = saved
