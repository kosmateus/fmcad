"""GM26: FPC fold/flatten, PCB exchange/check, ports, connectors, packing and keepouts.

FPC folding walks a declared flex chain (rigid lines plus bend arcs); the neutral
axis through every bend is ``radius * angle``, so flat and folded neutral length
are identical and the FPC is never scaled. Only declared bend zones bend; the
handler never treats the whole outline as flexible. PCB exchange reports the
datum offset between a STEP center and a lens/pad datum instead of conflating
them. Connector mate-check includes poka-yoke: a forbidden pair that can reach
seating position (shared key/shroud signature and pin count) is reported, so
similar 4-pin power/data/encoder connectors are not safe merely because each
intended pair mates. pack.cross-section defines the reserve denominator and
checks real outline fit, not just equal areas.
"""
import math as _fpc_adapter_math


if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _FpcNotRequired

    class _FpcLine(_CadTypedDict):
        type: Literal['line']
        length: JsonValue

    class _FpcBend(_CadTypedDict):
        type: Literal['bend']
        radius: JsonValue
        angle: JsonValue
        axis: _FpcNotRequired[str]

    _FpcChainItem: TypeAlias = _FpcLine | _FpcBend

    class _FpcConnector(_CadTypedDict):
        name: str
        gender: str
        pinCount: int
        key: JsonValue
        shroud: JsonValue

    class _FpcConnectorInput(_CadTypedDict):
        name: JsonValue
        gender: _FpcNotRequired[JsonValue]
        pinCount: _FpcNotRequired[JsonValue]
        key: _FpcNotRequired[JsonValue]
        shroud: _FpcNotRequired[JsonValue]

    class _FpcDatum(_CadTypedDict):
        origin: JsonValue
        name: _FpcNotRequired[JsonValue]
        type: _FpcNotRequired[JsonValue]

    class _FpcExchangeSide(_CadTypedDict):
        datum: JsonValue
        outline: _FpcNotRequired[JsonValue]

    class _FpcBoard(_CadTypedDict):
        outline: JsonValue
        thickness: _FpcNotRequired[JsonValue]
        holes: _FpcNotRequired[JsonValue]
        heightZones: _FpcNotRequired[JsonValue]
        courtyards: _FpcNotRequired[JsonValue]
        copperKeepouts: _FpcNotRequired[JsonValue]

    class _FpcHole(_CadTypedDict):
        center: JsonValue
        type: _FpcNotRequired[JsonValue]
        diameter: _FpcNotRequired[JsonValue]
        length: _FpcNotRequired[JsonValue]
        width: _FpcNotRequired[JsonValue]

    class _FpcPortFrame(_CadTypedDict):
        origin: JsonValue
        normal: JsonValue
        pin1: _FpcNotRequired[JsonValue]

    class _FpcMateInput(_CadTypedDict):
        connectors: JsonValue
        intendedPairs: JsonValue
        forbiddenPairs: _FpcNotRequired[JsonValue]
        insertionOrientations: _FpcNotRequired[JsonValue]
        checkScope: _FpcNotRequired[JsonValue]

    class _FpcCircleItem(_CadTypedDict):
        radius: JsonValue
        center: _FpcNotRequired[JsonValue]

    class _FpcOutlineItem(_CadTypedDict):
        outline: JsonValue

    _FpcPackingItem: TypeAlias = _FpcCircleItem | _FpcOutlineItem

    class _FpcKeepout(_CadTypedDict):
        outline: JsonValue
        name: _FpcNotRequired[JsonValue]
        side: _FpcNotRequired[JsonValue]

    class _FpcSized(_Protocol):
        def __len__(self) -> int: ...

    class _FpcBendRecord(_CadTypedDict):
        index: int
        type: Literal['bend']
        position: list[float]
        tangent: list[float]
        radius: float
        angle: float


# --- planar helpers --------------------------------------------------------------


def _polygon(ctx: "CadContext", spec: "JsonValue") -> "list[list[float]]":
    if not isinstance(spec, list) or len(spec) < 3:
        raise ValueError('outline requires at least three [x,y] points')
    points: list[list[float]] = []
    for point_value in spec:
        point = _cad_cast("Sequence[JsonValue]", point_value)
        points.append([ctx.length(point[0]), ctx.length(point[1])])
    return points


# --- FPC flex chain --------------------------------------------------------------


def _chain_geometry(ctx: "CadContext", chain: "JsonValue") -> "tuple[float, float, float]":
    if not isinstance(chain, list) or not chain:
        raise ValueError('chain must be a nonempty array of line/bend objects')
    lines: float = 0.0
    bends: float = 0.0
    for item_value in chain:
        if not isinstance(item_value, dict) or 'type' not in item_value:
            raise ValueError('chain items require a type')
        item_type = item_value['type']
        if item_type == 'line':
            item = _cad_cast("_FpcLine", item_value)
            if ctx.length(item['length']) <= 0:
                raise ValueError('line length must be positive')
            lines += ctx.length(item['length'])
        elif item_type == 'bend':
            item = _cad_cast("_FpcBend", item_value)
            radius = ctx.length(item['radius'])
            if radius <= 0:
                raise ValueError('bend radius must be positive')
            if item.get('axis', 'y') not in _AXES:
                raise ValueError('bend axis must be x, y or z')
            bends += radius * abs(ctx.angle(item['angle']))
        else:
            raise ValueError('chain item type must be line or bend')
    return lines, bends, lines + bends


def _fold_walk(ctx: "CadContext", chain: "JsonValue") -> "tuple[list[list[float]], list[JsonRecord]]":
    segments = _cad_cast("Sequence[_FpcChainItem]", chain)
    position: list[float] = [0.0, 0.0, 0.0]
    tangent: list[float] = [1.0, 0.0, 0.0]
    points: list[list[float]] = [list(position)]
    mapping: list[JsonRecord] = []
    for index, item in enumerate(segments):
        if item['type'] == 'line':
            length = ctx.length(item['length'])
            position = _fpc_vadd(position, _fpc_vscale(tangent, length))
            mapping.append({'index': index, 'type': 'line', 'position': list(position),
                            'tangent': list(tangent)})
        else:
            radius = ctx.length(item['radius'])
            angle = ctx.angle(item['angle'])
            axis_name = item.get('axis', 'y')
            axis = _AXES[axis_name]
            inward = _fpc_vunit(_fpc_vcross(axis, tangent))
            center = _fpc_vadd(position, _fpc_vscale(inward, radius))
            start_radial = _fpc_vscale(inward, -1.0)
            end_radial = _fpc_rotate(start_radial, axis, angle)
            position = _fpc_vadd(center, _fpc_vscale(end_radial, radius))
            tangent = _fpc_rotate(tangent, axis, angle)
            mapping.append({'index': index, 'type': 'bend', 'position': list(position),
                            'tangent': list(tangent), 'radius': radius, 'angle': angle})
        points.append(list(position))
    return points, mapping


def _flatten_walk(ctx: "CadContext", chain: "JsonValue") -> "list[list[float]]":
    segments = _cad_cast("Sequence[_FpcChainItem]", chain)
    position: list[float] = [0.0, 0.0, 0.0]
    tangent: list[float] = [1.0, 0.0, 0.0]
    points: list[list[float]] = [list(position)]
    for item in segments:
        if item['type'] == 'line':
            length = ctx.length(item['length'])
        else:
            length = ctx.length(item['radius']) * abs(ctx.angle(item['angle']))
        position = _fpc_vadd(position, _fpc_vscale(tangent, length))
        points.append(list(position))
    return points


# --- envelope --------------------------------------------------------------------

def _fpc_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
                  status: str = 'pass') -> "JsonRecord":
    identity: JsonRecord | None = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component: JsonRecord | None = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged: JsonRecord = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'rad'},
                  frame={'space': 'component', 'component': component}, associativity='snapshot',
                  warnings=[], method='GM26 local geometry/recipe evaluation',
                  limitations=['FPC neutral-axis chain folding is a recipe; arbitrary 2D outline folding and native ECAD/flex remain a separate gate, not a default consequence of STEP import.',
                               'The whole outline is never treated as flexible; only declared bend zones bend.'],
                  provenance={'requirement': 'GM26', 'source': 'docs/FPC_PCB.md'}, affected=[])
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


def fpc_fold(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('chain',), ('outline', 'stackup', 'rigidIslands', 'stiffeners', 'bendZones',
                                   'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('fold requires schemaVersion 1')
    lines, bends, neutral = _chain_geometry(ctx, data['chain'])
    points, mapping = _fold_walk(ctx, data['chain'])
    stackup = data.get('stackup')
    neutral_fraction: float = 0.5
    if stackup is not None:
        stackup_data = _cad_cast("JsonObject", stackup)
        neutral_fraction = float(_cad_cast(
            "int | float | str | bool", stackup_data.get('neutralLayerFraction', 0.5)))
        if not 0.0 <= neutral_fraction <= 1.0:
            raise ValueError('neutralLayerFraction must be within [0,1]')
    bend_rows: list[_FpcBendRecord] = [
        _cad_cast("_FpcBendRecord", record) for record in mapping if record['type'] == 'bend']
    return _fpc_contract(ctx, 'fpc.fold', {
        'foldedCenterline': points, 'mapping': mapping,
        'flatNeutralLength': neutral, 'foldedNeutralLength': neutral, 'neutralLengthPreserved': True,
        'neutralLayerFraction': neutral_fraction,
        'bendArcLengths': [{'index': bend['index'], 'arcLength': bend['radius'] * abs(bend['angle'])}
                           for bend in bend_rows],
        'scaled': False})


def fpc_flatten(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('chain',), ('outline', 'stackup', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('flatten requires schemaVersion 1')
    lines, bends, neutral = _chain_geometry(ctx, data['chain'])
    points = _flatten_walk(ctx, data['chain'])
    return _fpc_contract(ctx, 'fpc.flatten', {
        'flatCenterline': points, 'flatNeutralLength': neutral, 'foldedNeutralLength': neutral,
        'neutralLengthPreserved': True, 'scaled': False,
        'straightenedBendLengths': bends})


def pcb_mechanical_exchange(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('source', 'target'), ('frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('mechanical-exchange requires schemaVersion 1')
    source_value, target_value = data['source'], data['target']
    if not isinstance(source_value, dict) or 'datum' not in source_value:
        raise ValueError('source requires a datum descriptor')
    if not isinstance(target_value, dict) or 'datum' not in target_value:
        raise ValueError('target requires a datum descriptor')
    source = _cad_cast("_FpcExchangeSide", source_value)
    target = _cad_cast("_FpcExchangeSide", target_value)
    s_datum = _cad_cast("_FpcDatum", source['datum'])
    t_datum = _cad_cast("_FpcDatum", target['datum'])
    s_origin = ctx.point(s_datum['origin'])
    t_origin = ctx.point(t_datum['origin'])
    offset = _fpc_vsub([t_origin.x, t_origin.y, t_origin.z], [s_origin.x, s_origin.y, s_origin.z])
    s_type = s_datum.get('type', 'mechanical')
    t_type = t_datum.get('type', 'mechanical')
    compatible = s_type == t_type
    warnings: list[str] = []
    if s_type == 'step-center' or t_type == 'step-center':
        warnings.append('STEP bounding-box center is a source of position, not a lens/pad datum; the offset is explicit and must not be silently adopted.')
    area_delta: float | None = None
    if 'outline' in source and 'outline' in target:
        s_area = _polygon_area(_polygon(ctx, source['outline']))
        t_area = _polygon_area(_polygon(ctx, target['outline']))
        area_delta = t_area - s_area
    return _fpc_contract(ctx, 'pcb.mechanical-exchange', {
        'datumOffset': offset, 'sourceDatum': {'name': s_datum.get('name'), 'type': s_type},
        'targetDatum': {'name': t_datum.get('name'), 'type': t_type},
        'compatibleDatum': compatible, 'outlineAreaDelta': area_delta,
        'sourceDiff': {'areaDelta': area_delta} if area_delta is not None else None,
        'warnings': warnings})


def pcb_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('board',), ('frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('check requires schemaVersion 1')
    board = _cad_cast("_FpcBoard", data['board'])
    thickness = ctx.length(board.get('thickness', '0 mm'))
    outline = _polygon(ctx, board['outline'])
    violations: list[str] = []
    if thickness <= 0:
        violations.append('thickness must be positive')
    holes_value = board.get('holes', [])
    if not isinstance(holes_value, list):
        raise ValueError('holes must be an array')
    holes = holes_value
    hole_rows: list[JsonRecord] = []
    for hole_value in holes:
        if not isinstance(hole_value, dict) or 'center' not in hole_value:
            raise ValueError('holes require a center')
        hole = _cad_cast("_FpcHole", hole_value)
        center = ctx.point(hole['center'])
        inside = _point_in_polygon([center.x, center.y], outline)
        kind = hole.get('type', 'round')
        if kind == 'round':
            diameter = ctx.length(hole.get('diameter', '0 mm'))
            if diameter <= 0:
                violations.append('round hole diameter must be positive')
        elif kind == 'slot':
            length = ctx.length(hole.get('length', '0 mm'))
            width = ctx.length(hole.get('width', '0 mm'))
            if length <= 0 or width <= 0:
                violations.append('slot length and width must be positive')
        else:
            violations.append('hole type must be round or slot')
        if not inside:
            violations.append('hole center outside board outline')
        hole_rows.append({'center': [center.x, center.y], 'type': kind, 'insideOutline': inside})
    zones = _cad_cast("Sequence[JsonValue]", board.get('heightZones', []))
    sides: set[str] = {
        _cad_cast(str, zone.get('side')) for zone in zones if isinstance(zone, dict)}
    for required in ('top', 'bottom'):
        if required not in sides:
            violations.append('height zone missing for ' + required + ' side')
    courtyards = _cad_cast("_FpcSized", board.get('courtyards', []))
    keepouts = _cad_cast("_FpcSized", board.get('copperKeepouts', []))
    passed = not violations
    return _fpc_contract(ctx, 'pcb.check', {'passed': passed, 'status': 'pass' if passed else 'fail',
        'violations': violations, 'thickness': thickness, 'holeCount': len(hole_rows),
        'heightZones': sorted(sides), 'courtyardCount': len(courtyards),
        'copperKeepoutCount': len(keepouts)}, status='pass' if passed else 'fail')


def port_define(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('name', 'frame'), ('key', 'matingStroke', 'supportZones', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('port.define requires schemaVersion 1')
    frame_value = data['frame']
    if not isinstance(frame_value, dict) or 'origin' not in frame_value or 'normal' not in frame_value:
        raise ValueError('frame requires origin and normal')
    frame = _cad_cast("_FpcPortFrame", frame_value)
    origin = ctx.point(frame['origin'])
    normal = _cad_direction(_cad_cast("Sequence[float]", frame['normal']))
    pin1 = ctx.point(frame['pin1']) if 'pin1' in frame else None
    key = data.get('key')
    stroke = ctx.length(data['matingStroke']) if 'matingStroke' in data else None
    if stroke is not None and stroke < 0:
        raise ValueError('matingStroke must be nonnegative')
    return _fpc_contract(ctx, 'port.define', {
        'name': data['name'], 'origin': [origin.x, origin.y, origin.z], 'normal': normal,
        'pin1': [pin1.x, pin1.y, pin1.z] if pin1 is not None else None, 'key': key,
        'matingStroke': stroke, 'supportZones': data.get('supportZones', [])})


def _connector(ctx: "CadContext", spec: "JsonValue") -> "_FpcConnector":
    if not isinstance(spec, dict) or 'name' not in spec:
        raise ValueError('connector requires a name')
    connector_spec = _cad_cast("_FpcConnectorInput", spec)
    gender = _cad_cast(str, connector_spec.get('gender', 'male'))
    if gender not in ('male', 'female'):
        raise ValueError('connector gender must be male or female')
    pin_count = connector_spec.get('pinCount')
    if type(pin_count) is not int or pin_count < 1:
        raise ValueError('connector pinCount must be a positive integer')
    key = connector_spec.get('key', 'unkeyed')
    shroud = connector_spec.get('shroud', key)
    name = _cad_cast(str, connector_spec['name'])
    return {'name': name, 'gender': gender, 'pinCount': pin_count, 'key': key, 'shroud': shroud}


def connector_mate_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('connectors', 'intendedPairs'), ('forbiddenPairs', 'insertionOrientations',
                                                        'checkScope', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('mate-check requires schemaVersion 1')
    mate_data = _cad_cast("_FpcMateInput", data)
    connector_values = _cad_cast("Sequence[JsonValue]", mate_data['connectors'])
    connectors: dict[str, _FpcConnector] = {}
    for connector_value in connector_values:
        connector = _connector(ctx, connector_value)
        connectors[connector['name']] = connector
    intended_value = mate_data['intendedPairs']
    if not isinstance(intended_value, list) or not intended_value:
        raise ValueError('intendedPairs must be a nonempty array')
    intended = _cad_cast("Sequence[tuple[str, str]]", intended_value)
    forbidden = _cad_cast("Sequence[tuple[str, str]]", mate_data.get('forbiddenPairs', []))
    orientations = _cad_cast("JsonObject", mate_data.get('insertionOrientations', {}))
    scope = _cad_cast(str, mate_data.get('checkScope', 'declared-pairs'))

    def can_seat(a: "_FpcConnector", b: "_FpcConnector") -> bool:
        return a['pinCount'] == b['pinCount'] and a['key'] == b['key'] and \
               a['shroud'] == b['shroud'] and a['gender'] != b['gender']

    intended_rows: list[JsonRecord] = []
    intended_ok = True
    for a_name, b_name in intended:
        a, b = connectors[a_name], connectors[b_name]
        ok = can_seat(a, b)
        intended_rows.append({'pair': [a_name, b_name], 'mates': ok,
                              'witnessPose': orientations.get(a_name + '-' + b_name, 'aligned')})
        intended_ok = intended_ok and ok
    forbidden_rows: list[JsonRecord] = []
    hazard = False
    for a_name, b_name in forbidden:
        a, b = connectors[a_name], connectors[b_name]
        seats = can_seat(a, b)
        hazard = hazard or seats
        forbidden_rows.append({'pair': [a_name, b_name], 'canReachSeating': seats,
                               'reason': 'shared key/shroud signature and pin count' if seats else 'poka-yoke key/shroud mismatch'})
    safe = intended_ok and not hazard
    return _fpc_contract(ctx, 'connector.mate-check', {'passed': safe, 'status': 'pass' if safe else 'fail',
        'intended': intended_rows, 'forbidden': forbidden_rows, 'pokaYokeViolation': hazard,
        'checkScope': scope, 'insertionOrientations': orientations}, status='pass' if safe else 'fail')


def pack_cross_section(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('cavity', 'items'), ('reserve', 'samplingBudget', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('cross-section requires schemaVersion 1')
    cavity = _polygon(ctx, data['cavity'])
    items = data['items']
    if not isinstance(items, list) or not items:
        raise ValueError('items must be a nonempty array')
    reserve = float(_cad_cast("int | float | str", data.get('reserve', 0.3)))
    if not 0.0 <= reserve <= 1.0:
        raise ValueError('reserve must be within [0,1]')
    budget = _cad_cast("int | float", data.get('samplingBudget', 200000))
    shape_violations: list[str] = []
    item_areas: list[float] = []
    circles: list[tuple[list[float], float]] = []
    for item_value in items:
        if not isinstance(item_value, dict):
            raise ValueError('items must be objects')
        item = _cad_cast("_FpcPackingItem", item_value)
        if 'radius' in item:
            center = ctx.point(item.get('center', ['0 mm', '0 mm', '0 mm']))
            radius = ctx.length(item['radius'])
            circles.append(([center.x, center.y], radius))
            if not _point_in_polygon([center.x, center.y], cavity):
                shape_violations.append('circle center outside cavity')
            item_areas.append(_fpc_adapter_math.pi * radius * radius)
        else:
            outline = _polygon(ctx, item['outline'])
            for vertex in outline:
                if not _point_in_polygon([vertex[0], vertex[1]], cavity):
                    shape_violations.append('item vertex outside cavity')
            item_areas.append(_polygon_area(outline))
    occupied_union = _circle_union_area(circles, budget) if circles else sum(item_areas)
    cavity_area = _polygon_area(cavity)
    free_area = cavity_area - occupied_union
    reserve_actual = free_area / cavity_area if cavity_area > 0 else 0.0
    fits = not shape_violations and reserve_actual >= reserve
    return _fpc_contract(ctx, 'pack.cross-section', {'passed': fits, 'status': 'pass' if fits else 'fail',
        'occupiedUnionArea': occupied_union, 'freeArea': free_area, 'cavityArea': cavity_area,
        'reserve': {'actual': reserve_actual, 'required': reserve, 'denominator': 'cavity area'},
        'shapeFitViolations': shape_violations, 'areaFitOnly': not shape_violations}, status='pass' if fits else 'fail')


def keepout_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('board', 'keepouts'), ('courtyards', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('keepout.check requires schemaVersion 1')
    board = _cad_cast("_FpcBoard", data['board'])
    outline = _polygon(ctx, board['outline'])
    keepouts_value = data['keepouts']
    if not isinstance(keepouts_value, list):
        raise ValueError('keepouts must be an array')
    keepouts = keepouts_value
    violations: list[str] = []
    rows: list[JsonRecord] = []
    for keepout_value in keepouts:
        if not isinstance(keepout_value, dict) or 'outline' not in keepout_value:
            raise ValueError('keepouts require an outline')
        keepout = _cad_cast("_FpcKeepout", keepout_value)
        poly = _polygon(ctx, keepout['outline'])
        inside = all(_point_in_polygon([v[0], v[1]], outline) for v in poly)
        if not inside:
            violations.append('keepout extends outside board outline')
        rows.append({'name': keepout.get('name'), 'insideBoard': inside,
                     'side': keepout.get('side', 'both')})
    courtyards_value = data.get('courtyards', [])
    if not isinstance(courtyards_value, list):
        raise ValueError('courtyards must be an array')
    courtyards = courtyards_value
    passed = not violations
    return _fpc_contract(ctx, 'keepout.check', {'passed': passed, 'status': 'pass' if passed else 'fail',
        'violations': violations, 'keepouts': rows, 'courtyardCount': len(courtyards)},
        status='pass' if passed else 'fail')


CAD_HANDLERS.update({
    'fpc.fold': fpc_fold, 'fpc.flatten': fpc_flatten,
    'pcb.mechanical-exchange': pcb_mechanical_exchange, 'pcb.check': pcb_check,
    'port.define': port_define, 'connector.mate-check': connector_mate_check,
    'pack.cross-section': pack_cross_section, 'keepout.check': keepout_check,
})
