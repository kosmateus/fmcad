"""GM-02 document adapters. Uses the core resolver, param.apply and import.file.

Matrices are row-major, column-vector local-to-parent transforms in cm.
Data parsing remains on the CLI host. Runtime preflight precedes writes; SDK
failures are partial, not a promise of global rollback. Never retries or saves.
"""
import hashlib
import time

_DI_GROUP = 'fmcad.dataImport.v1'


def _di_budget(plan):
    if time.monotonic() > plan.get('_deadline', float('inf')):
        raise TimeoutError('Data import budget exhausted; inspect partial state before retry')


def _di_get(entity, name):
    value = entity.attributes.itemByName(_DI_GROUP, name)
    return json.loads(value.value) if value else None


def _di_put(entity, name, value):
    _cad_require_result(entity.attributes.add(_DI_GROUP, name, json.dumps(value, allow_nan=False)), 'Store import ownership')


def _di_native(entity):
    return getattr(entity, 'nativeObject', None) or entity


def _di_eye():
    return [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]


def _di_mul(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def _di_inverse(a):
    b = _di_eye()
    for r in range(3):
        for c in range(3):
            b[r * 4 + c] = a[c * 4 + r]
        b[r * 4 + 3] = -sum(a[c * 4 + r] * a[c * 4 + 3] for c in range(3))
    return b


def _di_rigid(a):
    if not isinstance(a, list) or len(a) != 16 or any(type(v) not in (int, float) or not math.isfinite(v) for v in a):
        raise ValueError('Transform requires 16 finite numbers')
    if any(abs(a[12 + i] - (1 if i == 3 else 0)) > 1e-9 for i in range(4)):
        raise ValueError('Invalid homogeneous row')
    for r in range(3):
        for c in range(3):
            if abs(sum(a[k * 4 + r] * a[k * 4 + c] for k in range(3)) - (1 if r == c else 0)) > 1e-9:
                raise ValueError('Scaling/shear is not supported')
    det = a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) + a[2] * (a[4] * a[9] - a[5] * a[8])
    if abs(det - 1) > 1e-9:
        raise ValueError('Reflection/handedness reversal is not supported')
    return a


def _di_matrix(a):
    matrix = adsk.core.Matrix3D.create()
    _cad_require_result(matrix.setWithArray(_di_rigid(a)), 'Set rigid matrix')
    return matrix


def _di_world(occurrence):
    if occurrence is None:
        return _di_eye()
    parent = getattr(occurrence, 'assemblyContext', None)
    local = list(_di_native(occurrence).transform2.asArray())
    return _di_mul(_di_world(parent), local)


def _di_same(a, b, tolerance=1e-8):
    return len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b))


def _di_metadata(plan, **values):
    return dict(owner=plan['owner'], revision=plan['revision'], digest=plan['digest'], **values)


def _di_existing(old, plan, label):
    if not old:
        return
    if old.get('owner') != plan['owner']:
        raise ValueError(label + ': ownership conflict')
    if plan['onExisting'] == 'error':
        raise ValueError(label + ': already exists (onExisting defaults to error)')
    if plan['onExisting'] == 'reuse' and (old.get('digest') != plan['digest'] or old.get('revision') != plan['revision']):
        raise ValueError(label + ': reuse requires identical revision and content')
    if plan['onExisting'] == 'update' and old.get('revision') != plan['expectedRevision']:
        raise ValueError(label + ': expectedRevision conflict')


def _di_model_preflight(ctx, model):
    if model is None:
        return
    if model.get('missing'):
        raise ValueError('Missing model: ' + model['path'])
    local = Path(model['fusionPath'])
    if not local.is_file():
        raise ValueError('Model is not accessible on Fusion host: ' + str(local))
    digest = hashlib.sha256()
    with local.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != model['sha256']:
        raise ValueError('Model changed since CLI preflight: ' + model['path'])
    _io_import_options(ctx, local)


def _di_import_model(ctx, model, component):
    if model is None:
        return
    before_component, before_occurrence = ctx.component, ctx.occurrence
    try:
        ctx.component, ctx.occurrence = component, None
        ctx.call('import.file', {'path': model['fusionPath'], 'mode': 'component'})
        if component.bRepBodies.count + sum(o.component.bRepBodies.count for o in _cad_items(component.allOccurrences)) == 0:
            raise RuntimeError('Imported model contains no BRep bodies; no geometry acceptance claimed')
    finally:
        ctx.component, ctx.occurrence = before_component, before_occurrence


def _di_material_preflight(ctx, item):
    material = item.get('material') or {}
    if not material.get('id'):
        return
    source = ctx.design
    if material.get('library'):
        source = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries) if lib.id == material['library']], 'Material library')
    found = _cad_unique([m for m in _cad_items(source.materials) if m.id == material['id']], 'Material ID')
    if source != ctx.design and any(m.id == found.id or m.name == found.name for m in _cad_items(ctx.design.materials)):
        raise ValueError('Material library conflicts with local ID/name; explicitly select the local material')


def _di_geometry_state(component):
    return {'bodies': [{'token': b.entityToken, 'name': b.name, 'volume': b.volume, 'faces': b.faces.count, 'edges': b.edges.count,
                        'bounds': [_cad_xyz(b.boundingBox.minPoint), _cad_xyz(b.boundingBox.maxPoint)]} for b in _cad_items(component.bRepBodies)],
            'features': [{'token': f.entityToken, 'parameters': [{'name': p.name, 'expression': p.expression, 'unit': p.unit} for p in _cad_items(f.parameters)] if hasattr(f, 'parameters') else None} for f in _cad_items(component.features)],
            'sketches': [{'token': s.entityToken} for s in _cad_items(component.sketches)],
            # Local nested occurrences cannot expose entityToken in Fusion. Bind
            # through their owning definition, exact sibling name and component.
            'importedOccurrences': [{'name': o.name, 'componentToken': o.component.entityToken, 'matrix': list(o.transform2.asArray()), 'state': _di_geometry_state(o.component)} for o in _cad_items(component.occurrences) if not _di_get(o, 'occurrence')],
            'material': component.material.id if getattr(component, 'material', None) else None}


def _di_geometry_matches(ctx, component, saved):
    if not saved:
        return False
    actual = _di_geometry_state(component)
    if actual['material'] != saved.get('material'):
        return False
    imported = [o for o in _cad_items(component.occurrences) if not _di_get(o, 'occurrence')]
    if len(imported) != len(saved.get('importedOccurrences', [])):
        return False
    for row in saved.get('importedOccurrences', []):
        occurrence = (_di_native(ctx.resolve({'token': row['token']})) if 'token' in row else
                      _cad_unique([o for o in imported if o.name == row['name'] and
                                   o.component == ctx.resolve({'token': row['componentToken']}, 'component')],
                                  'Imported local occurrence'))
        if occurrence not in imported or not _di_same(row['matrix'], list(occurrence.transform2.asArray())) or not _di_geometry_matches(ctx, occurrence.component, row['state']):
            return False
    # Entity tokens are locators, not immutable strings. Resolve old tokens and
    # compare objects, while checking observed topology/shape/feature parameters.
    for key, entities in (('bodies', _cad_items(component.bRepBodies)), ('features', _cad_items(component.features)), ('sketches', _cad_items(component.sketches))):
        if len(saved[key]) != len(entities):
            return False
        for old in saved[key]:
            entity = ctx.resolve({'token': old['token']})
            if entity not in entities:
                return False
            current = actual[key][entities.index(entity)]
            if {k: v for k, v in old.items() if k != 'token'} != {k: v for k, v in current.items() if k != 'token'}:
                return False
    return True


def _di_parameter(ctx, plan):
    parameters = []
    for row in plan['result']['parameters']:
        _di_budget(plan)
        old = ctx.design.allParameters.itemByName(row['name'])
        if old:
            owned = _di_get(old, 'parameter')
            if owned is None:
                raise ValueError('Parameter is unowned: ' + row['name'])
            _di_existing(owned, plan, row['name'])
            current = _cad_parameter_info(ctx, old)
            if owned['state'] != current:
                raise ValueError('Parameter changed outside import: ' + row['name'])
        parameter = {k: row[k] for k in ('name', 'expression', 'unit', 'comment') if k in row}
        parameter['metadata'] = {'source': json.dumps(row['provenance'], sort_keys=True)}
        parameters.append(parameter)
    # This existing handler preflights all expressions/forward dependencies/units
    # before the first parameter mutation. It is intentionally the only engine.
    result = ctx.call('param.apply', {'parameters': parameters, 'overwrite': plan['onExisting'] == 'update'})
    for row in plan['result']['parameters']:
        parameter = ctx.design.userParameters.itemByName(row['name'])
        _di_put(parameter, 'parameter', _di_metadata(plan, state=_cad_parameter_info(ctx, parameter), provenance=row['provenance']))
    return dict(result, associativity='nativeExpression', regeneration='Fusion expression solver; reimport explicitly for source revisions')


def _di_catalog_state(ctx, manifest):
    differences, instances = [], []
    for row in manifest['instances']:
        try:
            occurrence = ctx.resolve(row['occurrence'], 'occurrence')
            native = _di_native(occurrence)
            own = _di_get(native, 'occurrence')
            if not own or own['owner'] != manifest['owner']:
                raise ValueError('Occurrence ownership changed')
            actual = list(native.transform2.asArray())
            if not _di_same(actual, row['localMatrix']):
                differences.append({'id': row['id'], 'field': 'placement', 'status': 'fail', 'actual': actual, 'expected': row['localMatrix']})
            if occurrence.component.name != row['componentName']:
                differences.append({'id': row['id'], 'field': 'componentName', 'status': 'fail'})
            item = _di_get(occurrence.component, 'item')
            if not item or not _di_geometry_matches(ctx, occurrence.component, item.get('geometry')):
                differences.append({'id': row['id'], 'field': 'geometry', 'status': 'fail', 'reason': 'Imported definition changed; no silent reuse'})
            instances.append(dict(row, occurrence=ctx.ref(occurrence), actualMatrix=actual))
        except Exception as error:
            differences.append({'id': row['id'], 'status': 'fail', 'error': str(error)})
    # Detect additions, deletion, or reassignment of owned occurrences, including
    # occurrences added under a repeatedly-instanced assembly definition.
    expected_paths = {r['occurrence'].get('path') for r in manifest['instances']}
    for occurrence in _cad_items(ctx.root.allOccurrences):
        own = _di_get(_di_native(occurrence), 'occurrence')
        if own and own['owner'] == manifest['owner'] and ctx.ref(occurrence).get('path') not in expected_paths:
            differences.append({'occurrence': ctx.ref(occurrence), 'status': 'fail', 'error': 'Unexpected owned occurrence path'})
    return instances, differences


def _di_catalog(ctx, plan, check=False):
    data = plan['result']
    key = 'catalog:' + str(plan['owner'])
    old = _di_get(ctx.root, key)
    if check:
        if old is None:
            return {'status': 'unknown', 'differences': data['differences'], 'unresolved': [{'field': 'catalog', 'reason': 'No owned catalog manifest in this document'}]}
        actual, differences = _di_catalog_state(ctx, old)
        expected = {r['id']: r for r in data['instances']}
        for r in actual:
            row = expected.pop(r['id'], None)
            if row is None or (row['item'], row['parent']) != (r['item'], r['parent']):
                differences.append({'id': r['id'], 'status': 'fail', 'reason': 'Catalog instance mismatch'})
            elif row['placement'] is None:
                differences.append({'id': r['id'], 'status': 'unknown', 'reason': 'Missing requested placement'})
            elif not _di_same(row['placement']['matrix'], r['actualMatrix']):
                differences.append({'id': r['id'], 'status': 'fail', 'reason': 'Requested pose differs from current model'})
        differences.extend({'id': k, 'status': 'fail', 'reason': 'Missing instance'} for k in expected)
        differences.extend(data['differences'])
        return dict(data, instances=actual, differences=differences, status='fail' if any(d['status'] == 'fail' for d in differences) else ('unknown' if differences or plan['unresolved'] else 'pass'))
    _di_existing(old, plan, key)
    if data['differences']:
        raise ValueError('BOM differences must be resolved before catalog import')
    if any(r['placement'] is None for r in data['instances']):
        raise ValueError('Missing placement: refusing to infer origin, roll or lens offset')
    for item in data['items']:
        _di_budget(plan)
        _di_model_preflight(ctx, item['model'])
        if not old:
            _di_material_preflight(ctx, item)
    if old:
        actual, differences = _di_catalog_state(ctx, old)
        if differences:
            raise ValueError('Catalog state conflict: ' + json.dumps(differences))
        # A catalog revision can update metadata without secretly rebuilding CAD.
        structure = [{k: r.get(k) for k in ('id', 'name', 'parent', 'quantity', 'model', 'placement', 'material')} for r in data['items']]
        if structure != old['structure'] or data['instances'] != old['requestedInstances']:
            raise ValueError('Geometry/structure update requires explicit placement import or cots replace; catalog update changes metadata only')
        if plan['onExisting'] == 'reuse':
            return dict(data, idMap=old['idMap'], instances=actual, reused=True, associativity='importedReference')
    else:
        names = {c.name for c in _cad_items(ctx.design.allComponents)}
        requested_names = [r['name'] for r in data['items']]
        if len(set(requested_names)) != len(requested_names) or any(n in names for n in requested_names):
            raise ValueError('Catalog component names must be unique and unused; unowned components cannot be adopted')
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    definitions, actual, by_instance, local_occurrences, copied_materials = {}, [], {}, {}, {}
    if old:
        definitions = {item: ctx.resolve(row['definition'], 'component') for item, row in old['idMap'].items() if row['definition']}
        actual = old['instances']
    else:
        items = {r['id']: r for r in data['items']}
        for row in data['instances']:
            _di_budget(plan)
            item = items[row['item']]
            parent = by_instance[row['parent']] if row['parent'] is not None else None
            component = parent.component if parent else ctx.root
            local_key = (next(r['item'] for r in data['instances'] if r['id'] == row['parent']) if parent else None, row['localKey'])
            local = row['placement']['matrix']
            created_occurrence = local_key not in local_occurrences
            if local_key in local_occurrences:
                native = local_occurrences[local_key]
            else:
                if row['item'] in definitions:
                    native = _cad_require_result(component.occurrences.addExistingComponent(definitions[row['item']], _di_matrix(local)), 'Add linked catalog occurrence')
                else:
                    native = _cad_require_result(component.occurrences.addNewComponent(_di_matrix(local)), 'Create catalog definition')
                    definitions[row['item']] = native.component
                    native.component.name = item['name']
                    ctx.created.append(ctx.ref(native.component))
                    _di_put(native.component, 'item', _di_metadata(plan, id=item['id'], item=item))
                    _di_import_model(ctx, item['model'], native.component)
                    material = item.get('material') or {}
                    if material.get('id'):
                        key_material = (material.get('library'), material['id'])
                        selection = copied_materials.get(key_material, {k: material[k] for k in ('id', 'library') if k in material})
                        assigned = ctx.call('material.assign', dict(selection, refs=[ctx.ref(native.component)]))
                        copied_materials[key_material] = {'id': assigned['id']}
                _di_put(native, 'occurrence', _di_metadata(plan, item=row['item'], localKey=row['localKey']))
                local_occurrences[local_key] = native
            occurrence = _cad_require_result(native.createForAssemblyContext(parent), 'Create nested occurrence proxy') if parent else native
            if created_occurrence:
                ctx.created.append(ctx.ref(occurrence))
            observed_local = list(native.transform2.asArray())
            if not _di_same(local, observed_local):
                raise RuntimeError('Catalog occurrence placement readback mismatch')
            by_instance[row['id']] = occurrence
            actual.append({'id': row['id'], 'item': row['item'], 'parent': row['parent'], 'occurrence': ctx.ref(occurrence),
                           'localMatrix': observed_local, 'componentName': item['name']})
            print('FMCAD_PROGRESS ' + json.dumps({'operation': plan['operation'], 'completed': len(actual), 'total': len(data['instances'])}))
    id_map = {r['id']: {'definition': ctx.ref(definitions[r['id']]) if r['id'] in definitions else None,
                       'occurrences': [a['occurrence'] for a in actual if a['item'] == r['id']]} for r in data['items']}
    for item in data['items']:
        if item['id'] in definitions:
            _di_put(definitions[item['id']], 'item', _di_metadata(plan, id=item['id'], item=item, geometry=_di_geometry_state(definitions[item['id']])))
    manifest = _di_metadata(plan, instances=actual, idMap=id_map, ledger=data['ledger'], provenance=plan['provenance'],
                            requestedInstances=data['instances'], structure=[{k: r.get(k) for k in ('id', 'name', 'parent', 'quantity', 'model', 'placement', 'material')} for r in data['items']])
    _di_put(ctx.root, key, manifest)
    snapshot = _assembly_capture(ctx, capture)
    return dict(data, idMap=id_map, instances=actual, notExecuted=[{'id': r['id'], 'reason': 'No physical/reference occurrence requested; definition retained as catalog data'} for r in data['items'] if r['id'] not in definitions],
                associativity='importedReference', metadataOnly=bool(old), snapshot=snapshot)


def _di_unconstrained(ctx, occurrence):
    native = _di_native(occurrence)
    # isGrounded is unavailable on unqualified nested natives in Fusion.
    if native.isReferencedComponent or occurrence.isGrounded or native.isGroundToParent:
        raise ValueError('External/grounded occurrence cannot be changed')
    # Descendant constraints also constrain a parent assembly's placement.
    subtree = [native] + [_di_native(o) for o in _cad_items(native.component.allOccurrences)]
    for component in _cad_items(ctx.design.allComponents):
        for collection in ('joints', 'asBuiltJoints', 'rigidGroups'):
            for joint in _cad_items(getattr(component, collection)):
                if getattr(joint, 'isSuppressed', False):
                    continue
                participants = _cad_items(joint.occurrences) if collection == 'rigidGroups' else [joint.occurrenceOne, joint.occurrenceTwo]
                if any(o and _di_native(o) in subtree for o in participants):
                    raise ValueError('Occurrence participates in an active joint/rigid group; edit its driving relationship explicitly')


def _di_pose_plan(ctx, rows):
    resolved = [(r, ctx.resolve(r['occurrence'], 'occurrence')) for r in rows]
    paths = [o.fullPathName for r, o in resolved]
    if len(set(paths)) != len(paths):
        raise ValueError('Duplicate resolved occurrence path')
    targets = {o.fullPathName: (r, o) for r, o in resolved}
    cache, visiting = {}, set()

    def world(o):
        if o is None:
            return _di_eye()
        key = o.fullPathName
        if key in cache:
            return cache[key]
        if key in visiting:
            raise ValueError('Placement frame dependency cycle')
        visiting.add(key)
        if key in targets:
            row = targets[key][0]
            if row['transform'] is None:
                raise ValueError('Missing complete placement: ' + row['id'])
            transform = row['transform']
            frame = transform['frame']
            if frame == 'parent':
                basis = world(getattr(o, 'assemblyContext', None))
            elif frame == 'root':
                basis = _di_eye()
            else:
                frame_occurrence = ctx.resolve(frame['occurrence'], 'occurrence') if 'occurrence' in frame else None
                basis = world(frame_occurrence)
                if 'datum' in frame:
                    owner = frame_occurrence.component if frame_occurrence else ctx.root
                    attribute = owner.attributes.itemByName(_CAD_FRAME_GROUP, frame['datum'])
                    if not attribute:
                        raise ValueError('Named datum frame does not exist: ' + frame['datum'])
                    datum = json.loads(attribute.value)
                    if datum.get('space') != 'component local' or datum.get('lengthUnits') != 'cm' or ctx.resolve(datum['component'], 'component') != owner:
                        raise ValueError('Named datum identity, space or units mismatch')
                    basis = _di_mul(basis, _di_rigid(datum['matrix']))
            value = _di_mul(basis, _di_rigid(transform['matrix']))
        else:
            value = _di_mul(world(getattr(o, 'assemblyContext', None)), list(_di_native(o).transform2.asArray()))
        visiting.remove(key)
        cache[key] = value
        return value

    result = []
    for row, occurrence in resolved:
        desired_world = world(occurrence)
        local = _di_mul(_di_inverse(world(getattr(occurrence, 'assemblyContext', None))), desired_world)
        result.append((row, occurrence, local, desired_world))
    return result


def _di_placement(ctx, plan, check=False):
    data = plan['result']
    if any(r['transform'] is None for r in data['poses']) and check:
        return {'status': 'unknown', 'poses': [], 'unresolved': plan['unresolved']}
    planned = _di_pose_plan(ctx, data['poses'])
    if check:
        measured = []
        for row, occurrence, local, world in planned:
            delta = _di_mul(_di_inverse(world), _di_world(occurrence))
            distance = math.hypot(delta[3], delta[7], delta[11])
            angle = math.acos(max(-1., min(1., (delta[0] + delta[5] + delta[10] - 1) / 2)))
            measured.append({'id': row['id'], 'occurrence': ctx.ref(occurrence), 'distance': distance, 'units': 'cm', 'angle': angle, 'angleUnits': 'rad', 'frame': 'root',
                             'status': 'pass' if distance <= data['tolerance'] and angle <= data['angleTolerance'] else 'fail', 'actual': _di_world(occurrence), 'expected': world})
        return {'poses': measured, 'status': 'fail' if any(r['status'] == 'fail' for r in measured) else ('unknown' if plan['unresolved'] else 'pass')}
    all_occurrences = _cad_items(ctx.root.allOccurrences)
    native_plan = []
    for row, occurrence, local, world in planned:
        _di_budget(plan)
        native = _di_native(occurrence)
        _di_unconstrained(ctx, occurrence)
        old = _di_get(native, 'placement')
        if old:
            _di_existing(old, plan, row['id'])
            if not _di_same(old['matrix'], list(native.transform2.asArray())):
                raise ValueError('Placement changed outside owned import')
        else:
            owned = _di_get(native, 'occurrence')
            if not owned or owned['owner'] != plan['owner']:
                raise ValueError('Placement cannot adopt an unowned occurrence')
        for other in all_occurrences:
            if _di_native(other) == native:
                target = next((p for p in planned if p[1].fullPathName == other.fullPathName), None)
                if target is None or not _di_same(target[2], local):
                    raise ValueError('Nested linked occurrence changes require every affected path with the same local pose')
        if not any(p[1] == native for p in native_plan):
            native_plan.append((row, native, local))
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    for row, native, local in native_plan:
        _di_budget(plan)
        native.transform2 = _di_matrix(local)
        if not _di_same(local, list(native.transform2.asArray())):
            raise RuntimeError('Placement readback mismatch')
        _di_put(native, 'placement', _di_metadata(plan, matrix=local, provenance=row['provenance']))
    snapshot = _assembly_capture(ctx, capture)
    return {'poses': [{'id': r['id'], 'occurrence': ctx.ref(o), 'actual': _di_world(o), 'units': 'cm', 'frame': 'root'} for r, o, local, world in planned],
            'snapshot': snapshot, 'associativity': 'snapshot', 'invalidated': ['catalog placement check', 'mating parts', 'routings', 'clearance', 'mass CG/inertia']}


def _di_replace(ctx, plan):
    data = plan['result']
    components = [c for c in _cad_items(ctx.design.allComponents) if (_di_get(c, 'item') or {}).get('id') == data['target'] and (_di_get(c, 'item') or {}).get('owner') == plan['owner'] and (_di_get(c, 'item') or {}).get('revision') == plan['expectedRevision']]
    component = _cad_unique(components, 'Owned replacement item ' + data['target'])
    old = _di_get(component, 'item')
    if plan['expectedRevision'] != old['revision']:
        raise ValueError('COTS replacement requires matching expectedRevision')
    if old['item']['kind'] not in ('purchased', 'pcba'):
        raise ValueError('COTS replacement requires purchased/pcba catalog item')
    if not _di_geometry_matches(ctx, component, old.get('geometry')):
        raise ValueError('COTS geometry changed outside owned import; explicit reconciliation required')
    candidates = [o for o in _cad_items(ctx.root.allOccurrences) if o.component == component]
    selected = candidates if data['occurrencePolicy'] == 'all' else [ctx.resolve(r, 'occurrence') for r in data['occurrences']]
    if not selected or len({o.fullPathName for o in selected}) != len(selected) or any(o.component != component for o in selected):
        raise ValueError('Selected occurrences must be unique paths of the owned target component')
    selected_paths = {o.fullPathName for o in selected}
    if len(selected) > plan['maxItems']:
        raise ValueError('COTS affected occurrence count exceeds maxItems')
    for occurrence in selected:
        _di_unconstrained(ctx, occurrence)
        own = _di_get(_di_native(occurrence), 'occurrence')
        if not own or own['owner'] != plan['owner']:
            raise ValueError('Unowned occurrence cannot be replaced')
        # Removing a native nested occurrence removes all its assembly proxies.
        if any(_di_native(o) == _di_native(occurrence) and o.fullPathName not in selected_paths for o in candidates):
            raise ValueError('Selected policy omits linked nested paths; select every shared native path or make the assembly independent first')
    children = [o for o in _cad_items(component.occurrences) if _di_get(o, 'occurrence')]
    if children:
        if data['childrenPolicy'] != 'preserve' or 'includedItems' not in data['model']:
            raise ValueError('Physical children require childrenPolicy:preserve and explicit model.includedItems to prevent duplicate contents')
        for child in children:
            child_data = _di_get(child, 'occurrence')
            if child_data['owner'] != plan['owner'] or child_data['item'] in data['model']['includedItems']:
                raise ValueError('Cannot preserve foreign or already-included physical contents')
    # Do not destroy user geometry or associative downstream references silently.
    for body in _cad_items(component.bRepBodies):
        if hasattr(body, 'assemblyContext') and body.assemblyContext is not None:
            raise ValueError('Replacement requires native source bodies')
    _di_model_preflight(ctx, data['model'])
    capture = _assembly_capture_ready(ctx)
    ctx.assert_identity()
    # Import once into a new definition. All old occurrences remain until the
    # replacement has been imported successfully and complete poses are known.
    first = selected[0]
    first_native = _di_native(first)
    first_parent = getattr(first, 'assemblyContext', None)
    parent_component = first_parent.component if first_parent else ctx.root
    matrix = _di_mul(list(first_native.transform2.asArray()), data['delta'])
    seed = _cad_require_result(parent_component.occurrences.addNewComponent(_di_matrix(matrix)), 'Create replacement component')
    seed.component.name = component.name + ' [' + plan['revision'] + ']'
    seed_context = seed.createForAssemblyContext(first_parent) if first_parent else seed
    ctx.created.extend([ctx.ref(seed.component), ctx.ref(seed_context)])
    _di_import_model(ctx, data['model'], seed.component)
    child_replacements = []
    for child in children:
        _di_budget(plan)
        replacement = _cad_require_result(seed.component.occurrences.addExistingComponent(child.component,
            _di_matrix(_di_mul(_di_inverse(data['delta']), list(child.transform2.asArray())))), 'Preserve physical COTS child')
        ctx.created.append(ctx.ref(replacement.createForAssemblyContext(seed_context)))
        _di_put(replacement, 'occurrence', dict(_di_get(child, 'occurrence'), replaces=ctx.ref(child.createForAssemblyContext(first))))
        child_replacements.append((child, replacement))
    item = dict(old['item'], model=data['model'], mass=data['mass'])
    # The old part's assigned material is not evidence for the new vendor file.
    item.pop('material', None)
    _di_put(seed.component, 'item', _di_metadata(plan, id=data['target'], item=item, geometry=_di_geometry_state(seed.component), replaces=ctx.ref(component), invalidated=data['impacts']))
    natives, replacements, new_natives = [], [], []
    for occurrence in selected:
        _di_budget(plan)
        native = _di_native(occurrence)
        if native in natives:
            continue
        natives.append(native)
        parent = getattr(occurrence, 'assemblyContext', None)
        parent_component = parent.component if parent else ctx.root
        replacement = seed if native == first_native else _cad_require_result(parent_component.occurrences.addExistingComponent(seed.component,
            _di_matrix(_di_mul(list(native.transform2.asArray()), data['delta']))), 'Add replacement occurrence')
        actual = replacement.createForAssemblyContext(parent) if parent else replacement
        if replacement != seed:
            ctx.created.append(ctx.ref(actual))
        _di_put(replacement, 'occurrence', _di_metadata(plan, item=data['target'], replaces=ctx.ref(occurrence)))
        new_natives.append((native, replacement))
        replacements.append({'before': ctx.ref(occurrence), 'after': ctx.ref(actual), 'localMatrix': list(replacement.transform2.asArray())})
    datum_checks, occurrence_map, child_map = [], [], []
    for occurrence in selected:
        replacement = next(new for old, new in new_natives if old == _di_native(occurrence))
        parent = getattr(occurrence, 'assemblyContext', None)
        actual = replacement.createForAssemblyContext(parent) if parent else replacement
        for datum in data['datums']:
            expected = _di_mul(_di_world(occurrence), datum['old']['matrix'])
            observed = _di_mul(_di_world(actual), datum['new']['matrix'])
            if not _di_same(expected, observed):
                raise RuntimeError('Replacement datum readback mismatch; old occurrences retained')
            datum_checks.append({'occurrence': ctx.ref(actual), 'datum': datum['name'], 'status': 'pass', 'expected': expected, 'actual': observed, 'frame': 'root', 'units': 'cm'})
        occurrence_map.append({'before': ctx.ref(occurrence), 'after': ctx.ref(actual)})
        for child, new_child in child_replacements:
            before_child = child.createForAssemblyContext(occurrence)
            after_child = new_child.createForAssemblyContext(actual)
            if not _di_same(_di_world(before_child), _di_world(after_child)):
                raise RuntimeError('Physical child placement readback mismatch; old COTS retained')
            child_map.append({'before': ctx.ref(before_child), 'after': ctx.ref(after_child), 'worldMatrix': _di_world(after_child), 'frame': 'root', 'units': 'cm'})
    for native in natives:
        _di_budget(plan)
        _cad_require_result(native.deleteMe(), 'Remove replaced owned occurrence')
    snapshot = _assembly_capture(ctx, capture)
    return {'replacements': replacements, 'occurrenceMap': occurrence_map, 'childMap': child_map, 'datumChecks': datum_checks, 'selectedPaths': sorted(selected_paths), 'datumMap': data['datums'], 'preservedDatumTransform': data['delta'],
            'impacts': data['impacts'], 'mass': data['mass'], 'snapshot': snapshot, 'associativity': 'importedReference',
            'material': {'previous': old['item'].get('material'), 'replacement': None, 'status': 'unknown', 'reason': 'Imported material has not been reconciled with supplier evidence'},
            'unresolved': [{'id': data['target'], 'field': 'replacement.material', 'status': 'unknown'}],
            'invalidated': ['catalog occurrence refs', 'geometry refs', 'mating parts', 'routings', 'mass/CG/inertia checks'],
            'limitations': ['Replacement creates a new imported definition; geometric refs are invalidated, not remapped. Datums are explicit input evidence, not native construction constraints.']}


def _di_handler(ctx, plan):
    operation = plan['operation']
    ctx.assert_identity()
    before = len(ctx.created)
    plan['_deadline'] = time.monotonic() + plan['budgetMs'] / 1000
    try:
        if operation == 'param.import':
            result = _di_parameter(ctx, plan)
        elif operation.startswith('catalog.'):
            result = _di_catalog(ctx, plan, operation.endswith('.check'))
        elif operation.startswith('placement.'):
            result = _di_placement(ctx, plan, operation.endswith('.check'))
        else:
            result = _di_replace(ctx, plan)
    except Exception as error:
        return {'status': 'blocked' if len(ctx.created) == before else 'fail', 'error': str(error), 'atomic': False,
                'created': ctx.created[before:], 'mutationMayHaveOccurred': True, 'notExecuted': 'Inspect current document before retry; mutations are not automatically replayed',
                'documentIdentity': _io_identity(ctx), 'provenance': plan['provenance'], 'operation': operation,
                'units': 'cm', 'frame': 'explicit per row', 'associativity': 'nativeExpression' if operation == 'param.import' else 'importedReference',
                'warnings': plan['warnings'], 'unresolved': plan['unresolved'], 'method': 'data adapter preflight/execution',
                'limitations': ['No global rollback. No automatic retry.']}
    result.setdefault('status', 'unknown' if plan['unresolved'] or result.get('unresolved') else 'pass')
    result.update(documentIdentity=_io_identity(ctx), operation=operation, atomic=False, units='per parameter; internal cm,rad,kg,s' if operation == 'param.import' else 'cm', frame='explicit per row',
                  provenance=plan['provenance'], warnings=plan['warnings'], unresolved=plan['unresolved'] + result.get('unresolved', []), method='data adapter through existing CAD handlers')
    result.setdefault('associativity', 'snapshot' if operation.startswith('placement.') else 'importedReference')
    result.setdefault('limitations', ['Native kernel and API failures are non-atomic; no automatic retry or save.',
                                    'Source confidence is retained. Geometry guards compare observed topology, bounds, volume and exposed feature parameters; they are not exact BRep equivalence certificates.'])
    return result


CAD_HANDLERS.update({name: _di_handler for name in ('param.import', 'catalog.import', 'catalog.check', 'placement.import', 'placement.check', 'cots.replace')})
