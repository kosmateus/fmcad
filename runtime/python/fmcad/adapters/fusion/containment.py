"""GM20: containment, corridor and control-region occupancy.

The containment classifier uses its own analytic signed-distance method for
boundary tolerance. Native body refs use ``BRepBody.pointContainment`` and the
minimum distance to the copied body's faces; ``TemporaryBRepManager`` only
creates and transforms that temporary copy. Unsupported or unknown SDK results
remain unknown. Analytic regions (cylinder, ring, box, sphere, union) are
classified locally. The ring keeps its open channel: the inner cylinder is an
exclusion, never filled. Corridor clearance is a geometric swept-circle check
along a centerline, not a CFD claim.
"""
# --- vector helpers (cm internal) -------------------------------------------------

if '_Protocol' in globals():
    class _ContainmentPoint(_Protocol):
        @property
        def x(self) -> float: ...
        @property
        def y(self) -> float: ...
        @property
        def z(self) -> float: ...


def _containment_point3(ctx: "CadContext", spec: "JsonValue") -> "list[float]":
    p: object = ctx.point(spec)
    if isinstance(p, (list, tuple)):
        return [float(v) for v in _cad_cast("Sequence[str | int | float]", p)]
    return [float(_cad_cast("_ContainmentPoint", p).x),
            float(_cad_cast("_ContainmentPoint", p).y),
            float(_cad_cast("_ContainmentPoint", p).z)]


# --- region descriptors ----------------------------------------------------------


def _region_signed_distance(ctx: "CadContext", region: "JsonObject", p: "Sequence[float]") -> float:
    kind = region.get('type')
    if kind == 'cylinder':
        return _signed_cylinder(_containment_point3(ctx, _region_field(region, 'origin')),
                                _cad_direction(region['direction']),
                                ctx.length(_region_field(region, 'radius')),
                                ctx.length(_region_field(region, 'height')), p)
    if kind == 'ring':
        outer = _signed_cylinder(_containment_point3(ctx, _region_field(region, 'origin')),
                                 _cad_direction(region['direction']),
                                 ctx.length(_region_field(region, 'outerRadius')),
                                 ctx.length(_region_field(region, 'height')), p)
        inner = _signed_cylinder(_containment_point3(ctx, _region_field(region, 'origin')),
                                 _cad_direction(region['direction']),
                                 ctx.length(_region_field(region, 'innerRadius')),
                                 ctx.length(_region_field(region, 'height')), p)
        return min(outer, -inner)
    if kind == 'box':
        return _signed_box(_containment_point3(ctx, _region_field(region, 'min')), _containment_point3(ctx, _region_field(region, 'max')), p)
    if kind == 'sphere':
        return _signed_sphere(_containment_point3(ctx, _region_field(region, 'center')),
                              ctx.length(_region_field(region, 'radius')), p)
    if kind == 'union':
        return max(_region_signed_distance(ctx, _cad_cast("JsonObject", r), p)
                   for r in _cad_cast("list[JsonValue]", region['regions']))
    raise ValueError('Unsupported region type: %s' % (kind,))


def _parse_point(ctx: "CadContext", spec: "JsonValue") -> "list[float]":
    if isinstance(spec, dict):
        if 'point' in spec:
            spec = spec['point']
        elif 'coordinates' in spec:
            spec = spec['coordinates']
    if not isinstance(spec, (list, tuple)) or len(spec) != 3:
        raise ValueError('Points require three length expressions')
    return [ctx.length(v) for v in _cad_cast("Sequence[JsonValue]", spec)]


def _contains_contract(ctx: "CadContext", operation: str, result: "JsonObject", status: str = 'pass') -> "JsonObject":
    identity: JsonValue = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component: JsonValue = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged: JsonObject = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
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


def _measure_contains(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('region', 'points'), ('boundaryTolerance', 'method', 'samplingBudget', 'frame', 'units', 'schemaVersion'))
    if not isinstance(data['points'], list) or not data['points']:
        raise ValueError('points must be a nonempty array')
    tolerance = ctx.length(data.get('boundaryTolerance', '0.01 mm'))
    if tolerance < 0:
        raise ValueError('boundaryTolerance must be nonnegative')
    method = _cad_cast(str, data.get('method', 'analytic'))
    if method not in ('analytic', 'native', 'sampled'):
        raise ValueError('method must be analytic, native or sampled')
    budget = data.get('samplingBudget', 10000)
    if type(budget) is not int or budget < 1:
        raise ValueError('samplingBudget must be a positive integer')
    region = data['region']
    if not isinstance(region, dict) or 'type' not in region:
        raise ValueError('region must be an object with a type')
    points: list[list[float]]
    if region['type'] == 'body':
        points = [_parse_point(ctx, spec) for spec in data['points']]
        results = _native_contains(ctx, region, points, tolerance)
    else:
        points = [_parse_point(ctx, spec) for spec in data['points']]
        results: list[JsonObject] = []
        for point in points:
            distance = _region_signed_distance(ctx, region, point)
            results.append({'point': point, 'classification': _classify(distance, tolerance),
                            'signedDistance': distance, 'boundaryDistance': abs(distance)})
    counts: dict[str, int] = {'inside': 0, 'outside': 0, 'boundary': 0, 'error': 0, 'unknown': 0}
    for row in results:
        counts[_cad_cast(str, row['classification'])] += 1
    return _contains_contract(ctx, 'measure.contains', {
        'results': results, 'counts': counts, 'boundaryTolerance': tolerance,
        'method': method, 'samplingBudget': budget, 'samplingUsed': len(points),
        'region': region}, status='unknown' if counts['unknown'] or counts['error'] else 'pass')


def _native_contains(ctx: "CadContext", region: "JsonObject", points: "Sequence[Sequence[float]]", tolerance: float) -> "list[JsonObject]":
    def unknown_rows(reason: str) -> "list[JsonObject]":
        return [{'point': point, 'classification': 'unknown', 'signedDistance': None,
                 'boundaryDistance': None, 'reason': reason} for point in points]

    body = ctx.resolve(region['ref'], 'body')
    native = body.nativeObject or body
    occurrence = _cad_cast("adsk.fusion.Occurrence | None", body.assemblyContext)
    try:
        manager = adsk.fusion.TemporaryBRepManager.get()
        target = _cad_cast("adsk.fusion.BRepBody | None", manager.copy(native))
    except Exception as exc:
        return unknown_rows('Temporary BRep copy failed: %s' % exc)
    if target is None:
        return unknown_rows('Temporary BRep copy failed')
    if occurrence is not None:
        try:
            transformed = manager.transform(target, occurrence.transform2)
        except Exception as exc:
            return unknown_rows('Temporary body transform failed: %s' % exc)
        if not transformed:
            return unknown_rows('Temporary body transform failed')
    try:
        inside_state = _cad_cast(
            "adsk.fusion.PointContainment", adsk.fusion.PointContainment.PointInsidePointContainment)
        on_state = _cad_cast(
            "adsk.fusion.PointContainment", adsk.fusion.PointContainment.PointOnPointContainment)
        outside_state = _cad_cast(
            "adsk.fusion.PointContainment", adsk.fusion.PointContainment.PointOutsidePointContainment)
        unknown_state = _cad_cast(
            "adsk.fusion.PointContainment", adsk.fusion.PointContainment.UnknownPointContainment)
    except AttributeError as exc:
        return unknown_rows('PointContainment values are unavailable: %s' % exc)
    results: list[JsonObject] = []
    for point in points:
        try:
            pt = _cad_require_result(adsk.core.Point3D.create(*point), 'Create containment point')
        except Exception as exc:
            results.append({'point': point, 'classification': 'unknown', 'signedDistance': None,
                            'boundaryDistance': None, 'reason': 'Point3D creation failed: %s' % exc})
            continue
        try:
            state = target.pointContainment(pt)
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


def _native_face_distance(ctx: "CadContext", body: "adsk.fusion.BRepBody", point: "adsk.core.Point3D") -> "float | None":
    faces: "adsk.fusion.BRepFaces | None" = _cad_cast(
        "adsk.fusion.BRepFaces | None", getattr(body, 'faces', None))
    measure_manager: "adsk.core.MeasureManager | None" = _cad_cast(
        "adsk.core.MeasureManager | None", getattr(getattr(ctx, 'app', None), 'measureManager', None))
    measure_minimum_distance: "Callable[[adsk.core.Base, adsk.core.Base], adsk.core.MeasureResults] | None" = _cad_cast(
        "Callable[[adsk.core.Base, adsk.core.Base], adsk.core.MeasureResults] | None",
        getattr(measure_manager, 'measureMinimumDistance', None))
    if faces is None or not callable(measure_minimum_distance):
        return None
    try:
        count: int = faces.count
        if type(count) is not int or count < 1:
            return None
        distances: list[float] = []
        for index in range(count):
            face = _cad_cast("adsk.fusion.BRepFace | None", faces.item(index))
            if face is None:
                return None
            measured = measure_minimum_distance(face, point)
            distance = _cad_cast("object", getattr(measured, 'value', None))
            if not isinstance(distance, (int, float)) or not math.isfinite(distance) or distance < 0:
                return None
            distances.append(float(distance))
        return min(distances)
    except Exception:
        return None


def _measure_corridor(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('path', 'radius'), ('obstacles', 'sections', 'frame', 'minimumClearance', 'method', 'units', 'schemaVersion'))
    waypoints = data['path']
    if not isinstance(waypoints, list) or len(waypoints) < 2:
        raise ValueError('path requires at least two waypoints')
    radius = ctx.length(data['radius'])
    if radius <= 0:
        raise ValueError('radius must be positive')
    centerline = [_containment_point3(ctx, wp) for wp in waypoints]
    obstacles = data.get('obstacles', [])
    if not isinstance(obstacles, list):
        raise ValueError('obstacles must be an array')
    minimum = ctx.length(data.get('minimumClearance', '0 mm'))
    if minimum < 0:
        raise ValueError('minimumClearance must be nonnegative')
    sections = data.get('sections', [])
    if not isinstance(sections, list) or any(not isinstance(s, dict) for s in sections):
        raise ValueError('sections must be an array of station objects')
    arc_lengths: list[float] = [0.0]
    for a, b in zip(centerline, centerline[1:]):
        arc_lengths.append(arc_lengths[-1] + _containment_vnorm(_containment_vsub(b, a)))
    total = arc_lengths[-1]
    occupancy: list[JsonObject] = []
    for obstacle in obstacles:
        point = _parse_point(ctx, obstacle if isinstance(obstacle, (dict, list)) else {'point': obstacle})
        distance = _polyline_distance(centerline, point)
        clearance = distance - radius
        occupancy.append({'obstacle': point, 'clearance': clearance,
                          'intrudes': clearance < minimum, 'distanceToCenterline': distance})
    station_rows: list[JsonObject] = []
    for section in sections:
        station = ctx.length(_cad_cast("JsonObject", section).get('station', '0 mm'))
        if not 0 <= station <= total:
            raise ValueError('section station out of route range')
        position = _containment_point_at_station(centerline, arc_lengths, station)
        station_rows.append({'station': station, 'position': position, 'radius': radius,
                             'clearance': _cad_cast("JsonObject", section).get('clearance', '0 mm')})
    return _contains_contract(ctx, 'measure.corridor', {
        'occupancy': occupancy, 'sections': station_rows, 'arcLength': total,
        'radius': radius, 'minimumClearance': minimum,
        'minClearance': min((_cad_cast(float, o['clearance']) for o in occupancy), default=None),
        'intrusions': sum(1 for o in occupancy if o['intrudes']),
        'limits': {'length': total, 'radius': radius}})


def _measure_region(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
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
    rows: list[JsonObject] = []
    for occupant in occupants:
        if not isinstance(occupant, dict) or 'point' not in occupant:
            raise ValueError('occupants require a point')
        point = _parse_point(ctx, occupant['point'])
        radius = ctx.length(occupant.get('radius', '0 mm'))
        distance = _region_signed_distance(ctx, region, point)
        rows.append({'point': point, 'radius': radius, 'signedDistance': distance,
                     'inside': distance >= -radius, 'classification': _classify(distance, 0.0)})
    inside = [r for r in rows if r['inside']]
    sections: list[JsonObject] = []
    for spec in _cad_cast("Iterable[JsonValue]", data.get('sections', [])):
        if not isinstance(spec, dict) or 'z' not in spec:
            raise ValueError('sections require a z plane')
        z = ctx.length(spec['z'])
        circles: list[tuple[Sequence[float], float]] = [
            (_cad_cast("Sequence[float]", r['point']), _cad_cast(float, r['radius'])) for r in inside
            if abs(_cad_cast("Sequence[float]", r['point'])[2] - z) <= _cad_cast(float, r['radius'])
            or (r['radius'] == 0 and abs(_cad_cast("Sequence[float]", r['point'])[2] - z) < 1e-9)]
        sections.append({'z': z, 'occupantCount': len(circles),
                         'occupiedUnionArea': _containment_circle_union_area([c for c in circles if c[1] > 0], budget)})
    return _contains_contract(ctx, 'measure.region', {
        'occupancy': rows, 'occupiedCount': len(inside), 'occupantCount': len(rows),
        'sections': sections, 'samplingBudget': budget,
        'limits': data.get('limits')})


CAD_HANDLERS.update({
    'measure.contains': _measure_contains,
    'measure.corridor': _measure_corridor,
    'measure.region': _measure_region,
})
