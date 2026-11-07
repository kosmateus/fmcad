"""Fusion adapter: expression-driven recipes using model/sketch commands."""
from typing import Callable as _geometry_shapes_Callable, Literal as _geometry_shapes_Literal
from typing import Sequence as _geometry_shapes_Sequence
from typing import cast as _geometry_shapes_cast


def _shapes_native(ctx: "CadContext", ref: object, kind: str | None = None) -> "CadEntity":
    entity = ctx.resolve(ref, kind)
    if getattr(entity, 'assemblyContext', None) is not None or _cad_owner(entity) != ctx.component:
        raise ValueError('Shapes require native geometry in the selected component')
    return entity


def _shapes_expression(ctx: "CadContext", expression: object,
                       units: str | None = None, unitless: bool = False) -> "tuple[str, float]":
    evaluate = _geometry_shapes_cast(
        "_geometry_shapes_Callable[[object, str | None, bool], tuple[str, float]]",
        getattr(ctx, '_expression'))
    return evaluate(expression, units, unitless)


def _shapes_reserve(ctx: "CadContext", names: "_geometry_shapes_Sequence[object]") -> None:
    if ctx.occurrence is not None:
        raise ValueError('Generated recipes require native component scope')
    if any(not isinstance(n, str) or not n.strip() for n in names) or len(set(names)) != len(names):
        raise ValueError('Generated names must be nonempty and distinct')
    existing = _geometry_shapes_cast("list[_CadNamed]", [])
    for prop in ('sketches', 'constructionPlanes', 'constructionPoints', 'constructionAxes', 'features', 'bRepBodies'):
        existing.extend(_cad_items(_geometry_shapes_cast(
            "_CadItemCollection[_CadNamed]", getattr(ctx.component, prop))))
    collisions = sorted({e.name for e in existing if e.name in names})
    if collisions:
        raise ValueError('Reserved shape name already exists; no changes made: ' + ', '.join(collisions))


def _shapes_count(ctx: "CadContext", quantity: object) -> int | str:
    value = quantity if type(quantity) is int else _shapes_expression(ctx, quantity, '', True)[1]
    if isinstance(quantity, bool) or value < 2 or value != int(value):
        raise ValueError('quantity must evaluate to an integer of at least two')
    _model_quantity(ctx, quantity)
    return _geometry_shapes_cast("int | str", quantity)




def _shapes_linked_point(ctx: "CadContext", sketch: "JsonValue", name: str, coordinates: list[str],
                         frame: "JsonValue | None" = None) -> "tuple[adsk.fusion.SketchPoint, list[JsonValue]]":
    payload = _geometry_shapes_cast("JsonObject", {'name': name, 'point': coordinates})
    if frame is not None:
        payload.update(frame=frame, associativity='snapshot', schemaVersion=1)
    datum = _geometry_shapes_cast("JsonObject", ctx.call('datum.point', payload))
    projected = _geometry_shapes_cast("list[JsonValue]", _geometry_shapes_cast(
        "JsonObject", ctx.call('sketch.project', {'sketch': sketch, 'entities': [datum], 'linked': True}))['entities'])
    point = _cad_unique([ctx.resolve(r) for r in projected], 'Projected datum point')
    if _cad_type(point) != 'SketchPoint':
        raise RuntimeError('Datum projection did not return a SketchPoint; inspect partial changes')
    return _geometry_shapes_cast("adsk.fusion.SketchPoint", point), [datum] + _geometry_shapes_cast(
        "list[JsonValue]", datum.get('helpers', []))


def _shapes_generated_cut(ctx: "CadContext", data: "JsonObject",
                          mode: "_geometry_shapes_Literal['bolt_circle', 'slot']") -> "JsonValue":
    """Coordinate datums preserve signed positions without unsigned sketch dimensions."""
    frame = None
    if mode == 'bolt_circle':
        _model_fields(data, ('name', 'pitchDiameter', 'quantity', 'diameter', 'depth'),
                      ('phase', 'reverse', 'participants'))
        for key in ('pitchDiameter', 'diameter', 'depth'):
            if ctx.length(data[key]) <= 0:
                raise ValueError(key + ' must be positive')
        _shapes_count(ctx, data['quantity'])
        phase = _geometry_shapes_cast("str", data.get('phase', '0 deg'))
        ctx.angle(phase)
        radius = '(' + _geometry_shapes_cast("str", data['pitchDiameter']) + ') / 2'
        coordinates = [[radius + ' * cos(' + phase + ')', radius + ' * sin(' + phase + ')', '0 mm']]
        point_names = [_geometry_shapes_cast("str", data['name']) + '__center']
        names = [_geometry_shapes_cast("str", data['name']),
                 _geometry_shapes_cast("str", data['name']) + '__section',
                 _geometry_shapes_cast("str", data['name']) + '__seed']
        _shapes_native(ctx, 'Z', 'axis')
    else:
        _model_fields(data, ('name', 'length', 'width', 'thickness'),
                      ('position', 'angle', 'operation', 'symmetric', 'participants', 'plane', 'frame'))
        if ctx.length(data['width']) <= 0 or ctx.length(data['length']) <= ctx.length(data['width']):
            raise ValueError('Slot requires length > width > 0; length is the overall stadium length')
        if ctx.length(data['thickness']) <= 0:
            raise ValueError('thickness must be positive')
        _model_operation(data)
        angle = _geometry_shapes_cast("str", data.get('angle', '0 deg'))
        ctx.angle(angle)
        position = data.get('position', ['0 mm', '0 mm', '0 mm'])
        ctx.point(position)
        frame = data.get('frame')
        if frame is not None and 'plane' in data and data['plane'] != 'XY':
            raise ValueError('frame and plane are mutually exclusive for generated slots')
        if frame is not None:
            if isinstance(frame, str):
                frame = {'datum': frame}
            if not isinstance(frame, dict) or not frame:
                raise ValueError('frame must be a datum.frame name or frame descriptor')
            if abs(ctx.point(position).z) > 1e-9:
                raise ValueError('frame slot position must be planar (z = 0) in the frame-local plane')
        half = ('((' + _geometry_shapes_cast("str", data['length']) + ') - (' +
                _geometry_shapes_cast("str", data['width']) + ')) / 2')
        coordinates = [[ '(' + _geometry_shapes_cast("list[str] | tuple[str, ...]", position)[0] + ') ' + sign + ' (' + half + ') * cos(' + angle + ')',
                         '(' + _geometry_shapes_cast("list[str] | tuple[str, ...]", position)[1] + ') ' + sign + ' (' + half + ') * sin(' + angle + ')',
                         _geometry_shapes_cast("list[str] | tuple[str, ...]", position)[2] if frame is None else '0 mm']
                       for sign in ('-', '+')]
        point_names = [_geometry_shapes_cast("str", data['name']) + '__start',
                       _geometry_shapes_cast("str", data['name']) + '__end']
        names = [_geometry_shapes_cast("str", data['name']),
                 _geometry_shapes_cast("str", data['name']) + '__section',
                 _geometry_shapes_cast("str", data['name']) + '__plane']
        if not hasattr(adsk.fusion.Sketch, 'addCenterToCenterSlot'):
            raise ValueError('Generated slot requires Fusion Sketch.addCenterToCenterSlot; use the profile alternative on older APIs')
    if ctx.design.designType != _geometry_shapes_cast(
            "adsk.fusion.DesignTypes", adsk.fusion.DesignTypes.ParametricDesignType):
        raise ValueError('Generated slot/bolt_circle requires parametric history for coordinate datums')
    if frame is None:
        _shapes_native(ctx, 'XY', 'plane')
    for coords in coordinates:
        ctx.point(coords)
    participants = data.get('participants')
    if participants is not None:
        if not isinstance(participants, list) or not participants:
            raise ValueError('participants must be a nonempty body reference array')
        for ref in participants:
            _shapes_native(ctx, ref, 'body')
    for point_name in point_names:
        names.extend(_shapes_point_names(point_name))
    _shapes_reserve(ctx, names)
    helpers = _geometry_shapes_cast("list[JsonValue]", [])
    plane = _geometry_shapes_cast("JsonValue", 'XY')
    if mode == 'slot':
        if frame is not None:
            plane = ctx.call('datum.plane', {
                                             'name': _geometry_shapes_cast("str", data['name']) + '__plane', 'mode': 'frame',
                                             'frame': frame, 'associativity': 'snapshot', 'schemaVersion': 1})
        else:
            plane = ctx.call('datum.plane', {
                'name': _geometry_shapes_cast("str", data['name']) + '__plane', 'plane': 'XY',
                'offset': _geometry_shapes_cast("list[str] | tuple[str, ...]",
                                                data.get('position', ['0 mm', '0 mm', '0 mm']))[2]})
        helpers.append(plane)
    sketch = _geometry_shapes_cast("JsonObject", ctx.call('sketch.create', {
        'name': _geometry_shapes_cast("str", data['name']) + '__section', 'plane': plane}))['sketch']
    helpers.append(sketch)
    points = _geometry_shapes_cast("list[adsk.fusion.SketchPoint]", [])
    for point_name, coords in zip(point_names, coordinates):
        point, made = _shapes_linked_point(ctx, sketch, point_name, coords, frame=frame)
        points.append(point)
        helpers.extend(made)
    if mode == 'slot':
        # Seed only: do not rely on the slot helper retaining point/width inputs.
        # Its native shape constraints remain; cap datums and radius drive the size.
        made = ctx.resolve(sketch, 'sketch').addCenterToCenterSlot(
            points[0].geometry, points[1].geometry, ctx.value(data['width']), False)
        if not made:
            raise RuntimeError('Slot creation returned no geometry; inspect partial changes')
        if len(made) < 2 or any(_cad_type(e) != 'SketchArc' for e in made[:2]):
            raise RuntimeError('Slot creation did not return ordered cap arcs; inspect partial changes')
        geometry = [_model_created(ctx, e) for e in made]
        for arc, point in zip(geometry[:2], points):
            ctx.call('sketch.constrain', {'sketch': sketch, 'type': 'coincident',
                'entities': [{'entity': arc, 'point': 'center'}, ctx.ref(point)]})
        dimension = _geometry_shapes_cast("JsonObject", ctx.call('sketch.dimension', {'sketch': sketch, 'type': 'radius',
            'entities': [geometry[0]], 'expression': '(' + _geometry_shapes_cast("str", data['width']) + ') / 2',
            'text': [data['width'], data['width'], '0 mm']}))
        geometry.append(dimension['dimension'])
        profile = _cad_unique(_cad_items(ctx.resolve(sketch, 'sketch').profiles), 'Generated slot profiles')
        payload = {'name': data['name'], 'profile': ctx.ref(profile), 'distance': data['thickness'],
                   'operation': data.get('operation', 'cut'), 'symmetric': data.get('symmetric', False)}
        if participants is not None:
            payload['participants'] = participants
        result = _geometry_shapes_cast("JsonObject", ctx.call('model.extrude', payload))
        result['slotGeometry'] = geometry
    else:
        payload = {'name': _geometry_shapes_cast("str", data['name']) + '__seed', 'points': [ctx.ref(points[0])],
                   'diameter': data['diameter'], 'depth': data['depth'], 'reverse': data.get('reverse', False)}
        if participants is not None:
            payload['participants'] = participants
        seed = _geometry_shapes_cast("JsonObject", ctx.call('model.hole', payload))
        result = _geometry_shapes_cast("JsonObject", ctx.call('pattern.circular', {
                         'name': _geometry_shapes_cast("str", data['name']), 'entities': [seed['feature']],
                          'axis': 'Z', 'quantity': data['quantity'], 'angle': '360 deg'}))
        result['seed'] = seed
    result.update(helpers=helpers, recipe=mode, dependencies='linked expression-driven coordinate datums and native feature dimensions', atomic=False)
    return result


def _shapes_prepare_sketch(ctx: "CadContext", spec: "JsonObject") -> "JsonObject":
    """Validate every label, expression and solver-command schema before adding a sketch."""
    _model_fields(spec, ('geometry',), ('plane', 'constraints', 'dimensions', 'profileIndex', 'inferencePolicy', 'positions'))
    if '_sketch_prepare_geometry' in globals():
        _geometry_shapes_cast("_geometry_shapes_Callable[[CadContext, JsonValue], None]",
                              _sketch_prepare_geometry)(ctx, spec['geometry'])
        _sketch_policy(spec)
    plane = spec.get('plane', 'XY')
    if _cad_type(_shapes_native(ctx, plane)) != 'ConstructionPlane':
        raise ValueError('Generated sketches require a native construction plane')
    geometry = spec['geometry']
    if not isinstance(geometry, list) or not geometry:
        raise ValueError('geometry must be a nonempty array of named primitives')
    labels = {'origin': 'point'}
    points = _geometry_shapes_cast("dict[str, int]", {})
    schemas = {'line': ('start', 'end'), 'arc': ('center', 'start', 'sweep'),
               'arc3': ('start', 'through', 'end'), 'circle': ('center', 'radius'),
               'spline': ('points',), 'point': ('point',), 'ellipse': ('center',),
               'rectangle': ('start', 'end'), 'bezier': ('controlPoints',)}
    for item in geometry:
        if not isinstance(item, dict) or item.get('type') not in schemas:
            raise ValueError('Geometry supports named line, arc, arc3, circle, ellipse, rectangle, bezier, spline or point')
        mode = _geometry_shapes_cast("str", item['type'])
        if mode == 'ellipse':
            _geometry_shapes_cast(
                "_geometry_shapes_Callable[[CadContext, JsonObject], tuple[adsk.core.Point3D, adsk.core.Point3D, adsk.core.Point3D]]",
                _sketch_ellipse_points)(ctx, item)
        else:
            _model_fields(item, ('type', 'name') + schemas[mode], ('construction', 'fixed'))
        name = _geometry_shapes_cast("str", item['name'])
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name) or name in labels:
            raise ValueError('Geometry labels must be unique ASCII identifiers; origin is reserved')
        if mode == 'point' and 'construction' in item:
            raise ValueError('Points cannot be construction geometry')
        labels[name] = mode
        coords = item.get('points') if mode == 'spline' else item.get('controlPoints') if mode == 'bezier' else [item[k] for k in ('start', 'end', 'center', 'through', 'point') if k in item]
        if not isinstance(coords, list) or mode == 'spline' and len(coords) < 2:
            raise ValueError('Spline requires at least two expression points')
        values = _geometry_shapes_cast("list[tuple[float, float]]", [])
        for point in coords:
            p = ctx.point(point)
            if abs(p.z) > 1e-9:
                raise ValueError('Structured sketch geometry must be planar in sketch-local XY; use the plane input for orientation')
            values.append((p.x, p.y))
        if mode in ('line', 'spline') and any(a == b for a, b in zip(values, values[1:])):
            raise ValueError('Consecutive geometry points must be distinct')
        if mode == 'arc':
            if not 0 < abs(ctx.angle(item['sweep'])) < 2 * math.pi or values[0] == values[1]:
                raise ValueError('Arc needs a nonzero radius and sweep with magnitude in (0,360 deg)')
        if mode == 'arc3':
            a, b, c = values
            if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12:
                raise ValueError('arc3 points must be noncollinear')
        if mode == 'circle' and ctx.length(item['radius']) <= 0:
            raise ValueError('Circle radius must be positive')
        if mode == 'spline':
            points[name] = len(coords)
    constraints = spec.get('constraints', [])
    dimensions = spec.get('dimensions', [])
    if not isinstance(constraints, list) or not isinstance(dimensions, list):
        raise ValueError('constraints and dimensions must be arrays')
    constraint_counts = {'coincident': 2, 'collinear': 2, 'concentric': 2, 'midpoint': 2,
        'parallel': 2, 'perpendicular': 2, 'horizontal': 1, 'vertical': 1, 'horizontalPoints': 2,
        'verticalPoints': 2, 'tangent': 2, 'smooth': 2, 'equal': 2, 'symmetry': 3}
    for dimension, command in [(False, c) for c in _geometry_shapes_cast("list[JsonObject]", constraints)] + [(True, d) for d in _geometry_shapes_cast("list[JsonObject]", dimensions)]:
        _model_fields(command, ('type', 'entities') + (('expression',) if dimension else ()),
                      ('text', 'orientation') if dimension else ())
        mode = _geometry_shapes_cast("str", command['type'])
        counts = {'distance': 2, 'angle': 2, 'radius': 1, 'diameter': 1, 'majorRadius': 1, 'minorRadius': 1} if dimension else constraint_counts
        if mode not in counts or not isinstance(command['entities'], list) or len(command['entities']) != counts[mode]:
            raise ValueError('Unsupported solver command type or wrong entity count')
        kinds = _geometry_shapes_cast("list[str]", [])
        for selector in command['entities']:
            if not isinstance(selector, str):
                raise ValueError('Local selectors must be strings: label, label.start/end/center/fitN, or origin')
            name, dot, part = selector.partition('.')
            if name not in labels:
                raise ValueError('Unknown local geometry label: ' + name)
            kind = labels[name]
            if kind == 'rectangle' and dot:
                edge, sep, endpoint = part.partition('.')
                if edge not in ('edge0', 'edge1', 'edge2', 'edge3') or sep and endpoint not in ('start', 'end'):
                    raise ValueError('Rectangle selector requires edge0..edge3, optionally .start/.end')
                kinds.append('point' if sep else 'line')
                continue
            if kind == 'ellipse' and part in ('majorAxis', 'minorAxis'):
                kinds.append('line')
                continue
            if dot:
                allowed = {'line': ('start', 'end'), 'arc': ('start', 'end', 'center'),
                           'arc3': ('start', 'end', 'center'), 'circle': ('center',), 'ellipse': ('center',),
                           'spline': tuple('fit' + str(i) for i in range(points.get(name, 0)))}.get(kind, ())
                if part not in allowed:
                    raise ValueError('Invalid local point selector: ' + selector)
                kind = 'point'
            kinds.append(kind)
        if not dimension:
            lines = ('line',)
            circular = ('arc', 'arc3', 'circle')
            if mode in ('horizontal', 'vertical', 'parallel', 'collinear') and any(k not in lines for k in kinds):
                raise ValueError(mode + ' requires lines')
            if mode in ('horizontalPoints', 'verticalPoints') and any(k != 'point' for k in kinds):
                raise ValueError(mode + ' requires points')
            if mode == 'concentric' and any(k not in circular for k in kinds):
                raise ValueError('concentric requires circular geometry')
            if mode in ('tangent', 'smooth') and 'point' in kinds:
                raise ValueError(mode + ' requires curves')
            if mode == 'coincident' and kinds[0] != 'point':
                raise ValueError('coincident requires a point as its first entity')
            if mode == 'midpoint' and (kinds[0] != 'point' or kinds[1] != 'line'):
                raise ValueError('midpoint requires a point followed by a line')
            if mode == 'perpendicular' and (kinds[0] != 'line' or kinds[1] == 'point'):
                raise ValueError('perpendicular requires a line followed by a curve')
            if mode == 'equal' and not (all(k == 'line' for k in kinds) or all(k in circular for k in kinds)):
                raise ValueError('equal requires two lines or two circular curves')
            if mode == 'symmetry' and (kinds[0] != kinds[1] or kinds[2] != 'line'):
                raise ValueError('symmetry requires two like entities followed by an axis line')
        if dimension:
            expected = {'distance': ('point',), 'angle': ('line',), 'radius': ('arc', 'arc3', 'circle'), 'diameter': ('arc', 'arc3', 'circle'), 'majorRadius': ('ellipse',), 'minorRadius': ('ellipse',)}[mode]
            if any(k not in expected for k in kinds):
                raise ValueError('Dimension selectors have incompatible geometry types')
            value = (ctx.angle if mode == 'angle' else ctx.length)(command['expression'])
            if mode != 'angle' and value <= 0:
                raise ValueError('Dimensions must be positive; use positions for signed coordinates')
            if 'orientation' in command and (mode != 'distance' or command['orientation'] not in ('aligned', 'horizontal', 'vertical')):
                raise ValueError('orientation requires a distance dimension: aligned, horizontal or vertical')
            ctx.point(command.get('text', ['10 mm', '10 mm', '0 mm']))
    if 'profileIndex' in spec and (type(spec['profileIndex']) is not int or spec['profileIndex'] < 0):
        raise ValueError('profileIndex must be a nonnegative integer')
    if 'positions' in spec:
        _geometry_shapes_cast(
            "_geometry_shapes_Callable[[CadContext, JsonObject, dict[str, str]], None]",
            _sketch_prepare_positions)(ctx, spec, labels)
    if '_sketch_order_build_dimensions' in globals():
        _geometry_shapes_cast(
            "_geometry_shapes_Callable[[CadContext, JsonObject], list[JsonObject]]",
            _sketch_order_build_dimensions)(ctx, spec)
    return spec


def _shapes_build_sketch(ctx: "CadContext", name: str, spec: "JsonObject") -> "tuple[JsonValue, dict[str, JsonValue]]":
    sketch = _geometry_shapes_cast("JsonObject", ctx.call(
        'sketch.create', {'name': name, 'plane': spec.get('plane', 'XY')}))['sketch']
    payload = {'sketch': sketch, 'geometry': spec['geometry']}
    if 'inferencePolicy' in spec:
        payload['inferencePolicy'] = spec['inferencePolicy']
    made = _geometry_shapes_cast("JsonObject", ctx.call('sketch.geometry', payload))
    refs = dict(_geometry_shapes_cast("JsonObject", made['refs']),
                origin=ctx.ref(ctx.resolve(sketch, 'sketch').originPoint))
    for item in _geometry_shapes_cast("list[JsonObject]", spec['geometry']):
        if item['type'] == 'rectangle':
            for i, ref in enumerate(_geometry_shapes_cast(
                    "list[JsonValue]", refs[_geometry_shapes_cast("str", item['name'])])):
                refs[_geometry_shapes_cast("str", item['name']) + '.edge' + str(i)] = ref
            continue
        entity = ctx.resolve(refs[_geometry_shapes_cast("str", item['name'])])
        if item['type'] == 'ellipse':
            for axis in ('majorAxis', 'minorAxis'):
                line = _geometry_shapes_cast("adsk.fusion.SketchLine | None", getattr(
                    _geometry_shapes_cast("adsk.fusion.SketchEllipse", entity), axis + 'Line'))
                if line is not None:
                    refs[_geometry_shapes_cast("str", item['name']) + '.' + axis] = ctx.ref(line)
        if item['type'] == 'spline':
            for i, point in enumerate(_cad_items(
                    _geometry_shapes_cast("adsk.fusion.SketchFittedSpline", entity).fitPoints)):
                refs[_geometry_shapes_cast("str", item['name']) + '.fit' + str(i)] = ctx.ref(point)
    for key, op in (('constraints', 'sketch.constrain'), ('dimensions', 'sketch.dimension')):
        commands = _geometry_shapes_cast("list[JsonObject]", _sketch_order_build_dimensions(
            ctx, spec) if key == 'dimensions' and '_sketch_order_build_dimensions' in globals() else spec.get(key, []))
        for command in commands:
            selected = _geometry_shapes_cast("list[JsonValue]", [])
            for selector in _geometry_shapes_cast("list[str]", command['entities']):
                if selector in refs:
                    selected.append(refs[selector])
                else:
                    label, part = selector.rsplit('.', 1)
                    selected.append({'entity': refs[label], 'point': part})
            payload = dict(command, sketch=sketch, entities=selected)
            if key == 'dimensions':
                payload.setdefault('text', ['10 mm', '10 mm', '0 mm'])
            elif command['type'] == 'coincident' and _model_resolve(ctx, selected[0]) == _model_resolve(ctx, selected[1]):
                continue
            ctx.call(op, payload)
    for position in _geometry_shapes_cast("list[JsonObject]", spec.get('positions', [])):
        _geometry_shapes_cast(
            "_geometry_shapes_Callable[[CadContext, JsonValue, dict[str, JsonValue], JsonObject], None]",
            _sketch_bind_position)(ctx, sketch, refs, position)
    return sketch, refs


def _shapes_data_recipe(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonObject":
    if mode == 'revolved_profile':
        _model_fields(data, ('name', 'profileData', 'axis'), ('angle', 'operation'))
        _shapes_native(ctx, data['axis'])
        if not 0 < ctx.angle(data.get('angle', '360 deg')) <= 2 * math.pi:
            raise ValueError('angle must be in (0,360 deg]')
        spec = _shapes_prepare_sketch(ctx, _geometry_shapes_cast("JsonObject", data['profileData']))
        suffix = '__section'
    else:
        _model_fields(data, ('name', 'profile', 'waypoints'),
                      ('plane', 'segments', 'interpolation', 'constraints', 'dimensions', 'operation', 'twist', 'taper'))
        _shapes_native(ctx, data['profile'], 'profile')
        for key in ('twist', 'taper'):
            if key in data:
                ctx.angle(data[key])
        waypoints = data['waypoints']
        if not isinstance(waypoints, list) or len(waypoints) < 2:
            raise ValueError('waypoints requires at least two expression coordinate arrays')
        for point in waypoints:
            ctx.point(point)
        interpolation = data.get('interpolation', 'segments')
        if interpolation not in ('segments', 'spline'):
            raise ValueError('interpolation must be segments or spline')
        if interpolation == 'spline':
            if 'segments' in data:
                raise ValueError('segments cannot be combined with spline interpolation')
            geometry = _geometry_shapes_cast("list[JsonObject]", [
                {'type': 'spline', 'name': 'route0', 'points': waypoints}])
            connections = _geometry_shapes_cast("list[JsonObject]", [])
        else:
            segments = data.get('segments', [{'type': 'line'} for unused in waypoints[1:]])
            if not isinstance(segments, list) or len(segments) != len(waypoints) - 1:
                raise ValueError('segments must have exactly len(waypoints)-1 entries')
            geometry = _geometry_shapes_cast("list[JsonObject]", [])
            for i, segment in enumerate(_geometry_shapes_cast("list[JsonObject]", segments)):
                _model_fields(segment, ('type',), ('through',))
                if segment['type'] not in ('line', 'arc') or ('through' in segment) != (segment['type'] == 'arc'):
                    raise ValueError('Route segment is {type:line} or {type:arc,through:[expressions]}')
                geometry.append(dict({'type': 'arc3' if segment['type'] == 'arc' else 'line',
                    'name': 'route' + str(i), 'start': waypoints[i], 'end': waypoints[i + 1]},
                    **({'through': segment['through']} if 'through' in segment else {})))
            connections = [{'type': 'coincident', 'entities': ['route%d.end' % i, 'route%d.start' % (i + 1)]}
                           for i in range(len(geometry) - 1)]
        constraints = data.get('constraints', [])
        if not isinstance(constraints, list):
            raise ValueError('constraints must be an array')
        spec = _shapes_prepare_sketch(ctx, _geometry_shapes_cast("JsonObject", {
            'plane': data.get('plane', 'XY'), 'geometry': geometry,
            'constraints': connections + constraints,
            'dimensions': data.get('dimensions', [])}))
        suffix = '__route'
    _model_operation(data)
    _shapes_reserve(ctx, [_geometry_shapes_cast("str", data['name']),
                          _geometry_shapes_cast("str", data['name']) + suffix])
    sketch, refs = _shapes_build_sketch(ctx, _geometry_shapes_cast("str", data['name']) + suffix, spec)
    common = {k: data[k] for k in ('name', 'operation', 'twist', 'taper') if k in data}
    if mode == 'revolved_profile':
        selector = {'kind': 'profile', 'sketch': sketch}
        if 'profileIndex' in spec:
            selector['index'] = spec['profileIndex']
        profile = ctx.resolve(selector, 'profile')
        result = _geometry_shapes_cast("JsonObject", ctx.call(
            'model.revolve', dict(common, profile=ctx.ref(profile), axis=data['axis'], angle=data.get('angle', '360 deg'))))
    else:
        path = {'curves': [refs[_geometry_shapes_cast("str", item['name'])]
                           for item in _geometry_shapes_cast("list[JsonObject]", spec['geometry'])], 'chain': 'none'}
        result = _geometry_shapes_cast("JsonObject", ctx.call(
            'model.sweep', dict(common, profile=data['profile'], path=path)))
        result['path'] = path
    result.update(helpers=[sketch], refs=refs, recipe=mode, atomic=False,
        dependencies='Only explicit dimensions, constraints and feature expressions are persistent; raw geometry/waypoint expressions are initial values, not automatically bound',
        isFullyConstrained=ctx.resolve(sketch, 'sketch').isFullyConstrained)
    return result


def _shapes_section(ctx: "CadContext", name: str, plane: "JsonValue",
                    dimensions: "JsonObject") -> "tuple[JsonValue, JsonObject]":
    sketch = _geometry_shapes_cast("JsonObject", ctx.call(
        'sketch.create', {'name': name, 'plane': plane}))['sketch']
    origin = ctx.ref(ctx.resolve(sketch, 'sketch').originPoint)
    zero = ['0 mm', '0 mm', '0 mm']
    if 'width' in dimensions:
        width, depth = _geometry_shapes_cast("tuple[str, str]", (dimensions['width'], dimensions['depth']))
        lines = _geometry_shapes_cast("list[JsonValue]", _geometry_shapes_cast(
            "JsonObject", ctx.call('sketch.geometry', {'sketch': sketch, 'geometry': [
            {'type': 'rectangle', 'start': zero, 'end': [width, depth, '0 mm']} ]}))['entities'])
        ctx.call('sketch.constrain', {'sketch': sketch, 'type': 'coincident',
            'entities': [{'entity': lines[0], 'point': 'start'}, origin]})
        for line, expression in ((lines[0], width), (lines[1], depth)):
            ctx.call('sketch.dimension', {'sketch': sketch, 'type': 'distance',
                'entities': [{'entity': line, 'point': 'start'}, {'entity': line, 'point': 'end'}],
                'text': [width, depth, '0 mm'], 'expression': expression})
    else:
        for expression in dimensions.values():
            circle = _geometry_shapes_cast("list[JsonValue]", _geometry_shapes_cast(
                "JsonObject", ctx.call('sketch.geometry', {'sketch': sketch, 'geometry': [
                {'type': 'circle', 'center': zero, 'radius': expression}]}))['entities'])[0]
            ctx.call('sketch.constrain', {'sketch': sketch, 'type': 'coincident',
                'entities': [{'entity': circle, 'point': 'center'}, origin]})
            ctx.call('sketch.dimension', {'sketch': sketch, 'type': 'radius', 'entities': [circle],
                'text': [expression, expression, '0 mm'], 'expression': expression})
    loops = 2 if len(dimensions) == 2 and 'width' not in dimensions else 1
    # Profile tokens need not round-trip through Fusion's token lookup.
    profile = {'kind': 'profile', 'sketch': sketch, 'loopCount': loops}
    ctx.resolve(profile, 'profile')
    return sketch, profile


def _shapes_primitive(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonObject":
    sizes = {'box': ('width', 'depth', 'height'), 'cylinder': ('radius', 'height'),
             'tube': ('outerRadius', 'innerRadius', 'height'),
             'ring': ('outerRadius', 'innerRadius', 'height'),
             'cone': ('baseRadius', 'topRadius', 'height')}[mode]
    _model_fields(data, ('name',) + sizes, ('plane',))
    for key in sizes:
        if ctx.length(data[key]) <= 0:
            raise ValueError(key + ' must be a positive length expression')
    if mode in ('tube', 'ring') and ctx.length(data['innerRadius']) >= ctx.length(data['outerRadius']):
        raise ValueError('innerRadius must be smaller than outerRadius')
    plane = data.get('plane', 'XY')
    entity = _shapes_native(ctx, plane)
    if _cad_type(entity) != 'ConstructionPlane':
        raise ValueError('Primitive plane must be a construction plane, not a face')
    if ctx.occurrence is not None:
        raise ValueError('Primitive creation requires component scope, not occurrence scope')
    names = [_geometry_shapes_cast("str", data['name']) + '__section']
    if mode == 'cone':
        names += [_geometry_shapes_cast("str", data['name']) + '__top',
                  _geometry_shapes_cast("str", data['name']) + '__topPlane']
    _shapes_reserve(ctx, [_geometry_shapes_cast("str", data['name'])] + names)
    dims = {k: data[k] for k in sizes if k != 'height'}
    if mode == 'cone':
        dims = {'radius': data['baseRadius']}
    sketch, profile = _shapes_section(ctx, names[0], plane, dims)
    if mode == 'cone':
        top_plane = ctx.call('datum.plane', {'name': names[2], 'plane': plane, 'offset': data['height']})
        top_sketch, top = _shapes_section(ctx, names[1], top_plane, {'radius': data['topRadius']})
        result = _geometry_shapes_cast("JsonObject", ctx.call(
            'model.loft', {'name': data['name'], 'profiles': [profile, top]}))
        result['helpers'] = [sketch, top_plane, top_sketch]
    else:
        result = _geometry_shapes_cast("JsonObject", ctx.call(
            'model.extrude', {'name': data['name'], 'profile': profile, 'distance': data['height']}))
        result['helpers'] = [sketch]
    result['recipe'] = mode
    return result


# --- GM10 generic shape library ---


def _shapes_declared_plane(ctx: "CadContext", data: "JsonObject") -> "tuple[JsonValue, bool, JsonValue | None]":
    """Resolve the declared orientation without creating geometry.
    Returns (plane_ref, framed_bool, frame_descriptor_or_None)."""
    if 'frame' in data and 'plane' in data and data['plane'] != 'XY':
        raise ValueError('frame and plane are mutually exclusive for generated recipes')
    if 'frame' in data:
        frame = data['frame']
        if isinstance(frame, str):
            frame = {'datum': frame}
        if not isinstance(frame, dict) or not frame:
            raise ValueError('frame must be a datum.frame name or frame descriptor')
        return data.get('plane', 'XY'), True, frame
    plane = data.get('plane', 'XY')
    _shapes_native(ctx, plane, 'plane')
    return plane, False, None


def _shapes_frame_plane(ctx: "CadContext", plane_name: str, frame: "JsonValue") -> "JsonValue":
    return ctx.call('datum.plane', {'name': plane_name, 'mode': 'frame', 'frame': frame,
                                    'associativity': 'snapshot', 'schemaVersion': 1})




def _shapes_cap_face(ctx: "CadContext", body_ref: object, axis_vector: "tuple[float, float, float]",
                     maximum: bool) -> "adsk.fusion.BRepFace":
    body = ctx.resolve(body_ref, 'body')
    faces = _cad_items(body.faces)
    if not faces:
        raise RuntimeError('Cannot locate the opening face: the body exposes no faces')
    best, best_value = None, None
    for face in faces:
        value = sum(a * b for a, b in zip(_cad_xyz(face.centroid), axis_vector))
        if best is None or (best_value is not None and (
                value > best_value if maximum else value < best_value)):
            best, best_value = face, value
    return _geometry_shapes_cast("adsk.fusion.BRepFace", best)


def _shapes_circular_edges(ctx: "CadContext", body_ref: object,
                           axis_vector: "tuple[float, float, float]") -> "_geometry_shapes_Sequence[adsk.fusion.BRepEdge | None]":
    body = ctx.resolve(body_ref, 'body')
    circular = _geometry_shapes_cast("list[tuple[float, adsk.fusion.BRepEdge]]", [])
    for edge in _cad_items(body.edges):
        geometry = _geometry_shapes_cast("object | None", getattr(edge, 'geometry', None))
        if geometry is None or getattr(geometry, 'center', None) is None or not hasattr(geometry, 'radius'):
            continue
        center = _cad_xyz(_geometry_shapes_cast("adsk.core.Point3D", getattr(geometry, 'center', None)))
        circular.append((sum(a * b for a, b in zip(center, axis_vector)), edge))
    return [edge for value, edge in sorted(circular, key=lambda item: item[0])]


@_cad_scoped_step('shape', native_only=True)
def _shapes_gm10(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonObject":
    return {'annular_segment': _shapes_annular_segment, 'arc_strip': _shapes_arc_strip,
            'can': _shapes_can, 'impeller': _shapes_impeller, 'boss_pattern': _shapes_boss_pattern}[mode](ctx, data)


def _shapes_annular_segment(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'innerRadius', 'outerRadius', 'height'),
                  ('center', 'start', 'sweep', 'plane', 'frame', 'operation', 'participants'))
    for key in ('innerRadius', 'outerRadius', 'height'):
        if ctx.length(data[key]) <= 0:
            raise ValueError(key + ' must be positive')
    if ctx.length(data['innerRadius']) >= ctx.length(data['outerRadius']):
        raise ValueError('innerRadius must be smaller than outerRadius')
    if not 0 < abs(ctx.angle(data.get('sweep', '180 deg'))) < 2 * math.pi:
        raise ValueError('sweep magnitude must be in (0, 360 deg); use shape.ring for a full annulus')
    ctx.angle(data.get('start', '0 deg'))
    center = data.get('center', ['0 mm', '0 mm', '0 mm'])
    if abs(ctx.point(center).z) > 1e-9:
        raise ValueError('center must be planar in the sketch-local XY plane; use plane/frame for orientation')
    _model_operation(data)
    participants = data.get('participants')
    if participants is not None:
        if not isinstance(participants, list) or not participants:
            raise ValueError('participants must be a nonempty body reference array')
        for ref in participants:
            _shapes_native(ctx, ref, 'body')
    plane, framed, frame = _shapes_declared_plane(ctx, data)
    names = [_geometry_shapes_cast("str", data['name']),
             _geometry_shapes_cast("str", data['name']) + '__section'] + (
                 [_geometry_shapes_cast("str", data['name']) + '__plane'] if framed else [])
    _shapes_reserve(ctx, names)
    if framed:
        plane = _shapes_frame_plane(ctx, _geometry_shapes_cast("str", data['name']) + '__plane',
                                    frame)
    cx, cy = (_geometry_shapes_cast("list[str] | tuple[str, ...]", center)[0],
              _geometry_shapes_cast("list[str] | tuple[str, ...]", center)[1])
    start, sweep = _geometry_shapes_cast("tuple[str, str]",
                                         (data.get('start', '0 deg'), data.get('sweep', '180 deg')))
    sweep_end = '((' + start + ') + (' + sweep + '))'

    def at(radius: str, angle_expr: str) -> list[str]:
        return ['(' + cx + ') + (' + radius + ') * cos(' + angle_expr + ')',
                '(' + cy + ') + (' + radius + ') * sin(' + angle_expr + ')', '0 mm']
    spec = _geometry_shapes_cast("JsonObject", {'plane': plane, 'geometry': [
        {'name': 'inner', 'type': 'arc', 'center': center, 'start': at(_geometry_shapes_cast("str", data['innerRadius']), start), 'sweep': sweep},
        {'name': 'outer', 'type': 'arc', 'center': center, 'start': at(_geometry_shapes_cast("str", data['outerRadius']), start), 'sweep': sweep},
        {'name': 'capStart', 'type': 'line', 'start': at(_geometry_shapes_cast("str", data['innerRadius']), start), 'end': at(_geometry_shapes_cast("str", data['outerRadius']), start)},
        {'name': 'capEnd', 'type': 'line', 'start': at(_geometry_shapes_cast("str", data['innerRadius']), sweep_end), 'end': at(_geometry_shapes_cast("str", data['outerRadius']), sweep_end)},
    ], 'constraints': [
        {'type': 'coincident', 'entities': ['capStart.start', 'inner.start']},
        {'type': 'coincident', 'entities': ['capStart.end', 'outer.start']},
        {'type': 'coincident', 'entities': ['capEnd.start', 'inner.end']},
        {'type': 'coincident', 'entities': ['capEnd.end', 'outer.end']},
    ], 'dimensions': [
        {'type': 'radius', 'entities': ['inner'], 'expression': data['innerRadius']},
        {'type': 'radius', 'entities': ['outer'], 'expression': data['outerRadius']},
    ]})
    _shapes_prepare_sketch(ctx, spec)
    sketch, refs = _shapes_build_sketch(ctx, _geometry_shapes_cast("str", data['name']) + '__section', spec)
    profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
    payload = {'name': data['name'], 'profile': ctx.ref(profile), 'distance': data['height'],
               'operation': data.get('operation', 'newBody')}
    if participants is not None:
        payload['participants'] = participants
    result = _geometry_shapes_cast("JsonObject", ctx.call('model.extrude', payload))
    result.update(helpers=[sketch] + ([plane] if framed else []), refs=refs, recipe='annular_segment',
                  diameters={'inner': data['innerRadius'], 'outer': data['outerRadius'],
                             'start': start, 'sweep': sweep},
                  atomic=False, isFullyConstrained=ctx.resolve(sketch, 'sketch').isFullyConstrained,
                  dependencies='Inner/outer radii are driving dimensions; start/sweep expressions initialize geometry only')
    return result


def _shapes_circle_from_points(ctx: "CadContext", start: object, through: object, end: object) -> "tuple[list[str], str, str, str]":
    points = _geometry_shapes_cast("list[tuple[float, float]]", [])
    for value in (start, through, end):
        point = ctx.point(value)
        if abs(point.z) > 1e-9:
            raise ValueError('arc strip threePoints must be planar in sketch-local XY')
        points.append((point.x, point.y))
    (ax, ay), (bx, by), (cx, cy) = points
    denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(denominator) < 1e-12:
        raise ValueError('threePoints must be noncollinear')
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / denominator
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / denominator
    radius = math.hypot(ax - ux, ay - uy)
    a = math.atan2(ay - uy, ax - ux)
    b = math.atan2(by - uy, bx - ux)
    c = math.atan2(cy - uy, cx - ux)
    sweep_ccw = (c - a) % (2 * math.pi)
    b_rel = (b - a) % (2 * math.pi)
    sweep = sweep_ccw if 0 < b_rel < sweep_ccw else -(2 * math.pi - sweep_ccw)
    center = [str(ux) + ' cm', str(uy) + ' cm', '0 mm']
    return center, str(radius) + ' cm', str(a) + ' rad', str(sweep) + ' rad'


def _shapes_arc_strip(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'thickness', 'height'),
                  ('centerline', 'radius', 'start', 'sweep', 'center', 'plane', 'frame', 'operation', 'participants'))
    if ctx.length(data['thickness']) <= 0 or ctx.length(data['height']) <= 0:
        raise ValueError('thickness and height must be positive')
    _model_operation(data)
    participants = data.get('participants')
    if participants is not None:
        if not isinstance(participants, list) or not participants:
            raise ValueError('participants must be a nonempty body reference array')
        for ref in participants:
            _shapes_native(ctx, ref, 'body')
    centerline = data.get('centerline')
    if centerline is not None:
        if not isinstance(centerline, dict):
            raise ValueError('centerline must be an arc or threePoints descriptor')
        if 'radius' in centerline:
            _model_fields(centerline, ('radius',), ('start', 'sweep', 'center'))
            center = centerline.get('center', data.get('center', ['0 mm', '0 mm', '0 mm']))
            start, sweep = centerline.get('start', '0 deg'), centerline.get('sweep', '90 deg')
            radius = centerline['radius']
        else:
            _model_fields(centerline, ('start', 'through', 'end'))
            center, radius, start, sweep = _shapes_circle_from_points(ctx, centerline['start'], centerline['through'], centerline['end'])
    else:
        if 'radius' not in data:
            raise ValueError('Provide a centerline descriptor or a top-level radius')
        center = data.get('center', ['0 mm', '0 mm', '0 mm'])
        start, sweep, radius = data.get('start', '0 deg'), data.get('sweep', '90 deg'), data['radius']
    if not 0 < abs(ctx.angle(sweep)) <= 2 * math.pi:
        raise ValueError('centerline sweep magnitude must be in (0, 360 deg]')
    if abs(ctx.point(center).z) > 1e-9:
        raise ValueError('center must be planar in the sketch-local XY plane')
    plane, framed, frame = _shapes_declared_plane(ctx, data)
    names = [_geometry_shapes_cast("str", data['name']),
             _geometry_shapes_cast("str", data['name']) + '__section'] + (
                 [_geometry_shapes_cast("str", data['name']) + '__plane'] if framed else [])
    _shapes_reserve(ctx, names)
    if framed:
        plane = _shapes_frame_plane(ctx, _geometry_shapes_cast("str", data['name']) + '__plane',
                                    frame)
    cx, cy = (_geometry_shapes_cast("list[str] | tuple[str, ...]", center)[0],
              _geometry_shapes_cast("list[str] | tuple[str, ...]", center)[1])
    inner_radius = ('((' + _geometry_shapes_cast("str", radius) + ') - (' +
                    _geometry_shapes_cast("str", data['thickness']) + ') / 2)')
    outer_radius = ('((' + _geometry_shapes_cast("str", radius) + ') + (' +
                    _geometry_shapes_cast("str", data['thickness']) + ') / 2)')
    sweep_end = '((' + _geometry_shapes_cast("str", start) + ') + (' + _geometry_shapes_cast("str", sweep) + '))'

    def at(radius: str, angle_expr: str) -> list[str]:
        return ['(' + cx + ') + (' + radius + ') * cos(' + angle_expr + ')',
                '(' + cy + ') + (' + radius + ') * sin(' + angle_expr + ')', '0 mm']
    spec = _geometry_shapes_cast("JsonObject", {'plane': plane, 'geometry': [
        {'name': 'inner', 'type': 'arc', 'center': center, 'start': at(inner_radius, _geometry_shapes_cast("str", start)), 'sweep': sweep},
        {'name': 'outer', 'type': 'arc', 'center': center, 'start': at(outer_radius, _geometry_shapes_cast("str", start)), 'sweep': sweep},
        {'name': 'capStart', 'type': 'line', 'start': at(inner_radius, _geometry_shapes_cast("str", start)), 'end': at(outer_radius, _geometry_shapes_cast("str", start))},
        {'name': 'capEnd', 'type': 'line', 'start': at(inner_radius, sweep_end), 'end': at(outer_radius, sweep_end)},
    ], 'constraints': [
        {'type': 'coincident', 'entities': ['capStart.start', 'inner.start']},
        {'type': 'coincident', 'entities': ['capStart.end', 'outer.start']},
        {'type': 'coincident', 'entities': ['capEnd.start', 'inner.end']},
        {'type': 'coincident', 'entities': ['capEnd.end', 'outer.end']},
    ], 'dimensions': [
        {'type': 'radius', 'entities': ['inner'], 'expression': inner_radius},
        {'type': 'radius', 'entities': ['outer'], 'expression': outer_radius},
    ]})
    _shapes_prepare_sketch(ctx, spec)
    sketch, refs = _shapes_build_sketch(ctx, _geometry_shapes_cast("str", data['name']) + '__section', spec)
    profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
    payload = {'name': data['name'], 'profile': ctx.ref(profile), 'distance': data['height'],
               'operation': data.get('operation', 'newBody')}
    if participants is not None:
        payload['participants'] = participants
    result = _geometry_shapes_cast("JsonObject", ctx.call('model.extrude', payload))
    result.update(helpers=[sketch] + ([plane] if framed else []), refs=refs, recipe='arc_strip',
                  centerline={'center': center, 'innerRadius': inner_radius, 'outerRadius': outer_radius,
                              'start': start, 'sweep': sweep},
                  atomic=False, isFullyConstrained=ctx.resolve(sketch, 'sketch').isFullyConstrained,
                  dependencies='Offset radii retain the thickness expression; centerline start/sweep are initial values only')
    return result


def _shapes_can(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'height', 'wallThickness'),
                  ('diameter', 'profileData', 'profile', 'axis', 'plane', 'frame', 'opening', 'radii', 'operation'))
    if ctx.length(data['height']) <= 0 or ctx.length(data['wallThickness']) <= 0:
        raise ValueError('height and wallThickness must be positive')
    if ('diameter' in data) == ('profileData' in data or 'profile' in data):
        raise ValueError('Provide exactly one of diameter or profileData/profile')
    if 'profileData' in data and 'profile' in data:
        raise ValueError('Provide at most one of profileData or profile')
    opening = _geometry_shapes_cast("str", data.get('opening', 'top'))
    if opening not in ('top', 'bottom', 'none'):
        raise ValueError('opening must be top, bottom or none')
    axis = _geometry_shapes_cast("str", data.get('axis', 'Y'))
    _shapes_native(ctx, axis, 'axis')
    radii = data.get('radii', [])
    if not isinstance(radii, list):
        raise ValueError('radii must be an array of fillet radius expressions')
    for radius in radii:
        if ctx.length(radius) <= 0:
            raise ValueError('fillet radii must be positive')
    _model_operation(data)
    plane, framed, frame = _shapes_declared_plane(ctx, data)
    names = [_geometry_shapes_cast("str", data['name']),
             _geometry_shapes_cast("str", data['name']) + '__section'] + (
                 [_geometry_shapes_cast("str", data['name']) + '__plane'] if framed else [])
    _shapes_reserve(ctx, names)
    if framed:
        plane = _shapes_frame_plane(ctx, _geometry_shapes_cast("str", data['name']) + '__plane',
                                    frame)
    sketch = _geometry_shapes_cast("JsonValue | None", None)
    if 'diameter' in data:
        if ctx.length(data['diameter']) <= 0:
            raise ValueError('diameter must be positive')
        radius_expr = '(' + _geometry_shapes_cast("str", data['diameter']) + ') / 2'
        spec = _geometry_shapes_cast("JsonObject", {'plane': plane, 'geometry': [
            {'name': 'axisEdge', 'type': 'line', 'start': ['0 mm', '0 mm', '0 mm'], 'end': ['0 mm', data['height'], '0 mm']},
            {'name': 'lip', 'type': 'line', 'start': ['0 mm', data['height'], '0 mm'], 'end': [radius_expr, data['height'], '0 mm']},
            {'name': 'wall', 'type': 'line', 'start': [radius_expr, data['height'], '0 mm'], 'end': [radius_expr, '0 mm', '0 mm']},
            {'name': 'base', 'type': 'line', 'start': [radius_expr, '0 mm', '0 mm'], 'end': ['0 mm', '0 mm', '0 mm']},
        ], 'constraints': [
            {'type': 'coincident', 'entities': ['axisEdge.start', 'origin']},
            {'type': 'coincident', 'entities': ['axisEdge.end', 'lip.start']},
            {'type': 'coincident', 'entities': ['lip.end', 'wall.start']},
            {'type': 'coincident', 'entities': ['wall.end', 'base.start']},
            {'type': 'coincident', 'entities': ['base.end', 'axisEdge.start']},
            {'type': 'vertical', 'entities': ['axisEdge']},
        ], 'dimensions': [
            {'type': 'distance', 'entities': ['axisEdge.start', 'axisEdge.end'], 'expression': data['height']},
        ]})
    elif 'profileData' in data:
        spec = dict(_geometry_shapes_cast("JsonObject", data['profileData']), plane=plane)
    else:
        spec = None
    if spec is None:
        _shapes_native(ctx, data['profile'], 'profile')
        blank = _geometry_shapes_cast("JsonObject", ctx.call('model.revolve', {
                                           'name': _geometry_shapes_cast("str", data['name']) + '__blank', 'profile': data['profile'],
                                           'axis': axis, 'angle': '360 deg', 'operation': data.get('operation', 'newBody')}))
    else:
        _shapes_prepare_sketch(ctx, spec)
        sketch, refs = _shapes_build_sketch(ctx, _geometry_shapes_cast("str", data['name']) + '__section', spec)
        profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
        blank = _geometry_shapes_cast("JsonObject", ctx.call('model.revolve', {
                                           'name': _geometry_shapes_cast("str", data['name']) + '__blank', 'profile': ctx.ref(profile),
                                           'axis': axis, 'angle': '360 deg', 'operation': data.get('operation', 'newBody')}))
    result = _geometry_shapes_cast("JsonObject", {'blank': blank})
    helpers = [blank['feature']]
    if sketch is not None:
        helpers.append(sketch)
    axis_vector = _shapes_axis_vector(axis)
    if opening != 'none':
        opening_face = _shapes_cap_face(ctx, _geometry_shapes_cast("list[JsonValue]", blank['bodies'])[0], axis_vector, opening == 'top')
        shell = _geometry_shapes_cast("JsonObject", ctx.call('model.shell', {
                                         'name': _geometry_shapes_cast("str", data['name']) + '__shell',
                                         'entities': [ctx.ref(opening_face)], 'thickness': data['wallThickness']}))
        result['shell'] = shell
        helpers.append(shell['feature'])
    if radii:
        edges = _shapes_circular_edges(ctx, _geometry_shapes_cast("list[JsonValue]", blank['bodies'])[0], axis_vector)
        if not edges:
            raise RuntimeError('Cannot locate fillet edges: the body exposes no circular edges')
        fillets = _geometry_shapes_cast("list[JsonValue]", [])
        for radius, edge in zip(radii, edges):
            if edge is None:
                continue
            fillet = _geometry_shapes_cast("JsonObject", ctx.call('model.fillet', {
                'name': _geometry_shapes_cast("str", data['name']) + '__fillet', 'edges': [ctx.ref(edge)],
                'radius': radius}))
            fillets.append(fillet)
            helpers.append(fillet['feature'])
        result['fillets'] = fillets
    result.update(recipe='can', helpers=helpers, atomic=False,
                  dependencies='Blank revolve, shell opening and fillet radii are distinct native features; wall thickness and radii are native expressions')
    return result


def _shapes_impeller(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'hub', 'blade', 'count'),
                  ('shroud', 'disk', 'phase', 'plane', 'frame', 'trim', 'participants', 'axis'))
    if not isinstance(data['hub'], dict) or not isinstance(data['blade'], dict):
        raise ValueError('hub and blade must be descriptors')
    _model_fields(data['hub'], ('diameter', 'height'), ('bore',))
    if ctx.length(data['hub']['diameter']) <= 0 or ctx.length(data['hub']['height']) <= 0:
        raise ValueError('hub diameter and height must be positive')
    _model_fields(data['blade'], (), ('thickness', 'radius', 'innerRadius', 'outerRadius', 'start', 'sweep', 'height', 'centerline', 'center', 'operation', 'plane', 'frame'))
    if 'thickness' not in data['blade'] and not ('innerRadius' in data['blade'] and 'outerRadius' in data['blade']):
        raise ValueError('blade requires thickness, or both innerRadius and outerRadius')
    _shapes_count(ctx, data['count'])
    ctx.angle(data.get('phase', '0 deg'))
    axis = data.get('axis', 'Z')
    _shapes_native(ctx, axis, 'axis')
    plane, framed, frame = _shapes_declared_plane(ctx, data)
    names = [_geometry_shapes_cast("str", data['name']), _geometry_shapes_cast("str", data['name']) + '__hub',
             _geometry_shapes_cast("str", data['name']) + '__hub__section',
             _geometry_shapes_cast("str", data['name']) + '__blade',
             _geometry_shapes_cast("str", data['name']) + '__blade__section'] + (
                 [_geometry_shapes_cast("str", data['name']) + '__hub__plane'] if framed else [])
    _shapes_reserve(ctx, names)
    if framed:
        plane = _shapes_frame_plane(ctx, _geometry_shapes_cast("str", data['name']) + '__hub__plane', frame)
    hub_radius = '(' + _geometry_shapes_cast("str", data['hub']['diameter']) + ') / 2'
    hub = _shapes_primitive(ctx, {'name': _geometry_shapes_cast("str", data['name']) + '__hub', 'radius': hub_radius,
                                  'height': data['hub']['height'], 'plane': plane}, 'cylinder')
    blade_op = data['blade'].get('operation', 'join')
    blade_data = {'name': _geometry_shapes_cast("str", data['name']) + '__blade',
                  'height': data['blade'].get('height', data['hub']['height']),
                  'operation': blade_op}
    for key in ('radius', 'thickness', 'start', 'sweep', 'center', 'centerline', 'plane', 'frame'):
        if key in data['blade']:
            blade_data[key] = data['blade'][key]
    if 'innerRadius' in data['blade'] and 'outerRadius' in data['blade']:
        blade_data['radius'] = '(' + _geometry_shapes_cast("str", data['blade']['innerRadius']) + ' + ' + _geometry_shapes_cast("str", data['blade']['outerRadius']) + ') / 2'
        blade_data['thickness'] = '(' + _geometry_shapes_cast("str", data['blade']['outerRadius']) + ') - (' + _geometry_shapes_cast("str", data['blade']['innerRadius']) + ')'
    elif 'outerRadius' in data['blade']:
        blade_data['radius'] = '(' + _geometry_shapes_cast("str", data['blade']['outerRadius']) + ') - (' + _geometry_shapes_cast("str", blade_data['thickness']) + ') / 2'
    elif 'innerRadius' in data['blade']:
        blade_data['radius'] = '(' + _geometry_shapes_cast("str", data['blade']['innerRadius']) + ') + (' + _geometry_shapes_cast("str", blade_data['thickness']) + ') / 2'
    if 'plane' in data['blade']:
        blade_data['plane'] = data['blade']['plane']
    elif 'frame' in data['blade']:
        blade_data['frame'] = data['blade']['frame']
    else:
        blade_data['plane'] = plane
    if blade_op in ('cut', 'intersect'):
        participants = [_geometry_shapes_cast("list[JsonValue]", hub['bodies'])[0]]
        for ref in _geometry_shapes_cast("list[JsonValue]", data.get('trim', data.get('participants', []))):
            _shapes_native(ctx, ref, 'body')
            participants.append(ref)
        blade_data['participants'] = participants
    blade = _geometry_shapes_cast("JsonObject", ctx.call('shape.arc_strip', blade_data))
    pattern = _geometry_shapes_cast("JsonObject", ctx.call('pattern.circular', {
                                            'name': _geometry_shapes_cast("str", data['name']), 'entities': [blade['feature']],
                                            'axis': axis, 'quantity': data['count'], 'angle': '360 deg'}))
    result = _geometry_shapes_cast("JsonObject", {'hub': hub, 'blade': blade, 'pattern': pattern, 'helpers': [hub['feature'], blade['feature'], pattern['feature']],
              'recipe': 'impeller', 'atomic': False,
              'dependencies': 'Seed blade extrudes joined to the hub body; the circular pattern depends on the blade feature; participants trim the blade against the shroud/disk'})
    if 'shroud' in data or 'disk' in data:
        for key in ('shroud', 'disk'):
            if key not in data:
                continue
            shroud = data[key]
            if not isinstance(shroud, dict):
                raise ValueError(key + ' must be a descriptor')
            _model_fields(shroud, ('profileData',), ('thickness',))
            shroud_spec = _shapes_prepare_sketch(ctx, dict(_geometry_shapes_cast("JsonObject", shroud['profileData']), plane=plane))
            sketch, refs = _shapes_build_sketch(ctx, _geometry_shapes_cast("str", data['name']) + '__' + key, shroud_spec)
            profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
            revolve = _geometry_shapes_cast("JsonObject", ctx.call('model.revolve', {
                'name': _geometry_shapes_cast("str", data['name']) + '__' + key, 'profile': ctx.ref(profile),
                'axis': axis, 'angle': '360 deg', 'operation': 'join'}))
            result[key] = revolve
            _geometry_shapes_cast("list[JsonValue]", result['helpers']).append(revolve['feature'])
    return result


def _shapes_boss_pattern(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('name', 'boss', 'layout'),
                  ('hole', 'insert', 'frame', 'plane', 'phase', 'extent', 'participants', 'axis', 'operation'))
    if not isinstance(data['boss'], dict) or not isinstance(data['layout'], dict):
        raise ValueError('boss and layout must be descriptors')
    _model_fields(data['boss'], ('diameter', 'height'), ())
    if ctx.length(data['boss']['diameter']) <= 0 or ctx.length(data['boss']['height']) <= 0:
        raise ValueError('boss diameter and height must be positive')
    hole = data.get('hole')
    if hole is not None:
        _model_fields(hole, ('diameter', 'depth'), ())
        if ctx.length(_geometry_shapes_cast("JsonObject", hole)['diameter']) <= 0 or ctx.length(_geometry_shapes_cast("JsonObject", hole)['depth']) <= 0:
            raise ValueError('hole diameter and depth must be positive')
    layout = data['layout']
    _model_fields(layout, ('type',), ('direction', 'directionTwo', 'quantity', 'quantityTwo', 'distance',
                                      'distanceTwo', 'axis', 'angle', 'phase', 'positions', 'distanceType'))
    if _geometry_shapes_cast("str", layout['type']) not in ('rectangular', 'circular', 'list'):
        raise ValueError('layout type must be rectangular, circular or list')
    if _geometry_shapes_cast("str", layout['type']) == 'rectangular':
        if not all(k in layout for k in ('direction', 'quantity', 'distance')):
            raise ValueError('rectangular layout requires direction, quantity and distance')
        _shapes_count(ctx, layout['quantity'])
        _shapes_native(ctx, layout['direction'])
        if 'directionTwo' in layout:
            _shapes_native(ctx, layout['directionTwo'])
            _shapes_count(ctx, layout['quantityTwo'])
            ctx.length(layout['distanceTwo'])
        ctx.length(layout['distance'])
    elif _geometry_shapes_cast("str", layout['type']) == 'circular':
        if 'quantity' not in layout:
            raise ValueError('circular layout requires quantity')
        _shapes_count(ctx, layout['quantity'])
        _shapes_native(ctx, layout.get('axis', data.get('axis', 'Z')), 'axis')
    else:
        positions = layout.get('positions')
        if not isinstance(positions, list) or len(positions) < 2:
            raise ValueError('list layout requires at least two positions')
        for position in positions:
            ctx.point(position)
    plane, framed, frame = _shapes_declared_plane(ctx, data)
    names = [_geometry_shapes_cast("str", data['name']),
             _geometry_shapes_cast("str", data['name']) + '__boss',
             _geometry_shapes_cast("str", data['name']) + '__boss__section'] + \
            ([_geometry_shapes_cast("str", data['name']) + '__boss__plane'] if framed else [])
    if hole is not None:
        names.append(_geometry_shapes_cast("str", data['name']) + '__hole')
    _shapes_reserve(ctx, names)
    if framed:
        plane = _shapes_frame_plane(ctx, _geometry_shapes_cast("str", data['name']) + '__boss__plane', frame)
    boss_radius = '(' + _geometry_shapes_cast("str", data['boss']['diameter']) + ') / 2'
    boss = _shapes_primitive(ctx, {'name': _geometry_shapes_cast("str", data['name']) + '__boss', 'radius': boss_radius,
                                   'height': data['boss']['height'], 'plane': plane}, 'cylinder')
    seed = [boss['feature']]
    made_hole = _geometry_shapes_cast("JsonObject | None", None)
    if hole is not None:
        boss_sketch = ctx.resolve(_geometry_shapes_cast("list[JsonValue]", boss['helpers'])[0], 'sketch')
        hole_payload = {'name': _geometry_shapes_cast("str", data['name']) + '__hole',
                        'points': [ctx.ref(boss_sketch.originPoint)],
                        'diameter': _geometry_shapes_cast("JsonObject", hole)['diameter'],
                        'depth': _geometry_shapes_cast("JsonObject", hole)['depth'], 'reverse': True,
                        'participants': [_geometry_shapes_cast("list[JsonValue]", boss['bodies'])[0]]}
        made_hole = _geometry_shapes_cast("JsonObject", ctx.call('model.hole', hole_payload))
        seed.append(made_hole['feature'])
    if _geometry_shapes_cast("str", layout['type']) == 'rectangular':
        payload = {'name': _geometry_shapes_cast("str", data['name']), 'entities': seed, 'direction': layout['direction'],
                   'quantity': layout['quantity'], 'distance': layout['distance']}
        if 'distanceType' in layout:
            payload['distanceType'] = layout['distanceType']
        if 'directionTwo' in layout:
            payload.update(directionTwo=layout['directionTwo'], quantityTwo=layout['quantityTwo'], distanceTwo=layout['distanceTwo'])
        pattern = _geometry_shapes_cast("JsonObject", ctx.call('pattern.rectangular', payload))
    elif _geometry_shapes_cast("str", layout['type']) == 'circular':
        axis = layout.get('axis', data.get('axis', 'Z'))
        pattern = _geometry_shapes_cast("JsonObject", ctx.call('pattern.circular', {
            'name': _geometry_shapes_cast("str", data['name']), 'entities': seed, 'axis': axis,
            'quantity': layout['quantity'], 'angle': layout.get('angle', '360 deg')}))
    else:
        pattern = {'feature': seed, 'positions': layout['positions'], 'recipe': 'list',
                   'note': 'Explicit per-position seed copies; the seed boss/hole are the persistent dependencies'}
    result = _geometry_shapes_cast("JsonObject", {'boss': boss, 'pattern': pattern})
    if hole is not None:
        result['hole'] = made_hole
    result.update(helpers=[boss['feature']] + ([_geometry_shapes_cast("JsonObject", made_hole)['feature']] if hole is not None else []) + ([pattern['feature']] if _geometry_shapes_cast("str", layout['type']) != 'list' else []),
                  recipe='boss_pattern', atomic=False,
                  dependencies='Seed boss is a dimension-driven cylinder; the hole (when present) depends on the boss body; the pattern depends on the seed feature(s)')
    return result
