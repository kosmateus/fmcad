"""Fusion reads for versioned fastener measurements; no handler registration here."""
from typing import TYPE_CHECKING as _MFAdapterTypeChecking, Literal as _MFAdapterLiteral
from typing import Protocol as _MFAdapterProtocol, cast as _MFAdapterCast


if _MFAdapterTypeChecking:
    class _MFAdapterDocumentIdentity(_MFAdapterProtocol):
        @property
        def creationId(self) -> str | None: ...

        @property
        def name(self) -> str | None: ...

    class _MFAdapterPointGeometry(_MFAdapterProtocol):
        x: float
        y: float
        z: float

    class _MFAdapterAxisGeometry(_MFAdapterProtocol):
        origin: _MFAdapterPointGeometry
        direction: _MFAdapterPointGeometry


def _mf_ref_entity(ctx: "CadContext", spec: "JsonValue", accepted_kinds: tuple[str, ...], path: str,
                   entities: "dict[str, CadEntity]", failures: "dict[str, JsonObject]") -> "CadEntity | None":
    if spec is None:
        failures[path] = {'status': 'missing', 'reason': 'No reference supplied.'}
        return None
    try:
        entity = ctx.resolve(spec)
        kind = _cad_kind(entity)
        if kind not in accepted_kinds:
            failures[path] = {'status': 'unsupported',
                              'reason': 'Expected %s reference, received %s.' %
                                        ('/'.join(accepted_kinds), kind),
                              'sourceRef': ctx.ref(entity)}
            return None
        entities[path] = entity
        return entity
    except Exception as error:
        failures[path] = {'status': 'unsupported',
                          'reason': 'Native reference could not be resolved: ' + str(error)}
        return None


def _mf_point_xyz(entity: "CadEntity") -> list[float]:
    geometry = _measure_geometry(entity)
    if not all(hasattr(geometry, axis) for axis in ('x', 'y', 'z')):
        raise ValueError('Reference does not expose a native point geometry')
    point = _MFAdapterCast('_MFAdapterPointGeometry', geometry)
    return [float(point.x) * 10.0, float(point.y) * 10.0, float(point.z) * 10.0]


def _mf_axis_values(entity: "CadEntity") -> "tuple[list[float], list[float]]":
    geometry = _measure_geometry(entity)
    origin = getattr(geometry, 'origin', None)
    direction = getattr(geometry, 'direction', None)
    if origin is None or direction is None:
        raise ValueError('Reference does not expose a native linear axis')
    axis = _MFAdapterCast('_MFAdapterAxisGeometry', geometry)
    return ([float(axis.origin.x) * 10.0, float(axis.origin.y) * 10.0, float(axis.origin.z) * 10.0],
            [float(axis.direction.x), float(axis.direction.y), float(axis.direction.z)])


def _mf_frame(ctx: "CadContext", entities: "list[CadEntity]", requested: "JsonValue") -> "JsonObject":
    if not entities:
        raise ValueError('Native fastener measurement requires at least one resolvable reference')
    frame = _measure_space(ctx, entities)
    if requested is not None:
        for entity in entities:
            _measure_frame(ctx, entity, requested)
    return frame


def _mf_read_record(ctx: "CadContext", path: str, entity: "CadEntity | None",
                   failures: "dict[str, JsonObject]", frame: "JsonObject",
                   kind: "str") -> "JsonObject":
    failure = failures.get(path)
    if failure is not None:
        if kind == 'axis':
            failure_record: "JsonObject" = dict(failure, sourceVersion=1, frame=frame)
            return {'origin': failure_record, 'direction': failure_record}
        return dict(failure, sourceVersion=1, frame=frame)
    if entity is None:
        missing_record: "JsonObject" = {'status': 'missing', 'sourceVersion': 1, 'frame': frame,
                                         'reason': 'No reference supplied.'}
        return {'origin': missing_record, 'direction': missing_record} if kind == 'axis' else missing_record
    try:
        value = _mf_axis_values(entity) if kind == 'axis' else _mf_point_xyz(entity)
    except Exception as error:
        unsupported_record: "JsonObject" = {'status': 'unsupported', 'sourceVersion': 1, 'frame': frame,
                                             'sourceRef': ctx.ref(entity),
                                             'reason': 'Native geometry read is unsupported: ' + str(error)}
        return {'origin': unsupported_record, 'direction': unsupported_record} if kind == 'axis' else unsupported_record
    if kind == 'axis':
        origin, direction = _MFAdapterCast('tuple[list[float], list[float]]', value)
        return {'origin': _mf_value_record(ctx, entity, origin, frame, 'native axis origin projected from Fusion geometry'),
                'direction': _mf_value_record(ctx, entity, direction, frame, 'native axis direction from Fusion geometry')}
    return _mf_value_record(ctx, entity, _MFAdapterCast('list[float]', value), frame,
                            'selected native point projected in the measured frame')


def _mf_value_record(ctx: "CadContext", entity: "CadEntity", value: "JsonValue",
                     frame: "JsonObject", coverage: str) -> "JsonObject":
    provenance = {'source': 'Fusion native entity geometry',
                  'sourceRef': ctx.ref(entity), 'sourceVersion': 1,
                  'frame': frame, 'coverage': coverage}
    identity = _mf_document_identity(ctx)
    if identity is not None:
        provenance['documentIdentity'] = identity
    return {'status': 'measured', 'value': value, 'sourceVersion': 1, 'provenance': provenance}


def _mf_document_identity(ctx: "CadContext") -> "JsonObject | None":
    document = getattr(ctx, 'doc', None)
    if document is None:
        return None
    identity: "JsonObject" = {}
    typed_document = _MFAdapterCast('_MFAdapterDocumentIdentity', document)
    for key in ('creationId', 'name'):
        value = typed_document.creationId if key == 'creationId' else typed_document.name
        if value is not None:
            identity[key] = value
    return identity or None


def _mf_collect_native_refs(ctx: "CadContext", request: "JsonValue") -> "tuple[dict[str, CadEntity], dict[str, JsonObject]]":
    if not isinstance(request, dict) or type(request.get('schemaVersion')) is not int or request.get('schemaVersion') != 1:
        raise ValueError('native fastener references require schemaVersion:1')
    for key in ('screw', 'receptacle'):
        if not isinstance(request.get(key), dict):
            raise ValueError('native.' + key + ' must be an object')
    screw = _MFAdapterCast('JsonObject', request['screw'])
    receptacle = _MFAdapterCast('JsonObject', request['receptacle'])
    if receptacle.get('kind') not in ('blind', 'through', 'tapped', 'insert', 'nut'):
        raise ValueError('native.receptacle.kind must be blind, through, tapped, insert or nut')
    layers = request.get('layers', [])
    if not isinstance(layers, list) or any(not isinstance(layer, dict) for layer in layers):
        raise ValueError('native.layers must be an array of reference objects')
    layers = _MFAdapterCast('list[JsonObject]', layers)

    entities: "dict[str, CadEntity]" = {}
    failures: "dict[str, JsonObject]" = {}
    point_kinds = ('point', 'vertex')
    axis_kinds = ('axis', 'edge')
    _mf_ref_entity(ctx, screw.get('axis'), axis_kinds, 'screw.axis', entities, failures)
    for key in ('headBearing', 'tip', 'threadStart', 'threadEnd'):
        _mf_ref_entity(ctx, screw.get(key), point_kinds, 'screw.' + key, entities, failures)
    _mf_ref_entity(ctx, receptacle.get('axis'), axis_kinds, 'receptacle.axis', entities, failures)
    for key in ('threadStart', 'threadEnd', 'bottom'):
        _mf_ref_entity(ctx, receptacle.get(key), point_kinds, 'receptacle.' + key, entities, failures)
    for index, layer in enumerate(layers):
        for key in ('start', 'end'):
            _mf_ref_entity(ctx, layer.get(key), point_kinds, 'layers.%d.%s' % (index, key), entities, failures)
    return entities, failures


def _mf_collect_tool_refs(ctx: "CadContext", request: "JsonValue", entities: "dict[str, CadEntity]",
                          failures: "dict[str, JsonObject]") -> None:
    if not isinstance(request, dict):
        raise ValueError('native.toolAccess must be an object')
    target = request.get('target')
    entry = request.get('entry')
    if not isinstance(target, dict) or not isinstance(entry, dict):
        raise ValueError('native.toolAccess requires target and entry references')
    _mf_ref_entity(ctx, target.get('origin'), ('point', 'vertex'), 'toolAccess.target.origin', entities, failures)
    _mf_ref_entity(ctx, target.get('axis'), ('axis', 'edge'), 'toolAccess.target.axis', entities, failures)
    _mf_ref_entity(ctx, entry.get('origin'), ('point', 'vertex'), 'toolAccess.entry.origin', entities, failures)
    _mf_ref_entity(ctx, entry.get('direction'), ('axis', 'edge'), 'toolAccess.entry.direction', entities, failures)
    obstacles = request.get('nativeObstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('native.toolAccess.nativeObstacles must be an array')
    for index, obstacle in enumerate(obstacles):
        if not isinstance(obstacle, dict):
            raise ValueError('native tool obstacles must be objects')
        _mf_ref_entity(ctx, obstacle.get('body'), ('body',), 'toolAccess.obstacles.%d' % index, entities, failures)


def _mf_tolerance(ctx: "CadContext", request: "JsonObject") -> "JsonObject":
    tolerance = request.get('tolerance')
    if not isinstance(tolerance, dict):
        raise ValueError('native.tolerance must declare axisOffset and axisAngle')
    if 'axisOffset' not in tolerance or 'axisAngle' not in tolerance:
        raise ValueError('native.tolerance requires axisOffset and axisAngle')
    minimum = tolerance.get('minimumEngagement')
    return {'axisOffsetMm': ctx.length(tolerance['axisOffset']) * 10.0,
            'axisAngleRad': ctx.angle(tolerance['axisAngle']),
            'minimumEngagementMm': ctx.length(minimum) * 10.0 if minimum is not None else None}


def _mf_measure_native(ctx: "CadContext", request: "JsonObject") -> "JsonObject":
    entities, failures = _mf_collect_native_refs(ctx, request)
    if entities:
        frame = _mf_frame(ctx, list(entities.values()), request.get('frame'))
    else:
        requested = request.get('frame')
        if not isinstance(requested, dict) or requested.get('space') not in ('assembly', 'component local'):
            raise ValueError('No native reference resolved; supply the expected frame to report unavailable reads')
        frame = dict(requested, status='unverified')
    screw = _MFAdapterCast('JsonObject', request['screw'])
    receptacle = _MFAdapterCast('JsonObject', request['receptacle'])

    def read(path: str, kind: str) -> "JsonObject":
        return _mf_read_record(ctx, path, entities.get(path), failures, frame, kind)

    screw_axis = read('screw.axis', 'axis')
    receptacle_axis = read('receptacle.axis', 'axis')
    measured: "JsonObject" = {'schemaVersion': 1, 'sourceVersion': 1, 'frame': frame,
                'tolerance': _mf_tolerance(ctx, request),
                'screw': {'axis': screw_axis,
                          'headBearing': read('screw.headBearing', 'point'),
                          'tip': read('screw.tip', 'point'),
                          'threadStart': read('screw.threadStart', 'point'),
                          'threadEnd': read('screw.threadEnd', 'point')},
                'receptacle': {'kind': receptacle['kind'], 'axis': receptacle_axis,
                               'threadStart': read('receptacle.threadStart', 'point'),
                               'threadEnd': read('receptacle.threadEnd', 'point')},
                'layers': []}
    if 'receptacle.bottom' in entities or receptacle['kind'] == 'blind':
        _MFAdapterCast('JsonObject', measured['receptacle'])['bottom'] = read('receptacle.bottom', 'point')
    layers = _MFAdapterCast('list[JsonObject]', request.get('layers', []))
    measured_layers = _MFAdapterCast('list[JsonObject]', measured['layers'])
    for index, layer in enumerate(layers):
        measured_layers.append({'id': layer.get('id', str(index)),
                                'start': read('layers.%d.start' % index, 'point'),
                                'end': read('layers.%d.end' % index, 'point')})
    return measured


def _mf_format_mm(value: float) -> str:
    return format(float(value), '.12g') + ' mm'


def _mf_tool_access(ctx: "CadContext", request: "JsonValue",
                    requested_frame: "JsonValue" = None) -> "JsonObject":
    if not isinstance(request, dict):
        raise ValueError('toolAccess must be an object')
    entities: "dict[str, CadEntity]" = {}
    failures: "dict[str, JsonObject]" = {}
    _mf_collect_tool_refs(ctx, request, entities, failures)
    if not entities:
        frame = dict(requested_frame, status='unverified') if isinstance(requested_frame, dict) else None
        return {'complete': False, 'frame': frame, 'result': None,
                'missingMeasurements': ['toolAccess.target/entry native references'],
                'nativeObstacleEvidence': [], 'declaredObstacleEvidence': [],
                'coverage': 'Tool access was not evaluated because no native target, entry or obstacle reference resolved.'}
    frame = _mf_frame(ctx, list(entities.values()), requested_frame)
    target = _MFAdapterCast('JsonObject', request['target'])
    entry = _MFAdapterCast('JsonObject', request['entry'])

    required_paths = ('toolAccess.target.origin', 'toolAccess.target.axis',
                      'toolAccess.entry.origin', 'toolAccess.entry.direction')
    missing_paths = [path for path in required_paths if path not in entities]
    if missing_paths:
        return {'complete': False, 'frame': frame, 'result': None,
                'missingMeasurements': missing_paths,
                'nativeObstacleEvidence': [], 'declaredObstacleEvidence': [],
                'coverage': 'Tool access was not evaluated because native target or entry references are unavailable.'}

    def point(path: str) -> "tuple[CadEntity, list[float]]":
        entity = entities.get(path)
        if entity is None:
            raise ValueError(failures.get(path, {}).get('reason', path + ' is unavailable'))
        return entity, _mf_point_xyz(entity)

    def axis(path: str) -> "tuple[CadEntity, list[float]]":
        entity = entities.get(path)
        if entity is None:
            raise ValueError(failures.get(path, {}).get('reason', path + ' is unavailable'))
        origin, direction = _mf_axis_values(entity)
        return entity, direction

    try:
        target_entity, target_point = point('toolAccess.target.origin')
        target_axis_entity, target_direction = axis('toolAccess.target.axis')
        entry_entity, entry_point = point('toolAccess.entry.origin')
        entry_axis_entity, entry_direction = axis('toolAccess.entry.direction')
    except Exception as error:
        return {'complete': False, 'frame': frame, 'result': None,
                'missingMeasurements': ['toolAccess.target/entry native geometry'],
                'nativeObstacleEvidence': [], 'declaredObstacleEvidence': [],
                'coverage': 'Tool access was not evaluated because a native target or entry geometry read is unsupported: ' + str(error)}
    obstacles: list[JsonObject] = []
    native_evidence: list[JsonObject] = []
    native_obstacles = _MFAdapterCast('list[JsonObject]', request.get('nativeObstacles', []))
    # An empty selection is not evidence that the surrounding model is clear.
    complete = bool(native_obstacles)
    for index, obstacle in enumerate(native_obstacles):
        path = 'toolAccess.obstacles.%d' % index
        body = entities.get(path)
        if body is None:
            complete = False
            native_evidence.append({'name': obstacle.get('name'), 'status': 'unsupported',
                                    'sourceVersion': 1, 'frame': frame,
                                    'reason': failures.get(path, {}).get('reason', 'Native body reference unavailable.')})
            continue
        try:
            copied = _measure_temporary_body(ctx, obstacle['body'], frame)
            bounds = copied.body.boundingBox
            minimum = [float(bounds.minPoint.x) * 10.0, float(bounds.minPoint.y) * 10.0,
                       float(bounds.minPoint.z) * 10.0]
            maximum = [float(bounds.maxPoint.x) * 10.0, float(bounds.maxPoint.y) * 10.0,
                       float(bounds.maxPoint.z) * 10.0]
            name = _MFAdapterCast('str', obstacle.get('name', 'native-obstacle-%d' % index))
            obstacles.append({'name': 'native:' + name,
                              'box': {'min': [_mf_format_mm(v) for v in minimum],
                                      'max': [_mf_format_mm(v) for v in maximum]}})
            measured_evidence: "JsonObject" = {'name': name, 'status': 'measured',
                                                'sourceRef': ctx.ref(body), 'sourceVersion': 1, 'frame': frame,
                                                'coverage': 'conservative axis-aligned bounds of a temporary solid-body copy'}
            identity = _mf_document_identity(ctx)
            if identity is not None:
                measured_evidence['documentIdentity'] = identity
            native_evidence.append(measured_evidence)
        except Exception as error:
            complete = False
            unsupported_evidence: "JsonObject" = {'name': obstacle.get('name'), 'status': 'unsupported',
                                                   'sourceRef': ctx.ref(body), 'sourceVersion': 1, 'frame': frame,
                                                   'reason': 'Native obstacle bounds unavailable: ' + str(error)}
            identity = _mf_document_identity(ctx)
            if identity is not None:
                unsupported_evidence['documentIdentity'] = identity
            native_evidence.append(unsupported_evidence)

    declared_obstacles = request.get('declaredObstacles', [])
    if not isinstance(declared_obstacles, list):
        raise ValueError('toolAccess.declaredObstacles must be an array')
    declared_evidence: list[JsonObject] = []
    for index, obstacle in enumerate(declared_obstacles):
        if not isinstance(obstacle, dict):
            raise ValueError('Declared tool obstacles must be objects')
        name = _MFAdapterCast('str', obstacle.get('name', 'declared-obstacle-%d' % index))
        row = dict(obstacle)
        row['name'] = 'declared:' + name
        obstacles.append(row)
        declared_evidence.append({'name': name, 'status': 'declared', 'sourceVersion': 1,
                                  'frame': 'declared tool-access input',
                                  'coverage': 'point/radius or axis-aligned box supplied by caller, not read from Fusion'})

    access_data: "JsonObject" = {'tool': request.get('tool'),
                   'target': {'origin': [_mf_format_mm(v) for v in target_point],
                              'axis': target_direction,
                              'engagementDepth': target.get('engagementDepth', '0 mm')},
                   'entry': {'origin': [_mf_format_mm(v) for v in entry_point],
                             'direction': entry_direction},
                   'obstacles': obstacles,
                   'minimumClearance': request.get('minimumClearance', '0 mm'),
                   'samples': request.get('samples', 20),
                   'schemaVersion': 1, 'frame': 'component'}
    result = tool_access(ctx, access_data)
    target_source: "JsonObject" = {'sourceRef': ctx.ref(target_entity), 'sourceVersion': 1,
                     'frame': frame, 'axisSourceRef': ctx.ref(target_axis_entity)}
    entry_source: "JsonObject" = {'sourceRef': ctx.ref(entry_entity), 'sourceVersion': 1,
                    'frame': frame, 'directionSourceRef': ctx.ref(entry_axis_entity)}
    identity = _mf_document_identity(ctx)
    if identity is not None:
        target_source['documentIdentity'] = identity
        entry_source['documentIdentity'] = identity
    return {'complete': complete, 'frame': frame, 'result': result,
            'targetSource': target_source, 'entrySource': entry_source,
            'nativeObstacleEvidence': native_evidence,
            'declaredObstacleEvidence': declared_evidence,
            'coverage': 'Reuses tool.access cylindrical-envelope sampling. Coverage is limited to the selected native body refs, whose solid geometry is represented by conservative axis-aligned bounds; no exhaustive scene obstacle enumeration is claimed. Declared point/box obstacles remain separate caller-supplied evidence.'}


class _MeasuredFastenerPorts:
    def __init__(self, ctx: "CadContext", native_request: "JsonObject") -> None:
        self.ctx = ctx
        self.native_request = native_request
        self.measured_frame: "JsonObject | None" = None

    def measure_native(self, request: "JsonObject") -> "JsonObject":
        result = _mf_measure_native(self.ctx, request)
        self.measured_frame = _MFAdapterCast('JsonObject', result['frame'])
        return result

    def declared_fastener(self, operation: _MFAdapterLiteral['fastener.stack', 'fastener.check'],
                          data: "JsonObject") -> "JsonObject":
        if operation == 'fastener.stack':
            return _fastener_stack(self.ctx, data)
        return _fastener_check(self.ctx, data)

    def tool_access(self, request: "JsonValue") -> "JsonObject":
        frame = self.measured_frame
        if not isinstance(frame, dict) or frame.get('status') == 'unverified':
            frame = self.native_request.get('frame')
        return _mf_tool_access(self.ctx, request, frame)


def measured_fasteners_check_operation(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    """Prepared-runtime entry point; the family registry wires it in its integration slot."""
    native_value = data.get('native')
    native_request: "JsonObject" = native_value if isinstance(native_value, dict) else {}
    return measured_fasteners_check(data, _MeasuredFastenerPorts(ctx, native_request))
