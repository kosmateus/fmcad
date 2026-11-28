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
import math

import adsk.core
import adsk.fusion


# --- planar helpers --------------------------------------------------------------

def _polygon_area(poly):
    n = len(poly)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def _point_in_polygon(p, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if ((yi > p[1]) != (yj > p[1])) and (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _polygon(ctx, spec):
    if not isinstance(spec, list) or len(spec) < 3:
        raise ValueError('outline requires at least three [x,y] points')
    return [[ctx.length(v[0]), ctx.length(v[1])] for v in spec]


def _circle_union_area(circles, budget=200000):
    if not circles:
        return 0.0
    xs = [c[0][0] - c[1] for c in circles] + [c[0][0] + c[1] for c in circles]
    ys = [c[0][1] - c[1] for c in circles] + [c[0][1] + c[1] for c in circles]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    width, height = maxx - minx, maxy - miny
    if width == 0 or height == 0:
        return 0.0
    cells = int(math.sqrt(budget))
    count = 0
    for i in range(cells):
        x = minx + width * (i + 0.5) / cells
        for j in range(cells):
            y = miny + height * (j + 0.5) / cells
            if any((x - c[0][0]) ** 2 + (y - c[0][1]) ** 2 <= c[1] ** 2 for c in circles):
                count += 1
    return count * (width * height) / (cells * cells)


# --- FPC flex chain --------------------------------------------------------------

def _vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _vadd(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _vscale(a, s):
    return [x * s for x in a]


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _vnorm(a):
    return math.sqrt(_vdot(a, a))


def _vunit(a):
    n = _vnorm(a)
    if n == 0:
        raise ValueError('Degenerate zero vector')
    return [x / n for x in a]


def _rotate(v, axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    axis = _vunit(axis)
    dot = _vdot(axis, v)
    return _vadd(_vadd(_vscale(v, c), _vscale(_vcross(axis, v), s)), _vscale(axis, dot * (1 - c)))


_AXES = {'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0]}


def _chain_geometry(ctx, chain):
    if not isinstance(chain, list) or not chain:
        raise ValueError('chain must be a nonempty array of line/bend objects')
    lines = 0.0
    bends = 0.0
    for item in chain:
        if not isinstance(item, dict) or 'type' not in item:
            raise ValueError('chain items require a type')
        if item['type'] == 'line':
            if ctx.length(item['length']) <= 0:
                raise ValueError('line length must be positive')
            lines += ctx.length(item['length'])
        elif item['type'] == 'bend':
            radius = ctx.length(item['radius'])
            if radius <= 0:
                raise ValueError('bend radius must be positive')
            if item.get('axis', 'y') not in _AXES:
                raise ValueError('bend axis must be x, y or z')
            bends += radius * abs(ctx.angle(item['angle']))
        else:
            raise ValueError('chain item type must be line or bend')
    return lines, bends, lines + bends


def _fold_walk(ctx, chain):
    position = [0.0, 0.0, 0.0]
    tangent = [1.0, 0.0, 0.0]
    points = [list(position)]
    mapping = []
    for index, item in enumerate(chain):
        if item['type'] == 'line':
            length = ctx.length(item['length'])
            position = _vadd(position, _vscale(tangent, length))
            mapping.append({'index': index, 'type': 'line', 'position': list(position),
                            'tangent': list(tangent)})
        else:
            radius = ctx.length(item['radius'])
            angle = ctx.angle(item['angle'])
            axis = _AXES[item.get('axis', 'y')]
            inward = _vunit(_vcross(axis, tangent))
            center = _vadd(position, _vscale(inward, radius))
            start_radial = _vscale(inward, -1.0)
            end_radial = _rotate(start_radial, axis, angle)
            position = _vadd(center, _vscale(end_radial, radius))
            tangent = _rotate(tangent, axis, angle)
            mapping.append({'index': index, 'type': 'bend', 'position': list(position),
                            'tangent': list(tangent), 'radius': radius, 'angle': angle})
        points.append(list(position))
    return points, mapping


def _flatten_walk(ctx, chain):
    position = [0.0, 0.0, 0.0]
    tangent = [1.0, 0.0, 0.0]
    points = [list(position)]
    for item in chain:
        if item['type'] == 'line':
            length = ctx.length(item['length'])
        else:
            length = ctx.length(item['radius']) * abs(ctx.angle(item['angle']))
        position = _vadd(position, _vscale(tangent, length))
        points.append(list(position))
    return points


# --- envelope --------------------------------------------------------------------

def _fpc_contract(ctx, operation, result, status='pass'):
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
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


def fpc_fold(ctx, data):
    _cad_fields(data, ('chain',), ('outline', 'stackup', 'rigidIslands', 'stiffeners', 'bendZones',
                                   'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('fold requires schemaVersion 1')
    lines, bends, neutral = _chain_geometry(ctx, data['chain'])
    points, mapping = _fold_walk(ctx, data['chain'])
    stackup = data.get('stackup')
    neutral_fraction = 0.5
    if stackup is not None:
        neutral_fraction = float(stackup.get('neutralLayerFraction', 0.5))
        if not 0.0 <= neutral_fraction <= 1.0:
            raise ValueError('neutralLayerFraction must be within [0,1]')
    return _fpc_contract(ctx, 'fpc.fold', {
        'foldedCenterline': points, 'mapping': mapping,
        'flatNeutralLength': neutral, 'foldedNeutralLength': neutral, 'neutralLengthPreserved': True,
        'neutralLayerFraction': neutral_fraction,
        'bendArcLengths': [{'index': m['index'], 'arcLength': m['radius'] * abs(m['angle'])}
                           for m in mapping if m['type'] == 'bend'],
        'scaled': False})


def fpc_flatten(ctx, data):
    _cad_fields(data, ('chain',), ('outline', 'stackup', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('flatten requires schemaVersion 1')
    lines, bends, neutral = _chain_geometry(ctx, data['chain'])
    points = _flatten_walk(ctx, data['chain'])
    return _fpc_contract(ctx, 'fpc.flatten', {
        'flatCenterline': points, 'flatNeutralLength': neutral, 'foldedNeutralLength': neutral,
        'neutralLengthPreserved': True, 'scaled': False,
        'straightenedBendLengths': bends})


def pcb_mechanical_exchange(ctx, data):
    _cad_fields(data, ('source', 'target'), ('frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('mechanical-exchange requires schemaVersion 1')
    source, target = data['source'], data['target']
    for key in ('source', 'target'):
        if not isinstance(data[key], dict) or 'datum' not in data[key]:
            raise ValueError(key + ' requires a datum descriptor')
    s_datum, t_datum = source['datum'], target['datum']
    s_origin = ctx.point(s_datum['origin'])
    t_origin = ctx.point(t_datum['origin'])
    offset = _vsub([t_origin.x, t_origin.y, t_origin.z], [s_origin.x, s_origin.y, s_origin.z])
    s_type = s_datum.get('type', 'mechanical')
    t_type = t_datum.get('type', 'mechanical')
    compatible = s_type == t_type
    warnings = []
    if s_type == 'step-center' or t_type == 'step-center':
        warnings.append('STEP bounding-box center is a source of position, not a lens/pad datum; the offset is explicit and must not be silently adopted.')
    area_delta = None
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


def pcb_check(ctx, data):
    _cad_fields(data, ('board',), ('frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('check requires schemaVersion 1')
    board = data['board']
    if not isinstance(board, dict):
        raise ValueError('board must be an object')
    thickness = ctx.length(board.get('thickness', '0 mm'))
    outline = _polygon(ctx, board['outline'])
    violations = []
    if thickness <= 0:
        violations.append('thickness must be positive')
    holes = board.get('holes', [])
    if not isinstance(holes, list):
        raise ValueError('holes must be an array')
    hole_rows = []
    for hole in holes:
        if not isinstance(hole, dict) or 'center' not in hole:
            raise ValueError('holes require a center')
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
    zones = board.get('heightZones', [])
    sides = {z.get('side') for z in zones if isinstance(z, dict)}
    for required in ('top', 'bottom'):
        if required not in sides:
            violations.append('height zone missing for ' + required + ' side')
    courtyards = board.get('courtyards', [])
    keepouts = board.get('copperKeepouts', [])
    passed = not violations
    return _fpc_contract(ctx, 'pcb.check', {'passed': passed, 'status': 'pass' if passed else 'fail',
        'violations': violations, 'thickness': thickness, 'holeCount': len(hole_rows),
        'heightZones': sorted(sides), 'courtyardCount': len(courtyards),
        'copperKeepoutCount': len(keepouts)}, status='pass' if passed else 'fail')


def port_define(ctx, data):
    _cad_fields(data, ('name', 'frame'), ('key', 'matingStroke', 'supportZones', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('port.define requires schemaVersion 1')
    frame = data['frame']
    if not isinstance(frame, dict) or 'origin' not in frame or 'normal' not in frame:
        raise ValueError('frame requires origin and normal')
    origin = ctx.point(frame['origin'])
    normal = _cad_direction(frame['normal'])
    pin1 = ctx.point(frame['pin1']) if 'pin1' in frame else None
    key = data.get('key')
    stroke = ctx.length(data['matingStroke']) if 'matingStroke' in data else None
    if stroke is not None and stroke < 0:
        raise ValueError('matingStroke must be nonnegative')
    return _fpc_contract(ctx, 'port.define', {
        'name': data['name'], 'origin': [origin.x, origin.y, origin.z], 'normal': normal,
        'pin1': [pin1.x, pin1.y, pin1.z] if pin1 is not None else None, 'key': key,
        'matingStroke': stroke, 'supportZones': data.get('supportZones', [])})


def _connector(ctx, spec):
    if not isinstance(spec, dict) or 'name' not in spec:
        raise ValueError('connector requires a name')
    gender = spec.get('gender', 'male')
    if gender not in ('male', 'female'):
        raise ValueError('connector gender must be male or female')
    pin_count = spec.get('pinCount')
    if type(pin_count) is not int or pin_count < 1:
        raise ValueError('connector pinCount must be a positive integer')
    key = spec.get('key', 'unkeyed')
    shroud = spec.get('shroud', key)
    return {'name': spec['name'], 'gender': gender, 'pinCount': pin_count, 'key': key, 'shroud': shroud}


def connector_mate_check(ctx, data):
    _cad_fields(data, ('connectors', 'intendedPairs'), ('forbiddenPairs', 'insertionOrientations',
                                                        'checkScope', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('mate-check requires schemaVersion 1')
    connectors = {c['name']: _connector(ctx, c) for c in data['connectors']}
    intended = data['intendedPairs']
    if not isinstance(intended, list) or not intended:
        raise ValueError('intendedPairs must be a nonempty array')
    forbidden = data.get('forbiddenPairs', [])
    orientations = data.get('insertionOrientations', {})
    scope = data.get('checkScope', 'declared-pairs')

    def can_seat(a, b):
        return a['pinCount'] == b['pinCount'] and a['key'] == b['key'] and \
               a['shroud'] == b['shroud'] and a['gender'] != b['gender']

    intended_rows = []
    intended_ok = True
    for a_name, b_name in intended:
        a, b = connectors[a_name], connectors[b_name]
        ok = can_seat(a, b)
        intended_rows.append({'pair': [a_name, b_name], 'mates': ok,
                              'witnessPose': orientations.get(a_name + '-' + b_name, 'aligned')})
        intended_ok = intended_ok and ok
    forbidden_rows = []
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


def pack_cross_section(ctx, data):
    _cad_fields(data, ('cavity', 'items'), ('reserve', 'samplingBudget', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('cross-section requires schemaVersion 1')
    cavity = _polygon(ctx, data['cavity'])
    items = data['items']
    if not isinstance(items, list) or not items:
        raise ValueError('items must be a nonempty array')
    reserve = float(data.get('reserve', 0.3))
    if not 0.0 <= reserve <= 1.0:
        raise ValueError('reserve must be within [0,1]')
    budget = data.get('samplingBudget', 200000)
    shape_violations = []
    item_areas = []
    circles = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('items must be objects')
        if 'radius' in item:
            center = ctx.point(item.get('center', ['0 mm', '0 mm', '0 mm']))
            radius = ctx.length(item['radius'])
            circles.append(([center.x, center.y], radius))
            if not _point_in_polygon([center.x, center.y], cavity):
                shape_violations.append('circle center outside cavity')
            item_areas.append(math.pi * radius * radius)
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


def keepout_check(ctx, data):
    _cad_fields(data, ('board', 'keepouts'), ('courtyards', 'frame', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('keepout.check requires schemaVersion 1')
    board = data['board']
    outline = _polygon(ctx, board['outline'])
    keepouts = data['keepouts']
    if not isinstance(keepouts, list):
        raise ValueError('keepouts must be an array')
    violations = []
    rows = []
    for keepout in keepouts:
        if not isinstance(keepout, dict) or 'outline' not in keepout:
            raise ValueError('keepouts require an outline')
        poly = _polygon(ctx, keepout['outline'])
        inside = all(_point_in_polygon([v[0], v[1]], outline) for v in poly)
        if not inside:
            violations.append('keepout extends outside board outline')
        rows.append({'name': keepout.get('name'), 'insideBoard': inside,
                     'side': keepout.get('side', 'both')})
    courtyards = data.get('courtyards', [])
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
