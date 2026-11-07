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
import math as _optics_adapter_math


if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _OpticsNotRequired

    class _OpticsPointContext(_Protocol):
        def point(self, coordinates: object, /) -> object: ...

    class _OpticsVector(_Protocol):
        @property
        def x(self) -> float: ...

        @property
        def y(self) -> float: ...

        @property
        def z(self) -> float: ...

    class _OpticsPupil(_CadTypedDict):
        origin: JsonValue
        direction: JsonValue
        up: _OpticsNotRequired[JsonValue]

    class _OpticsFov(_CadTypedDict):
        horizontal: JsonValue
        vertical: JsonValue

    class _OpticsRanges(_CadTypedDict):
        near: JsonValue
        far: JsonValue

    class _OpticsSensorSpec(_CadTypedDict):
        pupil: JsonValue
        fov: JsonValue
        name: _OpticsNotRequired[JsonValue]
        ranges: _OpticsNotRequired[JsonValue]

    class _OpticsPupilTarget(_CadTypedDict):
        origin: JsonValue
        normal: JsonValue
        u: JsonValue
        outline: JsonValue
        name: _OpticsNotRequired[JsonValue]

    class _OpticsObstacle(_CadTypedDict):
        shape: JsonValue
        kind: _OpticsNotRequired[JsonValue]
        name: _OpticsNotRequired[JsonValue]
        transmittance: _OpticsNotRequired[JsonValue]

    class _OpticsHit(_CadTypedDict):
        name: JsonValue
        distance: float
        kind: str
        transparent: bool
        transmittance: float

    class _OpticsPolicy(_CadTypedDict, total=False):
        transparentByDefault: JsonValue

    class _OpticsLimits(_CadTypedDict):
        angle: JsonValue
        offset: JsonValue
        gap: _OpticsNotRequired[JsonValue]

    class _OpticsSensorAlignmentSpec(_CadTypedDict):
        origin: JsonValue
        axis: JsonValue


# --- shared vector helpers (cm/rad internal) ---------------------------------------

def _optics_point3(ctx: "_OpticsPointContext", spec: "JsonValue") -> "list[float]":
    p = ctx.point(spec)
    if isinstance(p, (list, tuple)):
        coordinates = _cad_cast("Sequence[JsonValue]", p)
        return [float(_cad_cast("int | float | str | bool", value)) for value in coordinates]
    point = _cad_cast("_OpticsVector", p)
    return [point.x, point.y, point.z]


# --- envelope ---------------------------------------------------------------------

def _optics_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
                     status: str = 'pass') -> "JsonRecord":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged: JsonRecord = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
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


# --- optics.frustum ---------------------------------------------------------------


def optics_frustum(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('pupil', 'fov', 'ranges'), ('window', 'frame', 'schemaVersion'))
    _optics_require_schema(data)
    pupil_value = data['pupil']
    if not isinstance(pupil_value, dict) or 'origin' not in pupil_value or 'direction' not in pupil_value:
        raise ValueError('pupil requires origin and direction')
    pupil = _cad_cast("_OpticsPupil", pupil_value)
    origin = _optics_point3(ctx, pupil['origin'])
    fov_value = data['fov']
    if not isinstance(fov_value, dict) or 'horizontal' not in fov_value or 'vertical' not in fov_value:
        raise ValueError('fov requires horizontal and vertical full angles')
    fov = _cad_cast("_OpticsFov", fov_value)
    half_h = ctx.angle(fov['horizontal']) / 2.0
    half_v = ctx.angle(fov['vertical']) / 2.0
    if not (0 < half_h < _optics_adapter_math.pi / 2) or not (0 < half_v < _optics_adapter_math.pi / 2):
        raise ValueError('half FOV must be within (0, 90 deg)')
    ranges_value = data['ranges']
    if not isinstance(ranges_value, dict) or 'near' not in ranges_value or 'far' not in ranges_value:
        raise ValueError('ranges requires near and far')
    ranges = _cad_cast("_OpticsRanges", ranges_value)
    near = ctx.length(ranges['near'])
    far = ctx.length(ranges['far'])
    if not (0 < near < far):
        raise ValueError('ranges must satisfy 0 < near < far')

    d, h, v = _optics_basis(pupil['direction'], pupil.get('up'))
    corners = {'near': _optics_rect_corners(origin, d, h, v, near, half_h, half_v),
               'far': _optics_rect_corners(origin, d, h, v, far, half_h, half_v)}

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
        limit_h = _optics_adapter_math.atan((width / 2.0) / wdist)
        limit_v = _optics_adapter_math.atan((height / 2.0) / wdist)
        if limit_h < half_h or limit_v < half_v:
            window_limited = True
            effective_h, effective_v = min(half_h, limit_h), min(half_v, limit_v)
            clipped = {'near': _optics_rect_corners(origin, d, h, v, near, effective_h, effective_v),
                       'far': _optics_rect_corners(origin, d, h, v, far, effective_h, effective_v)}

    return _optics_contract(ctx, 'optics.frustum', {
        'axis': d, 'horizontal': h, 'vertical': v,
        'halfAngles': {'horizontal': half_h, 'vertical': half_v},
        'ranges': {'near': near, 'far': far},
        'corners': corners, 'windowLimited': window_limited,
        'effectiveHalfAngles': {'horizontal': effective_h, 'vertical': effective_v},
        'clippedCorners': clipped})


# --- optics.coverage --------------------------------------------------------------

def _optics_sensor_geometry(ctx: "CadContext", spec_value: "JsonValue") -> "JsonRecord":
    if not isinstance(spec_value, dict) or 'pupil' not in spec_value or 'fov' not in spec_value:
        raise ValueError('sensors require pupil and fov')
    spec = _cad_cast("_OpticsSensorSpec", spec_value)
    pupil_value = spec['pupil']
    if not isinstance(pupil_value, dict) or 'origin' not in pupil_value or 'direction' not in pupil_value:
        raise ValueError('sensor pupil requires origin and direction')
    pupil = _cad_cast("_OpticsPupil", pupil_value)
    origin = _optics_point3(ctx, pupil['origin'])
    fov = _cad_cast("_OpticsFov", spec['fov'])
    half_h = ctx.angle(fov['horizontal']) / 2.0
    half_v = ctx.angle(fov['vertical']) / 2.0
    ranges = _cad_cast("JsonObject", spec.get('ranges', {'near': '0 mm', 'far': '1000 mm'}))
    near = ctx.length(ranges.get('near', '0 mm'))
    far = ctx.length(ranges.get('far', '1000 mm'))
    d, h, v = _optics_basis(pupil['direction'], pupil.get('up'))
    return {'name': spec.get('name'), 'origin': origin, 'd': d, 'h': h, 'v': v,
            'tan_h': _optics_adapter_math.tan(half_h), 'tan_v': _optics_adapter_math.tan(half_v), 'near': near, 'far': far}


def optics_coverage(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('sensors', 'targets'), ('samplingBudget', 'frame', 'schemaVersion'))
    _optics_require_schema(data)
    sensor_specs = _cad_cast("Sequence[JsonValue]", data['sensors'])
    sensors: list[JsonRecord] = [_optics_sensor_geometry(ctx, sensor) for sensor in sensor_specs]
    if not sensors:
        raise ValueError('sensors must be a nonempty array')
    targets = data['targets']
    if not isinstance(targets, list) or not targets:
        raise ValueError('targets must be a nonempty array')
    budget_value = data.get('samplingBudget', 100000)
    if type(budget_value) is not int or budget_value < 1:
        raise ValueError('samplingBudget must be a positive integer')
    budget = budget_value

    rows: list[JsonRecord] = []
    for target in targets:
        if not isinstance(target, dict) or 'origin' not in target or 'normal' not in target \
                or 'u' not in target or 'outline' not in target:
            raise ValueError('targets require origin, normal, u and outline')
        target_record = _cad_cast("_OpticsPupilTarget", target)
        origin = _optics_point3(ctx, target_record['origin'])
        normal = _optics_vunit(_cad_direction(target_record['normal']))
        u = _optics_vunit(_cad_direction(target_record['u']))
        if abs(_optics_vdot(u, normal)) > 1 - 1e-9:
            raise ValueError('target u axis must be perpendicular to normal')
        v = _optics_vcross(normal, u)
        outline_values = _cad_cast("Sequence[Sequence[JsonValue]]", target_record['outline'])
        outline = [[ctx.length(point[0]), ctx.length(point[1])] for point in outline_values]
        if len(outline) < 3:
            raise ValueError('target outline requires at least three points')
        area = _optics_poly2_area(outline)

        xs = [p[0] for p in outline]
        ys = [p[1] for p in outline]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        width, height = maxx - minx, maxy - miny
        cells = int(round(_optics_adapter_math.sqrt(budget)))
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
                if not _optics_point2_in_poly([x, y], outline):
                    continue
                inside += 1
                point = _optics_vadd(_optics_vadd(origin, _optics_vscale(u, x)), _optics_vscale(v, y))
                seen = False
                for sensor in sensors:
                    cls = _optics_sensor_classify(sensor, point)
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


def _optics_obstacle_hit(ctx: "CadContext", origin: "Sequence[float]", d: "Sequence[float]",
                         obstacle: "_OpticsObstacle", policy: "_OpticsPolicy") -> "_OpticsHit | None":
    kind = _cad_cast(str, obstacle.get('kind', 'opaque'))
    if kind not in ('opaque', 'baffle', 'window'):
        raise ValueError('obstacle kind must be opaque, baffle or window')
    shape_value = obstacle.get('shape')
    if not isinstance(shape_value, dict) or 'type' not in shape_value:
        raise ValueError('obstacles require a shape with a type')
    shape = shape_value
    if shape['type'] == 'box':
        t = _optics_ray_box(origin, d, _optics_point3(ctx, shape['min']), _optics_point3(ctx, shape['max']))
    elif shape['type'] == 'disk':
        t = _optics_ray_disk(origin, d, _optics_point3(ctx, shape['origin']),
                      _optics_vunit(_cad_direction(shape['normal'])), ctx.length(shape['radius']))
    elif shape['type'] == 'polygon':
        points = _cad_cast("Sequence[Sequence[JsonValue]]", shape['points'])
        t = _optics_ray_polygon(origin, d, _optics_point3(ctx, shape['origin']),
                          _optics_vunit(_cad_direction(shape['normal'])), _optics_vunit(_cad_direction(shape['u'])),
                          [[ctx.length(point[0]), ctx.length(point[1])] for point in points])
    else:
        raise ValueError('obstacle shape type must be box, disk or polygon')
    if t is None:
        return None
    transmittance = obstacle.get('transmittance')
    transparent = kind == 'window' and (transmittance is not None or policy.get('transparentByDefault', False))
    return _cad_cast("_OpticsHit", {'name': obstacle.get('name'), 'distance': t, 'kind': kind,
            'transparent': transparent,
            'transmittance': float(_cad_cast("int | float | str | bool", transmittance)) if transmittance is not None else 1.0})


def optics_occlusion(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('pupil', 'rays'), ('obstacles', 'policy', 'frame', 'schemaVersion'))
    _optics_require_schema(data)
    pupil_value = data['pupil']
    if not isinstance(pupil_value, dict) or 'origin' not in pupil_value:
        raise ValueError('pupil requires origin')
    pupil = pupil_value
    origin = _optics_point3(ctx, pupil['origin'])
    rays = data['rays']
    if not isinstance(rays, list) or not rays:
        raise ValueError('rays must be a nonempty array')
    policy = _cad_cast("_OpticsPolicy", data.get('policy', {}))
    obstacle_values = data.get('obstacles', [])
    if not isinstance(obstacle_values, list):
        raise ValueError('obstacles must be an array')
    obstacles = _cad_cast("list[_OpticsObstacle]", obstacle_values)

    rows: list[JsonRecord] = []
    blocked_count = transparent_count = clear_count = 0
    for index, ray in enumerate(rays):
        if not isinstance(ray, dict) or ('direction' not in ray and 'target' not in ray):
            raise ValueError('rays require a direction or a target point')
        ray_record = ray
        if 'target' in ray_record:
            target_point = _optics_point3(ctx, ray_record['target'])
            to_target = _optics_vsub(target_point, origin)
            max_dist = _optics_vnorm(to_target)
            direction = _optics_vunit(to_target) if max_dist > 0 else [0.0, 0.0, 0.0]
        else:
            direction = _optics_vunit(_cad_direction(ray_record['direction']))
            max_dist = _optics_adapter_math.inf

        nearest: _OpticsHit | None = None
        for obstacle in obstacles:
            hit = _optics_obstacle_hit(ctx, origin, direction, obstacle, policy)
            if hit is None or hit['distance'] > max_dist:
                continue
            if nearest is None or hit['distance'] < nearest['distance']:
                nearest = hit

        if nearest is None:
            result = 'clear'
            clear_count += 1
            row: JsonRecord = {'index': index, 'result': result, 'targetDistance': max_dist if _optics_adapter_math.isfinite(max_dist) else None}
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


def sensor_alignment_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('sensor', 'reference', 'limits'), ('forbiddenZones', 'frame', 'schemaVersion'))
    _optics_require_schema(data)
    sensor_value = data['sensor']
    reference_value = data['reference']
    if not isinstance(sensor_value, dict) or 'origin' not in sensor_value or 'axis' not in sensor_value:
        raise ValueError('sensor requires origin and axis')
    if not isinstance(reference_value, dict) or 'origin' not in reference_value or 'axis' not in reference_value:
        raise ValueError('reference requires origin and axis')
    sensor = _cad_cast("_OpticsSensorAlignmentSpec", sensor_value)
    reference = _cad_cast("_OpticsSensorAlignmentSpec", reference_value)
    s_origin = _optics_point3(ctx, sensor['origin'])
    s_axis = _optics_vunit(_cad_direction(sensor['axis']))
    r_origin = _optics_point3(ctx, reference['origin'])
    r_axis = _optics_vunit(_cad_direction(reference['axis']))

    limits_value = data['limits']
    if not isinstance(limits_value, dict) or 'angle' not in limits_value or 'offset' not in limits_value:
        raise ValueError('limits require angle and offset')
    limits = _cad_cast("_OpticsLimits", limits_value)
    angle_limit = ctx.angle(limits['angle'])
    offset_limit = ctx.length(limits['offset'])
    gap_value = limits.get('gap')
    gap = gap_value if isinstance(gap_value, dict) else {}
    gap_min = ctx.length(gap['min']) if 'min' in gap else None
    gap_max = ctx.length(gap['max']) if 'max' in gap else None

    cos_angle = max(-1.0, min(1.0, _optics_vdot(s_axis, r_axis)))
    angle = _optics_adapter_math.acos(cos_angle)
    lateral = _optics_line_line_distance(s_origin, s_axis, r_origin, r_axis)
    axial_gap = _optics_vdot(_optics_vsub(s_origin, r_origin), r_axis)

    violations: list[str] = []
    if angle > angle_limit:
        violations.append('angle deviation exceeds limit')
    if lateral > offset_limit:
        violations.append('lateral offset exceeds limit')
    if gap_min is not None and axial_gap < gap_min:
        violations.append('axial gap below minimum')
    if gap_max is not None and axial_gap > gap_max:
        violations.append('axial gap above maximum')

    forbidden_value = data.get('forbiddenZones', [])
    if not isinstance(forbidden_value, list):
        raise ValueError('forbiddenZones must be an array')
    forbidden = forbidden_value
    zone_intersections: list[JsonValue] = []
    for zone in forbidden:
        if not isinstance(zone, dict) or zone.get('type') != 'box' or 'min' not in zone or 'max' not in zone:
            raise ValueError('forbiddenZones accept box zones with min and max')
        minv = _optics_point3(ctx, zone['min'])
        maxv = _optics_point3(ctx, zone['max'])
        if _optics_line_box_intersects(s_origin, s_axis, minv, maxv):
            violations.append('sensor axis intersects a forbidden-material zone')
            zone_intersections.append(zone.get('name', 'unnamed'))

    aligned = not violations
    return _optics_contract(ctx, 'sensor.alignment-check', {
        'aligned': aligned, 'angleDeviation': angle, 'angleDeviationDegrees': _optics_adapter_math.degrees(angle),
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


def _optics_basis(direction: "JsonValue", up: "JsonValue | None") -> "tuple[list[float], list[float], list[float]]":
    d = _optics_vunit(_cad_direction(direction))
    u = _optics_vunit(_cad_direction(up)) if up is not None else [0.0, 0.0, 1.0]
    if abs(_optics_vdot(d, u)) > 1.0 - 1e-9:
        u = [1.0, 0.0, 0.0]
        if abs(_optics_vdot(d, u)) > 1.0 - 1e-9:
            u = [0.0, 1.0, 0.0]
    h = _optics_vunit(_optics_vsub(u, _optics_vscale(d, _optics_vdot(d, u))))
    v = _optics_vcross(d, h)
    return d, h, v
