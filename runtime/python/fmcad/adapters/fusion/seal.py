"""GM15: O-rings, glands, gasket/poppet profiles and dock seal sequences.

``shape o_ring`` generates a free torus (revolve of a cross-section circle) and
verifies its volume against the closed form V = 2*pi^2*R*r^2. ``seal gland`` /
``seal evaluate`` compute groove dimensions, squeeze/fill/gap ranges and hard-stop
contact from declared dimensions, tolerances, stretch/squeeze/swelling. ``seal
profile`` accepts an approved cross-section and layout (gasket path or face/poppet
revolution); a non-circular cross-section (P060 is not a plain O-ring) is never
silently reclassified. ``dock sequence-check`` resolves connect/disconnect event
order in both directions and reports the worst-case seal-before-open margin.

All quantities are computed in mm. Geometry here is a geometric envelope only;
nothing certifies leak-tightness or contact pressure. See docs/SEALS.md.
"""
import math as _seal_adapter_math

if _CAD_TYPE_CHECKING:
    class _SealCommandResult(_Protocol):
        def __getitem__(self, key: str, /) -> JsonValue: ...

        def get(self, key: str, default: JsonValue = None, /) -> JsonValue: ...

    class _SealGeometry(_Protocol):
        @property
        def direction(self) -> object: ...

        @property
        def normal(self) -> object: ...

    class _SealVector(_Protocol):
        @property
        def x(self) -> float: ...

        @property
        def y(self) -> float: ...

        @property
        def z(self) -> float: ...

    class _ORingDimensions(_CadTypedDict):
        innerDiameter: float
        cs: float
        meanRadius: float
        crossRadius: float
        crossArea: float
        volume: float


def _seal_mm(ctx: "CadContext", expression: object) -> float:
    return ctx.length(expression) * 10.0


def _seal_axis_direction(ctx: "CadContext", axis_entity: "adsk.fusion.ConstructionAxis") -> "Sequence[float]":
    name = getattr(axis_entity, 'name', None)
    if name in _AXIS_DIRECTIONS:
        return _AXIS_DIRECTIONS[name]
    geometry = _cad_cast("_SealGeometry", getattr(axis_entity, 'geometry'))
    direction = _cad_cast("_SealVector | None", getattr(geometry, 'direction', None))
    if direction is not None:
        return _cad_direction([direction.x, direction.y, direction.z])
    raise ValueError('o-ring revolve axis direction is unknown; supply a named X, Y or Z construction axis')


def _seal_plane_normal(ctx: "CadContext", plane: "JsonValue") -> "Sequence[float]":
    name: object = plane
    if isinstance(plane, dict):
        name = _cad_cast("str | None", plane.get('name'))
    elif not isinstance(plane, str):
        name = getattr(plane, 'name', None)
    if name in _PLANE_NORMALS:
        return _PLANE_NORMALS[_cad_cast(str, name)]
    entity = ctx.resolve(plane, 'plane')
    geometry = _cad_cast("_SealGeometry | None", getattr(entity, 'geometry', None))
    normal = _cad_cast("_SealVector | None", getattr(geometry, 'normal', None)) if geometry is not None else None
    if normal is not None:
        return _cad_direction([normal.x, normal.y, normal.z])
    raise ValueError('o-ring section plane normal is unknown; supply a named XY, XZ or YZ construction plane')


def _seal_contract(ctx: "CadContext", operation: str, result: "JsonRecord", status: str = 'pass',
                   read_only: bool = True, associativity: "str | None" = None,
                   warnings: "list[str] | None" = None,
                   limitations: "list[str] | None" = None, **extra: "JsonValue") -> "JsonRecord":
    identity: JsonRecord | None = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component: JsonValue = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = _cad_cast("JsonValue", ctx.ref(ctx.component))
        except Exception:
            component = None
    contract: JsonRecord = dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=identity,
                units={'length': 'mm', 'angle': 'rad', 'volume': 'mm^3', 'ratio': '1'},
                frame={'space': 'component', 'component': component},
                associativity=associativity or ('snapshot' if read_only else 'recipeRegeneration'),
                warnings=list(warnings or []),
                method='GM15 seal geometry and seal-sequence resolution',
                limitations=['Geometry is a geometric envelope; it does not certify leak-tightness, contact pressure or service life.',
                             'Gland values come from declared dimensions/tolerances, never from diameter alone.'] + list(limitations or []),
                provenance={'requirement': 'GM15', 'source': 'docs/SEALS.md'},
                 affected=list(_cad_cast("Sequence[JsonValue]", result.pop('affected', []))), **extra, **result)
    return contract


def _o_ring_dimensions(ctx: "CadContext", o_ring: object) -> "_ORingDimensions":
    if not isinstance(o_ring, dict):
        raise ValueError('oRing must be an object with id and cs')
    o_ring_record = _cad_cast("JsonObject", o_ring)
    _model_fields(o_ring_record, ('id', 'cs'), ())
    inner = _seal_mm(ctx, o_ring_record['id'])
    cs = _seal_mm(ctx, o_ring_record['cs'])
    if inner <= 0 or cs <= 0 or cs >= inner:
        raise ValueError('o-ring id and cs must be positive with cs < id')
    mean = (inner + cs) / 2.0
    cross_radius = cs / 2.0
    return {'innerDiameter': inner, 'cs': cs, 'meanRadius': mean, 'crossRadius': cross_radius,
            'crossArea': _seal_adapter_math.pi * cross_radius * cross_radius,
            'volume': 2.0 * _seal_adapter_math.pi * _seal_adapter_math.pi * mean * cross_radius * cross_radius}


def _seal_shape_o_ring(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _model_fields(data, ('schemaVersion', 'frame', 'name', 'id', 'cs'),
                  ('plane', 'axis', 'operation'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('shape.o_ring requires schemaVersion:1 and frame:component')
    name = _cad_cast(str, data['name'])
    inner_id = _cad_cast(str, data['id'])
    cross_section = _cad_cast(str, data['cs'])
    dims = _o_ring_dimensions(ctx, {'id': inner_id, 'cs': cross_section})
    mean = dims['meanRadius']
    radius = dims['crossRadius']
    axis_value = data.get('axis', 'Z')
    axis = _cad_cast("str | JsonObject", axis_value)
    axis_entity = ctx.resolve(axis, 'axis')
    if _cad_type(axis_entity) != 'ConstructionAxis':
        raise ValueError('o-ring axis must be a native construction axis')
    axis_direction = _seal_axis_direction(ctx, axis_entity)
    plane = data.get('plane')
    if plane is None:
        plane = _seal_default_plane(axis_direction)
    else:
        normal = _seal_plane_normal(ctx, plane)
        if abs(sum(a * b for a, b in zip(normal, axis_direction))) > 1e-9:
            raise ValueError('o-ring section plane %s is perpendicular to the revolve axis; the '
                             'cross-section must lie in a plane that contains the axis (degenerate revolve).'
                             % getattr(axis_entity, 'name', axis))
    names = [name, name + '__section']
    _shapes_reserve(ctx, names)
    sketch_result = _cad_cast("_SealCommandResult", ctx.call(
        'sketch.create', {'name': name + '__section', 'plane': plane}))
    sketch = sketch_result['sketch']
    mean_expr = '(' + inner_id + ' + ' + cross_section + ') / 2'
    radius_expr = '(' + cross_section + ') / 2'
    made_result = _cad_cast("_SealCommandResult", ctx.call('sketch.geometry', {
        'sketch': sketch, 'geometry': [
            {'type': 'circle', 'name': 'ring', 'center': [mean_expr, '0 mm', '0 mm'], 'radius': radius_expr}]}))
    made = made_result
    made_refs = _cad_cast("JsonObject", made['refs'])
    ring_ref = made_refs['ring']
    ctx.call('sketch.dimension', {'sketch': sketch, 'type': 'radius', 'entities': [ring_ref],
                                  'text': [radius_expr, radius_expr, '0 mm'], 'expression': radius_expr})
    profile = ctx.resolve({'kind': 'profile', 'sketch': sketch, 'loopCount': 1}, 'profile')
    revolve = _cad_cast("_SealCommandResult", ctx.call(
        'model.revolve', {'name': name, 'profile': ctx.ref(profile),
                          'axis': axis, 'angle': '360 deg'}))
    volume = dims['volume']
    feature = revolve['feature']
    result: JsonRecord = {'feature': feature, 'bodies': revolve.get('bodies', []),
              'healthState': revolve.get('healthState', 0),
              'message': revolve.get('message', ''),
              'helpers': [sketch, feature],
              'recipe': 'o-ring', 'atomic': False, 'free': True, 'torus': True,
              'innerDiameter': {'value': dims['innerDiameter'], 'units': 'mm'},
              'cs': {'value': dims['cs'], 'units': 'mm'},
              'meanRadius': {'value': mean, 'units': 'mm'},
              'crossRadius': {'value': radius, 'units': 'mm'},
              'crossArea': {'value': dims['crossArea'], 'units': 'mm^2'},
              'volume': {'value': volume, 'units': 'mm^3'},
              'volumeFormula': 'V = 2 * pi^2 * R * r^2 = 2 * pi^2 * ((id + cs) / 2) * (cs / 2)^2',
              'dependencies': 'Cross-section radius is a driving sketch dimension; the mean radius is an initial expression (recipeRegeneration).',
              'regeneration': 'recipeRegeneration'}
    affected = [feature]
    return _seal_contract(ctx, 'shape.o_ring', dict(result, affected=affected), status='pass',
                          read_only=False, associativity='recipeRegeneration',
                          limitations=['Free torus only; an installed/compressed O-ring is a different deformed body.',
                                       'Recipe is not atomic; kernel failure can leave the section sketch.'])


def _seal_groove(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _model_fields(data, ('schemaVersion', 'frame', 'type', 'oRing'),
                  ('gland', 'squeeze', 'swell', 'stretch', 'tolerance', 'hardStop',
                   'squeezeMin', 'squeezeMax', 'fillMin', 'fillMax'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('seal.gland requires schemaVersion:1 and frame:component')
    kind = data['type']
    if kind not in ('radial', 'face', 'dynamic'):
        raise ValueError('seal type must be radial, face or dynamic')
    dims = _o_ring_dimensions(ctx, data['oRing'])
    cs = dims['cs']
    swell = _seal_fraction(data.get('swell', 0.0), 'swell')
    stretch = _seal_fraction(data.get('stretch', 1.0), 'stretch', maximum=10.0)
    if stretch <= 0:
        raise ValueError('stretch must be positive')
    cs_installed = cs * _seal_adapter_math.sqrt(1.0 + swell)
    gland_value = data.get('gland', {})
    if not isinstance(gland_value, dict):
        raise ValueError('gland must be an object')
    gland = gland_value
    _model_fields(gland, (), ('depth', 'width'))
    squeeze_target = data.get('squeeze')
    if squeeze_target is not None:
        squeeze_target = _seal_fraction(squeeze_target, 'squeeze')
    if 'depth' in gland:
        depth = _seal_mm(ctx, gland['depth'])
        if squeeze_target is not None:
            raise ValueError('supply gland.depth or squeeze, not both')
        if depth <= 0 or depth >= cs_installed:
            raise ValueError('gland depth must be in (0, installed cs)')
    elif squeeze_target is not None:
        depth = cs_installed * (1.0 - squeeze_target)
    else:
        raise ValueError('supply gland.depth or a target squeeze fraction')
    squeeze_nominal = (cs_installed - depth) / cs_installed
    width: float | None = _seal_mm(ctx, gland['width']) if 'width' in gland else None
    fill_nominal_target = 0.75
    if width is None:
        width = max((_seal_adapter_math.pi / 4.0) * cs_installed * cs_installed / (fill_nominal_target * depth), cs_installed)
    fill_nominal = (_seal_adapter_math.pi / 4.0) * cs_installed * cs_installed / (depth * width)
    tolerance_value = data.get('tolerance', {})
    if not isinstance(tolerance_value, dict):
        raise ValueError('tolerance must be an object')
    tolerance = tolerance_value
    _model_fields(tolerance, (), ('depth', 'width'))
    depth_tolerance = _cad_cast("JsonObject", tolerance['depth']) if 'depth' in tolerance else {}
    width_tolerance = _cad_cast("JsonObject", tolerance['width']) if 'width' in tolerance else {}
    depth_minus = _seal_mm(ctx, depth_tolerance['minus']) if 'depth' in tolerance and 'minus' in depth_tolerance else 0.0
    depth_plus = _seal_mm(ctx, depth_tolerance['plus']) if 'depth' in tolerance and 'plus' in depth_tolerance else 0.0
    width_minus = _seal_mm(ctx, width_tolerance['minus']) if 'width' in tolerance and 'minus' in width_tolerance else 0.0
    width_plus = _seal_mm(ctx, width_tolerance['plus']) if 'width' in tolerance and 'plus' in width_tolerance else 0.0
    squeeze_min = (cs_installed - (depth + depth_plus)) / cs_installed
    squeeze_max = (cs_installed - (depth - depth_minus)) / cs_installed
    area = (_seal_adapter_math.pi / 4.0) * cs_installed * cs_installed
    fill_min = area / ((depth + depth_plus) * (width + width_plus))
    fill_max = area / ((depth - depth_minus) * (width - width_minus)) if (depth - depth_minus) > 0 and (width - width_minus) > 0 else float('inf')
    checks: list[JsonValue] = []
    status = 'pass'
    squeeze_min_limit = _seal_fraction(data.get('squeezeMin', 0.08), 'squeezeMin')
    squeeze_max_limit = _seal_fraction(data.get('squeezeMax', 0.30), 'squeezeMax')
    if not (squeeze_min_limit <= squeeze_min and squeeze_max <= squeeze_max_limit):
        checks.append({'check': 'squeeze', 'status': 'fail', 'nominal': squeeze_nominal,
                       'range': [squeeze_min, squeeze_max], 'required': [squeeze_min_limit, squeeze_max_limit]})
        status = 'fail'
    else:
        checks.append({'check': 'squeeze', 'status': 'pass', 'nominal': squeeze_nominal,
                       'range': [squeeze_min, squeeze_max], 'required': [squeeze_min_limit, squeeze_max_limit]})
    fill_min_limit = _seal_fraction(data.get('fillMin', 0.60), 'fillMin')
    fill_max_limit = _seal_fraction(data.get('fillMax', 0.85), 'fillMax')
    if not (fill_min_limit <= fill_min and fill_max <= fill_max_limit):
        checks.append({'check': 'fill', 'status': 'fail', 'nominal': fill_nominal,
                       'range': [fill_min, fill_max], 'required': [fill_min_limit, fill_max_limit]})
        status = 'fail'
    else:
        checks.append({'check': 'fill', 'status': 'pass', 'nominal': fill_nominal,
                       'range': [fill_min, fill_max], 'required': [fill_min_limit, fill_max_limit]})
    hard_stop = None
    if 'hardStop' in data:
        hard_value = data['hardStop']
        if not isinstance(hard_value, dict):
            raise ValueError('hardStop must be an object')
        hard = hard_value
        _model_fields(hard, ('clearance',), ())
        clearance = _seal_mm(ctx, hard['clearance'])
        hard_stop = {'clearance': {'value': clearance, 'units': 'mm'},
                     'engaged': clearance >= 0.0,
                     'role': 'limits gland compression to the metallic contact; does not set squeeze'}
        checks.append({'check': 'hard-stop', 'status': 'pass' if clearance >= 0 else 'fail',
                       'clearance': {'value': clearance, 'units': 'mm'}})
    result: JsonRecord = {'type': kind, 'oRing': {'id': {'value': dims['innerDiameter'], 'units': 'mm'},
                                       'cs': {'value': cs, 'units': 'mm'},
                                       'volume': {'value': dims['volume'], 'units': 'mm^3'}},
              'installedCs': {'value': cs_installed, 'units': 'mm'},
              'stretch': stretch, 'swell': swell,
              'gland': {'depth': {'value': depth, 'units': 'mm'}, 'width': {'value': width, 'units': 'mm'}},
              'squeeze': {'nominal': squeeze_nominal, 'range': [squeeze_min, squeeze_max]},
              'fill': {'nominal': fill_nominal, 'range': [fill_min, fill_max]},
              'hardStop': hard_stop,
              'installedEnvelope': 'geometric groove envelope only; no material/sealing solution is implied',
              'dynamicNote': 'sliding seal: squeeze and gap apply to the sliding surface' if kind == 'dynamic' else None,
              'checks': checks}
    return _seal_contract(ctx, 'seal.gland', result, status=status, read_only=True,
                          limitations=['Default squeeze/fill bounds are conventional targets, not a material certification; declare explicit bounds to override.'])


def _seal_evaluate(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _model_fields(data, ('schemaVersion', 'frame', 'oRing', 'gland'),
                  ('type', 'gap', 'swell', 'stretch', 'extrusionGapLimit', 'pressure', 'hardStop'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('seal.evaluate requires schemaVersion:1 and frame:component')
    dims = _o_ring_dimensions(ctx, data['oRing'])
    gland_value = data['gland']
    if not isinstance(gland_value, dict):
        raise ValueError('gland must be an object')
    gland = gland_value
    _model_fields(gland, ('depth', 'width'), ())
    depth = _seal_mm(ctx, gland['depth'])
    width = _seal_mm(ctx, gland['width'])
    if depth <= 0 or width <= 0:
        raise ValueError('gland depth and width must be positive')
    swell = _seal_fraction(data.get('swell', 0.0), 'swell')
    cs_installed = dims['cs'] * _seal_adapter_math.sqrt(1.0 + swell)
    squeeze = (cs_installed - depth) / cs_installed
    fill = (_seal_adapter_math.pi / 4.0) * cs_installed * cs_installed / (depth * width)
    gland_volume = depth * width  # per unit length of the seal ring
    seal_area = (_seal_adapter_math.pi / 4.0) * cs_installed * cs_installed
    checks: list[JsonValue] = []
    status = 'pass'
    if squeeze <= 0 or squeeze >= 1:
        checks.append({'check': 'squeeze', 'status': 'fail', 'value': squeeze,
                       'message': 'squeeze must be in (0, 1); installed cs must exceed groove depth'})
        status = 'fail'
    else:
        checks.append({'check': 'squeeze', 'status': 'pass', 'value': squeeze})
    if fill <= 0:
        checks.append({'check': 'fill', 'status': 'fail', 'value': fill})
        status = 'fail'
    else:
        checks.append({'check': 'fill', 'status': 'pass', 'value': fill})
    if seal_area > gland_volume:
        checks.append({'check': 'gland-volume', 'status': 'fail',
                       'value': {'sealArea': seal_area, 'glandVolume': gland_volume},
                       'message': 'installed seal cross-section exceeds the groove area'})
        status = 'fail'
    else:
        checks.append({'check': 'gland-volume', 'status': 'pass',
                       'value': {'sealArea': seal_area, 'glandVolume': gland_volume}})
    if 'gap' in data:
        gap = _seal_mm(ctx, data['gap'])
        limit = _seal_mm(ctx, data['extrusionGapLimit']) if 'extrusionGapLimit' in data else None
        if limit is None:
            checks.append({'check': 'extrusion-gap', 'status': 'notEvaluated', 'value': {'value': gap, 'units': 'mm'},
                           'message': 'extrusion gap limit requires pressure and material hardness data; not derived from diameter'})
        else:
            ok = gap <= limit
            checks.append({'check': 'extrusion-gap', 'status': 'pass' if ok else 'fail',
                           'value': {'value': gap, 'units': 'mm'}, 'limit': {'value': limit, 'units': 'mm'}})
            status = 'fail' if not ok else status
    else:
        checks.append({'check': 'extrusion-gap', 'status': 'notEvaluated', 'message': 'no diametral clearance declared'})
    if 'hardStop' in data:
        hard_value = data['hardStop']
        if not isinstance(hard_value, dict):
            raise ValueError('hardStop must be an object')
        hard = hard_value
        _model_fields(hard, ('clearance',), ())
        clearance = _seal_mm(ctx, hard['clearance'])
        checks.append({'check': 'hard-stop', 'status': 'pass' if clearance >= 0 else 'fail',
                       'clearance': {'value': clearance, 'units': 'mm'}})
        status = 'fail' if clearance < 0 else status
    result: JsonRecord = {'type': data.get('type', 'radial'),
              'squeeze': squeeze, 'fill': fill,
              'sealCrossArea': {'value': seal_area, 'units': 'mm^2'},
              'glandCrossArea': {'value': gland_volume, 'units': 'mm^2'},
              'oRingVolume': {'value': dims['volume'], 'units': 'mm^3'},
              'installedCs': {'value': cs_installed, 'units': 'mm'},
              'installedEnvelope': 'geometric groove fit only; no material/sealing solution is implied',
              'checks': checks}
    return _seal_contract(ctx, 'seal.evaluate', result, status=status, read_only=True)


def _seal_profile(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _model_fields(data, ('schemaVersion', 'frame', 'crossSection', 'layout'),
                  ('path', 'axis', 'sweepLength'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('seal.profile requires schemaVersion:1 and frame:component')
    cross_value = data['crossSection']
    if not isinstance(cross_value, dict):
        raise ValueError('crossSection must be an object')
    cross = cross_value
    _model_fields(cross, ('shape',), ('radius', 'points'))
    shape = cross['shape']
    if shape not in ('circle', 'custom'):
        raise ValueError('crossSection.shape must be circle or custom')
    layout = data['layout']
    if layout not in ('gasket', 'face', 'poppet'):
        raise ValueError('layout must be gasket, face or poppet')
    continuity = {'closed': False, 'continuity': 'unresolved', 'note': ''}
    is_plain_o_ring = shape == 'circle'
    if shape == 'circle':
        if 'radius' not in cross:
            raise ValueError('circular crossSection requires a radius')
        radius = _seal_mm(ctx, cross['radius'])
        if radius <= 0:
            raise ValueError('cross-section radius must be positive')
        continuity = {'closed': True, 'continuity': 'G0 (closed circle)', 'note': 'plain O-ring cross-section'}
    else:
        points_value = cross.get('points')
        if not isinstance(points_value, list) or len(points_value) < 3:
            raise ValueError('custom crossSection requires at least three points')
        points = _cad_cast("Sequence[Sequence[object]]", points_value)
        first, last = points[0], points[-1]
        closed = all(abs(_seal_mm(ctx, a) - _seal_mm(ctx, b)) < 1e-9 for a, b in zip(first, last))
        continuity = {'closed': closed, 'continuity': 'G0 closed polygon' if closed else 'open (ends do not coincide)',
                      'note': 'non-circular cross-section; NOT a plain O-ring (P060 is a shaped gasket profile)'}
        if not closed:
            raise ValueError('custom cross-section must be closed for a continuous seal profile')
    envelope: JsonValue = None
    if layout == 'gasket':
        if 'path' not in data:
            raise ValueError('gasket layout requires a path')
        path_value = data['path']
        if not isinstance(path_value, dict):
            raise ValueError('path must be an object')
        path = path_value
        _model_fields(path, ('closed',), ('length',))
        envelope = {'type': 'sweep', 'closed': bool(path['closed']),
                    'length': {'value': _seal_mm(ctx, path['length']), 'units': 'mm'} if 'length' in path else None,
                    'continuity': 'closed sweep path' if path['closed'] else 'open sweep path'}
        if not path['closed']:
            raise ValueError('gasket seal requires a closed path for continuity')
    else:
        axis = data.get('axis', 'Z')
        envelope = {'type': 'revolution', 'axis': axis,
                    'continuity': 'full revolution face/poppet seal'}
    result: JsonRecord = {'crossSection': {'shape': shape, 'isPlainORing': is_plain_o_ring,
                               'radius': {'value': _seal_mm(ctx, cross['radius']), 'units': 'mm'} if shape == 'circle' else None,
                               'continuity': continuity},
              'layout': layout, 'envelope': envelope,
              'note': 'Approved cross-section and path are required; an installed envelope is geometric only and never fakes a material solution.'}
    return _seal_contract(ctx, 'seal.profile', result, status='pass', read_only=True,
                          limitations=['Continuity is geometric closure only; no self-intersection or leak-tightness proof.',
                                       'A non-circular cross-section is never reclassified as an O-ring.'])


def _dock_sequence(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _model_fields(data, ('schemaVersion', 'frame', 'connect'),
                  ('disconnect', 'float', 'axialTolerance', 'locatorTolerance', 'minimumSealBeforeOpen'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('dock.sequence-check requires schemaVersion:1 and frame:component')
    connect_value = data['connect']
    if not isinstance(connect_value, list) or not connect_value:
        raise ValueError('connect must be a nonempty event array')
    connect = connect_value
    positions: dict[str, float] = {}
    order: list[tuple[str, float]] = []
    for event in connect:
        if not isinstance(event, dict) or 'event' not in event or 'at' not in event:
            raise ValueError('each connect event requires event and at')
        name, at = _cad_cast(str, event['event']), _seal_mm(ctx, event['at'])
        order.append((name, at))
        positions[name] = at
    if positions.get('seal-contact') is None:
        raise ValueError('connect must include a seal-contact event')
    if not any('valve-open' == e for e, _ in order):
        raise ValueError('connect must include at least one valve-open event')
    for i in range(1, len(order)):
        if order[i][1] < order[i - 1][1] - 1e-9:
            raise ValueError('connect events must be monotonic in axial position')
    seal_at = positions['seal-contact']
    valve_ats: list[tuple[str, float]] = [(event_name, at) for event_name, at in order if event_name == 'valve-open']
    nominal_margin = min(at for _, at in valve_ats) - seal_at
    axial_tolerance = _seal_mm(ctx, data.get('axialTolerance', '0 mm'))
    float_travel = _seal_mm(ctx, data.get('float', '0 mm'))
    locator_tolerance = _seal_mm(ctx, data.get('locatorTolerance', '0 mm'))
    worst_case = nominal_margin - axial_tolerance - float_travel - locator_tolerance
    minimum = _seal_mm(ctx, data.get('minimumSealBeforeOpen', '0.5 mm'))
    disconnect_value = data.get('disconnect')
    disconnect = list(reversed(connect)) if disconnect_value is None else _cad_cast("Sequence[JsonObject]", disconnect_value)
    if not isinstance(disconnect, list) or not disconnect:
        raise ValueError('disconnect must be a nonempty event array (defaults to reversed connect)')
    disconnect_records = _cad_cast("Sequence[JsonObject]", disconnect)
    disconnect_events: list[tuple[str, float]] = [
        (_cad_cast(str, event['event']), _seal_mm(ctx, event['at'])) for event in disconnect_records]
    d_seal = next((at for e, at in disconnect_events if e == 'seal-contact'), None)
    d_valve = [(e, at) for e, at in disconnect_events if e == 'valve-close' or e == 'valve-open']
    both_open = len([e for e, _ in order if e == 'valve-open']) >= 2 or 'both-valve-open' in positions
    checks: list[JsonValue] = []
    status = 'pass'
    if worst_case + 1e-9 >= minimum:
        checks.append({'check': 'seal-before-open', 'status': 'pass',
                       'nominalMargin': {'value': nominal_margin, 'units': 'mm'},
                       'worstCaseMargin': {'value': worst_case, 'units': 'mm'},
                       'required': {'value': minimum, 'units': 'mm'}})
    else:
        checks.append({'check': 'seal-before-open', 'status': 'fail',
                       'nominalMargin': {'value': nominal_margin, 'units': 'mm'},
                       'worstCaseMargin': {'value': worst_case, 'units': 'mm'},
                       'required': {'value': minimum, 'units': 'mm'}})
        status = 'fail'
    checks.append({'check': 'both-valve-open', 'status': 'pass' if both_open else 'fail',
                   'message': 'both valves open during connect' if both_open else 'second valve open not evidenced'})
    if d_seal is not None:
        first_close = min((at for e, at in d_valve), default=d_seal)
        disconnect_margin = d_seal - first_close if d_valve else None
        checks.append({'check': 'seal-after-close', 'status': 'pass' if disconnect_margin is not None and disconnect_margin >= 0 else 'unknown',
                       'margin': {'value': disconnect_margin, 'units': 'mm'} if disconnect_margin is not None else None})
    result: JsonRecord = {'connectOrder': _cad_cast("JsonValue", order),
              'disconnectOrder': _cad_cast("JsonValue", disconnect_events),
              'sealContact': {'value': seal_at, 'units': 'mm'},
              'valveOpen': [{'at': {'value': at, 'units': 'mm'}} for _, at in valve_ats],
              'sealBeforeOpenMargin': {'value': nominal_margin, 'units': 'mm'},
              'worstCaseMargin': {'value': worst_case, 'units': 'mm'},
              'float': {'value': float_travel, 'units': 'mm'},
              'axialTolerance': {'value': axial_tolerance, 'units': 'mm'},
              'locatorTolerance': {'value': locator_tolerance, 'units': 'mm'},
              'requiredMargin': {'value': minimum, 'units': 'mm'},
              'checks': checks}
    return _seal_contract(ctx, 'dock.sequence-check', result, status=status, read_only=True,
                          limitations=['Event order is resolved from declared positions; it does not certify sealing or valve function.',
                                       'Jumps and float are represented as worst-case axial/locator tolerances.'])


CAD_HANDLERS.update({'shape.o_ring': _seal_shape_o_ring, 'seal.gland': _seal_groove,
                     'seal.profile': _seal_profile, 'seal.evaluate': _seal_evaluate,
                     'dock.sequence-check': _dock_sequence})


def _seal_default_plane(axis_direction: "Sequence[float]") -> str:
    # The cross-section circle is offset along +X by the mean radius, so its plane
    # must contain both the revolve axis and +X. Reject axis X (offset collinear
    # with the axis) and pick the canonical plane whose normal is axis x +X.
    if abs(abs(axis_direction[0]) - 1.0) < 1e-9:
        raise ValueError('o-ring cannot revolve about the X axis with the +X cross-section offset '
                         '(degenerate); use the Y or Z axis, or supply a custom plane')
    normal = _cad_direction([axis_direction[1] * _E_X[2] - axis_direction[2] * _E_X[1],
                             axis_direction[2] * _E_X[0] - axis_direction[0] * _E_X[2],
                             axis_direction[0] * _E_X[1] - axis_direction[1] * _E_X[0]])
    for name, candidate in _PLANE_NORMALS.items():
        if abs(sum(a * b for a, b in zip(normal, candidate))) > 1.0 - 1e-9:
            return name
    raise ValueError('o-ring cannot auto-pick a canonical section plane for this axis; supply plane explicitly')
