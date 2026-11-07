"""Fusion adapter: GM06 proposal recognition and explicit guarded application."""
import time as _geometry_sketch_plan_time
import hashlib as _geometry_sketch_plan_hashlib
from typing import Callable as _geometry_sketch_plan_Callable
from typing import Sequence as _geometry_sketch_plan_Sequence
from typing import TypedDict as _geometry_sketch_plan_TypedDict
from typing import cast as _geometry_sketch_plan_cast

time = _geometry_sketch_plan_time


class _SketchExisting(_geometry_sketch_plan_TypedDict):
    type: str
    entities: list["adsk.core.Base"]
    ref: "JsonObject"
    orientation: int | None
    driving: bool | None


class _SketchPending(_geometry_sketch_plan_TypedDict):
    type: str
    entities: list["adsk.core.Base"]
    orientation: int | None


def _sketch_order_build_dimensions(ctx: "CadContext", spec: "JsonObject") -> list["JsonObject"]:
    sizes: dict[str, list[float]] = {}
    for item in _geometry_sketch_plan_cast('list[JsonObject]', spec['geometry']):
        if item['type'] == 'ellipse':
            c, a, b = _sketch_ellipse_points(ctx, item)
            sizes[_geometry_sketch_plan_cast(str, item['name'])] = [
                math.hypot(a.x-c.x, a.y-c.y), math.hypot(b.x-c.x, b.y-c.y)]
    final = {name: list(values) for name, values in sizes.items()}
    seen, ordered = _geometry_sketch_plan_cast('tuple[set[tuple[str, tuple[str, ...], str]], list[tuple[int, JsonObject]]]',
                                               (set(), []))
    for dimension in _geometry_sketch_plan_cast('list[JsonObject]', spec.get('dimensions', [])):
        mode, entities = _geometry_sketch_plan_cast('tuple[str, list[str]]',
                                                     (dimension['type'], dimension['entities']))
        signature = ('radius' if mode == 'diameter' else mode, tuple(sorted(entities)),
                     _geometry_sketch_plan_cast(str, dimension.get('orientation', 'aligned')))
        if signature in seen:
            raise ValueError('Duplicate build dimension; edit the existing expression instead')
        seen.add(signature)
        priority = 1
        if mode in ('majorRadius', 'minorRadius'):
            index = 0 if mode == 'majorRadius' else 1
            value = ctx.length(dimension['expression'])
            initial = sizes[entities[0]][index]
            final[entities[0]][index] = value
            if index == 0 and value > initial or index == 1 and value < initial:
                priority = 0
        ordered.append((priority, dimension))
    if any(not major > minor > 0 for major, minor in final.values()):
        raise ValueError('Final build ellipse dimensions require major > minor > 0')
    return [d for priority, d in sorted(ordered, key=lambda item: item[0])]


def _sketch_prepare_positions(ctx: "CadContext", spec: "JsonObject", labels: dict[str, str]) -> None:
    positions = spec['positions']
    if not isinstance(positions, list):
        raise ValueError('positions must be an array')
    if positions and ctx.design.designType != _geometry_sketch_plan_cast(
            'adsk.fusion.DesignTypes', adsk.fusion.DesignTypes.ParametricDesignType):
        raise ValueError('Signed coordinate bindings require parametric history')
    names, selectors = _geometry_sketch_plan_cast('tuple[list[str], list[str]]', ([], []))
    for item in positions:
        item = _geometry_sketch_plan_cast('JsonObject', item)
        _model_fields(item, ('name', 'point', 'coordinates'))
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', _geometry_sketch_plan_cast(str, item['name'])) or _geometry_sketch_plan_cast(str, item['name']) in labels:
            raise ValueError('Position helper names must be unique ASCII identifiers distinct from geometry labels')
        selector = item['point']
        if not isinstance(selector, str):
            raise ValueError('Position point must be a local point selector')
        label, dot, part = selector.partition('.')
        if label == 'origin':
            raise ValueError('The immutable sketch origin cannot have a position binding')
        kind = labels.get(label)
        rectangle_point = kind == 'rectangle' and re.fullmatch(r'edge[0-3]\.(start|end)', part)
        spline = next((g for g in _geometry_sketch_plan_cast('list[JsonObject]', spec['geometry'])
                       if g['name'] == label and g['type'] == 'spline'), None)
        spline_point = spline is not None and part in ['fit' + str(i) for i in range(
            len(_geometry_sketch_plan_cast('list[JsonValue]', spline['points'])))]
        if not (kind == 'point' and not dot or kind in ('ellipse', 'circle', 'arc', 'arc3') and part == 'center' or kind in ('line', 'arc', 'arc3') and part in ('start', 'end') or rectangle_point or spline_point):
            raise ValueError('positions require a named point, endpoint or center')
        _sketch_point(ctx, item['coordinates'])
        names.extend(_shapes_point_names(_geometry_sketch_plan_cast(str, item['name'])))
        selectors.append(selector)
    if len(set(selectors)) != len(selectors):
        raise ValueError('Duplicate position binding')
    _shapes_reserve(ctx, names)


def _sketch_component_expressions(sketch: "adsk.fusion.Sketch", coordinates: "JsonValue") -> list[str]:
    """Native sketch frame sampled once; retain signed coordinate expressions."""
    origin = sketch.sketchToModelSpace(_model_ok(adsk.core.Point3D.create(0, 0, 0), 'Point3D.create'))
    x = sketch.sketchToModelSpace(_model_ok(adsk.core.Point3D.create(1, 0, 0), 'Point3D.create'))
    y = sketch.sketchToModelSpace(_model_ok(adsk.core.Point3D.create(0, 1, 0), 'Point3D.create'))
    return ['(%.17g cm) + (%.17g) * (%s) + (%.17g) * (%s)' %
            (o, a-o, _geometry_sketch_plan_cast('list[str]', coordinates)[0],
             b-o, _geometry_sketch_plan_cast('list[str]', coordinates)[1])
            for o, a, b in zip(_cad_xyz(origin), _cad_xyz(x), _cad_xyz(y))]


def _sketch_bind_position(ctx: "CadContext", sketch_ref: "JsonValue", refs: dict[str, "JsonValue"],
                          item: "JsonObject") -> None:
    sketch = ctx.resolve(sketch_ref, 'sketch')
    selector = _geometry_sketch_plan_cast(str, item['point'])
    if selector in refs:
        point = refs[selector]
    else:
        label, part = selector.rsplit('.', 1)
        point = {'entity': refs[label], 'point': part}
    coordinates = _sketch_component_expressions(sketch, item['coordinates'])
    projected, helpers = _geometry_sketch_plan_cast('tuple[CadEntity, list[JsonValue]]',
        _shapes_linked_point(ctx, sketch_ref, _geometry_sketch_plan_cast(str, item['name']), coordinates))
    ctx.call('sketch.constrain', {'sketch': sketch_ref, 'type': 'coincident', 'entities': [point, ctx.ref(projected)]})
    refs[_geometry_sketch_plan_cast(str, item['name'])] = ctx.ref(projected)
    refs[_geometry_sketch_plan_cast(str, item['name']) + '.helpers'] = helpers




def _sketch_existing(ctx: "CadContext", sketch: "adsk.fusion.Sketch") -> tuple[list[_SketchExisting], list["JsonObject"]]:
    recognized, unknown = _geometry_sketch_plan_cast('tuple[list[_SketchExisting], list[JsonObject]]', ([], []))
    for entity in _cad_items(sketch.geometricConstraints) + _cad_items(sketch.sketchDimensions):
        shape = _SKETCH_RECOGNITION.get(_cad_type(entity))
        if shape is None:
            unknown.append(ctx.ref(entity))
            continue
        mode, props = shape
        selected: list[adsk.core.Base | None] = [
            _geometry_sketch_plan_cast('adsk.core.Base | None', getattr(entity, p, None)) for p in props]
        if any(e is None for e in selected):
            unknown.append(ctx.ref(entity))
            continue
        recognized.append({'type': mode, 'entities': _geometry_sketch_plan_cast('list[adsk.core.Base]', selected),
            'ref': ctx.ref(entity),
            'orientation': _geometry_sketch_plan_cast('int | None', getattr(entity, 'orientation', None)),
            'driving': _geometry_sketch_plan_cast('bool | None', getattr(entity, 'isDriving', None))})
    return recognized, unknown


def _sketch_same_entities(left: _geometry_sketch_plan_Sequence["adsk.core.Base"],
                          right: _geometry_sketch_plan_Sequence["adsk.core.Base"]) -> bool:
    # Resolve refs and compare native objects, never use token-string equality as identity.
    return len(left) == len(right) and all(any(a == b for b in right) for a in left)


def _sketch_has(existing: _geometry_sketch_plan_Sequence[_SketchExisting | _SketchPending],
                mode: str, entities: _geometry_sketch_plan_Sequence["adsk.core.Base"],
                orientation: int | None = None,
                check_budget: _geometry_sketch_plan_Callable[[], None] | None = None) -> bool:
    canonical = 'radius' if mode == 'diameter' else mode
    def equivalent(left: "adsk.core.Base", right: "adsk.core.Base", relation: str) -> bool:
        reached: list[adsk.core.Base] = [left]
        changed = True
        while changed:
            if check_budget:
                check_budget()
            changed = False
            for item in existing:
                if item['type'] != relation or len(item['entities']) != 2:
                    continue
                a, b = item['entities']
                if relation == 'coincident' and any(_cad_type(e) != 'SketchPoint' for e in (a, b)):
                    continue
                if a in reached and b not in reached:
                    reached.append(b)
                    changed = True
                elif b in reached and a not in reached:
                    reached.append(a)
                    changed = True
        return right in reached
    for item in existing:
        same = _sketch_same_entities(item['entities'], entities)
        if canonical == 'radius' and item['type'] == canonical and len(item['entities']) == len(entities) == 1:
            same = equivalent(item['entities'][0], entities[0], 'equal')
        elif canonical == 'distance' and item['type'] == canonical and len(item['entities']) == len(entities) == 2:
            a, b = item['entities']
            c, d = entities
            same = equivalent(a, c, 'coincident') and equivalent(b, d, 'coincident') or equivalent(a, d, 'coincident') and equivalent(b, c, 'coincident')
        if item['type'] == canonical and same:
            if mode != 'distance' or item['orientation'] == orientation:
                return True
    return False


def _sketch_rectangles(lines: list["adsk.fusion.SketchLine"], tolerance: float,
                       check_budget: _geometry_sketch_plan_Callable[[], None] | None = None
                       ) -> list[list["adsk.fusion.SketchLine"]]:
    """Find isolated four-edge rectangular components; do not guess amid branches."""
    def near(a: "adsk.fusion.SketchPoint", b: "adsk.fusion.SketchPoint") -> bool:
        return math.dist(_cad_xyz(a.geometry), _cad_xyz(b.geometry)) <= tolerance
    def ends(line: "adsk.fusion.SketchLine") -> "list[adsk.fusion.SketchPoint]":
        return [line.startSketchPoint, line.endSketchPoint]
    remaining, result = list(lines), _geometry_sketch_plan_cast('list[list[adsk.fusion.SketchLine]]', [])
    while remaining:
        if check_budget:
            check_budget()
        group = [remaining.pop(0)]
        changed = True
        while changed:
            if check_budget:
                check_budget()
            changed = False
            for line in list(remaining):
                if any(near(a, b) for member in group for a in ends(member) for b in ends(line)):
                    group.append(line)
                    remaining.remove(line)
                    changed = True
        if len(group) != 4:
            continue
        if any(sum(near(p, q) for other in group if other != line for q in ends(other)) != 1 for line in group for p in ends(line)):
            continue
        first = group[0]
        ordered = [first]
        end = first.endSketchPoint
        while len(ordered) < 4:
            nxt = next((line for line in group if line not in ordered and any(near(end, p) for p in ends(line))), None)
            if nxt is None:
                break
            end = nxt.endSketchPoint if near(end, nxt.startSketchPoint) else nxt.startSketchPoint
            ordered.append(nxt)
        if len(ordered) != 4:
            continue
        vectors = [(l.endSketchPoint.geometry.x-l.startSketchPoint.geometry.x,
                    l.endSketchPoint.geometry.y-l.startSketchPoint.geometry.y) for l in ordered]
        lengths = [math.hypot(*v) for v in vectors]
        if min(lengths) <= tolerance:
            continue
        if all(abs(a[0]*b[0]+a[1]*b[1]) <= 1e-7*la*lb for a, b, la, lb in zip(vectors, vectors[1:]+vectors[:1], lengths, lengths[1:]+lengths[:1])):
            result.append(ordered)
    return result


def _sketch_plan_options(ctx: "CadContext", data: "JsonObject") -> tuple[int, float, int | float]:
    _model_fields(data, ('sketch',), ('entities', 'relations', 'tolerance', 'maxEntities', 'maxSeconds', 'schemaVersion'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('dimension-plan schemaVersion must be 1')
    maximum = data.get('maxEntities', 200)
    if type(maximum) is not int or not 1 <= maximum <= 1000:
        raise ValueError('maxEntities must be an integer from 1 to 1000')
    tolerance = ctx.length(data.get('tolerance', '0.000001 cm'))
    if not 0 < tolerance <= 0.01:
        raise ValueError('Recognition tolerance must be positive and at most 0.01 cm')
    if not isinstance(data.get('relations', []), list):
        raise ValueError('relations must be an array')
    if len(_geometry_sketch_plan_cast('list[JsonValue]', data.get('relations', []))) > maximum:
        raise ValueError('Relations exceed maxEntities work budget')
    seconds = data.get('maxSeconds', 10)
    if type(seconds) not in (int, float) or not math.isfinite(
            _geometry_sketch_plan_cast('int | float', seconds)) or not 0 < _geometry_sketch_plan_cast(
                'int | float', seconds) <= 120:
        raise ValueError('maxSeconds must be a positive number at most 120 seconds')
    return maximum, tolerance, _geometry_sketch_plan_cast('int | float', seconds)


def sketch_dimension_plan(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    maximum, tolerance, seconds = _sketch_plan_options(ctx, data)
    started = time.monotonic()
    def budget() -> None:
        if time.monotonic() - started > seconds:
            raise ValueError('Sketch recognition exceeded maxSeconds; no mutations were made')
    sketch = _sketch_target(ctx, data['sketch'])
    _sketch_identity(ctx)
    curves: list[CadEntity] = (_model_entities(ctx, data['entities'], sketch) if 'entities' in data else
                               _geometry_sketch_plan_cast('list[CadEntity]', _cad_items(sketch.sketchCurves)))
    if len(curves) > maximum:
        raise ValueError('Sketch recognition exceeds maxEntities; narrow the selection')
    existing, unknown = _sketch_existing(ctx, sketch)
    proposals, skipped = _geometry_sketch_plan_cast('tuple[list[JsonObject], list[JsonObject]]', ([], []))
    recognized: list[JsonObject] = []
    pending: list[_SketchExisting | _SketchPending] = list(existing)
    def propose(mode: str, entities: "list[CadEntity]", reason: str, expression: str | None = None,
                orientation: int | None = None) -> None:
        budget()
        if _sketch_has(pending, mode, entities, orientation, budget):
            skipped.append({'reason': 'existing constraint or dimension', 'type': mode, 'entities': [ctx.ref(e) for e in entities]})
            return
        if all(getattr(e, 'isFullyConstrained', False) or getattr(e, 'isFixed', False) or getattr(e, 'isReference', False) for e in entities):
            skipped.append({'reason': 'fixed, referenced or fully constrained', 'type': mode, 'entities': [ctx.ref(e) for e in entities]})
            return
        command: JsonObject = {'type': mode, 'entities': [ctx.ref(e) for e in entities]}
        if expression is not None:
            command.update(expression=expression, text=['10 mm', '10 mm', '0 mm'])
            if mode == 'distance':
                command['orientation'] = 'aligned'
        proposals.append({'id': 'p%d' % (len(proposals)+1), 'operation': 'sketch.dimension' if expression is not None else 'sketch.constrain',
            'reason': reason, 'data': command})
        pending.append({'type': mode, 'entities': entities, 'orientation': orientation})
    lines = [_geometry_sketch_plan_cast('adsk.fusion.SketchLine', c) for c in curves
             if _cad_type(c) == 'SketchLine' and
             not _geometry_sketch_plan_cast('adsk.fusion.SketchLine', c).isConstruction]
    aligned = adsk.fusion.DimensionOrientations.AlignedDimensionOrientation
    for curve in curves:
        budget()
        kind = _cad_type(curve)
        if kind in ('SketchCircle', 'SketchEllipse') and not _geometry_sketch_plan_cast(
                'adsk.fusion.SketchCurve', curve).isConstruction:
            recognized.append({'type': 'circle' if kind == 'SketchCircle' else 'ellipse', 'entities': [ctx.ref(curve)]})
            for mode, value in ([('radius', _geometry_sketch_plan_cast('adsk.fusion.SketchCircle', curve).radius)]
                                if kind == 'SketchCircle' else
                                [('majorRadius', _geometry_sketch_plan_cast('adsk.fusion.SketchEllipse', curve).majorAxisRadius),
                                 ('minorRadius', _geometry_sketch_plan_cast('adsk.fusion.SketchEllipse', curve).minorAxisRadius)]):
                propose(mode, [curve], 'Recognized analytic ' + kind, '%.17g cm' % value)
    for rectangle in _sketch_rectangles(lines, tolerance, budget):
        recognized.append({'type': 'rectangle', 'entities': [ctx.ref(l) for l in rectangle]})
        for line, opposite in ((rectangle[0], rectangle[2]), (rectangle[1], rectangle[3])):
            candidates = _geometry_sketch_plan_cast(
                'tuple[list[CadEntity], list[CadEntity]]',
                ([line.startSketchPoint, line.endSketchPoint],
                 [opposite.startSketchPoint, opposite.endSketchPoint]))
            def same_side_dimension(item: _SketchExisting | _SketchPending) -> bool:
                if item['type'] != 'distance' or not any(_sketch_has(pending, 'distance', pair, item['orientation'], budget) for pair in candidates):
                    return False
                a, b = line.startSketchPoint.geometry, line.endSketchPoint.geometry
                valid = [aligned]
                if abs(a.y-b.y) <= tolerance:
                    valid.append(adsk.fusion.DimensionOrientations.HorizontalDimensionOrientation)
                if abs(a.x-b.x) <= tolerance:
                    valid.append(adsk.fusion.DimensionOrientations.VerticalDimensionOrientation)
                return item['orientation'] in valid
            if not any(same_side_dimension(item) for item in pending):
                a, b = line.startSketchPoint.geometry, line.endSketchPoint.geometry
                propose('distance', candidates[0], 'Recognized rectangle side; opposite-side dimensions also checked',
                    '%.17g cm' % math.dist(_cad_xyz(a), _cad_xyz(b)), aligned)
    # Only propose explicit user-requested relations. Geometry alone is not design intent.
    for relation in _geometry_sketch_plan_cast('list[JsonObject]', data.get('relations', [])):
        budget()
        _model_fields(relation, ('type', 'entities'))
        mode = _geometry_sketch_plan_cast(str, relation['type'])
        allowed = {'horizontal': 1, 'vertical': 1, 'parallel': 2, 'perpendicular': 2, 'concentric': 2,
                   'equal': 2, 'coincident': 2, 'horizontalPoints': 2, 'verticalPoints': 2}
        entities = _model_entities(ctx, relation['entities'], sketch)
        if mode not in allowed or len(entities) != allowed[mode]:
            raise ValueError('Unsupported relation or wrong entity count')
        kinds = [_cad_type(e) for e in entities]
        if mode in ('horizontal', 'vertical', 'parallel', 'perpendicular') and any(k != 'SketchLine' for k in kinds):
            raise ValueError('Line relation requires lines')
        if mode in ('horizontalPoints', 'verticalPoints') and any(k != 'SketchPoint' for k in kinds):
            raise ValueError('Point relation requires points')
        if mode == 'coincident' and kinds[0] != 'SketchPoint':
            raise ValueError('coincident starts with a point')
        if mode == 'concentric' and any(k not in ('SketchCircle', 'SketchArc') for k in kinds):
            raise ValueError('concentric requires circular curves')
        if mode == 'equal' and not (all(k == 'SketchLine' for k in kinds) or all(k in ('SketchCircle', 'SketchArc') for k in kinds)):
            raise ValueError('equal requires compatible lines or circular curves')
        if len(entities) == 2 and entities[0] == entities[1]:
            skipped.append({'reason': 'same native entity', 'type': mode})
        else:
            propose(mode, entities, 'Explicitly requested relation')
    state = _sketch_state(ctx, sketch)
    budget()
    fingerprint = _geometry_sketch_plan_hashlib.sha256(json.dumps(state, sort_keys=True, allow_nan=False).encode()).hexdigest()
    plan: JsonObject = {'schemaVersion': 1, 'documentIdentity': _sketch_identity(ctx), 'sketch': ctx.ref(sketch),
        'fingerprint': fingerprint, 'options': {k: v for k, v in data.items() if k != 'sketch'}, 'proposals': proposals}
    return _sketch_result(ctx, sketch, 'sketch.dimension-plan', plan=plan, recognized=recognized, skipped=skipped,
        existing=[{'type': e['type'], 'ref': e['ref'], 'entities': [ctx.ref(x) for x in e['entities']], 'driving': e['driving']} for e in existing],
        unrecognizedConstraints=unknown, mutation=False, work={'entities': len(curves), 'maxEntities': maximum, 'proposals': len(proposals),
            'candidatePairsUpperBound': len(curves)*(len(curves)-1)//2,
            'relations': len(_geometry_sketch_plan_cast('list[JsonValue]', data.get('relations', []))),
            'maxSeconds': seconds, 'elapsedSeconds': time.monotonic()-started},
        coverage='Analytic circles/ellipses, isolated four-line rectangles and explicit relations; no solver feasibility claim')


def sketch_dimension_apply(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('sketch', 'plan', 'accept'))
    plan = _geometry_sketch_plan_cast('JsonObject', data['plan'])
    _model_fields(plan, ('schemaVersion', 'documentIdentity', 'sketch', 'fingerprint', 'options', 'proposals'))
    if type(plan['schemaVersion']) is not int or plan['schemaVersion'] != 1 or plan['documentIdentity'] != _sketch_identity(ctx):
        raise ValueError('Plan schema/document identity mismatch')
    sketch = _sketch_target(ctx, data['sketch'])
    if ctx.resolve(plan['sketch'], 'sketch') != sketch:
        raise ValueError('Plan belongs to another sketch')
    accept = data['accept']
    if not isinstance(accept, list) or not accept or any(not isinstance(x, str) for x in accept) or len(set(accept)) != len(accept):
        raise ValueError('accept must be a nonempty array of unique reviewed proposal IDs')
    if not isinstance(plan['options'], dict) or 'sketch' in plan['options']:
        raise ValueError('Invalid plan options')
    current = _geometry_sketch_plan_cast('JsonObject', sketch_dimension_plan(
        ctx, dict(plan['options'], sketch=data['sketch']))['plan'])
    if current['fingerprint'] != plan['fingerprint'] or current['proposals'] != plan['proposals']:
        raise ValueError('Plan is stale or modified; regenerate and review before applying')
    selected = [p for p in _geometry_sketch_plan_cast('list[JsonObject]', current['proposals'])
                if p['id'] in _geometry_sketch_plan_cast('list[str]', accept)]
    if len(selected) != len(accept):
        raise ValueError('Unknown accepted proposal ID')
    for proposal in selected:
        if proposal['operation'] == 'sketch.dimension':
            _sketch_dimension_prepare(ctx, dict(_geometry_sketch_plan_cast('JsonObject', proposal['data']),
                                                sketch=data['sketch']))
    before = _sketch_state(ctx, sketch)
    completed, conflicts = _geometry_sketch_plan_cast('tuple[list[JsonObject], list[JsonObject]]', ([], []))
    for proposal in selected:
        try:
            result = ctx.call(_geometry_sketch_plan_cast(str, proposal['operation']),
                              dict(_geometry_sketch_plan_cast('JsonObject', proposal['data']), sketch=data['sketch']))
            completed.append({'id': proposal['id'], 'result': result})
            if int(_geometry_sketch_plan_cast(int, sketch.healthState)) != 0:
                raise RuntimeError('Sketch became unhealthy: ' + sketch.errorOrWarningMessage)
        except Exception as exc:
            conflicts.append({'id': proposal['id'], 'error': str(exc)})
            break
    return _sketch_result(ctx, sketch, 'sketch.dimension-apply', status='fail' if conflicts else 'pass',
        before=before, after=_sketch_state(ctx, sketch), completed=completed, conflicts=conflicts,
        notApplied=[p['id'] for p in selected if p['id'] not in [c['id'] for c in completed]],
        affected=[ctx.ref(sketch)], associativity={'dimensions': 'nativeExpression', 'constraints': 'nativeReference'}, atomic=False)
