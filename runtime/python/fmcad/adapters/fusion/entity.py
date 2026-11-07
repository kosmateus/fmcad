"""GM03 snapshot queries shared by discovery and modeling consumers.

All calculations use native geometry, then native-to-root-to-output transforms.
No tokens, topology, or query results are cached across operations.
"""

_ENTITY_TYPES = {
    'plane': ('Plane',), 'cylinder': ('Cylinder',), 'cone': ('Cone',),
    'sphere': ('Sphere',), 'torus': ('Torus',), 'circle': ('Circle3D', 'Arc3D'),
    'ellipse': ('Ellipse3D', 'EllipticalArc3D'),
    'line': ('Line3D', 'InfiniteLine3D'), 'point': ('Point3D',),
    'nurbsCurve': ('NurbsCurve3D',), 'nurbsSurface': ('NurbsSurface',),
}
_ENTITY_QUERY_FIELDS = ('schemaVersion', 'kind', 'component', 'occurrence', 'scope',
                        'instances', 'frame', 'filters', 'expect', 'unique', 'groupBy')
_ENTITY_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _cad_context_scope(ctx: "CadContext", data: "JsonObject") -> "tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]":
    resolver = _cad_cast(
        "Callable[[JsonObject], tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]]",
        getattr(ctx, '_scope'))
    return resolver(data)


def _cad_context_proxy(ctx: "CadContext", entity: "CadEntity",
                       occurrence: "adsk.fusion.Occurrence | None") -> "CadEntity":
    proxy = _cad_cast(
        "Callable[[CadEntity, adsk.fusion.Occurrence | None], CadEntity]",
        getattr(ctx, '_proxy'))
    return proxy(entity, occurrence)


def _cad_context_entities(ctx: "CadContext", kind: "str | None",
                          component: "adsk.fusion.Component | None",
                          occurrence: "adsk.fusion.Occurrence | None") -> "Sequence[CadEntity]":
    entities = _cad_cast(
        "Callable[[str | None, adsk.fusion.Component | None, adsk.fusion.Occurrence | None], Sequence[CadEntity]]",
        getattr(ctx, '_entities'))
    return entities(kind, component, occurrence)


if _CAD_TYPE_CHECKING:
    from typing import NotRequired as _EntityNotRequired

    class _EntityBox(_CadTypedDict):
        min: list[float]
        max: list[float]
        mode: _EntityNotRequired[Literal['inside', 'intersects']]

    class _EntityQuantity(_CadTypedDict):
        value: int | float
        units: str

    class _EntityGeometry(_CadTypedDict, total=False):
        type: str
        origin: list[float]
        center: list[float]
        startPoint: list[float]
        endPoint: list[float]
        xyz: list[float]
        axis: list[float]
        normal: list[float]
        direction: list[float]
        radius: float
        space: str
        frame: JsonRecord
        directionUnits: str
        lengthUnits: str
        angleUnits: str
        majorRadius: float
        minorRadius: float
        halfAngle: float
        startAngle: float
        endAngle: float

    class _EntityAttributePredicate(_CadTypedDict):
        group: str
        name: str
        value: str
        owner: Literal['native', 'proxy', 'occurrence']

    class _EntityLevel(_CadTypedDict):
        axis: Literal['x', 'y', 'z']
        value: tuple[int | float | None, int | float | None]
        at: _EntityNotRequired[Literal['min', 'max', 'center']]

    class _EntityAdjacency(_CadTypedDict):
        kind: Literal['body', 'face', 'edge', 'vertex']
        filters: "_EntityNormalizedFilters"
        expect: tuple[int | float | None, int | float | None]
        refs: _EntityNotRequired[list[adsk.core.Base]]

    class _EntityNormalizedFilters(_CadTypedDict):
        tolerance: float
        angleTolerance: float
        name: _EntityNotRequired[str]
        geometry: _EntityNotRequired[str]
        radius: _EntityNotRequired[tuple[int | float | None, int | float | None]]
        length: _EntityNotRequired[tuple[int | float | None, int | float | None]]
        axis: _EntityNotRequired[list[float]]
        position: _EntityNotRequired[list[float]]
        bbox: _EntityNotRequired[_EntityBox]
        level: _EntityNotRequired[_EntityLevel]
        adjacency: _EntityNotRequired[_EntityAdjacency]
        attributes: _EntityNotRequired[list[_EntityAttributePredicate]]


def _entity_matrix(values: "Iterable[object]") -> list[int | float]:
    values = list(values)
    if len(values) != 16 or any(
            type(v) not in (int, float) or not math.isfinite(_cad_cast("int | float", v))
            for v in values):
        raise ValueError('Frame requires a finite 4x4 rigid matrix')
    values = _cad_cast("list[int | float]", values)
    columns: list[list[int | float]] = [[values[4 * r + c] for r in range(3)] for c in range(3)]
    dot: Callable[[Sequence[int | float], Sequence[int | float]], int | float] = lambda a, b: sum(x * y for x, y in zip(a, b))
    det = (columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1])
           - columns[1][0] * (columns[0][1] * columns[2][2] - columns[0][2] * columns[2][1])
           + columns[2][0] * (columns[0][1] * columns[1][2] - columns[0][2] * columns[1][1]))
    if (any(abs(dot(a, b) - (1 if i == j else 0)) > 1e-8
            for i, a in enumerate(columns) for j, b in enumerate(columns))
            or abs(det - 1) > 1e-8 or any(abs(a - b) > 1e-8 for a, b in zip(values[12:], [0, 0, 0, 1]))):
        raise ValueError('Scaled, reflected, or non-rigid frames are unsupported')
    return values


def _entity_multiply(a: "Sequence[int | float]", b: "Sequence[int | float]") -> list[int | float]:
    return [sum(a[4 * r + k] * b[4 * k + c] for k in range(4)) for r in range(4) for c in range(4)]


def _entity_inverse(m: "Sequence[int | float]") -> list[int | float]:
    out = _cad_cast("list[int | float]", list(_ENTITY_IDENTITY))
    for r in range(3):
        for c in range(3):
            out[4 * r + c] = m[4 * c + r]
        out[4 * r + 3] = -sum(m[4 * c + r] * m[4 * c + 3] for c in range(3))
    return out


def _entity_xyz(m: "Sequence[int | float]", xyz: "Sequence[int | float]", vector: bool = False) -> list[int | float]:
    return [sum(m[4 * r + c] * xyz[c] for c in range(3)) + (0 if vector else m[4 * r + 3]) for r in range(3)]


def _entity_occurrence_matrix(ctx: "CadContext", occurrence: "adsk.fusion.Occurrence") -> list[int | float]:
    # root.allOccurrences supplies root-qualified proxies. transform2 includes
    # occurrence overrides; reconstructing from native definitions loses them.
    result: list[int | float] = list(_ENTITY_IDENTITY)
    parts = occurrence.fullPathName.split('+')
    all_occurrences = _cad_items(ctx.root.allOccurrences)
    for depth in range(1, len(parts) + 1):
        path = '+'.join(parts[:depth])
        item = _cad_unique([o for o in all_occurrences if o.fullPathName == path], 'Occurrence path ' + path)
        result = _entity_matrix(item.transform2.asArray())
    return result


def _entity_owner_matrix(ctx: "CadContext", owner: "adsk.fusion.Component | None",
                         occurrence: "adsk.fusion.Occurrence | None" = None) -> list[int | float]:
    if owner == ctx.root or owner is None:
        return _cad_cast("list[int | float]", list(_ENTITY_IDENTITY))
    if occurrence is None:
        occurrence = _cad_unique([o for o in _cad_items(ctx.root.allOccurrences) if o.component == owner],
                                 'Frame conversion requires an explicit occurrence')
    if occurrence.component != owner:
        raise ValueError('Frame occurrence and component disagree')
    return _entity_occurrence_matrix(ctx, occurrence)


def _entity_sketch_model_point(sketch: "adsk.fusion.Sketch",
                               coordinates: "tuple[int | float, int | float, int | float]") -> list[int | float]:
    point = adsk.core.Point3D.create(*coordinates)
    if point is None:
        raise ValueError('Fusion could not create a sketch-frame point')
    return _cad_xyz(sketch.sketchToModelSpace(point))


def _entity_json_object(value: "JsonValue", label: str) -> "JsonObject":
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    entries = _cad_cast("dict[object, JsonValue]", value)
    if any(not isinstance(key, str) for key in entries):
        raise ValueError(label + ' keys must be strings')
    return _cad_cast("JsonObject", entries)


def _entity_vector(value: "JsonValue", label: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(label + ' must contain three numeric values')
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError(label + ' must contain three finite numeric values')
        if not math.isfinite(item):
            raise ValueError(label + ' must contain three finite numeric values')
        result.append(float(item))
    return result


def _entity_geometry(value: "JsonValue") -> "_EntityGeometry":
    if value is None:
        return {}
    geometry = _entity_json_object(value, 'geometry')
    geometry_type = geometry.get('type')
    if not isinstance(geometry_type, str):
        raise ValueError('geometry type must be text')
    for key in ('origin', 'center', 'startPoint', 'endPoint', 'xyz', 'axis', 'normal', 'direction'):
        if key in geometry:
            geometry[key] = _entity_vector(geometry[key], 'geometry ' + key)
    for key in ('radius', 'majorRadius', 'minorRadius', 'halfAngle', 'startAngle', 'endAngle'):
        if key in geometry:
            number = geometry[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                raise ValueError('geometry ' + key + ' must be finite and numeric')
            geometry[key] = float(number)
    for key in ('space', 'frame', 'directionUnits', 'lengthUnits', 'angleUnits'):
        if key in geometry and not isinstance(geometry[key], str):
            raise ValueError('geometry ' + key + ' must be text')
    return _cad_cast("_EntityGeometry", geometry)


def _entity_bounds(value: "JsonValue", label: str = 'boundingBox') -> "_EntityBox":
    bounds = _entity_json_object(value, label)
    minimum, maximum = bounds.get('min'), bounds.get('max')
    if minimum is None or maximum is None:
        raise ValueError(label + ' requires min and max')
    return {'min': _entity_vector(minimum, label + ' min'),
            'max': _entity_vector(maximum, label + ' max')}


def _entity_quantity(value: "JsonValue", label: str) -> "_EntityQuantity":
    quantity = _entity_json_object(value, label)
    _cad_fields(quantity, ('value', 'units'), ('accuracy',))
    amount, units = quantity['value'], quantity['units']
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount):
        raise ValueError(label + ' value must be finite and numeric')
    if not isinstance(units, str):
        raise ValueError(label + ' units must be text')
    return {'value': amount, 'units': units}


def _entity_frame_target(ctx: "CadContext", frame: "JsonValue") -> tuple["adsk.fusion.Component", "adsk.fusion.Occurrence | None", list[int | float], "JsonRecord"]:
    if not isinstance(frame, dict):
        raise ValueError('frame must be context, component, root, or a frame descriptor')
    frame = _entity_json_object(frame, 'frame')
    local = _cad_cast("list[int | float]", list(_ENTITY_IDENTITY))
    if 'sketch' in frame:
        _cad_fields(frame, ('sketch',))
        sketch = ctx.resolve(frame['sketch'], 'sketch')
        native = _cad_cast("adsk.fusion.Sketch", getattr(sketch, 'nativeObject', None) or sketch)
        points = [_entity_sketch_model_point(native, p)
                  for p in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1))]
        local = [points[c + 1][r] - points[0][r] if c < 3 else points[0][r]
                 for r in range(3) for c in range(4)] + [0, 0, 0, 1]
        component = _cad_owner(sketch)
        if component is None:
            raise ValueError('Sketch frame has no owning component')
        target_occurrence = _cad_cast("adsk.fusion.Occurrence | None", getattr(sketch, 'assemblyContext', None))
        local = _entity_matrix(local)
        label: JsonRecord = {'kind': 'sketch', 'ref': ctx.ref(sketch)}
    else:
        _cad_fields(frame, optional=('component', 'occurrence', 'datum'))
        if not frame:
            raise ValueError('Empty frame descriptor')
        component, target_occurrence = _cad_context_scope(ctx, frame)
        label = {'kind': 'occurrence' if target_occurrence else 'component',
                 'ref': ctx.ref(target_occurrence or component)}
        if 'datum' in frame:
            datum_name = frame['datum']
            if not isinstance(datum_name, str):
                raise ValueError('datum must be a frame name')
            attribute = _cad_cast("adsk.core.Attribute | None", component.attributes.itemByName(_CAD_FRAME_GROUP, datum_name))
            if attribute is None:
                raise ValueError('Unknown named datum frame: ' + datum_name)
            stored_value = _cad_cast("JsonValue", json.loads(attribute.value))
            if not isinstance(stored_value, dict) or 'matrix' not in stored_value:
                raise ValueError('Stored datum frame is malformed')
            stored = _entity_json_object(stored_value, 'Stored datum frame')
            matrix = stored['matrix']
            if not isinstance(matrix, list):
                raise ValueError('Stored datum frame matrix must be an array')
            local = _entity_matrix(_cad_cast("list[object]", matrix))
            label.update(kind='datum', name=datum_name)
    return component, target_occurrence, local, label


def _entity_frame(ctx: "CadContext", frame: "str | JsonObject", owner: "adsk.fusion.Component | None",
                  occurrence: "adsk.fusion.Occurrence | None") -> tuple[list[int | float], "JsonRecord"]:
    if frame == 'context':
        frame = 'root' if occurrence is not None else 'component'
    if frame == 'component':
        return _cad_cast("list[int | float]", list(_ENTITY_IDENTITY)), {'kind': 'component', 'ref': ctx.ref(owner or ctx.root)}
    if frame == 'root':
        return _entity_owner_matrix(ctx, owner, occurrence), {'kind': 'root', 'ref': ctx.ref(ctx.root)}
    component, target_occurrence, local, label = _entity_frame_target(ctx, frame)
    if component == owner and (target_occurrence is None or target_occurrence == occurrence):
        # Same-definition local conversion does not need an arbitrary placement.
        return _entity_inverse(local), label
    source = _entity_owner_matrix(ctx, owner, occurrence)
    target = _entity_multiply(_entity_owner_matrix(ctx, component, target_occurrence), local)
    return _entity_multiply(_entity_inverse(target), source), label


def _entity_interval(ctx: "CadContext", value: "JsonValue", label: str,
                     count: bool = False, signed: bool = False) -> tuple[int | float | None, int | float | None]:
    def scalar(v: "JsonValue") -> int | float:
        if count:
            if type(v) is not int or v < 0:
                raise ValueError(label + ' requires nonnegative integer counts')
            return v
        number = ctx.length(v)
        if not signed and number < 0:
            raise ValueError(label + ' cannot be negative')
        return number
    if isinstance(value, dict):
        value = _entity_json_object(value, label + ' interval')
        _cad_fields(value, optional=('min', 'max'))
        if not value:
            raise ValueError(label + ' interval cannot be empty')
        low = scalar(value['min']) if 'min' in value else None
        high = scalar(value['max']) if 'max' in value else None
    else:
        low = high = scalar(value)
    if low is not None and high is not None and low > high:
        raise ValueError(label + ' interval min exceeds max')
    return low, high


def _entity_attribute_filters(value: "JsonValue") -> list["_EntityAttributePredicate"]:
    if not isinstance(value, list) or not value:
        raise ValueError('filters.attributes must be a nonempty array')
    entries = value
    predicates: list[_EntityAttributePredicate] = []
    for entry in entries:
        predicate = _entity_json_object(entry, 'attribute predicate')
        _cad_fields(predicate, ('group', 'name', 'value', 'owner'))
        for key in ('group', 'name'):
            text = predicate[key]
            if not isinstance(text, str) or not text.strip():
                raise ValueError('attribute ' + key + ' must be nonempty text')
        if not isinstance(predicate['value'], str):
            raise ValueError('attribute value must be text')
        owner = predicate['owner']
        if not isinstance(owner, str) or owner not in ('native', 'proxy', 'occurrence'):
            raise ValueError('attribute owner must be native, proxy, or occurrence')
        predicate['owner'] = owner
        predicates.append(_cad_cast("_EntityAttributePredicate", dict(predicate)))
    return predicates


def _entity_attribute_owner(entity: "adsk.core.Base", owner: str) -> "adsk.core.Base | None":
    if owner == 'native':
        native = _cad_cast("adsk.core.Base | None", getattr(entity, 'nativeObject', None))
        if native is not None:
            return native
        context = _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
        return None if context is not None else entity
    if owner == 'proxy':
        context = _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
        return entity if context is not None else None
    if _cad_type(entity) == 'Occurrence':
        return entity
    return _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))


def _entity_attribute_reasons(entity: "adsk.core.Base", predicates: "Sequence[_EntityAttributePredicate]") -> list[str]:
    reasons: list[str] = []
    for predicate in predicates:
        group, name, expected = predicate['group'], predicate['name'], predicate['value']
        target = _entity_attribute_owner(entity, predicate['owner'])
        attributes = _cad_cast("_CadAttributes | None", getattr(target, 'attributes', None)) if target is not None else None
        attribute = attributes.itemByName(group, name) if attributes is not None else None
        label = group + '/' + name
        if attribute is None:
            reasons.append('attribute missing: ' + label)
        elif attribute.value != expected:
            reasons.append('attribute value mismatch: ' + label)
    return reasons


def _entity_attribute_occurrence_context(data: "JsonObject", predicates: "Sequence[_EntityAttributePredicate]") -> None:
    if not any(predicate['owner'] in ('proxy', 'occurrence') for predicate in predicates):
        return
    scope = data.get('scope', {})
    if not isinstance(scope, dict):
        return  # Let the query scope validator provide the structural error.
    scope = _entity_json_object(scope, 'scope')
    has_occurrence = ('occurrence' in data or 'occurrence' in scope or
                      any(isinstance(scope.get(key), dict) and
                          'occurrence' in _entity_json_object(scope[key], key)
                          for key in ('body', 'feature')))
    if data.get('kind') == 'component':
        raise ValueError('proxy and occurrence attribute predicates are not valid for component candidates')
    if not has_occurrence and not data.get('instances', False) and data.get('kind', 'face') != 'occurrence':
        raise ValueError('proxy and occurrence attribute predicates require an occurrence scope, kind:occurrence, or instances:true')


def _entity_attribute_predicates(filters: "_EntityNormalizedFilters") -> list["_EntityAttributePredicate"]:
    predicates = list(filters.get('attributes', []))
    adjacency = filters.get('adjacency')
    if adjacency is not None:
        predicates.extend(_entity_attribute_predicates(adjacency['filters']))
    return predicates


def _entity_in(value: int | float | None, interval: tuple[int | float | None, int | float | None], tolerance: float = 0) -> bool:
    return value is not None and (interval[0] is None or value >= interval[0] - tolerance) and (interval[1] is None or value <= interval[1] + tolerance)


def _entity_filters(ctx: "CadContext", filters: "JsonValue", adjacency: bool = True) -> "_EntityNormalizedFilters":
    filters = _entity_json_object(filters, 'filters')
    allowed = ('name', 'geometry', 'radius', 'length', 'axis', 'position',
               'bbox', 'level', 'adjacency', 'tolerance', 'angleTolerance', 'attributes')
    if set(filters) - set(allowed):
        raise ValueError('Unsupported geometry filters: ' + ', '.join(sorted(set(filters) - set(allowed))))
    # The closed key set and validation below establish every field before the
    # normalized record is exposed to geometry predicates.
    out: dict[str, object] = _cad_cast("dict[str, object]", dict(filters))
    if 'attributes' in filters:
        out['attributes'] = _entity_attribute_filters(filters['attributes'])
    if 'name' in out and not isinstance(out['name'], str):
        raise ValueError('name filter must be text')
    if 'geometry' in out:
        geometry_type = out['geometry']
        if not isinstance(geometry_type, str) or geometry_type not in _ENTITY_TYPES:
            raise ValueError('Unsupported geometry type')
    tolerance = ctx.length(filters.get('tolerance', '0.001 mm'))
    angle_tolerance = ctx.angle(filters.get('angleTolerance', '0.01 deg'))
    out['tolerance'] = tolerance
    out['angleTolerance'] = angle_tolerance
    if tolerance < 0 or not 0 <= angle_tolerance <= math.pi / 2:
        raise ValueError('Tolerances must be nonnegative; angleTolerance must be at most 90 deg')
    for key in ('radius', 'length'):
        if key in filters:
            out[key] = _entity_interval(ctx, filters[key], key)
    if 'axis' in filters:
        out['axis'] = _cad_direction(filters['axis'])
    if 'position' in filters:
        out['position'] = _cad_xyz(ctx.point(filters['position']))
    if 'bbox' in filters:
        box = _entity_json_object(filters['bbox'], 'bbox')
        _cad_fields(box, ('min', 'max'), ('mode',))
        mode = box.get('mode', 'inside')
        if not isinstance(mode, str) or mode not in ('inside', 'intersects'):
            raise ValueError('bbox mode must be inside or intersects')
        box['min'], box['max'] = _cad_xyz(ctx.point(box['min'])), _cad_xyz(ctx.point(box['max']))
        if any(a > b for a, b in zip(box['min'], box['max'])):
            raise ValueError('bbox min exceeds max')
        out['bbox'] = _cad_cast("_EntityBox", box)
    if 'level' in filters:
        level = _entity_json_object(filters['level'], 'level')
        _cad_fields(level, ('axis', 'value'), ('at',))
        axis = level['axis']
        at = level.get('at', 'center')
        if not isinstance(axis, str) or axis not in ('x', 'y', 'z') or not isinstance(at, str) or at not in ('min', 'max', 'center'):
            raise ValueError('level requires axis x/y/z and at min/max/center')
        level['axis'] = axis
        level['at'] = at
        level['value'] = _entity_interval(ctx, level['value'], 'level', signed=True)
        out['level'] = level
    if 'adjacency' in filters:
        if not adjacency:
            raise ValueError('Nested adjacency queries are unsupported')
        adjacent = _entity_json_object(filters['adjacency'], 'adjacency')
        _cad_fields(adjacent, ('kind',), ('filters', 'expect', 'refs'))
        adjacency_kind = adjacent['kind']
        if not isinstance(adjacency_kind, str) or adjacency_kind not in ('body', 'face', 'edge', 'vertex'):
            raise ValueError('Adjacency kind must be body, face, edge, or vertex')
        adjacent_filters = _entity_filters(ctx, adjacent.get('filters', {}), False)
        adjacent_expect = _entity_interval(ctx, adjacent.get('expect', {'min': 1}), 'adjacency expect', True)
        normalized_adjacency: _EntityAdjacency = {
            'kind': adjacency_kind,
            'filters': adjacent_filters,
            'expect': adjacent_expect,
        }
        if 'refs' in adjacent:
            if not isinstance(adjacent['refs'], list) or not adjacent['refs']:
                raise ValueError('adjacency refs must be a nonempty array')
            refs = adjacent['refs']
            normalized_adjacency['refs'] = [ctx.resolve(ref, adjacency_kind) for ref in refs]
        out['adjacency'] = normalized_adjacency
    # This cast follows the closed key set and field-by-field validator above.
    return _cad_cast("_EntityNormalizedFilters", out)


def _entity_candidates(ctx: "CadContext", data: "JsonObject") -> list["adsk.core.Base"]:
    scope = _entity_json_object(data.get('scope', {}), 'scope')
    _cad_fields(scope, optional=('component', 'occurrence', 'body', 'feature'))
    if 'scope' in data and any(k in data for k in ('component', 'occurrence')):
        raise ValueError('scope cannot combine with top-level component/occurrence')
    if 'body' in scope and 'feature' in scope:
        raise ValueError('scope body and feature are exclusive')
    component, occurrence = _cad_context_scope(ctx, scope if 'scope' in data else data)
    kind = data.get('kind', 'face')
    if not isinstance(kind, str):
        raise ValueError('query kind must be text')
    target: adsk.core.Base | None = None
    for key in ('body', 'feature'):
        if key in scope:
            ref = scope[key]
            if isinstance(ref, str):
                reference: JsonObject = {'name': ref}
            elif isinstance(ref, dict):
                reference = _entity_json_object(ref, key + ' reference')
            else:
                raise ValueError(key + ' scope must be a name or reference object')
            context_fields = {field: scope[field] for field in ('component', 'occurrence') if field in scope}
            if 'query' in reference and context_fields:
                nested = _entity_json_object(reference['query'], 'Nested query')
                if any(field in nested for field in ('scope', 'component', 'occurrence')):
                    raise ValueError('Supply body/feature query context either in scope or in its query, not both')
                reference['query'] = {**nested, **context_fields}
            else:
                reference.update(context_fields)
            target = ctx.resolve(reference, key)
            component = _cad_owner(target)
            occurrence = _cad_cast("adsk.fusion.Occurrence | None", getattr(target, 'assemblyContext', None))
    contexts: list[adsk.fusion.Occurrence | None] = [occurrence]
    if data.get('instances', False):
        if occurrence is not None:
            contexts = [o for o in _cad_items(ctx.root.allOccurrences)
                        if o.fullPathName == occurrence.fullPathName or o.fullPathName.startswith(occurrence.fullPathName + '+')]
        else:
            contexts = [o for o in _cad_items(ctx.root.allOccurrences) if component == ctx.root or o.component == component]
        if occurrence is None and component == ctx.root:
            contexts.insert(0, None)
    result: list[adsk.core.Base] = []
    for context in contexts:
        current = context.component if context is not None else component
        entities: list[adsk.core.Base] = []
        if target is None and kind == 'component' and (data.get('instances') or 'component' in scope or 'occurrence' in scope or 'component' in data or 'occurrence' in data):
            entities = [_cad_cast("adsk.fusion.Component", current)]
        elif target is None and kind == 'occurrence':
            if data.get('instances'):
                entities = [context] if context is not None else []
            elif occurrence is not None:
                entities = [occurrence]
            else:
                entities = [o for o in _cad_items(ctx.root.allOccurrences) if component == ctx.root or o.component == component]
        elif target is not None:
            if current != component:
                continue
            native = _cad_cast("adsk.core.Base", getattr(target, 'nativeObject', None) or target)
            if _cad_kind(native) == 'body':
                body = _cad_cast("adsk.fusion.BRepBody", native)
                if kind == 'body':
                    entities = [body]
                elif kind in ('face', 'edge', 'vertex'):
                    collection = _cad_cast("_CadItemCollection[adsk.core.Base]",
                                           getattr(body, {'face': 'faces', 'edge': 'edges', 'vertex': 'vertices'}[kind]))
                    entities = _cad_items(collection)
                else:
                    raise ValueError('Body scope supports body/face/edge/vertex')
            else:
                feature = _cad_cast("adsk.fusion.Feature", native)
                if kind == 'feature':
                    entities = [feature]
                elif kind in ('body', 'face'):
                    collection = _cad_cast("_CadItemCollection[adsk.core.Base]",
                                           getattr(feature, {'body': 'bodies', 'face': 'faces'}[kind]))
                    entities = _cad_items(collection)
                elif kind in ('edge', 'vertex'):
                    faces = _cad_items(feature.faces)
                    entities = [edge
                                for face in faces
                                for edge in _cad_items(_cad_cast(
                                    "_CadItemCollection[adsk.core.Base]",
                                    getattr(face, 'edges' if kind == 'edge' else 'vertices')))]
                else:
                    raise ValueError('Feature scope supports feature/body/face/edge/vertex')
            entities = [_cad_context_proxy(ctx, e, context) for e in entities]
        else:
            entities = list(_cad_context_entities(ctx, kind, current, context))
        for entity in entities:
            if not any(entity == other for other in result):
                result.append(entity)
    return result


def _entity_describe(ctx: "CadContext", entity: "adsk.core.Base",
                     frame: "str | JsonObject" = 'context') -> "JsonRecord":
    if getattr(entity, 'isValid', True) is False:
        raise ValueError('Invalid entity; re-query current topology')
    native = _cad_cast("adsk.core.Base", getattr(entity, 'nativeObject', None) or entity)
    owner = _cad_owner(entity)
    occurrence = _cad_cast("adsk.fusion.Occurrence", entity) if _cad_kind(entity) == 'occurrence' else _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
    matrix, label = _entity_frame(ctx, frame, owner, occurrence)
    result: JsonRecord = ctx.describe(native)
    if _cad_kind(entity) == 'occurrence':
        result.pop('boundingBox', None)
        occurrence_entity = _cad_cast("adsk.fusion.Occurrence", entity)
        component = occurrence_entity.component
        if hasattr(component, 'boundingBox'):
            result['boundingBox'] = _cad_json(component.boundingBox)
        result['transformFrame'] = {'from': occurrence_entity.fullPathName, 'to': occurrence_entity.fullPathName.rpartition('+')[0] or 'root', 'lengthUnits': 'cm'}
    result.update(ctx.ref(entity))
    result['frame'] = label
    result['associativity'] = 'snapshot'
    result['occurrencePath'] = occurrence.fullPathName if occurrence is not None else None
    geometry_value = result.get('geometry')
    if geometry_value is not None:
        geometry = _entity_geometry(geometry_value)
        geometry.pop('space', None)
        # Sketch worldGeometry is component-local; profile bounds remain sketch-local.
        origin = geometry.get('origin')
        if origin is not None:
            geometry['origin'] = _entity_xyz(matrix, origin)
        center = geometry.get('center')
        if center is not None:
            geometry['center'] = _entity_xyz(matrix, center)
        start_point = geometry.get('startPoint')
        if start_point is not None:
            geometry['startPoint'] = _entity_xyz(matrix, start_point)
        end_point = geometry.get('endPoint')
        if end_point is not None:
            geometry['endPoint'] = _entity_xyz(matrix, end_point)
        xyz = geometry.get('xyz')
        if xyz is not None:
            geometry['xyz'] = _entity_xyz(matrix, xyz)
        axis = geometry.get('axis')
        if axis is not None:
            geometry['axis'] = _cad_direction(_entity_xyz(matrix, axis, True))
        normal = geometry.get('normal')
        if normal is not None:
            geometry['normal'] = _cad_direction(_entity_xyz(matrix, normal, True))
        direction = geometry.get('direction')
        if direction is not None:
            geometry['direction'] = _cad_direction(_entity_xyz(matrix, direction, True))
        geometry['frame'] = label
        geometry['directionUnits'] = 'unitless'
        result['geometry'] = _cad_cast("JsonRecord", geometry)
    box_value = result.get('boundingBox')
    if box_value is not None:
        box_record = _entity_json_object(box_value, 'boundingBox')
        box = _entity_bounds(box_value)
        if box_record.get('space') == 'sketch' or _cad_type(native).startswith('Sketch'):
            sketch = _cad_cast("adsk.fusion.Sketch", native) if _cad_kind(native) == 'sketch' else _cad_cast("adsk.fusion.Profile", native).parentSketch
            def model_point(x: float, y: float, z: float) -> list[int | float]:
                point = adsk.core.Point3D.create(x, y, z)
                if point is None:
                    raise ValueError('Fusion could not create a transformed bounding-box point')
                return _cad_xyz(sketch.sketchToModelSpace(point))
            corners = [model_point(x, y, z)
                       for x in (box['min'][0], box['max'][0]) for y in (box['min'][1], box['max'][1]) for z in (box['min'][2], box['max'][2])]
        else:
            corners = [[x, y, z] for x in (box['min'][0], box['max'][0]) for y in (box['min'][1], box['max'][1]) for z in (box['min'][2], box['max'][2])]
        corners = [_entity_xyz(matrix, point) for point in corners]
        result['boundingBox'] = {'min': [min(p[i] for p in corners) for i in range(3)],
                                 'max': [max(p[i] for p in corners) for i in range(3)],
                                 'units': 'cm', 'frame': label, 'method': 'transformed native AABB (conservative)'}
    if 'centroid' in result:
        centroid = _entity_json_object(result['centroid'], 'centroid')
        _cad_fields(centroid, ('xyz', 'units'), ('space',))
        centroid_xyz = _entity_vector(centroid['xyz'], 'centroid xyz')
        if not isinstance(centroid['units'], str):
            raise ValueError('centroid units must be text')
        point_value = adsk.core.Point3D.create(*centroid_xyz)
        if point_value is None:
            raise ValueError('Fusion could not create a transformed centroid point')
        profile = _cad_cast("adsk.fusion.Profile", native)
        point = _cad_xyz(profile.parentSketch.sketchToModelSpace(point_value))
        result['centroid'] = {'xyz': _entity_xyz(matrix, point), 'units': 'cm', 'frame': label}
    native_kind = _cad_kind(native)
    if native_kind == 'body':
        body = _cad_cast("adsk.fusion.BRepBody", native)
    elif native_kind == 'face':
        body = _cad_cast("adsk.fusion.BRepFace", native).body
    elif native_kind == 'edge':
        body = _cad_cast("adsk.fusion.BRepEdge", native).body
    elif native_kind == 'vertex':
        body = _cad_cast("adsk.fusion.BRepVertex", native).body
    else:
        body = None
    if body is not None:
        result['body'] = ctx.ref(_cad_context_proxy(ctx, body, occurrence))
    return result


def _entity_neighbors(entity: "adsk.core.Base", kind: str) -> list["adsk.core.Base"]:
    native = _cad_cast("adsk.core.Base", getattr(entity, 'nativeObject', None) or entity)
    own_kind = _cad_kind(native)
    if kind == 'body':
        if own_kind == 'face':
            return [_cad_cast("adsk.fusion.BRepFace", native).body]
        if own_kind == 'edge':
            return [_cad_cast("adsk.fusion.BRepEdge", native).body]
        if own_kind == 'vertex':
            return [_cad_cast("adsk.fusion.BRepVertex", native).body]
        return []
    if kind == 'face':
        if own_kind == 'face':
            face = _cad_cast("adsk.fusion.BRepFace", native)
            values = [neighbor for bridge in _cad_items(face.edges)
                      for neighbor in _cad_items(bridge.faces) if neighbor != native]
        elif own_kind == 'edge':
            values = _cad_items(_cad_cast("adsk.fusion.BRepEdge", native).faces)
        elif own_kind == 'body':
            values = _cad_items(_cad_cast("adsk.fusion.BRepBody", native).faces)
        elif own_kind == 'feature':
            values = _cad_items(_cad_cast("adsk.fusion.Feature", native).faces)
        else:
            values = []
    elif kind == 'edge':
        if own_kind == 'face':
            values = _cad_items(_cad_cast("adsk.fusion.BRepFace", native).edges)
        elif own_kind == 'edge':
            edge = _cad_cast("adsk.fusion.BRepEdge", native)
            values = [neighbor for bridge in _cad_items(edge.faces)
                      for neighbor in _cad_items(bridge.edges) if neighbor != native]
        elif own_kind == 'body':
            values = _cad_items(_cad_cast("adsk.fusion.BRepBody", native).edges)
        else:
            values = []
    elif kind == 'vertex':
        if own_kind == 'edge':
            edge = _cad_cast("adsk.fusion.BRepEdge", native)
            values = [edge.startVertex, edge.endVertex]
        elif own_kind == 'vertex':
            vertex = _cad_cast("adsk.fusion.BRepVertex", native)
            values = [neighbor for edge in _cad_items(vertex.edges)
                      for neighbor in (edge.startVertex, edge.endVertex)
                      if neighbor != native]
        elif own_kind == 'face':
            values = _cad_items(_cad_cast("adsk.fusion.BRepFace", native).vertices)
        elif own_kind == 'body':
            values = _cad_items(_cad_cast("adsk.fusion.BRepBody", native).vertices)
        else:
            values = []
    else:
        values = []
    result: list[adsk.core.Base] = []
    for value in values:
        if not any(value == other for other in result):
            result.append(value)
    return result


def _entity_reasons(ctx: "CadContext", entity: "adsk.core.Base", row: "JsonRecord",
                    filters: "_EntityNormalizedFilters", frame: "str | JsonObject") -> list[str]:
    geometry_value = row.get('geometry')
    geometry = _entity_geometry(geometry_value)
    tolerance = filters['tolerance']
    reasons: list[str] = []
    if 'name' in filters and row.get('name') != filters['name']:
        reasons.append('name')
    if 'attributes' in filters:
        reasons.extend(_entity_attribute_reasons(entity, filters['attributes']))
    if 'geometry' in filters and geometry.get('type') not in _ENTITY_TYPES[filters['geometry']]:
        reasons.append('geometry')
    radius_interval = filters.get('radius')
    if radius_interval is not None and not _entity_in(geometry.get('radius'), radius_interval, tolerance):
        reasons.append('radius')
    length_interval = filters.get('length')
    if length_interval is not None:
        length_value = row.get('length')
        length_record = _entity_quantity(length_value, 'length') if length_value is not None else None
        actual_length = length_record['value'] if length_record is not None else None
        if not _entity_in(actual_length, length_interval, tolerance):
            reasons.append('length')
    axis_filter = filters.get('axis')
    if axis_filter is not None:
        actual = geometry.get('axis', geometry.get('normal', geometry.get('direction')))
        if actual is None or math.acos(min(1, abs(sum(a * b for a, b in zip(axis_filter, _cad_direction(actual)))))) > filters['angleTolerance']:
            reasons.append('axis')
    box_value = row.get('boundingBox')
    box = _entity_bounds(box_value) if box_value is not None else None
    position_filter = filters.get('position')
    if position_filter is not None:
        actual = geometry.get('origin', geometry.get('center', geometry.get('xyz', geometry.get('startPoint'))))
        if actual is None and box:
            actual = [(a + b) / 2 for a, b in zip(box['min'], box['max'])]
        if actual is None:
            reasons.append('position unavailable')
        else:
            delta = [a - b for a, b in zip(position_filter, actual)]
            direction = geometry.get('axis', geometry.get('direction'))
            geometry_type = geometry.get('type')
            if geometry_type == 'Plane':
                normal = geometry.get('normal')
                if normal is None:
                    raise ValueError('Plane geometry is missing its normal')
                distance = abs(sum(a * b for a, b in zip(delta, _cad_direction(normal))))
            elif geometry.get('type') in ('Cylinder', 'InfiniteLine3D'):
                if direction is None:
                    raise ValueError('Linear geometry is missing its direction')
                direction = _cad_direction(direction)
                dot = sum(a * b for a, b in zip(delta, direction))
                distance = math.hypot(*[a - dot * b for a, b in zip(delta, direction)])
            else:
                distance = math.hypot(*delta)
            if distance > tolerance:
                reasons.append('position')
    wanted = filters.get('bbox')
    if wanted is not None:
        if box is None:
            reasons.append('bbox unavailable')
        elif wanted.get('mode', 'inside') == 'inside':
            if any(a < b - tolerance for a, b in zip(box['min'], wanted['min'])) or any(a > b + tolerance for a, b in zip(box['max'], wanted['max'])):
                reasons.append('bbox')
        elif any(a > b + tolerance for a, b in zip(box['min'], wanted['max'])) or any(a < b - tolerance for a, b in zip(box['max'], wanted['min'])):
            reasons.append('bbox')
    level = filters.get('level')
    if level is not None:
        index = 'xyz'.index(level['axis'])
        at = level.get('at', 'center')
        if box is None:
            value = None
        elif at == 'center':
            value = (box['min'][index] + box['max'][index]) / 2
        elif at == 'min':
            value = box['min'][index]
        else:
            value = box['max'][index]
        if not _entity_in(value, level['value'], tolerance):
            reasons.append('level')
    if 'adjacency' in filters:
        query = filters['adjacency']
        occurrence = _cad_cast("adsk.fusion.Occurrence | None", getattr(entity, 'assemblyContext', None))
        neighbors = [_cad_context_proxy(ctx, e, occurrence) for e in _entity_neighbors(entity, query['kind'])]
        matching = [e for e in neighbors if ('refs' not in query or any(e == ref for ref in query.get('refs', [])))
                    and not _entity_reasons(ctx, e, _entity_describe(ctx, e, frame), query['filters'], frame)]
        if not _entity_in(len(matching), query['expect']):
            reasons.append('adjacency')
    return reasons


def _entity_stats(rows: "Sequence[JsonRecord]") -> "JsonRecord":
    result: JsonRecord = {}
    for key, units in (('radius', 'cm'), ('length', 'cm'), ('area', 'cm^2'), ('volume', 'cm^3')):
        values: list[int | float | None] = []
        for row in rows:
            geometry_value = row.get('geometry')
            geometry = _entity_geometry(geometry_value)
            if key == 'radius':
                raw = geometry.get('radius')
            else:
                metric_value = row.get(key)
                metric = _entity_quantity(metric_value, key) if metric_value is not None else None
                raw = metric.get('value') if metric is not None else None
            if raw is None:
                values.append(None)
            else:
                values.append(raw)
        known = [v for v in values if v is not None]
        result[key] = {'count': len(known), 'missing': len(values) - len(known), 'units': units,
                       'min': min(known) if known else None, 'max': max(known) if known else None,
                       'sum': sum(known) if known else None, 'mean': sum(known) / len(known) if known else None}
    return result


def _entity_query(ctx: "CadContext", data: "JsonObject") -> tuple[list["adsk.core.Base"], "JsonRecord"]:
    """Return the actual entity set and its serializable snapshot, even on expect failure."""
    _cad_fields(data, optional=_ENTITY_QUERY_FIELDS)
    if 'schemaVersion' in data and (type(data['schemaVersion']) is not int or data['schemaVersion'] != 1):
        raise ValueError('schemaVersion must be 1')
    if 'instances' in data and type(data['instances']) is not bool:
        raise ValueError('instances must be boolean')
    if data.get('unique') and 'expect' in data:
        raise ValueError('unique and expect are exclusive')
    expect = _entity_interval(ctx, data.get('expect', 1 if data.get('unique') else {'min': 0}), 'expect', True)
    filters = _entity_filters(ctx, data.get('filters', {}))
    _entity_attribute_occurrence_context(data, _entity_attribute_predicates(filters))
    group_by = data.get('groupBy', [])
    if not isinstance(group_by, list) or any(
            not isinstance(k, str) or k not in ('kind', 'geometry', 'component', 'occurrence', 'body', 'radius', 'length', 'axis', 'level')
            for k in group_by):
        raise ValueError('groupBy must be distinct supported grouping fields')
    group_by = _cad_cast("list[str]", group_by)
    if len(set(group_by)) != len(group_by):
        raise ValueError('groupBy must be distinct supported grouping fields')
    frame_value = data.get('frame', 'context')
    frame = frame_value
    if not isinstance(frame, (str, dict)):
        raise ValueError('frame must be context, component, root, or a frame descriptor')
    if isinstance(frame, dict):
        frame = _entity_json_object(frame, 'frame')
    ctx.assert_identity()
    kind = data.get('kind', 'face')
    if not isinstance(kind, str) or kind not in set(_CAD_KINDS.values()) | {'feature'}:
        raise ValueError('Unsupported query kind')
    # Validate frame descriptors even when enumeration produces no candidates.
    if frame not in ('context', 'component', 'root'):
        _entity_frame_target(ctx, frame)
    candidates = _entity_candidates(ctx, data)
    matches: list[adsk.core.Base] = []
    rows: list[JsonRecord] = []
    rejected: list[JsonRecord] = []
    for entity in candidates:
        row = _entity_describe(ctx, entity, frame)
        reasons = _entity_reasons(ctx, entity, row, filters, frame)
        if reasons:
            rejected.append({'ref': ctx.ref(entity), 'reasons': reasons})
        else:
            matches.append(entity)
            rows.append(row)
    groups: dict[str, tuple[JsonRecord, list[JsonRecord]]] = {}
    for row in rows:
        keys: JsonRecord = {}
        for key in group_by:
            geometry_value = row.get('geometry')
            geometry = _entity_geometry(geometry_value)
            value: JsonValue = row.get(key)
            if key == 'geometry':
                value = geometry.get('type')
            elif key == 'radius':
                value = {'value': _cad_cast("int | float", geometry['radius']), 'units': 'cm'} if 'radius' in geometry else None
            elif key == 'axis':
                value = geometry.get('axis', geometry.get('normal', geometry.get('direction')))
                if value is not None:
                    value = _cad_direction(value)
                    sign = next((1 if v > 0 else -1 for v in value if abs(v) > 1e-12), 1)
                    value = {'direction': [round(sign * v, 12) or 0.0 for v in value], 'units': 'unitless', 'frame': row['frame']}
            elif key == 'level':
                box_value = row.get('boundingBox')
                box = _entity_bounds(box_value) if box_value is not None else None
                level = filters.get('level')
                axis = level['axis'] if level is not None else 'z'
                at = level.get('at', 'center') if level is not None else 'center'
                i = 'xyz'.index(axis)
                if box is None:
                    value = None
                elif at == 'center':
                    value = {'value': (box['min'][i] + box['max'][i]) / 2, 'units': 'cm', 'frame': row['frame']}
                elif at == 'min':
                    value = {'value': box['min'][i], 'units': 'cm', 'frame': row['frame']}
                else:
                    value = {'value': box['max'][i], 'units': 'cm', 'frame': row['frame']}
            keys[key] = value
        if group_by:
            key = json.dumps(keys, sort_keys=True)
            group: tuple[JsonRecord, list[JsonRecord]] | None = groups.get(key)
            if group is None:
                group = (keys, [])
                groups[key] = group
            group[1].append(row)
    passed = _entity_in(len(matches), expect)
    doc = ctx.doc
    file = doc.dataFile
    result: JsonRecord = {'schemaVersion': 1, 'success': passed, 'status': 'pass' if passed else 'fail',
              'documentIdentity': {'name': doc.name, 'creationId': getattr(doc, 'creationId', None),
                                   'fileId': getattr(file, 'id', None), 'version': getattr(file, 'versionNumber', None)},
              'entities': rows, 'refs': [ctx.ref(e) for e in matches], 'count': len(matches),
              'candidateCount': len(candidates), 'rejected': rejected,
              'ambiguous': [ctx.ref(e) for e in matches] if expect[1] is not None and len(matches) > expect[1] else [],
              'expect': {'min': expect[0], 'max': expect[1], 'passed': passed},
              'statistics': _entity_stats(rows),
              'groups': [{'key': keys, 'count': len(group_rows), 'entities': group_rows, 'statistics': _entity_stats(group_rows)}
                         for keys, group_rows in groups.values()],
              'units': {'length': 'cm', 'angle': 'rad', 'area': 'cm^2', 'volume': 'cm^3'},
              'frame': frame, 'associativity': 'snapshot', 'affected': [], 'warnings': [],
              'method': 'current native topology, analytic filters and conservative transformed AABB',
              'limitations': ['Re-run after topology, pose, or parameter changes; no native selection rule is stored.',
                              'Bounding boxes are conservative transformed native boxes, not exact containment.',
                              'Grouping uses exact values; axis grouping canonicalizes unoriented directions to 12 decimals.'],
              'provenance': {'query': data}}
    ctx.assert_identity()
    return matches, result


def _entity_find(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    matches, result = _entity_query(ctx, data)
    result['operation'] = 'entity.find'
    legacy_filters_value = data.get('filters', {})
    legacy_filters = _entity_json_object(legacy_filters_value, 'filters') if isinstance(legacy_filters_value, dict) else {}
    legacy = (set(data) <= {'kind', 'component', 'occurrence', 'filters', 'unique'}
              and set(legacy_filters) <= {'name', 'geometry', 'radius', 'axis', 'position', 'tolerance', 'angleTolerance'}
              and not isinstance(legacy_filters.get('radius'), dict))
    if data.get('unique'):
        _cad_unique(matches, 'Geometry search')
        if legacy:
            return ctx.describe(matches[0])
        row = _cad_cast("JsonRecord", _cad_cast("Sequence[JsonValue]", result['entities'])[0])
        for key in ('schemaVersion', 'operation', 'success', 'status', 'documentIdentity', 'units', 'affected', 'warnings', 'method', 'limitations', 'provenance'):
            row[key] = result[key]
        return row
    if legacy:
        return {'entities': [ctx.describe(e) for e in matches], 'count': len(matches)}
    return result


def _entity_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('ref',), ('frame', 'schemaVersion'))
    if 'schemaVersion' in data and (type(data['schemaVersion']) is not int or data['schemaVersion'] != 1):
        raise ValueError('schemaVersion must be 1')
    ctx.assert_identity()
    if set(data) == {'ref'}:
        return ctx.describe(ctx.resolve(data['ref']))
    frame = data.get('frame', 'context')
    if not isinstance(frame, (str, dict)):
        raise ValueError('frame must be context, component, root, or a frame descriptor')
    if isinstance(frame, dict):
        frame = _entity_json_object(frame, 'frame')
    row = _entity_describe(ctx, ctx.resolve(data['ref']), frame)
    file = ctx.doc.dataFile
    row.update(schemaVersion=1, success=True, status='pass', operation='entity.inspect',
               documentIdentity={'name': ctx.doc.name, 'creationId': getattr(ctx.doc, 'creationId', None),
                                 'fileId': getattr(file, 'id', None), 'version': getattr(file, 'versionNumber', None)},
               units={'length': 'cm', 'angle': 'rad', 'area': 'cm^2', 'volume': 'cm^3'},
               affected=[], warnings=[], method='native-to-root-to-output snapshot',
               limitations=['Re-inspect after topology, pose, or parameter changes; no native selection rule.',
                            'Bounding boxes are conservative transformed native AABBs.'], provenance={'query': data})
    ctx.assert_identity()
    return row


def _entity_statistics(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    result = _entity_query(ctx, data)[1]
    result['operation'] = 'entity.stats'
    return result


def _entity_resolve_reference(ctx: "CadContext", ref: "JsonObject", kind: str | None = None) -> "adsk.core.Base":
    """Single-reference adapter for existing assignment/measurement/check consumers."""
    _cad_fields(ref, ('query',), ('kind',))
    if not isinstance(ref['query'], dict):
        raise ValueError('Reference query must be an object')
    query = _entity_json_object(ref['query'], 'Reference query')
    required_kind = kind or ref.get('kind')
    if kind and ref.get('kind', kind) != kind:
        raise ValueError('Reference kind conflicts with required kind')
    if required_kind:
        if query.get('kind', required_kind) != required_kind:
            raise ValueError('Query kind conflicts with required reference kind')
        query['kind'] = required_kind
    if 'expect' not in query and not query.get('unique'):
        query['expect'] = 1
    depth = _cad_cast(int, getattr(ctx, '_entity_reference_depth', 0))
    if depth >= 16:
        raise ValueError('Reference query nesting exceeds 16 levels')
    setattr(ctx, '_entity_reference_depth', depth + 1)
    try:
        entities, result = _entity_query(ctx, query)
        if not result['success']:
            raise ValueError('Reference query expectation failed: ' + json.dumps(result))
        return _cad_unique(entities, 'Reference query')
    finally:
        setattr(ctx, '_entity_reference_depth', depth)


CAD_HANDLERS.update({'entity.stats': _entity_statistics})
