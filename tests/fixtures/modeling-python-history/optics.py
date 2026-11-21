"""GM28: geometric optics (frusta, coverage, occlusion) and sensor alignment.

``optics.frustum`` builds a rectangular pyramidal frustum from an optical
pupil/datum, full HFOV/VFOV, roll and near/far ranges, and clips it against a
declared window/aperture (a window edge limits the cone). ``optics.coverage``
computes the *geometric union* of several sensor frusta over a planar target, so
the sum of FOV angles is never mistaken for absence of a dead zone; near-field
gaps are reported separately. ``optics.occlusion`` traces rays against opaque
obstacles, transparent windows (only when a transparency policy declares them)
and line-of-sight baffles. ``sensor.alignment-check`` compares a sensor axis to
a reference axis with gap/offset/angle limits and forbidden-material zones. No
AI, focus, flare, RF or magnetic-field claim is made anywhere.
"""
import math

import adsk.core
import adsk.fusion


# --- shared vector helpers (cm/rad internal) ---------------------------------------

def _point3(ctx, spec):
    p = ctx.point(spec)
    if isinstance(p, (list, tuple)):
        return [float(v) for v in p]
    return [float(p.x), float(p.y), float(p.z)]


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
    if n == 0 or not math.isfinite(n):
        raise ValueError('Direction cannot be zero or non-finite')
    return [x / n for x in a]


def _point2_in_poly(p, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > p[1]) != (yj > p[1])) and (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _poly2_area(poly):
    n = len(poly)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


# --- envelope ---------------------------------------------------------------------

def _optics_contract(ctx, operation, result, status='pass'):
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
                  warnings=[], method='GM28 local geometric-optics recipe',
                  limitations=['The sum of FOV angles is not evidence of no dead zone; coverage is a geometric union over the target.',
                               'A surface that is transparent in a render has no physical optical property unless a transparency policy declares it.',
                               'No AI, focus, flare, RF or magnetic-field result is computed or claimed.'],
                  provenance={'requirement': 'GM28', 'source': 'docs/OPTICS.md'}, affected=[])
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


def _require_schema(data):
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('schemaVersion 1 is required')
    return 1


# --- optics.frustum ---------------------------------------------------------------

def _basis(direction, up):
    d = _vunit(_cad_direction(direction))
    u = _vunit(_cad_direction(up)) if up is not None else [0.0, 0.0, 1.0]
    if abs(_vdot(d, u)) > 1.0 - 1e-9:
        u = [1.0, 0.0, 0.0]
        if abs(_vdot(d, u)) > 1.0 - 1e-9:
            u = [0.0, 1.0, 0.0]
    h = _vunit(_vsub(u, _vscale(d, _vdot(d, u))))
    v = _vcross(d, h)
    return d, h, v


def _rect_corners(origin, d, h, v, dist, half_h, half_v):
    w = dist * math.tan(half_h)
    ht = dist * math.tan(half_v)
    center = _vadd(origin, _vscale(d, dist))
    return [
        _vadd(_vadd(center, _vscale(h, -w)), _vscale(v, -ht)),
        _vadd(_vadd(center, _vscale(h, w)), _vscale(v, -ht)),
        _vadd(_vadd(center, _vscale(h, w)), _vscale(v, ht)),
        _vadd(_vadd(center, _vscale(h, -w)), _vscale(v, ht)),
    ]


def optics_frustum(ctx, data):
    _cad_fields(data, ('pupil', 'fov', 'ranges'), ('window', 'frame', 'schemaVersion'))
    _require_schema(data)
    pupil = data['pupil']
    if not isinstance(pupil, dict) or 'origin' not in pupil or 'direction' not in pupil:
        raise ValueError('pupil requires origin and direction')
    origin = _point3(ctx, pupil['origin'])
    fov = data['fov']
    if not isinstance(fov, dict) or 'horizontal' not in fov or 'vertical' not in fov:
        raise ValueError('fov requires horizontal and vertical full angles')
    half_h = ctx.angle(fov['horizontal']) / 2.0
    half_v = ctx.angle(fov['vertical']) / 2.0
    if not (0 < half_h < math.pi / 2) or not (0 < half_v < math.pi / 2):
        raise ValueError('half FOV must be within (0, 90 deg)')
    ranges = data['ranges']
    if not isinstance(ranges, dict) or 'near' not in ranges or 'far' not in ranges:
        raise ValueError('ranges requires near and far')
    near = ctx.length(ranges['near'])
    far = ctx.length(ranges['far'])
    if not (0 < near < far):
        raise ValueError('ranges must satisfy 0 < near < far')

    d, h, v = _basis(pupil['direction'], pupil.get('up'))
    corners = {'near': _rect_corners(origin, d, h, v, near, half_h, half_v),
               'far': _rect_corners(origin, d, h, v, far, half_h, half_v)}

    window = data.get('window')
    window_limited = False
    effective_h, effective_v = half_h, half_v
    clipped = corners
    if window is not None:
        if not isinstance(window, dict) or 'distance' not in window or 'width' not in window or 'height' not in window:
            raise ValueError('window requires distance, width and height')
        wdist = ctx.length(window['distance'])
        width = ctx.length(window['width'])
        height = ctx.length(window['height'])
        if wdist <= 0 or width <= 0 or height <= 0:
            raise ValueError('window distance, width and height must be positive')
        limit_h = math.atan((width / 2.0) / wdist)
        limit_v = math.atan((height / 2.0) / wdist)
        if limit_h < half_h or limit_v < half_v:
            window_limited = True
            effective_h, effective_v = min(half_h, limit_h), min(half_v, limit_v)
            clipped = {'near': _rect_corners(origin, d, h, v, near, effective_h, effective_v),
                       'far': _rect_corners(origin, d, h, v, far, effective_h, effective_v)}

    return _optics_contract(ctx, 'optics.frustum', {
        'axis': d, 'horizontal': h, 'vertical': v,
        'halfAngles': {'horizontal': half_h, 'vertical': half_v},
        'ranges': {'near': near, 'far': far},
        'corners': corners, 'windowLimited': window_limited,
        'effectiveHalfAngles': {'horizontal': effective_h, 'vertical': effective_v},
        'clippedCorners': clipped})


# --- optics.coverage --------------------------------------------------------------

def _sensor_geometry(ctx, spec):
    if not isinstance(spec, dict) or 'pupil' not in spec or 'fov' not in spec:
        raise ValueError('sensors require pupil and fov')
    pupil = spec['pupil']
    if not isinstance(pupil, dict) or 'origin' not in pupil or 'direction' not in pupil:
        raise ValueError('sensor pupil requires origin and direction')
    origin = _point3(ctx, pupil['origin'])
    fov = spec['fov']
    half_h = ctx.angle(fov['horizontal']) / 2.0
    half_v = ctx.angle(fov['vertical']) / 2.0
    ranges = spec.get('ranges', {'near': '0 mm', 'far': '1000 mm'})
    near = ctx.length(ranges.get('near', '0 mm'))
    far = ctx.length(ranges.get('far', '1000 mm'))
    d, h, v = _basis(pupil['direction'], pupil.get('up'))
    return {'name': spec.get('name'), 'origin': origin, 'd': d, 'h': h, 'v': v,
            'tan_h': math.tan(half_h), 'tan_v': math.tan(half_v), 'near': near, 'far': far}


def _sensor_classify(sensor, point):
    w = _vsub(point, sensor['origin'])
    dist = _vnorm(w)
    if dist < 1e-12:
        return 'outside'
    wd = _vdot(w, sensor['d'])
    if wd <= 0:
        return 'outside'
    if abs(_vdot(w, sensor['h'])) / wd > sensor['tan_h']:
        return 'outside'
    if abs(_vdot(w, sensor['v'])) / wd > sensor['tan_v']:
        return 'outside'
    if dist < sensor['near']:
        return 'near'
    if dist > sensor['far']:
        return 'far'
    return 'covered'


def optics_coverage(ctx, data):
    _cad_fields(data, ('sensors', 'targets'), ('samplingBudget', 'frame', 'schemaVersion'))
    _require_schema(data)
    sensors = [_sensor_geometry(ctx, s) for s in data['sensors']]
    if not sensors:
        raise ValueError('sensors must be a nonempty array')
    targets = data['targets']
    if not isinstance(targets, list) or not targets:
        raise ValueError('targets must be a nonempty array')
    budget = data.get('samplingBudget', 100000)
    if type(budget) is not int or budget < 1:
        raise ValueError('samplingBudget must be a positive integer')

    rows = []
    for target in targets:
        if not isinstance(target, dict) or 'origin' not in target or 'normal' not in target \
                or 'u' not in target or 'outline' not in target:
            raise ValueError('targets require origin, normal, u and outline')
        origin = _point3(ctx, target['origin'])
        normal = _vunit(_cad_direction(target['normal']))
        u = _vunit(_cad_direction(target['u']))
        if abs(_vdot(u, normal)) > 1 - 1e-9:
            raise ValueError('target u axis must be perpendicular to normal')
        v = _vcross(normal, u)
        outline = [[ctx.length(p[0]), ctx.length(p[1])] for p in target['outline']]
        if len(outline) < 3:
            raise ValueError('target outline requires at least three points')
        area = _poly2_area(outline)

        xs = [p[0] for p in outline]
        ys = [p[1] for p in outline]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        width, height = maxx - minx, maxy - miny
        cells = int(round(math.sqrt(budget)))
        if cells < 2:
            cells = 2

        inside = 0
        covered = 0
        sum_count = 0
        near_count = 0
        far_count = 0
        for i in range(cells):
            x = minx + width * (i + 0.5) / cells
            for j in range(cells):
                y = miny + height * (j + 0.5) / cells
                if not _point2_in_poly([x, y], outline):
                    continue
                inside += 1
                point = _vadd(_vadd(origin, _vscale(u, x)), _vscale(v, y))
                seen = False
                for sensor in sensors:
                    cls = _sensor_classify(sensor, point)
                    if cls == 'covered':
                        sum_count += 1
                        seen = True
                    elif cls == 'near':
                        near_count += 1
                    elif cls == 'far':
                        far_count += 1
                if seen:
                    covered += 1

        frac = (covered / inside) if inside else 0.0
        sum_frac = (sum_count / inside) if inside else 0.0
        rows.append({'name': target.get('name'), 'outlineArea': area,
                     'unionCoveredArea': frac * area, 'sumIndividualArea': sum_frac * area,
                     'coveredFraction': frac, 'deadZoneFraction': 1.0 - frac,
                     'nearFieldGapFraction': (near_count / inside) if inside else 0.0,
                     'farFieldGapFraction': (far_count / inside) if inside else 0.0,
                     'sensorCount': len(sensors), 'samples': inside})

    return _optics_contract(ctx, 'optics.coverage', {'targets': rows, 'samplingBudget': budget})


# --- optics.occlusion -------------------------------------------------------------

def _ray_box(origin, d, minv, maxv):
    tmin, tmax = -math.inf, math.inf
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if origin[i] < minv[i] or origin[i] > maxv[i]:
                return None
            continue
        inv = 1.0 / d[i]
        t1 = (minv[i] - origin[i]) * inv
        t2 = (maxv[i] - origin[i]) * inv
        if t1 > t2:
            t1, t2 = t2, t1
        tmin = max(tmin, t1)
        tmax = min(tmax, t2)
    if tmax < 0:
        return None
    entry = tmin if tmin > 0 else 0.0
    return entry if entry <= tmax else None


def _ray_disk(origin, d, center, normal, radius):
    denom = _vdot(d, normal)
    if abs(denom) < 1e-12:
        return None
    t = _vdot(_vsub(center, origin), normal) / denom
    if t <= 1e-12:
        return None
    hit = _vadd(origin, _vscale(d, t))
    return t if _vnorm(_vsub(hit, center)) <= radius else None


def _ray_polygon(origin, d, poly_origin, normal, u, points2):
    denom = _vdot(d, normal)
    if abs(denom) < 1e-12:
        return None
    t = _vdot(_vsub(poly_origin, origin), normal) / denom
    if t <= 1e-12:
        return None
    hit = _vadd(origin, _vscale(d, t))
    v = _vcross(normal, u)
    rel = _vsub(hit, poly_origin)
    return t if _point2_in_poly([_vdot(rel, u), _vdot(rel, v)], points2) else None


def _obstacle_hit(ctx, origin, d, obstacle, policy):
    kind = obstacle.get('kind', 'opaque')
    if kind not in ('opaque', 'baffle', 'window'):
        raise ValueError('obstacle kind must be opaque, baffle or window')
    shape = obstacle.get('shape')
    if not isinstance(shape, dict) or 'type' not in shape:
        raise ValueError('obstacles require a shape with a type')
    if shape['type'] == 'box':
        t = _ray_box(origin, d, _point3(ctx, shape['min']), _point3(ctx, shape['max']))
    elif shape['type'] == 'disk':
        t = _ray_disk(origin, d, _point3(ctx, shape['origin']),
                      _vunit(_cad_direction(shape['normal'])), ctx.length(shape['radius']))
    elif shape['type'] == 'polygon':
        t = _ray_polygon(origin, d, _point3(ctx, shape['origin']),
                         _vunit(_cad_direction(shape['normal'])), _vunit(_cad_direction(shape['u'])),
                         [[ctx.length(p[0]), ctx.length(p[1])] for p in shape['points']])
    else:
        raise ValueError('obstacle shape type must be box, disk or polygon')
    if t is None:
        return None
    transmittance = obstacle.get('transmittance')
    transparent = kind == 'window' and (transmittance is not None or policy.get('transparentByDefault', False))
    return {'name': obstacle.get('name'), 'distance': t, 'kind': kind,
            'transparent': transparent,
            'transmittance': float(transmittance) if transmittance is not None else 1.0}


def optics_occlusion(ctx, data):
    _cad_fields(data, ('pupil', 'rays'), ('obstacles', 'policy', 'frame', 'schemaVersion'))
    _require_schema(data)
    pupil = data['pupil']
    if not isinstance(pupil, dict) or 'origin' not in pupil:
        raise ValueError('pupil requires origin')
    origin = _point3(ctx, pupil['origin'])
    rays = data['rays']
    if not isinstance(rays, list) or not rays:
        raise ValueError('rays must be a nonempty array')
    policy = data.get('policy', {})
    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')

    rows = []
    blocked_count = transparent_count = clear_count = 0
    for index, ray in enumerate(rays):
        if not isinstance(ray, dict) or ('direction' not in ray and 'target' not in ray):
            raise ValueError('rays require a direction or a target point')
        if 'target' in ray:
            target_point = _point3(ctx, ray['target'])
            to_target = _vsub(target_point, origin)
            max_dist = _vnorm(to_target)
            direction = _vunit(to_target) if max_dist > 0 else [0.0, 0.0, 0.0]
        else:
            direction = _vunit(_cad_direction(ray['direction']))
            max_dist = math.inf

        nearest = None
        for obstacle in obstacles:
            hit = _obstacle_hit(ctx, origin, direction, obstacle, policy)
            if hit is None or hit['distance'] > max_dist:
                continue
            if nearest is None or hit['distance'] < nearest['distance']:
                nearest = hit

        if nearest is None:
            result = 'clear'
            clear_count += 1
            row = {'index': index, 'result': result, 'targetDistance': max_dist if math.isfinite(max_dist) else None}
        elif nearest['transparent']:
            result = 'window'
            transparent_count += 1
            row = {'index': index, 'result': result, 'obstacleName': nearest['name'],
                   'transmittance': nearest['transmittance'], 'hitDistance': nearest['distance']}
        else:
            result = 'blocked'
            blocked_count += 1
            row = {'index': index, 'result': result, 'obstacleName': nearest['name'],
                   'hitDistance': nearest['distance']}
        rows.append(row)

    return _optics_contract(ctx, 'optics.occlusion', {
        'rays': rows, 'blockedCount': blocked_count, 'transparentCount': transparent_count,
        'clearCount': clear_count, 'transparentByDefault': bool(policy.get('transparentByDefault', False))})


# --- sensor.alignment-check -------------------------------------------------------

def _line_line_distance(p1, d1, p2, d2):
    a = _vdot(d1, d1)
    b = _vdot(d1, d2)
    c = _vdot(d2, d2)
    w0 = _vsub(p1, p2)
    dd = _vdot(d1, w0)
    ee = _vdot(d2, w0)
    denom = a * c - b * b
    if abs(denom) < 1e-12:
        return _vnorm(_vcross(d1, _vsub(p2, p1)))
    s = (b * ee - c * dd) / denom
    t = (a * ee - b * dd) / denom
    return _vnorm(_vsub(_vadd(p1, _vscale(d1, s)), _vadd(p2, _vscale(d2, t))))


def _line_box_intersects(origin, d, minv, maxv):
    tmin, tmax = 0.0, math.inf
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if origin[i] < minv[i] or origin[i] > maxv[i]:
                return False
            continue
        inv = 1.0 / d[i]
        t1 = (minv[i] - origin[i]) * inv
        t2 = (maxv[i] - origin[i]) * inv
        if t1 > t2:
            t1, t2 = t2, t1
        tmin = max(tmin, t1)
        tmax = min(tmax, t2)
        if tmin > tmax:
            return False
    return True


def sensor_alignment_check(ctx, data):
    _cad_fields(data, ('sensor', 'reference', 'limits'), ('forbiddenZones', 'frame', 'schemaVersion'))
    _require_schema(data)
    sensor = data['sensor']
    reference = data['reference']
    if not isinstance(sensor, dict) or 'origin' not in sensor or 'axis' not in sensor:
        raise ValueError('sensor requires origin and axis')
    if not isinstance(reference, dict) or 'origin' not in reference or 'axis' not in reference:
        raise ValueError('reference requires origin and axis')
    s_origin = _point3(ctx, sensor['origin'])
    s_axis = _vunit(_cad_direction(sensor['axis']))
    r_origin = _point3(ctx, reference['origin'])
    r_axis = _vunit(_cad_direction(reference['axis']))

    limits = data['limits']
    if not isinstance(limits, dict) or 'angle' not in limits or 'offset' not in limits:
        raise ValueError('limits require angle and offset')
    angle_limit = ctx.angle(limits['angle'])
    offset_limit = ctx.length(limits['offset'])
    gap = limits.get('gap')
    gap_min = ctx.length(gap['min']) if isinstance(gap, dict) and 'min' in gap else None
    gap_max = ctx.length(gap['max']) if isinstance(gap, dict) and 'max' in gap else None

    cos_angle = max(-1.0, min(1.0, _vdot(s_axis, r_axis)))
    angle = math.acos(cos_angle)
    lateral = _line_line_distance(s_origin, s_axis, r_origin, r_axis)
    axial_gap = _vdot(_vsub(s_origin, r_origin), r_axis)

    violations = []
    if angle > angle_limit:
        violations.append('angle deviation exceeds limit')
    if lateral > offset_limit:
        violations.append('lateral offset exceeds limit')
    if gap_min is not None and axial_gap < gap_min:
        violations.append('axial gap below minimum')
    if gap_max is not None and axial_gap > gap_max:
        violations.append('axial gap above maximum')

    forbidden = data.get('forbiddenZones', [])
    if not isinstance(forbidden, list):
        raise ValueError('forbiddenZones must be an array')
    zone_intersections = []
    for zone in forbidden:
        if not isinstance(zone, dict) or zone.get('type') != 'box' or 'min' not in zone or 'max' not in zone:
            raise ValueError('forbiddenZones accept box zones with min and max')
        minv = _point3(ctx, zone['min'])
        maxv = _point3(ctx, zone['max'])
        if _line_box_intersects(s_origin, s_axis, minv, maxv):
            violations.append('sensor axis intersects a forbidden-material zone')
            zone_intersections.append(zone.get('name', 'unnamed'))

    aligned = not violations
    return _optics_contract(ctx, 'sensor.alignment-check', {
        'aligned': aligned, 'angleDeviation': angle, 'angleDeviationDegrees': math.degrees(angle),
        'lateralOffset': lateral, 'axialGap': axial_gap,
        'limits': {'angle': angle_limit, 'offset': offset_limit,
                   'gap': {'min': gap_min, 'max': gap_max}},
        'violations': violations, 'forbiddenZoneIntersections': zone_intersections},
        status='pass' if aligned else 'fail')


CAD_HANDLERS.update({
    'optics.frustum': optics_frustum,
    'optics.coverage': optics_coverage,
    'optics.occlusion': optics_occlusion,
    'sensor.alignment-check': sensor_alignment_check,
})
