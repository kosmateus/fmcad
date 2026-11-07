"""Fusion adapter: GM06 extensions of model handlers and shapes sketch schema.

Public SDK signatures: installed adsk/defs/adsk/fusion.py; see docs/GM06.md.
This module is bundled after shapes.py. It does not change global sketch preferences.
"""
from typing import Callable as _geometry_sketch_Callable
from typing import cast as _geometry_sketch_cast


def _sketch_target(ctx: "CadContext", ref: object) -> "adsk.fusion.Sketch":
    sketch = ctx.resolve(ref, 'sketch')
    if getattr(sketch, 'assemblyContext', None) is not None or _cad_owner(sketch) != ctx.component:
        raise ValueError('Sketch edits require a native sketch in the selected component')
    return sketch


def _sketch_identity(ctx: "CadContext") -> "JsonObject":
    ctx.assert_identity()
    return {'creationId': ctx.doc.creationId, 'name': ctx.doc.name}


def _sketch_result(ctx: "CadContext", sketch: "adsk.fusion.Sketch | None", operation: str,
                   **result: "JsonValue") -> "JsonObject":
    status = _geometry_sketch_cast(str, result.pop(
        'status', 'pass' if sketch is None or int(_geometry_sketch_cast(int, sketch.healthState)) == 0 else 'fail'))
    return dict(schemaVersion=1, success=status == 'pass', status=status, operation=operation,
        documentIdentity=_sketch_identity(ctx), sketch=ctx.ref(sketch) if sketch else None,
        units={'length': 'cm', 'angle': 'rad'}, frame={'space': 'sketch', 'sketch': ctx.ref(sketch) if sketch else None},
        associativity=result.pop('associativity', 'snapshot'), warnings=[sketch.errorOrWarningMessage] if sketch and sketch.errorOrWarningMessage else [],
        method='Public Fusion sketch SDK; explicit constraints and reviewed proposals',
        limitations=['Kernel changes are not atomic. Inspect partial results before retry.',
                     'Raw coordinates and transforms are snapshots; only explicit bindings persist.'],
        provenance={'requirement': 'GM06', 'source': 'docs/GM06.md'}, **result)


def _sketch_point(ctx: "CadContext", value: object) -> "adsk.core.Point3D":
    p = ctx.point(value)
    if not all(math.isfinite(v) for v in (p.x, p.y, p.z)) or abs(p.z) > 1e-9:
        raise ValueError('GM06 coordinates must be finite sketch-local XY points (z = 0); plane controls orientation')
    return p




def _sketch_ellipse_points(ctx: "CadContext", spec: "JsonObject"
                           ) -> tuple["adsk.core.Point3D", "adsk.core.Point3D", "adsk.core.Point3D"]:
    endpoints = 'majorAxisPoint' in spec or 'minorAxisPoint' in spec
    required = ('type', 'center', 'majorAxisPoint', 'minorAxisPoint') if endpoints else ('type', 'center', 'majorRadius', 'minorRadius')
    _model_fields(spec, required, ('name', 'construction', 'fixed') + (() if endpoints else ('angle',)))
    center = _sketch_point(ctx, spec['center'])
    if endpoints:
        major, minor = [_sketch_point(ctx, spec[k]) for k in ('majorAxisPoint', 'minorAxisPoint')]
        a = (major.x - center.x, major.y - center.y)
        b = (minor.x - center.x, minor.y - center.y)
        ra, rb = math.hypot(*a), math.hypot(*b)
        if ra <= 0 or rb <= 0 or rb >= ra or abs(a[0]*b[0] + a[1]*b[1]) > 1e-9*ra*rb:
            raise ValueError('Ellipse endpoints require perpendicular axes and major radius > minor radius > 0')
    else:
        ra, rb = ctx.length(spec['majorRadius']), ctx.length(spec['minorRadius'])
        if not ra > rb > 0:
            raise ValueError('Ellipse requires majorRadius > minorRadius > 0 (radii, not diameters)')
        angle = ctx.angle(spec.get('angle', '0 deg'))
        major = _model_ok(adsk.core.Point3D.create(center.x + ra*math.cos(angle), center.y + ra*math.sin(angle), 0),
                          'Point3D.create')
        minor = _model_ok(adsk.core.Point3D.create(center.x - rb*math.sin(angle), center.y + rb*math.cos(angle), 0),
                          'Point3D.create')
    return center, major, minor


def _sketch_prepare_geometry(ctx: "CadContext", specs: "JsonValue") -> None:
    if not isinstance(specs, list) or not specs:
        raise ValueError('geometry must be a nonempty array')
    schemas = {'point': ('point',), 'line': ('start', 'end'), 'circle': ('center', 'radius'),
        'arc': ('center', 'start', 'sweep'), 'arc3': ('start', 'through', 'end'),
        'rectangle': ('start', 'end'), 'spline': ('points',), 'bezier': ('controlPoints',)}
    names: set[str] = set()
    for spec in specs:
        if not isinstance(spec, dict):
            raise ValueError('Each primitive must be an object')
        mode = _geometry_sketch_cast(str, spec.get('type'))
        if mode == 'ellipse':
            _sketch_ellipse_points(ctx, spec)
        elif mode in schemas:
            _model_fields(spec, ('type',) + schemas[mode], ('name', 'construction', 'fixed'))
            coordinates = spec.get('points', spec.get('controlPoints'))
            if mode in ('spline', 'bezier'):
                if not isinstance(coordinates, list) or (len(coordinates) != 4 if mode == 'bezier' else len(coordinates) < 2):
                    raise ValueError('Spline needs at least two points; Bezier needs four controlPoints')
                if mode == 'bezier' and spec.get('fixed') is False:
                    raise ValueError('Bezier is intrinsically fixed; fixed:false is unsupported')
            else:
                coordinates = [spec[k] for k in ('start', 'end', 'center', 'through', 'point') if k in spec]
            # Existing geometry supports spatial points/lines/splines. Build's
            # shapes validator separately enforces planar profiles.
            points = [ctx.point(p) for p in coordinates]
            xy = [(p.x, p.y) for p in points]
            if mode in ('line', 'spline') and any(a == b for a, b in zip(xy, xy[1:])):
                raise ValueError('Consecutive points must be distinct')
            if mode == 'rectangle' and (points[0].x == points[1].x or points[0].y == points[1].y):
                raise ValueError('Rectangle must have nonzero width and height')
            if mode == 'circle' and ctx.length(spec['radius']) <= 0:
                raise ValueError('Circle radius must be positive')
            if mode == 'arc' and (xy[0] == xy[1] or not 0 < abs(ctx.angle(spec['sweep'])) < 2*math.pi):
                raise ValueError('Arc requires nonzero radius and sweep in (0,360 deg) magnitude')
            if mode == 'arc3':
                a, b, c = xy
                if abs((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])) < 1e-12:
                    raise ValueError('arc3 points must be noncollinear')
        else:
            raise ValueError('Unsupported geometry type: ' + str(mode))
        if mode == 'point' and 'construction' in spec:
            raise ValueError('Points cannot be construction geometry')
        if 'name' in spec:
            if not isinstance(spec['name'], str) or not spec['name'].strip() or spec['name'] in names:
                raise ValueError('Geometry names must be nonempty and unique')
            names.add(spec['name'])


@_cad_scoped_step('sketch.geometry', native_only=True)
def sketch_geometry(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('sketch', 'geometry'), ('inferencePolicy', 'frame'))
    _sketch_policy(data)
    if data.get('frame', 'sketch') != 'sketch':
        raise ValueError('geometry frame must be sketch; select the sketch plane when building')
    sketch = _sketch_target(ctx, data['sketch'])
    _sketch_prepare_geometry(ctx, data['geometry'])
    _sketch_identity(ctx)
    result: JsonObject = {'entities': [], 'refs': {}}
    for spec in _geometry_sketch_cast('list[JsonObject]', data['geometry']):
        if spec['type'] == 'ellipse':
            entity = _model_ok(sketch.sketchCurves.sketchEllipses.add(*_sketch_ellipse_points(ctx, spec)), 'SketchEllipses.add')
            for key, prop in (('construction', 'isConstruction'), ('fixed', 'isFixed')):
                if key in spec:
                    setattr(entity, prop, spec[key])
            made = _model_geometry_result(ctx, [entity])
            if 'name' in spec:
                _geometry_sketch_cast('dict[str, JsonValue]', made['refs'])[
                    _geometry_sketch_cast(str, spec['name'])] = _geometry_sketch_cast(
                        'list[JsonValue]', made['entities'])[0]
        else:
            made = _geometry_sketch_cast('JsonObject', model_sketch_geometry(
                ctx, {'sketch': data['sketch'], 'geometry': [spec]}))
        _geometry_sketch_cast('list[JsonValue]', result['entities']).extend(
            _geometry_sketch_cast('list[JsonValue]', made['entities']))
        _geometry_sketch_cast('dict[str, JsonValue]', result['refs']).update(
            _geometry_sketch_cast('dict[str, JsonValue]', made['refs']))
    return _sketch_result(ctx, sketch, 'sketch.geometry', inferencePolicy=_sketch_policy(data), **result)


def _sketch_dimension_prepare(ctx: "CadContext", data: "JsonObject"
                              ) -> tuple["adsk.fusion.Sketch", list["CadEntity"]]:
    _model_fields(data, ('sketch', 'type', 'entities', 'text'), ('expression', 'driving', 'orientation'))
    sketch = _sketch_target(ctx, data['sketch'])
    entities = _model_entities(ctx, data['entities'], sketch)
    mode = _geometry_sketch_cast(str, data['type'])
    counts = {'distance': 2, 'angle': 2, 'radius': 1, 'diameter': 1, 'majorRadius': 1, 'minorRadius': 1}
    if mode not in counts or len(entities) != counts[mode]:
        raise ValueError('Unsupported dimension type or entity count')
    types = {'distance': ('SketchPoint',), 'angle': ('SketchLine',), 'radius': ('SketchCircle', 'SketchArc'),
        'diameter': ('SketchCircle', 'SketchArc'), 'majorRadius': ('SketchEllipse',), 'minorRadius': ('SketchEllipse',)}
    if any(_cad_type(e) not in types[mode] for e in entities):
        raise ValueError('Dimension selectors have incompatible geometry types')
    if len(entities) == 2 and entities[0] == entities[1]:
        raise ValueError('Dimension requires distinct entities')
    driving = data.get('driving', True)
    if driving != ('expression' in data):
        raise ValueError('Driving dimensions require expression; driven dimensions prohibit expression')
    if 'orientation' in data and (mode != 'distance' or data['orientation'] not in ('aligned', 'horizontal', 'vertical')):
        raise ValueError('orientation requires distance: aligned, horizontal or vertical')
    if 'expression' in data:
        value = (ctx.angle if mode == 'angle' else ctx.length)(data['expression'])
        if mode in ('radius', 'diameter', 'majorRadius', 'minorRadius') and value <= 0:
            raise ValueError('Radius/diameter dimensions must be positive')
        if mode == 'majorRadius' and value <= _geometry_sketch_cast(
                'adsk.fusion.SketchEllipse', entities[0]).minorAxisRadius:
            raise ValueError('majorRadius must exceed current minor radius')
        if mode == 'minorRadius' and value >= _geometry_sketch_cast(
                'adsk.fusion.SketchEllipse', entities[0]).majorAxisRadius:
            raise ValueError('minorRadius must be below current major radius')
        if mode == 'distance' and value <= 0:
            raise ValueError('Distance dimensions are unsigned and positive; use position binding for signed coordinates through zero')
    _sketch_point(ctx, data['text'])
    return sketch, entities


@_cad_scoped_step('sketch.dimension', native_only=True)
def sketch_dimension(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    sketch, entities = _sketch_dimension_prepare(ctx, data)
    _sketch_identity(ctx)
    mode = _geometry_sketch_cast(str, data['type'])
    existing, unused = _sketch_existing(ctx, sketch)
    orientation = None
    if mode == 'distance':
        orientation = _geometry_sketch_cast(int, getattr(adsk.fusion.DimensionOrientations, {
            'aligned': 'AlignedDimensionOrientation', 'horizontal': 'HorizontalDimensionOrientation',
            'vertical': 'VerticalDimensionOrientation'}[_geometry_sketch_cast(
                str, data.get('orientation', 'aligned'))]))
    if _sketch_has(existing, mode, entities, orientation):
        raise ValueError('An existing dimension controls this selection; edit its expression instead of adding a duplicate')
    if mode in ('majorRadius', 'minorRadius'):
        method = 'addEllipseMajorRadiusDimension' if mode == 'majorRadius' else 'addEllipseMinorRadiusDimension'
        dimension = _model_ok(_geometry_sketch_cast(
            'Callable[[adsk.fusion.SketchEllipse, adsk.core.Point3D, bool], adsk.fusion.SketchDimension]',
            getattr(sketch.sketchDimensions, method))(
                _geometry_sketch_cast('adsk.fusion.SketchEllipse', entities[0]), ctx.point(data['text']),
                _geometry_sketch_cast(bool, data.get('driving', True))), method)
        ref = _model_created(ctx, dimension)
        if data.get('driving', True):
            dimension.parameter.expression = _geometry_sketch_cast(str, data['expression'])
        result = {'dimension': ref, 'parameter': dimension.parameter.name, 'expression': dimension.parameter.expression}
    else:
        result = _geometry_sketch_cast('JsonObject', model_sketch_dimension(ctx, data))
    return _sketch_result(ctx, sketch, 'sketch.dimension', associativity='nativeExpression' if data.get('driving', True) else 'nativeReference', **result)


def _sketch_positions(sketch: "adsk.fusion.Sketch") -> list[list[float]]:
    return [_cad_xyz(p.geometry) for p in _cad_items(sketch.sketchPoints)]


def _sketch_state(ctx: "CadContext", sketch: "adsk.fusion.Sketch") -> "JsonObject":
    return {'points': _sketch_positions(sketch), 'curves': [ctx.describe(e) for e in _cad_items(sketch.sketchCurves)],
        'constraints': [ctx.ref(e) for e in _cad_items(sketch.geometricConstraints)],
        'dimensions': [{'ref': ctx.ref(d), 'expression': d.parameter.expression, 'driving': d.isDriving}
                       for d in _cad_items(sketch.sketchDimensions)],
        'healthState': int(_geometry_sketch_cast(int, sketch.healthState)), 'message': sketch.errorOrWarningMessage}


def _sketch_move_report(ctx: "CadContext", sketch: "adsk.fusion.Sketch", operation: str,
                        before: "JsonObject", action: _geometry_sketch_Callable[[], bool],
                        verify: _geometry_sketch_Callable[[], bool],
                        finalize: _geometry_sketch_Callable[[], None] | None = None) -> "JsonObject":
    _sketch_identity(ctx)
    errors: list[str] = []
    try:
        if action() is not True:
            errors.append('Fusion solver refused the requested move')
    except Exception as exc:
        errors.append(str(exc))
    if finalize is not None:
        try:
            finalize()
        except Exception as exc:
            errors.append(str(exc))
    try:
        after: JsonObject = _sketch_state(ctx, sketch)
        if not errors and (not verify() or int(_geometry_sketch_cast(int, sketch.healthState)) != 0):
            errors.append('Solver result differs from requested geometry or sketch is unhealthy')
    except Exception as exc:
        after = {'status': 'unknown', 'readbackError': str(exc)}
        errors.append('Readback failed: ' + str(exc))
    return _sketch_result(ctx, sketch, operation, status='fail' if errors else 'pass', before=before, after=after,
        affected=[ctx.ref(sketch)], conflicts=errors, atomic=False)


@_cad_scoped_step('sketch.transform', native_only=True)
def sketch_transform(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('sketch', 'entities', 'frame'), ('translate', 'rotate'))
    if data['frame'] != 'sketch' or not any(k in data for k in ('translate', 'rotate')):
        raise ValueError('Transform requires frame:sketch and translate and/or rotate')
    sketch = _sketch_target(ctx, data['sketch'])
    entities = _geometry_sketch_cast('list[adsk.fusion.SketchEntity]',
                                     _model_entities(ctx, data['entities'], sketch))
    if any(e in entities[:i] for i, e in enumerate(entities)):
        raise ValueError('Transform selection contains duplicate entities')
    translation = _sketch_point(ctx, data.get('translate', ['0 mm']*3))
    rotation = _geometry_sketch_cast('JsonObject', data.get('rotate', {'angle': '0 deg', 'center': ['0 mm']*3}))
    _model_fields(rotation, ('angle',), ('center',))
    angle = ctx.angle(rotation['angle'])
    center = _sketch_point(ctx, rotation.get('center', ['0 mm']*3))
    c, s = math.cos(angle), math.sin(angle)
    tx = center.x - c*center.x + s*center.y + translation.x
    ty = center.y - s*center.x - c*center.y + translation.y
    matrix = adsk.core.Matrix3D.create()
    _model_ok(matrix.setWithArray([c, -s, 0, tx, s, c, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1]), 'sketch rigid transform')
    points: list[adsk.fusion.SketchPoint] = []
    moved: dict[str, CadEntity] = {}
    for entity in entities:
        if _cad_type(entity) == 'SketchEllipse':
            lines = [_geometry_sketch_cast('adsk.fusion.SketchLine', line)
                     for line in (getattr(entity, 'majorAxisLine', None), getattr(entity, 'minorAxisLine', None))
                     if line is not None]
        else:
            lines = []
        candidates: list[adsk.fusion.SketchPoint | None] | list[adsk.fusion.SketchPoint] = (
            [_geometry_sketch_cast('adsk.fusion.SketchPoint', entity)] if _cad_type(entity) == 'SketchPoint' else
            [_geometry_sketch_cast('adsk.fusion.SketchPoint | None', getattr(entity, key, None)) for key in
             ('startSketchPoint', 'endSketchPoint', 'centerSketchPoint')])
        if _cad_type(entity) == 'SketchFittedSpline':
            candidates += _cad_items(_geometry_sketch_cast('adsk.fusion.SketchFittedSpline', entity).fitPoints)
        for line in lines:
            candidates += [line.startSketchPoint, line.endSketchPoint]
        candidates = [p for p in candidates if p is not None]
        if not candidates:
            raise ValueError('Transform supports points, lines, circular curves, ellipses and fitted splines')
        for p in _geometry_sketch_cast('list[adsk.fusion.SketchPoint]', candidates):
            if abs(p.geometry.z) > 1e-9:
                raise ValueError('GM06 transform requires planar sketch-local XY geometry')
            if p not in points:
                points.append(p)
        moved.setdefault(entity.entityToken, entity)
        for line in lines:
            moved.setdefault(line.entityToken, line)
    expected: list[tuple[adsk.fusion.SketchPoint, tuple[float, float, float]]] = [
        (p, (c*p.geometry.x-s*p.geometry.y+tx, s*p.geometry.x+c*p.geometry.y+ty, p.geometry.z))
        for p in points]
    axes: list[tuple[adsk.fusion.SketchEllipse, tuple[float, float, float]]] = [
        (_geometry_sketch_cast('adsk.fusion.SketchEllipse', e),
         (c*_geometry_sketch_cast('adsk.fusion.SketchEllipse', e).majorAxis.x-
          s*_geometry_sketch_cast('adsk.fusion.SketchEllipse', e).majorAxis.y,
          s*_geometry_sketch_cast('adsk.fusion.SketchEllipse', e).majorAxis.x+
          c*_geometry_sketch_cast('adsk.fusion.SketchEllipse', e).majorAxis.y,
          _geometry_sketch_cast('adsk.fusion.SketchEllipse', e).majorAxis.z))
        for e in entities if _cad_type(e) == 'SketchEllipse']
    before = _sketch_state(ctx, sketch)
    if any(_geometry_sketch_cast(bool, getattr(e, 'isFixed', False)) or
           _geometry_sketch_cast(bool, getattr(e, 'isReference', False)) or e.isFullyConstrained
           for e in entities):
        return _sketch_result(ctx, sketch, 'sketch.transform', status='blocked', before=before, after=before,
            conflicts=['Selection contains fixed, referenced or fully constrained geometry'], affected=[])
    def verify() -> bool:
        return all(max(abs(a-b) for a, b in zip(_cad_xyz(p.geometry), target)) < 1e-7 for p, target in expected) and all(
            min(max(abs(a-sign*b) for a, b in zip(_cad_xyz(e.majorAxis), target)) for sign in (-1, 1)) < 1e-7 for e, target in axes)
    result = _sketch_move_report(ctx, sketch, 'sketch.transform', before,
        lambda: sketch.move(ctx.collection(list(moved.values())), matrix), verify)
    result.update(matrix=list(matrix.asArray()), order='rotate about sketch-local center, then translate')
    return result


@_cad_scoped_step('sketch.edit', native_only=True)
def sketch_edit(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    if 'movePoints' not in data and 'dimensions' not in data:
        return model_sketch_edit(ctx, data)
    _model_fields(data, ('sketch',), ('movePoints', 'dimensions', 'frame'))
    sketch = _sketch_target(ctx, data['sketch'])
    if data.get('frame', 'sketch') != 'sketch':
        raise ValueError('movePoints frame must be sketch')
    moves, edits = data.get('movePoints', []), data.get('dimensions', [])
    if not isinstance(moves, list) or not isinstance(edits, list) or not moves and not edits:
        raise ValueError('Provide nonempty movePoints and/or dimensions arrays')
    prepared, dimensions = _geometry_sketch_cast(
        'tuple[list[tuple[adsk.fusion.SketchPoint, adsk.core.Point3D]], list[tuple[adsk.fusion.SketchDimension, str]]]',
        ([], []))
    for item in moves:
        item = _geometry_sketch_cast('JsonObject', item)
        _model_fields(item, ('point', 'to'))
        point = _geometry_sketch_cast('adsk.fusion.SketchPoint',
                                       _model_entities(ctx, [item['point']], sketch)[0])
        if _cad_type(point) != 'SketchPoint':
            raise ValueError('movePoints requires sketch points or endpoint selectors')
        prepared.append((point, _sketch_point(ctx, item['to'])))
    for item in edits:
        item = _geometry_sketch_cast('JsonObject', item)
        _model_fields(item, ('dimension', 'expression'))
        d = _geometry_sketch_cast('adsk.fusion.SketchDimension', ctx.resolve(item['dimension']))
        if d.parentSketch != sketch or not d.isDriving:
            raise ValueError('Dimension edits require driving dimensions in this sketch')
        value = (ctx.angle if _cad_type(d) == 'SketchAngularDimension' else ctx.length)(item['expression'])
        if _cad_type(d) != 'SketchAngularDimension' and value <= 0:
            raise ValueError('Dimension must be positive; signed position uses coordinate datum expressions')
        dimensions.append((d, _geometry_sketch_cast(str, item['expression'])))
    ellipse_sizes: list[list[object]] = []
    for d, expression in dimensions:
        if _cad_type(d) in ('SketchEllipseMajorRadiusDimension', 'SketchEllipseMinorRadiusDimension'):
            entry = next((v for v in ellipse_sizes if v[0] == _geometry_sketch_cast(
                'adsk.fusion.SketchEllipse', _geometry_sketch_cast(
                    'adsk.fusion.SketchEllipseMajorRadiusDimension | adsk.fusion.SketchEllipseMinorRadiusDimension',
                    d).ellipse)), None)
            if entry is None:
                entry = [
                    _geometry_sketch_cast('adsk.fusion.SketchEllipse', _geometry_sketch_cast(
                        'adsk.fusion.SketchEllipseMajorRadiusDimension | adsk.fusion.SketchEllipseMinorRadiusDimension',
                        d).ellipse),
                    _geometry_sketch_cast('adsk.fusion.SketchEllipse', _geometry_sketch_cast(
                        'adsk.fusion.SketchEllipseMajorRadiusDimension | adsk.fusion.SketchEllipseMinorRadiusDimension',
                        d).ellipse).majorAxisRadius,
                    _geometry_sketch_cast('adsk.fusion.SketchEllipse', _geometry_sketch_cast(
                        'adsk.fusion.SketchEllipseMajorRadiusDimension | adsk.fusion.SketchEllipseMinorRadiusDimension',
                        d).ellipse).minorAxisRadius]
                ellipse_sizes.append(_geometry_sketch_cast('list[object]', entry))
            entry[1 if _cad_type(d) == 'SketchEllipseMajorRadiusDimension' else 2] = ctx.length(expression)
    if any(not _geometry_sketch_cast(float, major) > _geometry_sketch_cast(float, minor) > 0
           for ellipse, major, minor in ellipse_sizes):
        raise ValueError('Edited ellipse radii require major > minor > 0')
    # Avoid an invalid intermediate ellipse when both valid final radii change.
    dimensions.sort(key=lambda item: 0 if (
        _cad_type(item[0]) == 'SketchEllipseMinorRadiusDimension' and ctx.length(item[1]) <
        _geometry_sketch_cast('adsk.fusion.SketchEllipse', _geometry_sketch_cast(
            'adsk.fusion.SketchEllipseMinorRadiusDimension', item[0]).ellipse).minorAxisRadius or
        _cad_type(item[0]) == 'SketchEllipseMajorRadiusDimension' and ctx.length(item[1]) >
        _geometry_sketch_cast('adsk.fusion.SketchEllipse', _geometry_sketch_cast(
            'adsk.fusion.SketchEllipseMajorRadiusDimension', item[0]).ellipse).majorAxisRadius) else 1)
    if any(p in [q for q, v in prepared[:i]] for i, (p, target) in enumerate(prepared)) or any(d in [q for q, v in dimensions[:i]] for i, (d, expression) in enumerate(dimensions)):
        raise ValueError('Duplicate point or dimension edit')
    before = _sketch_state(ctx, sketch)
    if any(p.isFullyConstrained or _geometry_sketch_cast(bool, getattr(p, 'isFixed', False)) or
           _geometry_sketch_cast(bool, getattr(p, 'isReference', False)) for p, v in prepared):
        return _sketch_result(ctx, sketch, 'sketch.edit', status='blocked', before=before, after=before,
            conflicts=['Cannot move a fixed, referenced or fully constrained point'], affected=[])
    def action() -> bool:
        if prepared:
            timeline_object = _geometry_sketch_cast(
                'adsk.fusion.TimelineObject | None', getattr(sketch, 'timelineObject', None))
            if timeline_object is not None:
                _cad_require_result(timeline_object.rollTo(True), 'TimelineObject.rollTo')
        for dimension, expression in dimensions:
            dimension.parameter.expression = expression
        for point, target in prepared:
            old = point.geometry
            if not point.move(adsk.core.Vector3D.create(target.x-old.x, target.y-old.y, target.z-old.z)):
                return False
        return True

    def finalize() -> None:
        _cad_require_result(ctx.design.timeline.moveToEnd(), 'Timeline.moveToEnd')
        _cad_require_result(ctx.design.computeAll(), 'Design.computeAll')

    result = _sketch_move_report(ctx, sketch, 'sketch.edit', before, action,
        lambda: all(max(abs(a-b) for a, b in zip(_cad_xyz(p.geometry), _cad_xyz(v))) < 1e-7 for p, v in prepared) and
            all(abs((ctx.angle if _cad_type(d) == 'SketchAngularDimension' else ctx.length)(d.parameter.expression) -
                (ctx.angle if _cad_type(d) == 'SketchAngularDimension' else ctx.length)(expression)) < 1e-7 for d, expression in dimensions),
        finalize=finalize if prepared else None)
    if dimensions:
        result['associativity'] = 'nativeExpression' if not prepared else {'dimensions': 'nativeExpression', 'movePoints': 'snapshot'}
    return result


@_cad_scoped_step('sketch.build', native_only=True)
def sketch_build(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'geometry'), ('plane', 'frame', 'constraints', 'dimensions', 'profileIndex', 'inferencePolicy', 'schemaVersion', 'positions'))
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1 or data.get('frame', 'sketch') != 'sketch':
        raise ValueError('build requires schemaVersion 1 and sketch-local coordinates')
    _sketch_policy(data)
    spec = {k: v for k, v in data.items() if k not in ('name', 'frame', 'schemaVersion')}
    _shapes_prepare_sketch(ctx, spec)
    _shapes_reserve(ctx, [_geometry_sketch_cast(str, data['name'])] +
                    [name for position in _geometry_sketch_cast('list[JsonObject]', spec.get('positions', []))
                     for name in _shapes_point_names(_geometry_sketch_cast(str, position['name']))])
    _sketch_identity(ctx)
    sketch_ref, refs = _shapes_build_sketch(
        ctx, _geometry_sketch_cast(str, data['name']), spec)
    sketch = ctx.resolve(sketch_ref, 'sketch')
    return _sketch_result(ctx, sketch, 'sketch.build', refs=refs, isFullyConstrained=sketch.isFullyConstrained,
        profiles=[{'kind': 'profile', 'sketch': sketch_ref, 'index': i} for i in range(sketch.profiles.count)],
        associativity={'geometry': 'snapshot', 'dimensions': 'nativeExpression', 'constraints': 'nativeReference', 'positions': 'nativeReference'},
        inferencePolicy=_sketch_policy(data))


def sketch_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    result = _geometry_sketch_cast('JsonObject', model_sketch_check(ctx, data))
    sketch = ctx.resolve(data['sketch'], 'sketch')
    result.pop('sketch')
    result['underconstrainedPoints'] = [ctx.ref(p) for p in _cad_items(sketch.sketchPoints) if not p.isFullyConstrained]
    return _sketch_result(ctx, sketch, 'sketch.check',
                          status='pass' if int(_geometry_sketch_cast(int, sketch.healthState)) == 0 else 'fail',
                          **result)


@_cad_scoped_step('sketch.constrain', native_only=True)
def sketch_constrain(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    _model_fields(data, ('sketch', 'type', 'entities'))
    sketch = _sketch_target(ctx, data['sketch'])
    entities = _model_entities(ctx, data['entities'], sketch)
    existing, unused = _sketch_existing(ctx, sketch)
    if _sketch_has(existing, _geometry_sketch_cast(str, data['type']), entities):
        match = next(e for e in existing if e['type'] == _geometry_sketch_cast(str, data['type']) and
                     _sketch_same_entities(e['entities'], entities))
        return {'constraint': match['ref'], 'reused': True}
    _sketch_identity(ctx)
    return model_sketch_constrain(ctx, data)
