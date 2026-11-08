"""GM20: containment, corridor and control-region occupancy.

The containment classifier uses its own analytic signed-distance method for
boundary tolerance. Native body refs use ``BRepBody.pointContainment`` and the
minimum distance to the copied body's faces; ``TemporaryBRepManager`` only
creates and transforms that temporary copy. Analytic regions (cylinder, ring,
box, sphere, union) are classified locally. The ring keeps its open channel:
the inner cylinder is an exclusion, never filled. Corridor clearance is a
geometric swept-circle check along a centerline, not a CFD claim.
"""
import adsk.core
import adsk.fusion


# --- vector helpers (cm internal) -------------------------------------------------

def _point3(ctx, spec):
    p = ctx.point(spec)
    if isinstance(p, (list, tuple)):
        return [float(v) for v in p]
    return [float(p.x), float(p.y), float(p.z)]


def _vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vnorm(a):
    return math.sqrt(_vdot(a, a))


def _vunit(a):
    n = _vnorm(a)
    if n == 0 or not math.isfinite(n):
        raise ValueError('Direction cannot be zero')
    return [x / n for x in a]


def _vscale(a, s):
    return [x * s for x in a]


def _vadd(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


# --- region descriptors ----------------------------------------------------------

def _region_field(data, key, dimension='length'):
    if key not in data:
        raise ValueError('region %s requires %s' % (data.get('type'), key))
    return data[key]


def _signed_cylinder(origin, direction, radius, height, p):
    """Signed distance to a capped cylinder: positive inside."""
    q = _vsub(p, origin)
    a = _vdot(q, direction)
    radial_vec = _vsub(q, _vscale(direction, a))
    radial = _vnorm(radial_vec)
    if radial <= radius and 0.0 <= a <= height:
        return min(radius - radial, a, height - a)
    d_radial = max(radial - radius, 0.0)
    d_axial = max(-a, a - height, 0.0)
    if radial <= radius:
        return -d_axial
    if 0.0 <= a <= height:
        return -d_radial
    return -math.hypot(d_radial, d_axial)


def _signed_box(minv, maxv, p):
    inside = all(minv[i] <= p[i] <= maxv[i] for i in range(3))
    if inside:
        return min(min(p[i] - minv[i], maxv[i] - p[i]) for i in range(3))
    d = 0.0
    for i in range(3):
        d += (minv[i] - p[i]) ** 2 if p[i] < minv[i] else (p[i] - maxv[i]) ** 2 if p[i] > maxv[i] else 0.0
    return -math.sqrt(d)


def _signed_sphere(center, radius, p):
    return radius - _vnorm(_vsub(p, center))


def _region_signed_distance(ctx, region, p):
    kind = region.get('type')
    if kind == 'cylinder':
        return _signed_cylinder(_point3(ctx, _region_field(region, 'origin')),
                                _cad_direction(region['direction']),
                                ctx.length(_region_field(region, 'radius')),
                                ctx.length(_region_field(region, 'height')), p)
    if kind == 'ring':
        outer = _signed_cylinder(_point3(ctx, _region_field(region, 'origin')),
                                 _cad_direction(region['direction']),
                                 ctx.length(_region_field(region, 'outerRadius')),
                                 ctx.length(_region_field(region, 'height')), p)
        inner = _signed_cylinder(_point3(ctx, _region_field(region, 'origin')),
                                 _cad_direction(region['direction']),
                                 ctx.length(_region_field(region, 'innerRadius')),
                                 ctx.length(_region_field(region, 'height')), p)
        return min(outer, -inner)
    if kind == 'box':
        return _signed_box(_point3(ctx, _region_field(region, 'min')), _point3(ctx, _region_field(region, 'max')), p)
    if kind == 'sphere':
        return _signed_sphere(_point3(ctx, _region_field(region, 'center')),
                              ctx.length(_region_field(region, 'radius')), p)
    if kind == 'union':
        return max(_region_signed_distance(ctx, r, p) for r in region['regions'])
    raise ValueError('Unsupported region type: %s' % (kind,))


def _region_kind(region):
    return region.get('type') if isinstance(region, dict) else 'body'


def _classify(distance, tolerance):
    if not math.isfinite(distance):
        return 'error'
    if distance > tolerance:
        return 'inside'
    if distance < -tolerance:
        return 'outside'
    return 'boundary'


def _parse_point(ctx, spec):
    if isinstance(spec, dict):
        if 'point' in spec:
            spec = spec['point']
        elif 'coordinates' in spec:
            spec = spec['coordinates']
    if not isinstance(spec, (list, tuple)) or len(spec) != 3:
        raise ValueError('Points require three length expressions')
    return [ctx.length(v) for v in spec]


def _contains_contract(ctx, operation, result, status='pass'):
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
                  warnings=[], method='GM20 analytic signed-distance containment; boundary tolerance by own distance field',
                  limitations=['Native BRepBody.pointContainment has no tolerance; native signed distance uses minimum distance to the copied body faces. Unsupported or unknown SDK results remain unknown.',
                               'Corridor clearance is geometric swept-section clearance, not CFD or a routing guarantee.'],
                  provenance={'requirement': 'GM20', 'source': 'docs/CONTAINMENT.md'}, affected=[])
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


def _measure_contains(ctx, data):
    _cad_fields(data, ('region', 'points'), ('boundaryTolerance', 'method', 'samplingBudget', 'frame', 'units', 'schemaVersion'))
    if not isinstance(data['points'], list) or not data['points']:
        raise ValueError('points must be a nonempty array')
    tolerance = ctx.length(data.get('boundaryTolerance', '0.01 mm'))
    if tolerance < 0:
        raise ValueError('boundaryTolerance must be nonnegative')
    method = data.get('method', 'analytic')
    if method not in ('analytic', 'native', 'sampled'):
        raise ValueError('method must be analytic, native or sampled')
    budget = data.get('samplingBudget', 10000)
    if type(budget) is not int or budget < 1:
        raise ValueError('samplingBudget must be a positive integer')
    region = data['region']
    if not isinstance(region, dict) or 'type' not in region:
        raise ValueError('region must be an object with a type')
    if region['type'] == 'body':
        points = [_parse_point(ctx, spec) for spec in data['points']]
        results = _native_contains(ctx, region, points, tolerance)
    else:
        points = [_parse_point(ctx, spec) for spec in data['points']]
        results = []
        for point in points:
            distance = _region_signed_distance(ctx, region, point)
            results.append({'point': point, 'classification': _classify(distance, tolerance),
                            'signedDistance': distance, 'boundaryDistance': abs(distance)})
    counts = {'inside': 0, 'outside': 0, 'boundary': 0, 'error': 0, 'unknown': 0}
    for row in results:
        counts[row['classification']] += 1
    return _contains_contract(ctx, 'measure.contains', {
        'results': results, 'counts': counts, 'boundaryTolerance': tolerance,
        'method': method, 'samplingBudget': budget, 'samplingUsed': len(points),
        'region': region}, status='unknown' if counts['unknown'] or counts['error'] else 'pass')


def _native_contains(ctx, region, points, tolerance):
    def unknown_rows(reason):
        return [{'point': point, 'classification': 'unknown', 'signedDistance': None,
                 'boundaryDistance': None, 'reason': reason} for point in points]

    body = ctx.resolve(region['ref'], 'body')
    native = getattr(body, 'nativeObject', None) or body
    occurrence = getattr(body, 'assemblyContext', None)
    manager_type = getattr(adsk.fusion, 'TemporaryBRepManager', None)
    manager_get = getattr(manager_type, 'get', None)
    if not callable(manager_get):
        return unknown_rows('TemporaryBRepManager.get is unavailable')
    try:
        manager = manager_get()
        target = manager.copy(native) if manager is not None else None
    except Exception as exc:
        return unknown_rows('Temporary BRep copy failed: %s' % exc)
    if target is None:
        return unknown_rows('Temporary BRep copy failed')
    if occurrence is not None:
        transform = getattr(manager, 'transform', None)
        if not callable(transform):
            return unknown_rows('TemporaryBRepManager.transform is unavailable')
        try:
            transformed = transform(target, occurrence.transform2)
        except Exception as exc:
            return unknown_rows('Temporary body transform failed: %s' % exc)
        if not transformed:
            return unknown_rows('Temporary body transform failed')
    try:
        inside_state = adsk.fusion.PointContainment.PointInsidePointContainment
        on_state = adsk.fusion.PointContainment.PointOnPointContainment
        outside_state = adsk.fusion.PointContainment.PointOutsidePointContainment
        unknown_state = adsk.fusion.PointContainment.UnknownPointContainment
    except AttributeError as exc:
        return unknown_rows('PointContainment values are unavailable: %s' % exc)
    results = []
    for point in points:
        try:
            pt = adsk.core.Point3D.create(*point)
        except Exception as exc:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None, 'reason': 'Point3D creation failed: %s' % exc})
            continue
        if pt is None:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None, 'reason': 'Point3D creation returned no point'})
            continue
        try:
            state = _cad_cast(int, target.pointContainment(pt))
        except Exception as exc:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None, 'reason': 'BRepBody.pointContainment failed: %s' % exc})
            continue
        if state == unknown_state:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None,
                            'reason': 'BRepBody.pointContainment returned UnknownPointContainment'})
            continue
        if state == on_state:
            results.append({'point': point, 'classification': 'boundary', 'signedDistance': 0.0,
                            'boundaryDistance': 0.0})
            continue
        if state not in (inside_state, outside_state):
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None,
                            'reason': 'BRepBody.pointContainment returned an unrecognized value'})
            continue
        distance = _native_face_distance(ctx, target, pt)
        if distance is None:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None,
                            'reason': 'Minimum distance to copied BRepBody faces is unavailable'})
            continue
        signed_distance = distance if state == inside_state else -distance
        results.append({'point': point, 'classification': _classify(signed_distance, tolerance),
                        'signedDistance': signed_distance, 'boundaryDistance': distance})
    return results


def _native_face_distance(ctx, body, point):
    faces = getattr(body, 'faces', None)
    measure_manager = getattr(getattr(ctx, 'app', None), 'measureManager', None)
    measure_minimum_distance = getattr(measure_manager, 'measureMinimumDistance', None)
    if faces is None or not callable(measure_minimum_distance):
        return None
    try:
        count = faces.count
        if type(count) is not int or count < 1:
            return None
        distances = []
        for index in range(count):
            face = faces.item(index)
            if face is None:
                return None
            measured = measure_minimum_distance(face, point)
            distance = getattr(measured, 'value', None)
            if not isinstance(distance, (int, float)) or not math.isfinite(distance) or distance < 0:
                return None
            distances.append(float(distance))
        return min(distances)
    except Exception:
        return None


def _polyline_distance(points, p):
    best = None
    for a, b in zip(points, points[1:]):
        ab = _vsub(b, a)
        ap = _vsub(p, a)
        length = _vnorm(ab)
        t = 0.0 if length == 0 else max(0.0, min(1.0, _vdot(ap, ab) / (length * length)))
        closest = _vadd(a, _vscale(ab, t))
        d = _vnorm(_vsub(p, closest))
        if best is None or d < best:
            best = d
    return best if best is not None else _vnorm(_vsub(points[0], p))


def _measure_corridor(ctx, data):
    _cad_fields(data, ('path', 'radius'), ('obstacles', 'sections', 'frame', 'minimumClearance', 'method', 'units', 'schemaVersion'))
    waypoints = data['path']
    if not isinstance(waypoints, list) or len(waypoints) < 2:
        raise ValueError('path requires at least two waypoints')
    radius = ctx.length(data['radius'])
    if radius <= 0:
        raise ValueError('radius must be positive')
    centerline = [_point3(ctx, wp) for wp in waypoints]
    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')
    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    if minimum < 0:
        raise ValueError('minimumClearance must be nonnegative')
    sections = data.get('sections', [])
    if not isinstance(sections, list) or any(not isinstance(s, dict) for s in sections):
        raise ValueError('sections must be an array of station objects')
    arc_lengths = [0.0]
    for a, b in zip(centerline, centerline[1:]):
        arc_lengths.append(arc_lengths[-1] + _vnorm(_vsub(b, a)))
    total = arc_lengths[-1]
    occupancy = []
    for obstacle in obstacles:
        point = _parse_point(ctx, obstacle if isinstance(obstacle, (dict, list)) else {'point': obstacle})
        distance = _polyline_distance(centerline, point)
        clearance = distance - radius
        occupancy.append({'obstacle': point, 'clearance': clearance,
                          'intrudes': clearance < minimum, 'distanceToCenterline': distance})
    station_rows = []
    for section in sections:
        station = ctx.length(section.get('station', '0 mm'))
        if not 0 <= station <= total:
            raise ValueError('section station out of route range')
        position = _point_at_station(centerline, arc_lengths, station)
        station_rows.append({'station': station, 'position': position, 'radius': radius,
                             'clearance': section.get('clearance', '0 mm')})
    return _contains_contract(ctx, 'measure.corridor', {
        'occupancy': occupancy, 'sections': station_rows, 'arcLength': total,
        'radius': radius, 'minimumClearance': minimum,
        'minClearance': min((o['clearance'] for o in occupancy), default=None),
        'intrusions': sum(1 for o in occupancy if o['intrudes']),
        'limits': {'length': total, 'radius': radius}})


def _point_at_station(centerline, arc_lengths, station):
    for i in range(len(centerline) - 1):
        if arc_lengths[i + 1] >= station:
            span = arc_lengths[i + 1] - arc_lengths[i]
            t = 0.0 if span == 0 else (station - arc_lengths[i]) / span
            return _vadd(centerline[i], _vscale(_vsub(centerline[i + 1], centerline[i]), t))
    return centerline[-1]


def _circle_union_area(circles, budget=200000):
    """Deterministic grid estimate of the union area of (center, radius) circles."""
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


def _measure_region(ctx, data):
    _cad_fields(data, ('region', 'occupants'), ('sections', 'limits', 'frame', 'units', 'samplingBudget', 'schemaVersion'))
    region = data['region']
    if not isinstance(region, dict) or 'type' not in region:
        raise ValueError('region must be an object with a type')
    occupants = data['occupants']
    if not isinstance(occupants, list):
        raise ValueError('occupants must be an array')
    budget = data.get('samplingBudget', 200000)
    if type(budget) is not int or budget < 1:
        raise ValueError('samplingBudget must be a positive integer')
    rows = []
    for occupant in occupants:
        if not isinstance(occupant, dict) or 'point' not in occupant:
            raise ValueError('occupants require a point')
        point = _parse_point(ctx, occupant['point'])
        radius = ctx.length(occupant.get('radius', '0 mm'))
        distance = _region_signed_distance(ctx, region, point)
        rows.append({'point': point, 'radius': radius, 'signedDistance': distance,
                     'inside': distance >= -radius, 'classification': _classify(distance, 0.0)})
    inside = [r for r in rows if r['inside']]
    sections = []
    for spec in data.get('sections', []):
        if not isinstance(spec, dict) or 'z' not in spec:
            raise ValueError('sections require a z plane')
        z = ctx.length(spec['z'])
        circles = [(r['point'], r['radius']) for r in inside if abs(r['point'][2] - z) <= r['radius']
                   or (r['radius'] == 0 and abs(r['point'][2] - z) < 1e-9)]
        sections.append({'z': z, 'occupantCount': len(circles),
                         'occupiedUnionArea': _circle_union_area([c for c in circles if c[1] > 0], budget)})
    return _contains_contract(ctx, 'measure.region', {
        'occupancy': rows, 'occupiedCount': len(inside), 'occupantCount': len(rows),
        'sections': sections, 'samplingBudget': budget,
        'limits': data.get('limits')})


CAD_HANDLERS.update({
    'measure.contains': _measure_contains,
    'measure.corridor': _measure_corridor,
    'measure.region': _measure_region,
})
