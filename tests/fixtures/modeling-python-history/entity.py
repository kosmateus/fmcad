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


def _entity_matrix(values):
    values = list(values)
    if len(values) != 16 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise ValueError('Frame requires a finite 4x4 rigid matrix')
    columns = [[values[4 * r + c] for r in range(3)] for c in range(3)]
    dot = lambda a, b: sum(x * y for x, y in zip(a, b))
    det = (columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1])
           - columns[1][0] * (columns[0][1] * columns[2][2] - columns[0][2] * columns[2][1])
           + columns[2][0] * (columns[0][1] * columns[1][2] - columns[0][2] * columns[1][1]))
    if (any(abs(dot(a, b) - (1 if i == j else 0)) > 1e-8
            for i, a in enumerate(columns) for j, b in enumerate(columns))
            or abs(det - 1) > 1e-8 or any(abs(a - b) > 1e-8 for a, b in zip(values[12:], [0, 0, 0, 1]))):
        raise ValueError('Scaled, reflected, or non-rigid frames are unsupported')
    return values


def _entity_multiply(a, b):
    return [sum(a[4 * r + k] * b[4 * k + c] for k in range(4)) for r in range(4) for c in range(4)]


def _entity_inverse(m):
    out = list(_ENTITY_IDENTITY)
    for r in range(3):
        for c in range(3):
            out[4 * r + c] = m[4 * c + r]
        out[4 * r + 3] = -sum(m[4 * c + r] * m[4 * c + 3] for c in range(3))
    return out


def _entity_xyz(m, xyz, vector=False):
    return [sum(m[4 * r + c] * xyz[c] for c in range(3)) + (0 if vector else m[4 * r + 3]) for r in range(3)]


def _entity_occurrence_matrix(ctx, occurrence):
    # root.allOccurrences supplies root-qualified proxies. transform2 includes
    # occurrence overrides; reconstructing from native definitions loses them.
    result = list(_ENTITY_IDENTITY)
    parts = occurrence.fullPathName.split('+')
    all_occurrences = _cad_items(ctx.root.allOccurrences)
    for depth in range(1, len(parts) + 1):
        path = '+'.join(parts[:depth])
        item = _cad_unique([o for o in all_occurrences if o.fullPathName == path], 'Occurrence path ' + path)
        result = _entity_matrix(item.transform2.asArray())
    return result


def _entity_owner_matrix(ctx, owner, occurrence=None):
    if owner == ctx.root or owner is None:
        return list(_ENTITY_IDENTITY)
    if occurrence is None:
        occurrence = _cad_unique([o for o in _cad_items(ctx.root.allOccurrences) if o.component == owner],
                                 'Frame conversion requires an explicit occurrence')
    if occurrence.component != owner:
        raise ValueError('Frame occurrence and component disagree')
    return _entity_occurrence_matrix(ctx, occurrence)


def _entity_frame_target(ctx, frame):
    if not isinstance(frame, dict):
        raise ValueError('frame must be context, component, root, or a frame descriptor')
    local = list(_ENTITY_IDENTITY)
    if 'sketch' in frame:
        _cad_fields(frame, ('sketch',))
        sketch = ctx.resolve(frame['sketch'], 'sketch')
        native = getattr(sketch, 'nativeObject', None) or sketch
        points = [_cad_xyz(native.sketchToModelSpace(adsk.core.Point3D.create(*p)))
                  for p in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1))]
        local = [points[c + 1][r] - points[0][r] if c < 3 else points[0][r]
                 for r in range(3) for c in range(4)] + [0, 0, 0, 1]
        component, target_occurrence = _cad_owner(sketch), getattr(sketch, 'assemblyContext', None)
        local = _entity_matrix(local)
        label = {'kind': 'sketch', 'ref': ctx.ref(sketch)}
    else:
        _cad_fields(frame, optional=('component', 'occurrence', 'datum'))
        if not frame:
            raise ValueError('Empty frame descriptor')
        component, target_occurrence = ctx._scope(frame)
        label = {'kind': 'occurrence' if target_occurrence else 'component',
                 'ref': ctx.ref(target_occurrence or component)}
        if 'datum' in frame:
            attribute = component.attributes.itemByName(_CAD_FRAME_GROUP, frame['datum'])
            if attribute is None:
                raise ValueError('Unknown named datum frame: ' + str(frame['datum']))
            local = _entity_matrix(json.loads(attribute.value)['matrix'])
            label.update(kind='datum', name=frame['datum'])
    return component, target_occurrence, local, label


def _entity_frame(ctx, frame, owner, occurrence):
    if frame == 'context':
        frame = 'root' if occurrence is not None else 'component'
    if frame == 'component':
        return list(_ENTITY_IDENTITY), {'kind': 'component', 'ref': ctx.ref(owner or ctx.root)}
    if frame == 'root':
        return _entity_owner_matrix(ctx, owner, occurrence), {'kind': 'root', 'ref': ctx.ref(ctx.root)}
    component, target_occurrence, local, label = _entity_frame_target(ctx, frame)
    if component == owner and (target_occurrence is None or target_occurrence == occurrence):
        # Same-definition local conversion does not need an arbitrary placement.
        return _entity_inverse(local), label
    source = _entity_owner_matrix(ctx, owner, occurrence)
    target = _entity_multiply(_entity_owner_matrix(ctx, component, target_occurrence), local)
    return _entity_multiply(_entity_inverse(target), source), label


def _entity_interval(ctx, value, label, count=False, signed=False):
    def scalar(v):
        if count:
            if type(v) is not int or v < 0:
                raise ValueError(label + ' requires nonnegative integer counts')
            return v
        number = ctx.length(v)
        if not signed and number < 0:
            raise ValueError(label + ' cannot be negative')
        return number
    if isinstance(value, dict):
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


def _entity_attribute_filters(value):
    if not isinstance(value, list) or not value:
        raise ValueError('filters.attributes must be a nonempty array')
    predicates = []
    for predicate in value:
        if not isinstance(predicate, dict):
            raise ValueError('attribute predicate must be an object')
        _cad_fields(predicate, ('group', 'name', 'value', 'owner'))
        for key in ('group', 'name'):
            if not isinstance(predicate[key], str) or not predicate[key].strip():
                raise ValueError('attribute ' + key + ' must be nonempty text')
        if not isinstance(predicate['value'], str):
            raise ValueError('attribute value must be text')
        if predicate['owner'] not in ('native', 'proxy', 'occurrence'):
            raise ValueError('attribute owner must be native, proxy, or occurrence')
        predicates.append(dict(predicate))
    return predicates


def _entity_attribute_owner(entity, owner):
    if owner == 'native':
        native = getattr(entity, 'nativeObject', None)
        if native is not None:
            return native
        return None if getattr(entity, 'assemblyContext', None) is not None else entity
    if owner == 'proxy':
        return entity if getattr(entity, 'assemblyContext', None) is not None else None
    if _cad_type(entity) == 'Occurrence':
        return entity
    return getattr(entity, 'assemblyContext', None)


def _entity_attribute_reasons(entity, predicates):
    reasons = []
    for predicate in predicates:
        target = _entity_attribute_owner(entity, predicate['owner'])
        attributes = getattr(target, 'attributes', None) if target is not None else None
        attribute = attributes.itemByName(predicate['group'], predicate['name']) if attributes is not None else None
        label = predicate['group'] + '/' + predicate['name']
        if attribute is None:
            reasons.append('attribute missing: ' + label)
        elif attribute.value != predicate['value']:
            reasons.append('attribute value mismatch: ' + label)
    return reasons


def _entity_attribute_occurrence_context(data, predicates):
    if not any(predicate['owner'] in ('proxy', 'occurrence') for predicate in predicates):
        return
    scope = data.get('scope', {})
    if not isinstance(scope, dict):
        return  # Let the query scope validator provide the structural error.
    has_occurrence = ('occurrence' in data or 'occurrence' in scope or
                      any(isinstance(scope.get(key), dict) and 'occurrence' in scope[key]
                          for key in ('body', 'feature')))
    if data.get('kind') == 'component':
        raise ValueError('proxy and occurrence attribute predicates are not valid for component candidates')
    if not has_occurrence and not data.get('instances', False) and data.get('kind', 'face') != 'occurrence':
        raise ValueError('proxy and occurrence attribute predicates require an occurrence scope, kind:occurrence, or instances:true')


def _entity_attribute_predicates(filters):
    predicates = list(filters.get('attributes', []))
    adjacency = filters.get('adjacency')
    if adjacency:
        predicates.extend(_entity_attribute_predicates(adjacency.get('filters', {})))
    return predicates


def _entity_in(value, interval, tolerance=0):
    return value is not None and (interval[0] is None or value >= interval[0] - tolerance) and (interval[1] is None or value <= interval[1] + tolerance)


def _entity_filters(ctx, filters, adjacency=True):
    if not isinstance(filters, dict):
        raise ValueError('filters must be an object')
    allowed = ('name', 'geometry', 'radius', 'length', 'axis', 'position',
               'bbox', 'level', 'adjacency', 'tolerance', 'angleTolerance', 'attributes')
    if set(filters) - set(allowed):
        raise ValueError('Unsupported geometry filters: ' + ', '.join(sorted(set(filters) - set(allowed))))
    out = dict(filters)
    if 'attributes' in out:
        out['attributes'] = _entity_attribute_filters(out['attributes'])
    if 'name' in out and not isinstance(out['name'], str):
        raise ValueError('name filter must be text')
    if 'geometry' in out and out['geometry'] not in _ENTITY_TYPES:
        raise ValueError('Unsupported geometry type')
    out['tolerance'] = ctx.length(filters.get('tolerance', '0.001 mm'))
    out['angleTolerance'] = ctx.angle(filters.get('angleTolerance', '0.01 deg'))
    if out['tolerance'] < 0 or not 0 <= out['angleTolerance'] <= math.pi / 2:
        raise ValueError('Tolerances must be nonnegative; angleTolerance must be at most 90 deg')
    for key in ('radius', 'length'):
        if key in out:
            out[key] = _entity_interval(ctx, out[key], key)
    if 'axis' in out:
        out['axis'] = _cad_direction(out['axis'])
    if 'position' in out:
        out['position'] = _cad_xyz(ctx.point(out['position']))
    if 'bbox' in out:
        box = dict(out['bbox'])
        _cad_fields(box, ('min', 'max'), ('mode',))
        if box.get('mode', 'inside') not in ('inside', 'intersects'):
            raise ValueError('bbox mode must be inside or intersects')
        box['min'], box['max'] = _cad_xyz(ctx.point(box['min'])), _cad_xyz(ctx.point(box['max']))
        if any(a > b for a, b in zip(box['min'], box['max'])):
            raise ValueError('bbox min exceeds max')
        out['bbox'] = box
    if 'level' in out:
        level = dict(out['level'])
        _cad_fields(level, ('axis', 'value'), ('at',))
        if level['axis'] not in ('x', 'y', 'z') or level.get('at', 'center') not in ('min', 'max', 'center'):
            raise ValueError('level requires axis x/y/z and at min/max/center')
        level['value'] = _entity_interval(ctx, level['value'], 'level', signed=True)
        out['level'] = level
    if 'adjacency' in out:
        if not adjacency:
            raise ValueError('Nested adjacency queries are unsupported')
        adjacent = dict(out['adjacency'])
        _cad_fields(adjacent, ('kind',), ('filters', 'expect', 'refs'))
        if adjacent['kind'] not in ('body', 'face', 'edge', 'vertex'):
            raise ValueError('Adjacency kind must be body, face, edge, or vertex')
        adjacent['filters'] = _entity_filters(ctx, adjacent.get('filters', {}), False)
        adjacent['expect'] = _entity_interval(ctx, adjacent.get('expect', {'min': 1}), 'adjacency expect', True)
        if 'refs' in adjacent:
            if not isinstance(adjacent['refs'], list) or not adjacent['refs']:
                raise ValueError('adjacency refs must be a nonempty array')
            adjacent['refs'] = [ctx.resolve(ref, adjacent['kind']) for ref in adjacent['refs']]
        out['adjacency'] = adjacent
    return out


def _entity_candidates(ctx, data):
    scope = data.get('scope', {})
    if not isinstance(scope, dict):
        raise ValueError('scope must be an object')
    _cad_fields(scope, optional=('component', 'occurrence', 'body', 'feature'))
    if 'scope' in data and any(k in data for k in ('component', 'occurrence')):
        raise ValueError('scope cannot combine with top-level component/occurrence')
    if 'body' in scope and 'feature' in scope:
        raise ValueError('scope body and feature are exclusive')
    component, occurrence = ctx._scope(scope if 'scope' in data else data)
    kind = data.get('kind', 'face')
    target = None
    for key in ('body', 'feature'):
        if key in scope:
            ref = scope[key]
            ref = {'name': ref} if isinstance(ref, str) else dict(ref)
            context_fields = {field: scope[field] for field in ('component', 'occurrence') if field in scope}
            if 'query' in ref and context_fields:
                nested = dict(ref['query'])
                if any(field in nested for field in ('scope', 'component', 'occurrence')):
                    raise ValueError('Supply body/feature query context either in scope or in its query, not both')
                ref['query'] = dict(nested, **context_fields)
            else:
                ref.update(context_fields)
            target = ctx.resolve(ref, key)
            component = _cad_owner(target)
            occurrence = getattr(target, 'assemblyContext', None)
    contexts = [occurrence]
    if data.get('instances', False):
        if occurrence is not None:
            contexts = [o for o in _cad_items(ctx.root.allOccurrences)
                        if o.fullPathName == occurrence.fullPathName or o.fullPathName.startswith(occurrence.fullPathName + '+')]
        else:
            contexts = [o for o in _cad_items(ctx.root.allOccurrences) if component == ctx.root or o.component == component]
        if occurrence is None and component == ctx.root:
            contexts.insert(0, None)
    result = []
    for context in contexts:
        current = context.component if context is not None else component
        if target is None and kind == 'component' and (data.get('instances') or 'component' in scope or 'occurrence' in scope or 'component' in data or 'occurrence' in data):
            entities = [current]
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
            native = getattr(target, 'nativeObject', None) or target
            if _cad_kind(native) == 'body':
                if kind == 'body':
                    entities = [native]
                elif kind in ('face', 'edge', 'vertex'):
                    entities = _cad_items(getattr(native, {'face': 'faces', 'edge': 'edges', 'vertex': 'vertices'}[kind]))
                else:
                    raise ValueError('Body scope supports body/face/edge/vertex')
            else:
                if kind == 'feature':
                    entities = [native]
                elif kind in ('body', 'face'):
                    entities = _cad_items(getattr(native, {'body': 'bodies', 'face': 'faces'}[kind]))
                elif kind in ('edge', 'vertex'):
                    entities = [e for face in _cad_items(native.faces)
                                for e in _cad_items(getattr(face, 'edges' if kind == 'edge' else 'vertices'))]
                else:
                    raise ValueError('Feature scope supports feature/body/face/edge/vertex')
            entities = [ctx._proxy(e, context) for e in entities]
        else:
            entities = ctx._entities(kind, current, context)
        for entity in entities:
            if not any(entity == other for other in result):
                result.append(entity)
    return result


def _entity_describe(ctx, entity, frame='context'):
    if getattr(entity, 'isValid', True) is False:
        raise ValueError('Invalid entity; re-query current topology')
    native = getattr(entity, 'nativeObject', None) or entity
    owner = _cad_owner(entity)
    occurrence = entity if _cad_kind(entity) == 'occurrence' else getattr(entity, 'assemblyContext', None)
    matrix, label = _entity_frame(ctx, frame, owner, occurrence)
    result = ctx.describe(native)
    if _cad_kind(entity) == 'occurrence':
        result.pop('boundingBox', None)
        if hasattr(entity.component, 'boundingBox'):
            result['boundingBox'] = _cad_json(entity.component.boundingBox)
        result['transformFrame'] = {'from': entity.fullPathName, 'to': entity.fullPathName.rpartition('+')[0] or 'root', 'lengthUnits': 'cm'}
    result.update(ctx.ref(entity))
    result['frame'] = label
    result['associativity'] = 'snapshot'
    result['occurrencePath'] = occurrence.fullPathName if occurrence else None
    geometry = result.get('geometry')
    if geometry:
        geometry.pop('space', None)
        # Sketch worldGeometry is component-local; profile bounds remain sketch-local.
        for key in ('origin', 'center', 'startPoint', 'endPoint', 'xyz'):
            if key in geometry:
                geometry[key] = _entity_xyz(matrix, geometry[key])
        for key in ('axis', 'normal', 'direction'):
            if key in geometry:
                geometry[key] = _cad_direction(_entity_xyz(matrix, geometry[key], True))
        geometry['frame'] = label
        geometry['directionUnits'] = 'unitless'
    box = result.get('boundingBox')
    if box:
        if box.get('space') == 'sketch' or _cad_type(native).startswith('Sketch'):
            sketch = native if _cad_kind(native) == 'sketch' else native.parentSketch
            corners = [_cad_xyz(sketch.sketchToModelSpace(adsk.core.Point3D.create(x, y, z)))
                       for x in (box['min'][0], box['max'][0]) for y in (box['min'][1], box['max'][1]) for z in (box['min'][2], box['max'][2])]
        else:
            corners = [[x, y, z] for x in (box['min'][0], box['max'][0]) for y in (box['min'][1], box['max'][1]) for z in (box['min'][2], box['max'][2])]
        corners = [_entity_xyz(matrix, point) for point in corners]
        result['boundingBox'] = {'min': [min(p[i] for p in corners) for i in range(3)],
                                 'max': [max(p[i] for p in corners) for i in range(3)],
                                 'units': 'cm', 'frame': label, 'method': 'transformed native AABB (conservative)'}
    if 'centroid' in result:
        centroid = result['centroid']
        point = _cad_xyz(native.parentSketch.sketchToModelSpace(adsk.core.Point3D.create(*centroid['xyz'])))
        result['centroid'] = {'xyz': _entity_xyz(matrix, point), 'units': 'cm', 'frame': label}
    body = native if _cad_kind(native) == 'body' else getattr(native, 'body', None)
    if body is not None:
        result['body'] = ctx.ref(ctx._proxy(body, occurrence))
    return result


def _entity_neighbors(entity, kind):
    native = getattr(entity, 'nativeObject', None) or entity
    own_kind = _cad_kind(native)
    if kind == 'body':
        return [native.body] if hasattr(native, 'body') else []
    prop = {'face': 'faces', 'edge': 'edges', 'vertex': 'vertices'}[kind]
    if own_kind == kind:
        via = 'edges' if kind == 'face' else 'faces' if kind == 'edge' else 'edges'
        values = [neighbor for bridge in _cad_items(getattr(native, via))
                  for neighbor in _entity_neighbors(bridge, kind) if neighbor != native]
    elif own_kind == 'edge' and kind == 'vertex':
        values = [v for v in (native.startVertex, native.endVertex) if v is not None]
    elif hasattr(native, prop):
        values = _cad_items(getattr(native, prop))
    else:
        values = []
    result = []
    for value in values:
        if not any(value == other for other in result):
            result.append(value)
    return result


def _entity_reasons(ctx, entity, row, filters, frame):
    geometry = row.get('geometry') or {}
    tolerance = filters['tolerance']
    reasons = []
    if 'name' in filters and row.get('name') != filters['name']:
        reasons.append('name')
    if 'attributes' in filters:
        reasons.extend(_entity_attribute_reasons(entity, filters['attributes']))
    if 'geometry' in filters and geometry.get('type') not in _ENTITY_TYPES[filters['geometry']]:
        reasons.append('geometry')
    for key in ('radius', 'length'):
        actual = geometry.get('radius') if key == 'radius' else row.get('length', {}).get('value')
        if key in filters and not _entity_in(actual, filters[key], tolerance):
            reasons.append(key)
    if 'axis' in filters:
        actual = geometry.get('axis', geometry.get('normal', geometry.get('direction')))
        if actual is None or math.acos(min(1, abs(sum(a * b for a, b in zip(filters['axis'], _cad_direction(actual)))))) > filters['angleTolerance']:
            reasons.append('axis')
    box = row.get('boundingBox')
    if 'position' in filters:
        actual = geometry.get('origin', geometry.get('center', geometry.get('xyz', geometry.get('startPoint'))))
        if actual is None and box:
            actual = [(a + b) / 2 for a, b in zip(box['min'], box['max'])]
        if actual is None:
            reasons.append('position unavailable')
        else:
            delta = [a - b for a, b in zip(filters['position'], actual)]
            direction = geometry.get('axis', geometry.get('direction'))
            if geometry.get('type') == 'Plane':
                distance = abs(sum(a * b for a, b in zip(delta, _cad_direction(geometry['normal']))))
            elif geometry.get('type') in ('Cylinder', 'InfiniteLine3D'):
                direction = _cad_direction(direction)
                dot = sum(a * b for a, b in zip(delta, direction))
                distance = math.hypot(*[a - dot * b for a, b in zip(delta, direction)])
            else:
                distance = math.hypot(*delta)
            if distance > tolerance:
                reasons.append('position')
    if 'bbox' in filters:
        wanted = filters['bbox']
        if box is None:
            reasons.append('bbox unavailable')
        elif wanted.get('mode', 'inside') == 'inside':
            if any(a < b - tolerance for a, b in zip(box['min'], wanted['min'])) or any(a > b + tolerance for a, b in zip(box['max'], wanted['max'])):
                reasons.append('bbox')
        elif any(a > b + tolerance for a, b in zip(box['min'], wanted['max'])) or any(a < b - tolerance for a, b in zip(box['max'], wanted['min'])):
            reasons.append('bbox')
    if 'level' in filters:
        level = filters['level']
        index = 'xyz'.index(level['axis'])
        value = None if box is None else ((box['min'][index] + box['max'][index]) / 2 if level.get('at', 'center') == 'center' else box[level['at']][index])
        if not _entity_in(value, level['value'], tolerance):
            reasons.append('level')
    if 'adjacency' in filters:
        query = filters['adjacency']
        neighbors = [ctx._proxy(e, getattr(entity, 'assemblyContext', None)) for e in _entity_neighbors(entity, query['kind'])]
        matching = [e for e in neighbors if ('refs' not in query or any(e == ref for ref in query['refs']))
                    and not _entity_reasons(ctx, e, _entity_describe(ctx, e, frame), query['filters'], frame)]
        if not _entity_in(len(matching), query['expect']):
            reasons.append('adjacency')
    return reasons


def _entity_stats(rows):
    result = {}
    for key, units in (('radius', 'cm'), ('length', 'cm'), ('area', 'cm^2'), ('volume', 'cm^3')):
        values = [(row.get('geometry') or {}).get('radius') if key == 'radius' else row.get(key, {}).get('value') for row in rows]
        known = [v for v in values if v is not None]
        result[key] = {'count': len(known), 'missing': len(values) - len(known), 'units': units,
                       'min': min(known) if known else None, 'max': max(known) if known else None,
                       'sum': sum(known) if known else None, 'mean': sum(known) / len(known) if known else None}
    return result


def _entity_query(ctx, data):
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
    if not isinstance(group_by, list) or any(k not in ('kind', 'geometry', 'component', 'occurrence', 'body', 'radius', 'length', 'axis', 'level') for k in group_by) or len(set(group_by)) != len(group_by):
        raise ValueError('groupBy must be distinct supported grouping fields')
    frame = data.get('frame', 'context')
    ctx.assert_identity()
    if data.get('kind', 'face') not in set(_CAD_KINDS.values()) | {'feature'}:
        raise ValueError('Unsupported query kind')
    # Validate frame descriptors even when enumeration produces no candidates.
    if frame not in ('context', 'component', 'root'):
        _entity_frame_target(ctx, frame)
    candidates = _entity_candidates(ctx, data)
    matches, rows, rejected = [], [], []
    for entity in candidates:
        row = _entity_describe(ctx, entity, frame)
        reasons = _entity_reasons(ctx, entity, row, filters, frame)
        if reasons:
            rejected.append({'ref': ctx.ref(entity), 'reasons': reasons})
        else:
            matches.append(entity)
            rows.append(row)
    groups = {}
    for row in rows:
        keys = {}
        for key in group_by:
            geometry = row.get('geometry') or {}
            value = row.get(key)
            if key == 'geometry':
                value = geometry.get('type')
            elif key == 'radius':
                value = {'value': geometry['radius'], 'units': 'cm'} if 'radius' in geometry else None
            elif key == 'axis':
                value = geometry.get('axis', geometry.get('normal', geometry.get('direction')))
                if value is not None:
                    value = _cad_direction(value)
                    sign = next((1 if v > 0 else -1 for v in value if abs(v) > 1e-12), 1)
                    value = {'direction': [round(sign * v, 12) or 0.0 for v in value], 'units': 'unitless', 'frame': row['frame']}
            elif key == 'level':
                box = row.get('boundingBox')
                level = filters.get('level', {'axis': 'z', 'at': 'center'})
                i = 'xyz'.index(level['axis'])
                value = None if box is None else {'value': (box['min'][i] + box['max'][i]) / 2 if level.get('at', 'center') == 'center' else box[level['at']][i], 'units': 'cm', 'frame': row['frame']}
            keys[key] = value
        if group_by:
            key = json.dumps(keys, sort_keys=True)
            group = groups.setdefault(key, {'key': keys, 'rows': []})
            group['rows'].append(row)
    passed = _entity_in(len(matches), expect)
    doc = ctx.doc
    file = doc.dataFile
    result = {'schemaVersion': 1, 'success': passed, 'status': 'pass' if passed else 'fail',
              'documentIdentity': {'name': doc.name, 'creationId': getattr(doc, 'creationId', None),
                                   'fileId': getattr(file, 'id', None), 'version': getattr(file, 'versionNumber', None)},
              'entities': rows, 'refs': [ctx.ref(e) for e in matches], 'count': len(matches),
              'candidateCount': len(candidates), 'rejected': rejected,
              'ambiguous': [ctx.ref(e) for e in matches] if expect[1] is not None and len(matches) > expect[1] else [],
              'expect': {'min': expect[0], 'max': expect[1], 'passed': passed},
              'statistics': _entity_stats(rows),
              'groups': [{'key': g['key'], 'count': len(g['rows']), 'entities': g['rows'], 'statistics': _entity_stats(g['rows'])} for g in groups.values()],
              'units': {'length': 'cm', 'angle': 'rad', 'area': 'cm^2', 'volume': 'cm^3'},
              'frame': frame, 'associativity': 'snapshot', 'affected': [], 'warnings': [],
              'method': 'current native topology, analytic filters and conservative transformed AABB',
              'limitations': ['Re-run after topology, pose, or parameter changes; no native selection rule is stored.',
                              'Bounding boxes are conservative transformed native boxes, not exact containment.',
                              'Grouping uses exact values; axis grouping canonicalizes unoriented directions to 12 decimals.'],
              'provenance': {'query': data}}
    ctx.assert_identity()
    return matches, result


def _entity_find(ctx, data):
    matches, result = _entity_query(ctx, data)
    result['operation'] = 'entity.find'
    legacy = (set(data) <= {'kind', 'component', 'occurrence', 'filters', 'unique'}
              and set(data.get('filters', {})) <= {'name', 'geometry', 'radius', 'axis', 'position', 'tolerance', 'angleTolerance'}
              and not isinstance(data.get('filters', {}).get('radius'), dict))
    if data.get('unique'):
        _cad_unique(matches, 'Geometry search')
        if legacy:
            return ctx.describe(matches[0])
        row = result['entities'][0]
        for key in ('schemaVersion', 'operation', 'success', 'status', 'documentIdentity', 'units', 'affected', 'warnings', 'method', 'limitations', 'provenance'):
            row[key] = result[key]
        return row
    if legacy:
        return {'entities': [ctx.describe(e) for e in matches], 'count': len(matches)}
    return result


def _entity_inspect(ctx, data):
    _cad_fields(data, ('ref',), ('frame', 'schemaVersion'))
    if 'schemaVersion' in data and (type(data['schemaVersion']) is not int or data['schemaVersion'] != 1):
        raise ValueError('schemaVersion must be 1')
    ctx.assert_identity()
    if set(data) == {'ref'}:
        return ctx.describe(ctx.resolve(data['ref']))
    row = _entity_describe(ctx, ctx.resolve(data['ref']), data.get('frame', 'context'))
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


def _entity_statistics(ctx, data):
    result = _entity_query(ctx, data)[1]
    result['operation'] = 'entity.stats'
    return result


def _entity_resolve_reference(ctx, ref, kind=None):
    """Single-reference adapter for existing assignment/measurement/check consumers."""
    _cad_fields(ref, ('query',), ('kind',))
    if not isinstance(ref['query'], dict):
        raise ValueError('Reference query must be an object')
    query = dict(ref['query'])
    required_kind = kind or ref.get('kind')
    if kind and ref.get('kind', kind) != kind:
        raise ValueError('Reference kind conflicts with required kind')
    if required_kind:
        if query.get('kind', required_kind) != required_kind:
            raise ValueError('Query kind conflicts with required reference kind')
        query['kind'] = required_kind
    if 'expect' not in query and not query.get('unique'):
        query['expect'] = 1
    depth = getattr(ctx, '_entity_reference_depth', 0)
    if depth >= 16:
        raise ValueError('Reference query nesting exceeds 16 levels')
    ctx._entity_reference_depth = depth + 1
    try:
        entities, result = _entity_query(ctx, query)
        if not result['success']:
            raise ValueError('Reference query expectation failed: ' + json.dumps(result))
        return _cad_unique(entities, 'Reference query')
    finally:
        ctx._entity_reference_depth = depth


CAD_HANDLERS.update({'entity.stats': _entity_statistics})
