"""GM29 appearances, physical materials, assignment maps and style reports.

Appearance and physical material are two independent properties of an entity.
A library resource is copied into the Design before it is edited and a copy ID
is never assumed to be unique (the actual returned ID is authoritative). Typed
properties are read and written through the documented
Appearance.appearanceProperties / Material.materialProperties collections using
the concrete Property subclasses; the preview Color/roughness/texture shortcuts
are used only where no documented property path exists and are flagged as such.
A missing material density is reported, never silently replaced. See
docs/APPEARANCES.md.
"""
import math


_STYLE_LIMITS = [
    'Appearance and physical material are separate properties; assigning one never implies the other.',
    'A face override can mask a body style; inspect the concrete entity, not an assumed effective style.',
    'A missing density or coating is reported, never fabricated; measure mass separately.',
]


def _style_identity(ctx):
    ctx.assert_identity()
    return {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}


def _style_contract(ctx, operation, result, status='pass', read_only=False, warnings=None, limitations=None):
    base = {
        'schemaVersion': 1, 'operation': operation, 'status': status, 'success': status == 'pass',
        'documentIdentity': _style_identity(ctx),
        'units': {'length': 'cm', 'angle': 'rad'},
        'frame': {'space': 'component', 'component': ctx.ref(ctx.component)},
        'associativity': 'snapshot' if read_only else 'nativeProperty',
        'warnings': list(result.pop('warnings', warnings or [])),
        'method': 'Public Fusion appearance/material SDK with explicit availability gates (GM29)',
        'limitations': _STYLE_LIMITS + list(result.pop('limitations', limitations or [])),
        'provenance': {'requirement': 'GM29', 'source': 'docs/APPEARANCES.md'},
        'affected': list(result.pop('affected', [])),
        'dependencies': result.pop('dependencies', 'Direct native property assignment; no automatic recompute.'),
    }
    merged = dict(base)
    merged.update(result)
    merged['status'] = status
    merged['success'] = status == 'pass'
    return merged


def _style_blocked(ctx, operation, reason):
    return _style_contract(ctx, operation, {}, status='blocked', read_only=True,
                           warnings=[reason],
                           limitations=['The requested representation is not available through the installed '
                                        'SDK; an explicit alternative must be chosen, none was silently substituted.'])


def _style_value(value):
    return {'id': value.id, 'name': value.name} if value is not None else None


def _style_collection(ctx, kind, library=None):
    source = ctx.design
    if library is not None:
        if not isinstance(library, str) or not library:
            raise ValueError('library must be an exact loaded library ID')
        source = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries)
                              if lib.id == library], 'Loaded library ID')
    return source, getattr(source, 'appearances' if kind == 'appearance' else 'materials')


def _style_resolve(ctx, kind, style_id, collection):
    """Deterministically resolve a style ID without assuming a unique copy ID."""
    local_collection = getattr(ctx.design, 'appearances' if kind == 'appearance' else 'materials')
    return _cad_style_resolve([v for v in _cad_items(collection) if v.id == style_id],
                              kind + ' ID', local_collection, style_id)


def _style_resolution_warning(kind, style_id, resolution):
    if not resolution['ambiguous']:
        return None
    return ('%s ID %r is not unique; deterministically resolved to %r (precedence %s) among %d candidates'
            % (kind, style_id, resolution['selected']['name'], resolution['precedence'],
               len(resolution['candidates'])))


def _style_require_design_item(ctx, kind, style_id):
    if not isinstance(style_id, str) or not style_id:
        raise ValueError('id must be an exact design-local ' + kind + ' ID')
    collection = getattr(ctx.design, 'appearances' if kind == 'appearance' else 'materials')
    item, resolution = _style_resolve(ctx, kind, style_id, collection)
    if not _cad_style_is_design_local(item, collection):
        raise ValueError(kind + '.edit targets design-local resources only; copy a library resource first via ' + kind + '.create')
    return item, resolution


def _style_prop_type(prop):
    for name in ('FloatProperty', 'IntegerProperty', 'BooleanProperty', 'StringProperty',
                 'ColorProperty', 'ChoiceProperty', 'AppearanceTextureProperty'):
        cls = getattr(adsk.core, name, None)
        if cls is not None and cls.cast(prop) is not None:
            return name
    return 'Property'


def _style_prop_value(value):
    if value is None:
        return None
    if hasattr(value, 'red') and hasattr(value, 'green') and hasattr(value, 'blue'):
        return {'color': [int(value.red), int(value.green), int(value.blue),
                          int(getattr(value, 'opacity', 255))]}
    if hasattr(value, 'objectType'):
        kind = value.objectType.split('::')[-1]
        if kind in ('Point3D', 'Vector3D'):
            return {'type': kind, 'xyz': _cad_xyz(value)}
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, str):
        return value
    if hasattr(value, 'name') and hasattr(value, 'value'):
        return {'name': value.name, 'value': value.value}
    return str(value)


def _style_prop_info(prop):
    info = {'id': prop.id, 'name': prop.name, 'isReadOnly': prop.isReadOnly, 'type': _style_prop_type(prop)}
    # Check the class, not the instance: `hasattr(prop, 'units')` would invoke the
    # property getter, which can raise RuntimeError (InternalValidationError) for a
    # unit string Fusion does not recognize (e.g. the "Stal — satynowa" appearance).
    if hasattr(type(prop), 'units'):
        try:
            info['units'] = prop.units
        except Exception:
            # Report an unrecognized unit as unknown rather than crashing or
            # fabricating a unit, matching "a style must not silently substitute a
            # missing property".
            info['units'] = 'unknown'
    if hasattr(prop, 'value'):
        info['value'] = _style_prop_value(getattr(prop, 'value', None))
    if hasattr(prop, 'hasConnectedTexture'):
        info['hasConnectedTexture'] = bool(prop.hasConnectedTexture)
    if hasattr(prop, 'hasLimits'):
        info['hasLimits'] = bool(prop.hasLimits)
    return info


def _style_properties(item, kind):
    collection = getattr(item, 'appearanceProperties' if kind == 'appearance' else 'materialProperties', None)
    if collection is None:
        return None
    return [_style_prop_info(collection.item(i)) for i in range(collection.count)]


def _style_set_property(ctx, prop, value):
    if prop.isReadOnly:
        raise ValueError('Property is read-only: ' + prop.name)
    ptype = _style_prop_type(prop)
    if ptype == 'FloatProperty':
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('FloatProperty value must be a finite number')
        prop.value = float(value)
    elif ptype == 'IntegerProperty':
        if type(value) is not int:
            raise ValueError('IntegerProperty value must be an integer')
        prop.value = value
    elif ptype == 'BooleanProperty':
        if type(value) is not bool:
            raise ValueError('BooleanProperty value must be a boolean')
        prop.value = value
    elif ptype == 'StringProperty':
        if not isinstance(value, str):
            raise ValueError('StringProperty value must be a string')
        prop.value = value
    elif ptype == 'ChoiceProperty':
        if not isinstance(value, str):
            raise ValueError('ChoiceProperty value must be a choice name string')
        prop.value = value
    elif ptype == 'ColorProperty':
        if not isinstance(value, (list, tuple)) or len(value) not in (3, 4):
            raise ValueError('ColorProperty value must be [r,g,b] or [r,g,b,a] integers 0..255')
        if any(type(v) is not int or not 0 <= v <= 255 for v in value):
            raise ValueError('Color components must be integers 0..255')
        rgba = list(value) + [255] if len(value) == 3 else list(value)
        prop.value = adsk.core.Color.create(*rgba)
    else:
        raise ValueError('Unsupported property type for edit: ' + ptype)


def _style_apply_properties(ctx, item, kind, specs):
    if not isinstance(specs, list) or not specs:
        raise ValueError('properties must be a nonempty array of {id, value}')
    collection = getattr(item, 'appearanceProperties' if kind == 'appearance' else 'materialProperties', None)
    if collection is None:
        raise ValueError('Installed SDK does not expose typed ' + kind + ' properties')
    changes = []
    for spec in specs:
        if not isinstance(spec, dict) or set(spec) - {'id', 'value'} or 'id' not in spec or 'value' not in spec:
            raise ValueError('Property edits accept {id, value} only')
        prop = collection.itemById(spec['id'])
        if prop is None:
            raise ValueError('Unknown property ID: ' + str(spec['id']))
        before = _style_prop_info(prop)
        _style_set_property(ctx, prop, spec['value'])
        changes.append({'id': spec['id'], 'before': before, 'after': _style_prop_info(prop)})
    return changes


def _style_props_by_name(item, kind):
    collection = getattr(item, 'appearanceProperties' if kind == 'appearance' else 'materialProperties', None)
    if collection is None:
        return {}
    return {collection.item(i).name: collection.item(i) for i in range(collection.count)}


def _style_find_prop(item, kind, prop_id):
    collection = getattr(item, 'appearanceProperties' if kind == 'appearance' else 'materialProperties', None)
    if collection is None:
        return None
    prop = collection.itemById(prop_id)
    if prop is None:
        prop = next((collection.item(i) for i in range(collection.count)
                     if collection.item(i).name == prop_id), None)
    return prop


def appearance_create(ctx, data):
    _cad_fields(data, ('name',), ('id', 'library', 'surfaceType'))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty')
    local = ctx.design.appearances
    if any(v.name == name for v in _cad_items(local)):
        raise ValueError('Appearance name already exists in the Design; copy/edit the existing resource')
    source = ctx.design
    requested = {'id': None, 'library': None}
    resolution = None
    if 'id' in data:
        if not isinstance(data['id'], str) or not data['id']:
            raise ValueError('id must be an exact appearance ID from appearance.list')
        source, collection = _style_collection(ctx, 'appearance', data.get('library'))
        if 'library' in data and source != ctx.design:
            if any(v.id == data['id'] or v.name == name for v in _cad_items(local)):
                raise ValueError('Design-local ID/name collision: no equivalence assumed; select the local id without library')
        item, resolution = _style_resolve(ctx, 'appearance', data['id'], collection)
        requested = {'id': data['id'], 'library': data.get('library')}
        created = _cad_require_result(local.addByCopy(item, name), 'Copy appearance')
    else:
        if not hasattr(local, 'add'):
            raise ValueError('Installed SDK cannot create a neutral appearance; pass id/library to copy an existing one')
        surface_type = adsk.core.AppearanceSurfaceTypes.OpaqueAppearanceSurface
        surfaces = {'opaque': 'OpaqueAppearanceSurface', 'metal': 'MetalAppearanceSurface',
                    'transparent': 'TransparentAppearanceSurface'}
        if 'surfaceType' in data:
            if data['surfaceType'] not in surfaces:
                raise ValueError('surfaceType must be opaque, metal, or transparent')
            surface_type = getattr(adsk.core.AppearanceSurfaceTypes, surfaces[data['surfaceType']])
        created = _cad_require_result(local.add(name, surface_type), 'Create appearance')
    ctx.created.append({'token': None, 'kind': 'appearance', 'name': name})
    result = {'created': _style_value(created), 'requested': requested,
              'id': created.id, 'copiedFrom': requested['id'],
              'properties': _style_properties(created, 'appearance') or [],
              'resolution': resolution,
              'limitations': ['Appearances.add is a preview feature and the returned copy is design-local; verify in the UI.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': created.id}, 'before': None,
                            'after': _style_value(created)}]}
    warning = _style_resolution_warning('appearance', data['id'], resolution) if 'id' in data else None
    if warning:
        result['warnings'] = [warning]
    return result


def material_create(ctx, data):
    _cad_fields(data, ('name', 'id'), ('library',))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty')
    local = ctx.design.materials
    if any(v.name == name for v in _cad_items(local)):
        raise ValueError('Material name already exists in the Design; copy/edit the existing resource')
    source, collection = _style_collection(ctx, 'material', data.get('library'))
    if 'library' in data and source != ctx.design:
        if any(v.id == data['id'] or v.name == name for v in _cad_items(local)):
            raise ValueError('Design-local ID/name collision: no equivalence assumed; select the local id without library')
    item, resolution = _style_resolve(ctx, 'material', data['id'], collection)
    created = _cad_require_result(local.addByCopy(item, name), 'Copy material')
    ctx.created.append({'token': None, 'kind': 'material', 'name': name})
    result = {'created': _style_value(created), 'requested': {'id': data['id'], 'library': data.get('library')},
              'id': created.id, 'copiedFrom': data['id'],
              'properties': _style_properties(created, 'material') or [],
              'resolution': resolution,
              'limitations': ['Physical material is copied, not created from scratch (Materials.addByCopy only).'],
              'affected': [{'ref': {'kind': 'material', 'id': created.id}, 'before': None,
                            'after': _style_value(created)}]}
    warning = _style_resolution_warning('material', data['id'], resolution)
    if warning:
        result['warnings'] = [warning]
    return result


def _style_edit(ctx, data, kind):
    _cad_fields(data, ('id',), ('name', 'properties', 'description') if kind == 'material' else ('name', 'properties'))
    item, resolution = _style_require_design_item(ctx, kind, data['id'])
    before = {'id': item.id, 'name': item.name,
              'description': getattr(item, 'description', None) if kind == 'material' else None,
              'properties': _style_properties(item, kind) or []}
    changed = []
    if 'name' in data:
        new_name = data['name']
        if not isinstance(new_name, str) or not new_name.strip():
            raise ValueError('name must be nonempty')
        if new_name != item.name:
            local = getattr(ctx.design, 'appearances' if kind == 'appearance' else 'materials')
            if any(v.name == new_name and v.id != item.id for v in _cad_items(local)):
                raise ValueError(kind + ' name already exists in the Design: ' + new_name)
            item.name = new_name
            changed.append('name')
    if kind == 'material' and 'description' in data:
        if not isinstance(data['description'], str):
            raise ValueError('description must be a string')
        if not hasattr(item, 'description'):
            raise ValueError('Installed SDK does not expose material description')
        item.description = data['description']
        changed.append('description')
    property_changes = []
    if 'properties' in data:
        property_changes = _style_apply_properties(ctx, item, kind, data['properties'])
        changed.append('properties')
    after = {'id': item.id, 'name': item.name,
             'description': getattr(item, 'description', None) if kind == 'material' else None,
             'properties': _style_properties(item, kind) or []}
    result = {'id': item.id, 'changed': bool(changed), 'changedFields': changed,
              'propertyChanges': property_changes, 'before': before, 'after': after,
              'resolution': resolution,
              'affected': [{'ref': {'kind': kind, 'id': item.id}, 'before': before, 'after': after}]}
    warning = _style_resolution_warning(kind, data['id'], resolution)
    if warning:
        result['warnings'] = [warning]
    return result


def appearance_edit(ctx, data):
    result = _style_edit(ctx, data, 'appearance')
    return _style_contract(ctx, 'appearance.edit', result)


def material_edit(ctx, data):
    result = _style_edit(ctx, data, 'material')
    return _style_contract(ctx, 'material.edit', result)


def _appearance_texture_channels(item):
    return {'color': 'colorTexture', 'normal': 'normalTexture', 'roughness': 'roughnessTexture'}


def appearance_texture(ctx, data):
    _cad_fields(data, ('id', 'channel'), ('image', 'scaleX', 'scaleY', 'rotation', 'bump', 'lock'))
    item, resolution = _style_require_design_item(ctx, 'appearance', data['id'])
    channels = _appearance_texture_channels(item)
    if data['channel'] not in channels:
        raise ValueError('channel must be color, normal, or roughness')
    prop_name = channels[data['channel']]
    if not hasattr(item, prop_name):
        return _style_blocked(ctx, 'appearance.texture', 'Installed SDK does not expose ' + prop_name)
    if 'image' in data and not isinstance(data['image'], str):
        raise ValueError('image must be a path string or empty string to disconnect')
    lock = data.get('lock', False)
    if type(lock) is not bool:
        raise ValueError('lock must be boolean')
    before = {'channel': data['channel'], 'image': getattr(item, prop_name)}
    changed = []
    if 'image' in data:
        setattr(item, prop_name, data['image'])
        changed.append('image')
    scales = {}
    scale_x = data.get('scaleX')
    scale_y = data.get('scaleY')
    if lock and scale_x is not None and scale_y is None:
        scale_y = scale_x
    elif lock and scale_y is not None and scale_x is None:
        scale_x = scale_y
    for key, prop_id, value in (('scaleX', 'texture_RealWorldScaleX', scale_x),
                                ('scaleY', 'texture_RealWorldScaleY', scale_y)):
        if value is not None:
            prop = _style_find_prop(item, 'appearance', prop_id)
            if prop is None or prop.isReadOnly:
                raise ValueError('Installed SDK does not expose a writable ' + prop_id + ' property')
            _style_set_property(ctx, prop, ctx.length(value))
            scales[key] = _style_prop_value(getattr(prop, 'value', None))
            changed.append(key)
    bump = None
    if 'bump' in data:
        if type(data['bump']) is not bool:
            raise ValueError('bump must be boolean')
        prop = _style_find_prop(item, 'appearance', 'bumpmap_Type')
        if prop is None:
            raise ValueError('Installed SDK does not expose bumpmap_Type to select a height-map bump')
        _style_set_property(ctx, prop, 'bumpmap_height_map' if data['bump'] else 'bumpmap_normal_map')
        bump = data['bump']
        changed.append('bump')
    rotation = None
    if 'rotation' in data:
        prop = _style_find_prop(item, 'appearance', 'texture_RotationAngle')
        if prop is None or prop.isReadOnly:
            raise ValueError('Installed SDK does not expose a writable texture_RotationAngle property')
        _style_set_property(ctx, prop, ctx.angle(data['rotation']))
        rotation = _style_prop_value(getattr(prop, 'value', None))
        changed.append('rotation')
    result = {'id': item.id, 'channel': data['channel'], 'before': before,
              'after': {'channel': data['channel'], 'image': getattr(item, prop_name)},
              'changed': changed, 'realWorldScale': scales, 'bump': bump, 'rotation': rotation, 'scaleLocked': lock,
              'resolution': resolution,
              'warnings': ['Texture setters (colorTexture/normalTexture/roughnessTexture) are preview features; '
                           'the image is embedded in the document but the returned path may differ after save/reopen.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': item.id}, 'before': before,
                            'after': {'channel': data['channel'], 'image': getattr(item, prop_name)}}]}
    warning = _style_resolution_warning('appearance', data['id'], resolution)
    if warning:
        result['warnings'].append(warning)
    return _style_contract(ctx, 'appearance.texture', result)


_PROJECTIONS = {'automatic': 'AutomaticTextureMapProjection', 'planar': 'PlanarTextureMapProjection',
                'box': 'BoxTextureMapProjection', 'spherical': 'SphericalTextureMapProjection',
                'cylindrical': 'CylindricalTextureMapProjection'}


def appearance_projection(ctx, data):
    _cad_fields(data, ('id',), ('projection',))
    item, resolution = _style_require_design_item(ctx, 'appearance', data['id'])
    prop = _style_find_prop(item, 'appearance', 'texture_ProjectionType')
    before = _style_prop_value(getattr(prop, 'value', None)) if prop is not None else None
    if 'projection' not in data:
        return _style_contract(ctx, 'appearance.projection',
                               {'id': item.id, 'projection': before, 'changed': False,
                                'resolution': resolution,
                                'limitations': ['Projection is read from the appearance texture property; '
                                                'a projection frame is not persisted as a named datum.']})
    if data['projection'] not in _PROJECTIONS:
        raise ValueError('projection must be ' + ', '.join(sorted(_PROJECTIONS)))
    if prop is None or prop.isReadOnly:
        return _style_blocked(ctx, 'appearance.projection',
                              'Installed SDK does not expose a writable texture_ProjectionType property')
    _style_set_property(ctx, prop, _PROJECTIONS[data['projection']])
    result = {'id': item.id, 'requested': data['projection'], 'before': before,
              'after': _style_prop_value(getattr(prop, 'value', None)), 'changed': True,
              'resolution': resolution,
              'limitations': ['Projection type is a texture property; a geometric projection frame is not created.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': item.id}, 'before': before,
                            'after': _style_prop_value(getattr(prop, 'value', None))}]}
    warning = _style_resolution_warning('appearance', data['id'], resolution)
    if warning:
        result.setdefault('warnings', []).append(warning)
    return _style_contract(ctx, 'appearance.projection', result)


def _style_resolve_refs(ctx, data, allowed):
    refs = data.get('refs')
    if refs is None or (isinstance(refs, list) and not refs):
        entities = ctx._entities('body') + ctx._entities('component') + ctx._entities('face') + ctx._entities('occurrence')
        return entities
    if not isinstance(refs, list):
        raise ValueError('refs must be an array')
    entities = [ctx.resolve(ref) for ref in refs]
    for entity in entities:
        if _cad_kind(entity) not in allowed:
            raise ValueError('Unsupported target kind: ' + _cad_kind(entity))
    return entities


def _style_assignment_row(ctx, entity, kind):
    prop = 'appearance' if kind == 'appearance' else 'material'
    if _cad_kind(entity) == 'face':
        read = entity.body
    elif _cad_kind(entity) == 'occurrence':
        read = entity.component
    else:
        read = entity
    value = getattr(read, prop, None)
    return {'ref': ctx.ref(entity), 'scope': 'instance' if _cad_kind(entity) == 'occurrence' else 'definition',
            'definition': ctx.ref(_cad_owner(entity)) if _cad_owner(entity) is not None else None,
            'assigned': _style_value(value)}


def _style_assign_map(ctx, data, kind):
    _cad_fields(data, (), ('refs', 'expected', 'library'))
    entities = _style_resolve_refs(ctx, data, ('component', 'body', 'face', 'occurrence'))
    rows = [_style_assignment_row(ctx, entity, kind) for entity in entities]
    mismatches = []
    expected = data.get('expected')
    if expected is not None:
        if not isinstance(expected, dict):
            raise ValueError('expected must be a map of {name/id -> expected style ID}')
        expected_items = _cad_items(getattr(ctx.design, 'appearances' if kind == 'appearance' else 'materials'))
        by_name = {v.name: v.id for v in expected_items}
        by_id = {v.id: v.id for v in expected_items}
        for row in rows:
            key = row['ref'].get('name') if row['ref'] else None
            want = expected.get(key) if key in expected else None
            if want is None:
                continue
            resolved = by_id.get(want) or by_name.get(want)
            actual = (row['assigned'] or {}).get('id')
            if resolved != actual:
                mismatches.append({'ref': row['ref'], 'expected': want, 'actual': actual,
                                   'resolvedExpected': resolved})
    status = 'fail' if mismatches else 'pass'
    return _style_contract(ctx, kind + '.assign-map',
                           {'kind': kind, 'assignments': rows, 'count': len(rows),
                            'expected': expected, 'mismatches': mismatches, 'mismatchCount': len(mismatches)},
                           status=status, read_only=True,
                           limitations=['Assignment reads the API getter for the selected entity kind; a face reads its body and an occurrence reads its component definition.',
                                        'Equal IDs do not establish inheritance provenance.'])


def appearance_assign_map(ctx, data):
    return _style_assign_map(ctx, data, 'appearance')


def material_assign_map(ctx, data):
    return _style_assign_map(ctx, data, 'material')


def _style_report(ctx, data):
    _cad_fields(data, (), ('refs',))
    entities = _style_resolve_refs(ctx, data, ('component', 'body', 'face', 'occurrence'))
    seen_definitions = []
    for entity in entities:
        owner = _cad_owner(entity)
        if _cad_kind(entity) != 'occurrence' and owner is not None and owner not in seen_definitions:
            seen_definitions.append(owner)
    rows = []
    for entity in entities:
        rows.append({'ref': ctx.ref(entity),
                     'appearance': _style_value(getattr(entity, 'appearance', None)),
                     'material': _style_value(getattr(
                         entity.body if _cad_kind(entity) == 'face' else
                         entity.component if _cad_kind(entity) == 'occurrence' else entity, 'material', None))})
    appearances = _cad_items(ctx.design.appearances)
    materials = _cad_items(ctx.design.materials)
    duplicate_names = {}
    for collection, label in ((appearances, 'appearance'), (materials, 'material')):
        by_name = {}
        for item in collection:
            by_name.setdefault(item.name, []).append(item.id)
        duplicate_names[label] = {name: ids for name, ids in by_name.items() if len(ids) > 1}
    density = []
    for material in materials:
        props = _style_props_by_name(material, 'material')
        density_prop = next((p for name, p in props.items() if 'density' in name.lower()), None)
        density.append({'id': material.id, 'name': material.name,
                        'density': _style_prop_value(getattr(density_prop, 'value', None)) if density_prop is not None else None,
                        'densityMissing': density_prop is None or getattr(density_prop, 'value', None) in (None, 0)})
    warnings = [label + ' has duplicate names: ' + ', '.join(names)
                for label, dup in duplicate_names.items() for names in dup.values()]
    warnings += [m['name'] + ' has no density property' for m in density if m['densityMissing']]
    result = {'styles': rows, 'count': len(rows), 'definitions': [ctx.ref(d) for d in seen_definitions],
              'appearanceCount': len(appearances), 'materialCount': len(materials),
              'duplicateNames': duplicate_names, 'density': density, 'warnings': warnings}
    status = 'fail' if duplicate_names['appearance'] or duplicate_names['material'] else 'pass'
    return _style_contract(ctx, 'styles.report', result, status=status, read_only=True,
                           warnings=warnings,
                           limitations=['A duplicate name/ID is reported, not assumed equivalent.',
                                        'A missing density is reported, never replaced by a default.'])


def styles_report(ctx, data):
    return _style_report(ctx, data)


CAD_HANDLERS.update({
    'appearance.create': appearance_create,
    'appearance.edit': appearance_edit,
    'appearance.texture': appearance_texture,
    'appearance.projection': appearance_projection,
    'appearance.assign-map': appearance_assign_map,
    'material.create': material_create,
    'material.edit': material_edit,
    'material.assign-map': material_assign_map,
    'styles.report': styles_report,
})
