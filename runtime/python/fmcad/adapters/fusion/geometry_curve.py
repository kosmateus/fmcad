"""Fusion adapter: GM07 sketch DSL/offset and bounded evaluator evidence."""
import time as _geometry_curve_time
from typing import cast as _geometry_curve_cast
from typing import Protocol as _geometry_curve_Protocol


class _OffsetConstraintFactory(_geometry_curve_Protocol):
    @staticmethod
    def cast(arg: "adsk.core.Base") -> "adsk.fusion.OffsetConstraint | None": ...


def _curve_offset_constraint(candidate: "adsk.core.Base") -> "adsk.fusion.OffsetConstraint | None":
    factory = _geometry_curve_cast('_OffsetConstraintFactory', adsk.fusion.OffsetConstraint)
    return factory.cast(candidate)


def _curve_offset_dimension(offset: "adsk.fusion.OffsetConstraint") -> "adsk.fusion.SketchDimension | None":
    return offset.dimension


def _curve_xyz(point: "adsk.core.Point3D") -> list[float]:
    return [point.x, point.y, point.z]






def _curve_intersections(polylines: list[list[list[float]]], tolerance: float,
                         deadline: float) -> list["JsonObject"]:
    segments = [(k, i, a, b) for k, points in enumerate(polylines) for i, (a, b) in enumerate(zip(points, points[1:]))]
    found: list[JsonObject] = []
    def cross(a: list[float], b: list[float], c: list[float]) -> float:
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    for index, (k, i, a, b) in enumerate(segments):
        if _geometry_curve_time.monotonic() > deadline:
            raise ValueError('Curve analysis budget exceeded')
        for l, j, c, d in segments[index+1:]:
            if k == l and (abs(i-j) == 1 or i == 0 and j == len(polylines[k])-2 and _curve_distance(a, d) <= tolerance):
                continue
            if any(max(a[q], b[q])+tolerance < min(c[q], d[q]) or max(c[q], d[q])+tolerance < min(a[q], b[q]) for q in (0, 1)):
                continue
            proper = cross(a, b, c)*cross(a, b, d) < 0 and cross(c, d, a)*cross(c, d, b) < 0
            touching = min(_curve_segment_distance(a, c, d), _curve_segment_distance(b, c, d),
                           _curve_segment_distance(c, a, b), _curve_segment_distance(d, a, b)) <= tolerance
            # Connections between distinct native curves are topology, not self-crossings.
            shared = k != l and any(_curve_distance(x, y) <= tolerance for x in (a, b) for y in (c, d))
            if proper or touching and not shared:
                found.append({'curves': [k, l], 'segments': [i, j], 'kind': 'crossing' if proper else 'nearContact'})
    return found


def _curve_limits(ctx: "CadContext", data: "JsonObject") -> tuple[float, int, float]:
    if data.get('schemaVersion') != 1 or data.get('frame') != 'sketch':
        raise ValueError('GM07 requires version 1 and sketch frame')
    tolerance = ctx.length(data.get('tolerance', '0.001 mm'))
    maximum, budget = data.get('maxSamples', 2000), data.get('budgetMs', 10000)
    if not math.isfinite(tolerance) or tolerance <= 0 or type(maximum) is not int or not 2 <= maximum <= 10000 or type(budget) is not int or not 1 <= budget <= 120000:
        raise ValueError('Invalid curve tolerance/work budget')
    return tolerance, maximum, _geometry_curve_time.monotonic()+budget/1000


def _curve_evidence(ctx: "CadContext", entities: list["CadEntity"], tolerance: float,
                    maximum: int, deadline: float, offset: float | None = None) -> "JsonObject":
    polylines, evidence, cusps = _geometry_curve_cast(
        'tuple[list[list[list[float]]], list[JsonObject], list[JsonObject]]', ([], [], []))
    total = 0
    for index, entity in enumerate(entities):
        if _geometry_curve_time.monotonic() > deadline:
            raise ValueError('Curve analysis budget exceeded')
        evaluator = _geometry_curve_cast('adsk.core.Curve3D', getattr(entity, 'geometry')).evaluator
        ok, start, end = evaluator.getParameterExtents()
        if not ok:
            raise ValueError('Curve evaluator has no bounded parameter range')
        ok, points = evaluator.getStrokes(start, end, tolerance)
        if not ok or len(points) < 2:
            raise ValueError('Curve stroke evaluation failed')
        total += len(points)
        if total > maximum:
            raise ValueError('Native stroke count exceeds maxSamples')
        xyz = [_curve_xyz(p) for p in points]
        if any(abs(p[2]) > tolerance for p in xyz):
            raise ValueError('Planar curve inspection/offset requires sketchXY geometry')
        polylines.append(xyz)
        radii, unknown = _geometry_curve_cast('tuple[list[float], bool]', ([], False))
        for j in range(65):
            t = start+(end-start)*j/64
            ok, direction, curvature = evaluator.getCurvature(t)
            good, tangent = evaluator.getFirstDerivative(t)
            if not ok or not good:
                unknown = True
                continue
            speed = math.hypot(tangent.x, tangent.y)
            if speed < 1e-12:
                cusps.append({'curve': index, 'parameter': t, 'reason': 'zero derivative'})
                continue
            if curvature > 0:
                radii.append(1/curvature)
                # Curvature toward the requested signed right normal collapses at d*k=1.
                signed = curvature*(direction.x*tangent.y-direction.y*tangent.x)/speed
                if offset is not None and offset*signed >= 1-1e-9:
                    cusps.append({'curve': index, 'parameter': t, 'reason': 'offset reaches curvature radius'})
        evidence.append({'entity': ctx.ref(entity), 'closed': _curve_distance(xyz[0], xyz[-1]) <= tolerance,
                         'sampledMinimumRadius': min(radii) if radii else None,
                         'curvatureStatus': 'unknown' if unknown else 'pass', 'curvatureSamples': 65,
                         'continuity': {'G0': 'unknown', 'G1': 'unknown', 'G2': 'unknown'}})
    # Endpoint graph yields separate connected loops, without closing open chains.
    groups: list[list[int]] = []
    for i, points in enumerate(polylines):
        adjacent = [g for g in groups if any(any(_curve_distance(a, b) <= tolerance for a in (points[0], points[-1])
                    for b in (polylines[j][0], polylines[j][-1])) for j in g)]
        joined = [i]
        for group in adjacent:
            joined.extend(group)
            groups.remove(group)
        groups.append(joined)
    loops: list[JsonObject] = []
    for group in groups:
        endpoints = [p for i in group for p in (polylines[i][0], polylines[i][-1])]
        closed = all(sum(_curve_distance(p, q) <= tolerance for q in endpoints) == 2 for p in endpoints)
        loops.append({'curveIndexes': group, 'closed': closed})
    intersections = _curve_intersections(polylines, tolerance, deadline)
    return {'curves': evidence, 'loops': loops, 'selfIntersections': intersections, 'cusps': cusps,
            'strokeCount': total, 'strokeTolerance': tolerance, 'polylines': polylines,
            'status': 'fail' if intersections or cusps else 'unknown' if any(c['curvatureStatus'] == 'unknown' for c in evidence) else 'pass',
            'method': 'Tolerance-bounded evaluator strokes; sampled signed curvature; endpoint connectivity',
            'limitations': ['No continuous global curvature/self-contact certificate. G0/G1/G2 at joins not evaluated.']}


def _curve_result(ctx: "CadContext", sketch: "adsk.fusion.Sketch", operation: str,
                  evidence: "JsonObject", association: str = 'snapshot',
                  provenance: "JsonValue | None" = None, **extra: "JsonValue") -> "JsonObject":
    return dict(schemaVersion=1, operation=operation, status=evidence['status'],
        documentIdentity=_sketch_identity(ctx), units={'length': 'cm', 'angle': 'rad'},
        frame={'space': 'sketch', 'sketch': ctx.ref(sketch)}, associativity=association,
        warnings=[], method=evidence['method'], limitations=evidence['limitations'],
        provenance=provenance or {'requirement': 'GM07'}, affected=[], **extra, inspection=evidence)


def curve_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'sketch', 'frame', 'entities'), ('tolerance', 'maxSamples', 'budgetMs'))
    limits = _curve_limits(ctx, data)
    sketch = _sketch_target(ctx, data['sketch'])
    entities = _model_entities(ctx, data['entities'], sketch)
    return _curve_result(ctx, sketch, 'curve.inspect', _curve_evidence(ctx, entities, *limits))


def curve_fit(ctx: "CadContext", data: "JsonObject", operation: str = 'curve.fit') -> "JsonValue":
    _model_fields(data, ('schemaVersion', 'sketch', 'frame', 'geometry', 'loops', 'sampleMap', 'provenance'), ('tolerance', 'maxSamples', 'budgetMs'))
    limits = _curve_limits(ctx, data)
    sketch = _sketch_target(ctx, data['sketch'])
    _sketch_prepare_geometry(ctx, data['geometry'])
    # All loops and data topology are checked before the first sketch mutation.
    input_lines = [[_geometry_curve_cast('list[float]', s['point'])
                    for s in _geometry_curve_cast('list[JsonObject]', data['sampleMap'])
                    if s['loop'] == loop['id']]
                   for loop in _geometry_curve_cast('list[JsonObject]', data['loops'])]
    if _curve_intersections(input_lines, limits[0], limits[2]):
        raise ValueError('Input polyline contains self-intersections or near contacts')
    made = _geometry_curve_cast('JsonObject', ctx.call(
        'sketch.geometry', {'sketch': data['sketch'], 'geometry': data['geometry']}))
    entities = [ctx.resolve(ref) for ref in _geometry_curve_cast('list[JsonValue]', made['entities'])]
    # Duplicate endpoint is retained in the source map; set native periodic closure explicitly.
    for loop in _geometry_curve_cast('list[JsonObject]', data['loops']):
        indexes = _geometry_curve_cast('list[int]', loop['geometryIndexes'])
        if loop['closed'] and len(indexes) == 1 and _geometry_curve_cast(
                'list[JsonObject]', data['geometry'])[indexes[0]]['type'] == 'spline':
            _geometry_curve_cast('adsk.fusion.SketchFittedSpline', entities[indexes[0]]).isClosed = True
    inspection = _curve_evidence(ctx, entities, limits[0]/10, limits[1], limits[2])
    deviations: list[JsonObject] = []
    for sample in _geometry_curve_cast('list[JsonObject]', data['sampleMap']):
        loop = next(l for l in _geometry_curve_cast('list[JsonObject]', data['loops'])
                    if l['id'] == sample['loop'])
        segments = [(a, b) for i in _geometry_curve_cast('list[int]', loop['geometryIndexes'])
                    for a, b in zip(_geometry_curve_cast('list[list[list[float]]]', inspection['polylines'])[i],
                                    _geometry_curve_cast('list[list[list[float]]]', inspection['polylines'])[i][1:])]
        deviation = min(_curve_segment_distance(_geometry_curve_cast('list[float]', sample['point']), a, b)
                        for a, b in segments)
        deviations.append(dict(sample, strokeDistance=deviation, upperBound=deviation+limits[0]/10))
    maximum = max(_geometry_curve_cast(float, s['strokeDistance']) for s in deviations)
    # Stroke distances have +/- strokeTolerance uncertainty, not exact nearest-point proof.
    fit: JsonObject = {'status': 'pass' if maximum+limits[0]/10 <= limits[0] else 'fail' if maximum-limits[0]/10 > limits[0] else 'unknown', 'maximumStrokeDistance': maximum,
           'upperBound': maximum+limits[0]/10, 'tolerance': limits[0], 'method': 'Sample-to-tolerance-bounded-stroke distance'}
    if fit['status'] != 'pass':
        inspection['status'] = fit['status']
    return _curve_result(ctx, sketch, operation, inspection, 'importedReference', data['provenance'],
                         entities=made['entities'], sourceLoops=data['loops'], sampleMap=deviations, fitError=fit,
                          profiles=[{'kind': 'profile', 'sketch': ctx.ref(sketch), 'index': i} for i in range(sketch.profiles.count)])


def curve_offset(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'sketch', 'frame', 'entities', 'distance', 'side'), ('tolerance', 'maxSamples', 'budgetMs'))
    limits = _curve_limits(ctx, data)
    sketch = _sketch_target(ctx, data['sketch'])
    entities = _model_entities(ctx, data['entities'], sketch)
    distance = ctx.length(data['distance'])
    if distance <= 0 or _geometry_curve_cast(str, data['side']) not in ('left', 'right'):
        raise ValueError('Offset requires positive distance and left/right side')
    signed = distance if _geometry_curve_cast(str, data['side']) == 'right' else -distance
    before = _curve_evidence(ctx, entities, *limits, offset=signed)
    if before['cusps'] or before['selfIntersections'] or any(
            c['curvatureStatus'] == 'unknown' for c in _geometry_curve_cast('list[JsonObject]', before['curves'])):
        return _curve_result(ctx, sketch, 'curve.offset', dict(before, status='blocked'))
    if len(_geometry_curve_cast('list[JsonObject]', before['loops'])) != 1:
        raise ValueError('Offset one connected loop at a time; inspect reports all separate loops')
    expression = _geometry_curve_cast(str, data['distance']) if _geometry_curve_cast(str, data['side']) == 'right' else '-('+_geometry_curve_cast(str, data['distance'])+')'
    made = _geometry_curve_cast('JsonObject', ctx.call(
        'sketch.offset', {'sketch': data['sketch'], 'entities': data['entities'], 'distance': expression}))
    after = _curve_evidence(ctx, [ctx.resolve(ref) for ref in _geometry_curve_cast('list[JsonValue]', made['entities'])], *limits)
    return _curve_result(ctx, sketch, 'curve.offset', after, 'nativeExpression',
                         entities=made['entities'], constraint=made['constraint'],
                         offsetParameter=made.get('offsetParameter'), before=before,
                         topologyChanged=len(_geometry_curve_cast('list[JsonObject]', before['curves'])) !=
                             len(_geometry_curve_cast('list[JsonObject]', after['curves'])) or
                             len(_geometry_curve_cast('list[JsonObject]', before['loops'])) !=
                             len(_geometry_curve_cast('list[JsonObject]', after['loops'])))


def curve_offset_edit(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'distance', 'parameter'))
    if data['frame'] != 'sketch':
        raise ValueError('GM07 offset edits use the sketch frame')
    expression = _geometry_curve_cast(str, data['distance'])
    ctx.length(expression)
    selector = data['parameter']
    if isinstance(selector, str):
        name = selector.strip()
        if not name:
            raise ValueError('parameter name must be nonempty')
        parameters = [p for p in _cad_items(ctx.design.allParameters)
                      if _geometry_curve_cast(str, getattr(p, 'name', None)) == name]
        if len(parameters) != 1:
            raise ValueError('Offset dimension parameter not found: ' + name)
        parameter = parameters[0]
    else:
        parameter = ctx.resolve(selector, 'parameter')
    constraint = None
    for component in _cad_items(ctx.design.allComponents):
        for sketch in _cad_items(component.sketches):
            for candidate in _cad_items(sketch.geometricConstraints):
                offset = _curve_offset_constraint(candidate)
                if offset is None:
                    continue
                dimension = _curve_offset_dimension(offset)
                if dimension is not None and _geometry_curve_cast(
                        'adsk.fusion.ModelParameter | None', getattr(dimension, 'parameter', None)) is not None and \
                        dimension.parameter == parameter:
                    constraint = offset
    if constraint is None:
        raise ValueError('Parameter does not control a native offset dimension: ' +
                         _geometry_curve_cast(str, getattr(parameter, 'name', '')))
    before = {'name': parameter.name, 'expression': parameter.expression,
              'unit': parameter.unit, 'value': parameter.value}
    parameter.expression = expression
    after = {'name': parameter.name, 'expression': parameter.expression,
             'unit': parameter.unit, 'value': parameter.value}
    return dict(schemaVersion=1, operation='curve.offset-edit', status='pass',
                documentIdentity=_sketch_identity(ctx), units={'length': 'cm', 'angle': 'rad'},
                frame={'space': 'sketch', 'sketch': ctx.ref(constraint.parentSketch)},
                associativity='nativeExpression', warnings=[], affected=[],
                method='Native offset dimension parameter expression edit',
                limitations=['The existing native offset dimension is required; a deleted dimension cannot be edited.'],
                provenance={'requirement': 'GM07'}, parameter=after, before=before, after=after,
                constraint=ctx.ref(constraint))
