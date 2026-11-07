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
import math as _style_math


if _CAD_TYPE_CHECKING:
    _StyleKind: TypeAlias = Literal['appearance', 'material']
    _StylePropertyType: TypeAlias = Literal[
        'FloatProperty', 'IntegerProperty', 'BooleanProperty', 'StringProperty',
        'ColorProperty', 'ChoiceProperty', 'AppearanceTextureProperty', 'Property']
    _StyleItem: TypeAlias = adsk.core.Appearance | adsk.core.Material
    _StyleCollection: TypeAlias = adsk.core.Appearances | adsk.core.Materials
    _StyleSource: TypeAlias = adsk.fusion.Design | adsk.core.MaterialLibrary

    class _StyleResolutionInfo(_CadTypedDict):
        selected: JsonRecord
        candidates: list[JsonRecord]
        ambiguous: bool
        precedence: str

    class _StylePropertyCaster(_Protocol):
        def cast(self, arg: object, /) -> adsk.core.Property | None: ...

    class _StylePropertyValue(_Protocol):
        @property
        def value(self) -> object: ...

    class _StylePropertyUnits(_Protocol):
        @property
        def units(self) -> str: ...

    class _StylePropertyTextureFlags(_Protocol):
        @property
        def hasConnectedTexture(self) -> bool: ...

        @property
        def hasLimits(self) -> bool: ...

    class _StyleColorValue(_Protocol):
        @property
        def red(self) -> int: ...

        @property
        def green(self) -> int: ...

        @property
        def blue(self) -> int: ...

        @property
        def opacity(self) -> int: ...

    class _StyleTypedValue(_Protocol):
        @property
        def objectType(self) -> str: ...

    class _StyleNamedValue(_Protocol):
        @property
        def name(self) -> str: ...

        @property
        def value(self) -> JsonValue: ...

    class _StyleTextureAccess(_Protocol):
        @property
        def colorTexture(self) -> str: ...

        @colorTexture.setter
        def colorTexture(self, value: str) -> None: ...

        @property
        def normalTexture(self) -> str: ...

        @normalTexture.setter
        def normalTexture(self, value: str) -> None: ...

        @property
        def roughnessTexture(self) -> str: ...

        @roughnessTexture.setter
        def roughnessTexture(self, value: str) -> None: ...

    class _AppearanceSurfaceTypes(_Protocol):
        OpaqueAppearanceSurface: object
        MetalAppearanceSurface: object
        TransparentAppearanceSurface: object

    class _AppearanceAdder(_Protocol):
        def add(self, name: str, surface_type: object, /) -> adsk.core.Appearance | None: ...


def _style_value(value: "_StyleItem | None") -> "JsonRecord | None":
    return {'id': value.id, 'name': value.name} if value is not None else None


def _style_identity(ctx: "CadContext") -> "JsonRecord":
    ctx.assert_identity()
    return {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}


def _style_contract(ctx: "CadContext", operation: str, result: "JsonRecord",
                    status: str = 'pass', read_only: bool = False,
                    warnings: "list[str] | None" = None,
                    limitations: "list[str] | None" = None) -> "JsonRecord":
    warnings_value = list(_cad_cast("list[str]", result.pop('warnings', warnings or [])))
    limitations_value = list(_cad_cast("list[str]", result.pop('limitations', limitations or [])))
    affected_value = list(_cad_cast("list[JsonValue]", result.pop('affected', [])))
    base: JsonRecord = {
        'schemaVersion': 1, 'operation': operation, 'status': status, 'success': status == 'pass',
        'documentIdentity': _style_identity(ctx),
        'units': {'length': 'cm', 'angle': 'rad'},
        'frame': {'space': 'component', 'component': ctx.ref(ctx.component)},
        'associativity': 'snapshot' if read_only else 'nativeProperty',
        'warnings': warnings_value,
        'method': 'Public Fusion appearance/material SDK with explicit availability gates (GM29)',
        'limitations': _STYLE_LIMITS + limitations_value,
        'provenance': {'requirement': 'GM29', 'source': 'docs/APPEARANCES.md'},
        'affected': affected_value,
        'dependencies': result.pop('dependencies', 'Direct native property assignment; no automatic recompute.'),
    }
    merged: JsonRecord = dict(base)
    merged.update(result)
    merged['status'] = status
    merged['success'] = status == 'pass'
    return merged


def _style_blocked(ctx: "CadContext", operation: str, reason: str) -> "JsonRecord":
    return _style_contract(ctx, operation, {}, status='blocked', read_only=True,
                           warnings=[reason],
                           limitations=['The requested representation is not available through the installed '
                                        'SDK; an explicit alternative must be chosen, none was silently substituted.'])


def _style_collection(ctx: "CadContext", kind: "_StyleKind",
                      library: "object | None" = None) -> "tuple[_StyleSource, _StyleCollection]":
    source: _StyleSource = ctx.design
    if library is not None:
        if not isinstance(library, str) or not library:
            raise ValueError('library must be an exact loaded library ID')
        library_id = library
        source = _cad_unique([lib for lib in _cad_items(ctx.app.materialLibraries)
                              if lib.id == library_id], 'Loaded library ID')
    if kind == 'appearance':
        collection = source.appearances
    else:
        collection = source.materials
    return source, collection


def _style_property_collection(item: "_StyleItem", kind: "_StyleKind") -> "adsk.core.Properties | None":
    if kind == 'appearance':
        appearance = _cad_cast("adsk.core.Appearance", item)
        value = getattr(appearance, 'appearanceProperties', None)
    else:
        material = _cad_cast("adsk.core.Material", item)
        value = getattr(material, 'materialProperties', None)
    return _style_optional_properties(value)


def _style_optional_properties(value: object) -> "adsk.core.Properties | None":
    if value is None:
        return None
    return _cad_cast("adsk.core.Properties", value)


def _style_texture_image(item: "adsk.core.Appearance", channel: str) -> str:
    texture = _cad_cast("_StyleTextureAccess", item)
    if channel == 'color':
        return texture.colorTexture
    if channel == 'normal':
        return texture.normalTexture
    return texture.roughnessTexture


def _style_set_texture_image(item: "adsk.core.Appearance", channel: str, image: str) -> None:
    texture = _cad_cast("_StyleTextureAccess", item)
    if channel == 'color':
        texture.colorTexture = image
    elif channel == 'normal':
        texture.normalTexture = image
    else:
        texture.roughnessTexture = image


def _style_appearance_of(entity: "CadEntity") -> "adsk.core.Appearance | None":
    value = _cad_cast("object | None", getattr(entity, 'appearance', None))
    return None if value is None else _cad_cast("adsk.core.Appearance", value)


def _style_material_of(entity: "CadEntity") -> "adsk.core.Material | None":
    value = _cad_cast("object | None", getattr(entity, 'material', None))
    return None if value is None else _cad_cast("adsk.core.Material", value)


def _style_resolve(ctx: "CadContext", kind: "_StyleKind", style_id: str,
                   collection: "_StyleCollection") -> "tuple[_StyleItem, _StyleResolutionInfo]":
    """Deterministically resolve a style ID without assuming a unique copy ID."""
    local_collection: _StyleCollection
    if kind == 'appearance':
        local_collection = ctx.design.appearances
    else:
        local_collection = ctx.design.materials
    selected, resolution = _cad_style_resolve(
        [value for value in _cad_items(collection) if value.id == style_id],
        kind + ' ID', local_collection, style_id)
    return selected, _cad_cast("_StyleResolutionInfo", resolution)


def _style_require_design_item(ctx: "CadContext", kind: "_StyleKind",
                               style_id: object) -> "tuple[_StyleItem, _StyleResolutionInfo]":
    if not isinstance(style_id, str) or not style_id:
        raise ValueError('id must be an exact design-local ' + kind + ' ID')
    collection: _StyleCollection
    if kind == 'appearance':
        collection = ctx.design.appearances
    else:
        collection = ctx.design.materials
    item, resolution = _style_resolve(ctx, kind, style_id, collection)
    if not _cad_style_is_design_local(item, collection):
        raise ValueError(kind + '.edit targets design-local resources only; copy a library resource first via ' + kind + '.create')
    return item, resolution


def _style_prop_type(prop: "adsk.core.Property") -> "_StylePropertyType":
    for name in ('FloatProperty', 'IntegerProperty', 'BooleanProperty', 'StringProperty',
                 'ColorProperty', 'ChoiceProperty', 'AppearanceTextureProperty'):
        cls_value = _cad_cast("object | None", getattr(adsk.core, name, None))
        if cls_value is not None:
            caster = _cad_cast("_StylePropertyCaster", cls_value)
            if caster.cast(prop) is not None:
                return _cad_cast("_StylePropertyType", name)
    return 'Property'


def _style_prop_value(value: object) -> "JsonValue":
    if value is None:
        return None
    if hasattr(value, 'red') and hasattr(value, 'green') and hasattr(value, 'blue'):
        color = _cad_cast("_StyleColorValue", value)
        opacity = _cad_cast(int, getattr(value, 'opacity', 255))
        return {'color': [int(color.red), int(color.green), int(color.blue), int(opacity)]}
    if hasattr(value, 'objectType'):
        typed_value = _cad_cast("_StyleTypedValue", value)
        kind = typed_value.objectType.split('::')[-1]
        if kind in ('Point3D', 'Vector3D'):
            return {'type': kind, 'xyz': _cad_xyz(
                _cad_cast("adsk.core.Point3D | adsk.core.Vector3D", value))}
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and _style_math.isfinite(value):
        return value
    if isinstance(value, str):
        return value
    if hasattr(value, 'name') and hasattr(value, 'value'):
        named_value = _cad_cast("_StyleNamedValue", value)
        return {'name': named_value.name, 'value': named_value.value}
    return str(value)


def _style_prop_info(prop: "adsk.core.Property") -> "JsonRecord":
    info: JsonRecord = {'id': prop.id, 'name': prop.name, 'isReadOnly': prop.isReadOnly,
                        'type': _style_prop_type(prop)}
    # Check the class, not the instance: `hasattr(prop, 'units')` would invoke the
    # property getter, which can raise RuntimeError (InternalValidationError) for a
    # unit string Fusion does not recognize (e.g. the "Stal — satynowa" appearance).
    if hasattr(type(prop), 'units'):
        try:
            info['units'] = _cad_cast("_StylePropertyUnits", prop).units
        except Exception:
            # Report an unrecognized unit as unknown rather than crashing or
            # fabricating a unit, matching "a style must not silently substitute a
            # missing property".
            info['units'] = 'unknown'
    if hasattr(prop, 'value'):
        info['value'] = _style_prop_value(_cad_cast("_StylePropertyValue", prop).value)
    if hasattr(prop, 'hasConnectedTexture'):
        flags = _cad_cast("_StylePropertyTextureFlags", prop)
        info['hasConnectedTexture'] = flags.hasConnectedTexture
    if hasattr(prop, 'hasLimits'):
        flags = _cad_cast("_StylePropertyTextureFlags", prop)
        info['hasLimits'] = flags.hasLimits
    return info


def _style_property_value(prop: "adsk.core.Property") -> object:
    if not hasattr(prop, 'value'):
        return None
    return _cad_cast("_StylePropertyValue", prop).value


def _style_properties(item: "_StyleItem", kind: "_StyleKind") -> "list[JsonRecord] | None":
    collection = _style_property_collection(item, kind)
    if collection is None:
        return None
    return [_style_prop_info(collection.item(i)) for i in range(collection.count)]


def _style_set_property(ctx: "CadContext", prop: "adsk.core.Property", value: "JsonValue") -> None:
    if prop.isReadOnly:
        raise ValueError('Property is read-only: ' + prop.name)
    ptype = _style_prop_type(prop)
    if ptype == 'FloatProperty':
        if type(value) not in (int, float) or not _style_math.isfinite(_cad_cast("int | float", value)):
            raise ValueError('FloatProperty value must be a finite number')
        _cad_cast("adsk.core.FloatProperty", prop).value = float(_cad_cast("int | float", value))
    elif ptype == 'IntegerProperty':
        if type(value) is not int:
            raise ValueError('IntegerProperty value must be an integer')
        _cad_cast("adsk.core.IntegerProperty", prop).value = value
    elif ptype == 'BooleanProperty':
        if type(value) is not bool:
            raise ValueError('BooleanProperty value must be a boolean')
        _cad_cast("adsk.core.BooleanProperty", prop).value = value
    elif ptype == 'StringProperty':
        if not isinstance(value, str):
            raise ValueError('StringProperty value must be a string')
        _cad_cast("adsk.core.StringProperty", prop).value = value
    elif ptype == 'ChoiceProperty':
        if not isinstance(value, str):
            raise ValueError('ChoiceProperty value must be a choice name string')
        _cad_cast("adsk.core.ChoiceProperty", prop).value = value
    elif ptype == 'ColorProperty':
        if not isinstance(value, (list, tuple)) or len(value) not in (3, 4):
            raise ValueError('ColorProperty value must be [r,g,b] or [r,g,b,a] integers 0..255')
        if any(type(v) is not int or not 0 <= v <= 255 for v in value):
            raise ValueError('Color components must be integers 0..255')
        rgba = [_cad_cast(int, component) for component in value]
        if len(rgba) == 3:
            rgba.append(255)
        _cad_cast("adsk.core.ColorProperty", prop).value = adsk.core.Color.create(*rgba)
    else:
        raise ValueError('Unsupported property type for edit: ' + ptype)


def _style_apply_properties(ctx: "CadContext", item: "_StyleItem", kind: "_StyleKind",
                            specs: "JsonValue") -> "list[JsonRecord]":
    if not isinstance(specs, list) or not specs:
        raise ValueError('properties must be a nonempty array of {id, value}')
    collection = _style_property_collection(item, kind)
    if collection is None:
        raise ValueError('Installed SDK does not expose typed ' + kind + ' properties')
    changes: list[JsonRecord] = []
    for spec in specs:
        if not isinstance(spec, dict) or set(spec) - {'id', 'value'} or 'id' not in spec or 'value' not in spec:
            raise ValueError('Property edits accept {id, value} only')
        prop_id = spec['id']
        if not isinstance(prop_id, str):
            raise ValueError('Property id must be a string')
        prop = _style_optional_property(collection.itemById(prop_id))
        if prop is None:
            raise ValueError('Unknown property ID: ' + prop_id)
        before = _style_prop_info(prop)
        _style_set_property(ctx, prop, spec['value'])
        changes.append({'id': spec['id'], 'before': before, 'after': _style_prop_info(prop)})
    return changes


def _style_props_by_name(item: "_StyleItem", kind: "_StyleKind") -> "dict[str, adsk.core.Property]":
    collection = _style_property_collection(item, kind)
    if collection is None:
        return {}
    return {collection.item(i).name: collection.item(i) for i in range(collection.count)}


def _style_find_prop(item: "_StyleItem", kind: "_StyleKind",
                     prop_id: str) -> "adsk.core.Property | None":
    collection = _style_property_collection(item, kind)
    if collection is None:
        return None
    prop = _style_optional_property(collection.itemById(prop_id))
    if prop is None:
        prop = _style_optional_property(next((collection.item(i) for i in range(collection.count)
                                              if collection.item(i).name == prop_id), None))
    return prop


def _style_optional_property(value: object) -> "adsk.core.Property | None":
    if value is None:
        return None
    return _cad_cast("adsk.core.Property", value)


def appearance_create(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('name',), ('id', 'library', 'surfaceType'))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty')
    local = ctx.design.appearances
    if any(v.name == name for v in _cad_items(local)):
        raise ValueError('Appearance name already exists in the Design; copy/edit the existing resource')
    source = ctx.design
    requested = {'id': None, 'library': None}
    resolution: _StyleResolutionInfo | None = None
    style_id: str | None = None
    if 'id' in data:
        if not isinstance(data['id'], str) or not data['id']:
            raise ValueError('id must be an exact appearance ID from appearance.list')
        style_id = data['id']
        library = data.get('library')
        source, collection = _style_collection(ctx, 'appearance', library)
        if 'library' in data and source != ctx.design:
            if any(v.id == style_id or v.name == name for v in _cad_items(local)):
                raise ValueError('Design-local ID/name collision: no equivalence assumed; select the local id without library')
        item, resolution = _style_resolve(ctx, 'appearance', style_id, collection)
        requested = {'id': data['id'], 'library': data.get('library')}
        created = _cad_require_result(
            local.addByCopy(_cad_cast("adsk.core.Appearance", item), name), 'Copy appearance')
    else:
        if not hasattr(local, 'add'):
            raise ValueError('Installed SDK cannot create a neutral appearance; pass id/library to copy an existing one')
        surface_types = _cad_cast("_AppearanceSurfaceTypes", getattr(adsk.core, 'AppearanceSurfaceTypes'))
        surface_type = surface_types.OpaqueAppearanceSurface
        surfaces = {'opaque': 'OpaqueAppearanceSurface', 'metal': 'MetalAppearanceSurface',
                    'transparent': 'TransparentAppearanceSurface'}
        if 'surfaceType' in data:
            surface_name = _cad_cast(str, data['surfaceType'])
            if surface_name not in surfaces:
                raise ValueError('surfaceType must be opaque, metal, or transparent')
            if surface_name == 'opaque':
                surface_type = surface_types.OpaqueAppearanceSurface
            elif surface_name == 'metal':
                surface_type = surface_types.MetalAppearanceSurface
            else:
                surface_type = surface_types.TransparentAppearanceSurface
        adder = _cad_cast("_AppearanceAdder", local)
        created = _cad_require_result(adder.add(name, surface_type), 'Create appearance')
    ctx.created.append({'token': None, 'kind': 'appearance', 'name': name})
    resolution_value: JsonValue = None if resolution is None else _cad_cast("JsonRecord", resolution)
    result: JsonRecord = {'created': _style_value(created), 'requested': requested,
              'id': created.id, 'copiedFrom': requested['id'],
              'properties': _style_properties(created, 'appearance') or [],
              'resolution': resolution_value,
              'limitations': ['Appearances.add is a preview feature and the returned copy is design-local; verify in the UI.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': created.id}, 'before': None,
                            'after': _style_value(created)}]}
    warning = (_style_resolution_warning('appearance', style_id, resolution)
               if style_id is not None and resolution is not None else None)
    if warning:
        result['warnings'] = [warning]
    return result


def material_create(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('name', 'id'), ('library',))
    name = data['name']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('name must be nonempty')
    local = ctx.design.materials
    if any(v.name == name for v in _cad_items(local)):
        raise ValueError('Material name already exists in the Design; copy/edit the existing resource')
    library = data.get('library')
    source, collection = _style_collection(ctx, 'material', library)
    if 'library' in data and source != ctx.design:
        if any(v.id == data['id'] or v.name == name for v in _cad_items(local)):
            raise ValueError('Design-local ID/name collision: no equivalence assumed; select the local id without library')
    style_id = _cad_cast(str, data['id'])
    item, resolution = _style_resolve(ctx, 'material', style_id, collection)
    created = _cad_require_result(
        local.addByCopy(_cad_cast("adsk.core.Material", item), name), 'Copy material')
    ctx.created.append({'token': None, 'kind': 'material', 'name': name})
    result: JsonRecord = {'created': _style_value(created), 'requested': {'id': data['id'], 'library': data.get('library')},
              'id': created.id, 'copiedFrom': data['id'],
              'properties': _style_properties(created, 'material') or [],
              'resolution': _cad_cast("JsonRecord", resolution),
              'limitations': ['Physical material is copied, not created from scratch (Materials.addByCopy only).'],
              'affected': [{'ref': {'kind': 'material', 'id': created.id}, 'before': None,
                            'after': _style_value(created)}]}
    warning = _style_resolution_warning('material', _cad_cast(str, data['id']), resolution)
    if warning:
        result['warnings'] = [warning]
    return result


def _style_edit(ctx: "CadContext", data: "JsonObject", kind: "_StyleKind") -> "JsonRecord":
    _cad_fields(data, ('id',), ('name', 'properties', 'description') if kind == 'material' else ('name', 'properties'))
    item, resolution = _style_require_design_item(ctx, kind, data['id'])
    before: JsonRecord = {'id': item.id, 'name': item.name,
                          'description': _style_material_description(item, kind),
                          'properties': _style_properties(item, kind) or []}
    changed: list[str] = []
    if 'name' in data:
        new_name = data['name']
        if not isinstance(new_name, str) or not new_name.strip():
            raise ValueError('name must be nonempty')
        if new_name != item.name:
            if kind == 'appearance':
                local = ctx.design.appearances
            else:
                local = ctx.design.materials
            if any(v.name == new_name and v.id != item.id for v in _cad_items(local)):
                raise ValueError(kind + ' name already exists in the Design: ' + new_name)
            item.name = new_name
            changed.append('name')
    if kind == 'material' and 'description' in data:
        if not isinstance(data['description'], str):
            raise ValueError('description must be a string')
        material = _cad_cast("adsk.core.Material", item)
        if not hasattr(material, 'description'):
            raise ValueError('Installed SDK does not expose material description')
        material.description = data['description']
        changed.append('description')
    property_changes: list[JsonRecord] = []
    if 'properties' in data:
        property_changes = _style_apply_properties(ctx, item, kind, data['properties'])
        changed.append('properties')
    after: JsonRecord = {'id': item.id, 'name': item.name,
                         'description': _style_material_description(item, kind),
                         'properties': _style_properties(item, kind) or []}
    result: JsonRecord = {'id': item.id, 'changed': bool(changed), 'changedFields': changed,
              'propertyChanges': property_changes, 'before': before, 'after': after,
              'resolution': _cad_cast("JsonRecord", resolution),
              'affected': [{'ref': {'kind': kind, 'id': item.id}, 'before': before, 'after': after}]}
    warning = _style_resolution_warning(kind, _cad_cast(str, data['id']), resolution)
    if warning:
        result['warnings'] = [warning]
    return result


def _style_material_description(item: "_StyleItem", kind: "_StyleKind") -> "str | None":
    if kind != 'material':
        return None
    return getattr(_cad_cast("adsk.core.Material", item), 'description', None)


def _style_append_warning(result: "JsonRecord", warning: str) -> None:
    warnings = _cad_cast("list[str]", result['warnings'])
    warnings.append(warning)


def _style_setdefault_warning(result: "JsonRecord", warning: str) -> None:
    warnings = _cad_cast("list[str]", result.setdefault('warnings', []))
    warnings.append(warning)


def appearance_edit(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    result = _style_edit(ctx, data, 'appearance')
    return _style_contract(ctx, 'appearance.edit', result)


def material_edit(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    result = _style_edit(ctx, data, 'material')
    return _style_contract(ctx, 'material.edit', result)


def _appearance_texture_channels(item: "adsk.core.Appearance") -> "dict[str, str]":
    return {'color': 'colorTexture', 'normal': 'normalTexture', 'roughness': 'roughnessTexture'}


def appearance_texture(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('id', 'channel'), ('image', 'scaleX', 'scaleY', 'rotation', 'bump', 'lock'))
    item, resolution = _style_require_design_item(ctx, 'appearance', data['id'])
    appearance = _cad_cast("adsk.core.Appearance", item)
    channels = _appearance_texture_channels(appearance)
    channel = _cad_cast(str, data['channel'])
    if channel not in channels:
        raise ValueError('channel must be color, normal, or roughness')
    prop_name = channels[channel]
    if not hasattr(appearance, prop_name):
        return _style_blocked(ctx, 'appearance.texture', 'Installed SDK does not expose ' + prop_name)
    if 'image' in data and not isinstance(data['image'], str):
        raise ValueError('image must be a path string or empty string to disconnect')
    lock = data.get('lock', False)
    if type(lock) is not bool:
        raise ValueError('lock must be boolean')
    before: JsonRecord = {'channel': channel, 'image': _style_texture_image(appearance, channel)}
    changed: list[str] = []
    if 'image' in data:
        _style_set_texture_image(appearance, channel, _cad_cast(str, data['image']))
        changed.append('image')
    scales: JsonRecord = {}
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
            scales[key] = _style_prop_value(_style_property_value(prop))
            changed.append(key)
    bump: bool | None = None
    if 'bump' in data:
        if type(data['bump']) is not bool:
            raise ValueError('bump must be boolean')
        prop = _style_find_prop(item, 'appearance', 'bumpmap_Type')
        if prop is None:
            raise ValueError('Installed SDK does not expose bumpmap_Type to select a height-map bump')
        _style_set_property(ctx, prop, 'bumpmap_height_map' if data['bump'] else 'bumpmap_normal_map')
        bump = data['bump']
        changed.append('bump')
    rotation: JsonValue = None
    if 'rotation' in data:
        prop = _style_find_prop(item, 'appearance', 'texture_RotationAngle')
        if prop is None or prop.isReadOnly:
            raise ValueError('Installed SDK does not expose a writable texture_RotationAngle property')
        _style_set_property(ctx, prop, ctx.angle(data['rotation']))
        rotation = _style_prop_value(_style_property_value(prop))
        changed.append('rotation')
    result: JsonRecord = {'id': item.id, 'channel': channel, 'before': before,
              'after': {'channel': channel, 'image': _style_texture_image(appearance, channel)},
              'changed': changed, 'realWorldScale': scales, 'bump': bump, 'rotation': rotation, 'scaleLocked': lock,
              'resolution': _cad_cast("JsonRecord", resolution),
              'warnings': ['Texture setters (colorTexture/normalTexture/roughnessTexture) are preview features; '
                           'the image is embedded in the document but the returned path may differ after save/reopen.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': item.id}, 'before': before,
                            'after': {'channel': channel, 'image': _style_texture_image(appearance, channel)}}]}
    warning = _style_resolution_warning('appearance', _cad_cast(str, data['id']), resolution)
    if warning:
        _style_append_warning(result, warning)
    return _style_contract(ctx, 'appearance.texture', result)


def appearance_projection(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('id',), ('projection',))
    item, resolution = _style_require_design_item(ctx, 'appearance', data['id'])
    prop = _style_find_prop(item, 'appearance', 'texture_ProjectionType')
    before = _style_prop_value(_style_property_value(prop)) if prop is not None else None
    if 'projection' not in data:
        return _style_contract(ctx, 'appearance.projection',
                                {'id': item.id, 'projection': before, 'changed': False,
                                 'resolution': _cad_cast("JsonRecord", resolution),
                                'limitations': ['Projection is read from the appearance texture property; '
                                                'a projection frame is not persisted as a named datum.']})
    projection = _cad_cast(str, data['projection'])
    if projection not in _PROJECTIONS:
        raise ValueError('projection must be ' + ', '.join(sorted(_PROJECTIONS)))
    if prop is None or prop.isReadOnly:
        return _style_blocked(ctx, 'appearance.projection',
                              'Installed SDK does not expose a writable texture_ProjectionType property')
    _style_set_property(ctx, prop, _PROJECTIONS[projection])
    result: JsonRecord = {'id': item.id, 'requested': projection, 'before': before,
              'after': _style_prop_value(_style_property_value(prop)), 'changed': True,
              'resolution': _cad_cast("JsonRecord", resolution),
              'limitations': ['Projection type is a texture property; a geometric projection frame is not created.'],
              'affected': [{'ref': {'kind': 'appearance', 'id': item.id}, 'before': before,
                            'after': _style_prop_value(_style_property_value(prop))}]}
    warning = _style_resolution_warning('appearance', _cad_cast(str, data['id']), resolution)
    if warning:
        _style_setdefault_warning(result, warning)
    return _style_contract(ctx, 'appearance.projection', result)


def _style_resolve_refs(ctx: "CadContext", data: "JsonObject",
                        allowed: "Sequence[str]") -> "list[CadEntity]":
    refs = data.get('refs')
    if refs is None or (isinstance(refs, list) and not refs):
        all_entities: list[CadEntity] = []
        entity_provider = _cad_cast(
            "Callable[[str], Sequence[CadEntity]]", getattr(ctx, '_entities'))
        all_entities.extend(entity_provider('body'))
        all_entities.extend(entity_provider('component'))
        all_entities.extend(entity_provider('face'))
        all_entities.extend(entity_provider('occurrence'))
        return all_entities
    if not isinstance(refs, list):
        raise ValueError('refs must be an array')
    entities: list[CadEntity] = [ctx.resolve(ref) for ref in refs]
    for entity in entities:
        if _cad_kind(entity) not in allowed:
            raise ValueError('Unsupported target kind: ' + _cad_kind(entity))
    return entities


def _style_assignment_row(ctx: "CadContext", entity: "CadEntity",
                          kind: "_StyleKind") -> "JsonRecord":
    if _cad_kind(entity) == 'face':
        read = _cad_cast("adsk.fusion.BRepFace", entity).body
    elif _cad_kind(entity) == 'occurrence':
        read = _cad_cast("adsk.fusion.Occurrence", entity).component
    else:
        read = entity
    value = _style_appearance_of(read) if kind == 'appearance' else _style_material_of(read)
    owner = _cad_owner(entity)
    return {'ref': ctx.ref(entity), 'scope': 'instance' if _cad_kind(entity) == 'occurrence' else 'definition',
            'definition': ctx.ref(owner) if owner is not None else None,
            'assigned': _style_value(value)}


def _style_assign_map(ctx: "CadContext", data: "JsonObject",
                      kind: "_StyleKind") -> "JsonRecord":
    _cad_fields(data, (), ('refs', 'expected', 'library'))
    entities = _style_resolve_refs(ctx, data, ('component', 'body', 'face', 'occurrence'))
    rows: list[JsonRecord] = [_style_assignment_row(ctx, entity, kind) for entity in entities]
    mismatches: list[JsonRecord] = []
    expected_value = data.get('expected')
    expected: JsonObject | None = None
    if expected_value is not None:
        if not isinstance(expected_value, dict):
            raise ValueError('expected must be a map of {name/id -> expected style ID}')
        expected = expected_value
        source, collection = _style_collection(ctx, kind)
        expected_items = _cad_items(collection)
        by_name: dict[str, str] = {value.name: value.id for value in expected_items}
        by_id: dict[str, str] = {value.id: value.id for value in expected_items}
        for row in rows:
            reference = row['ref']
            reference_record = reference if isinstance(reference, dict) else {}
            key_value = reference_record.get('name')
            key = key_value if isinstance(key_value, str) else None
            want = expected.get(key) if key is not None and key in expected else None
            if want is None:
                continue
            want = _cad_cast(str, want)
            resolved = by_id.get(want) or by_name.get(want)
            assigned = row['assigned']
            assigned_record = assigned if isinstance(assigned, dict) else {}
            actual = assigned_record.get('id')
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


def appearance_assign_map(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _style_assign_map(ctx, data, 'appearance')


def material_assign_map(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _style_assign_map(ctx, data, 'material')


def _style_report(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, (), ('refs',))
    entities = _style_resolve_refs(ctx, data, ('component', 'body', 'face', 'occurrence'))
    seen_definitions: list[CadEntity] = []
    for entity in entities:
        owner = _cad_owner(entity)
        if _cad_kind(entity) != 'occurrence' and owner is not None and owner not in seen_definitions:
            seen_definitions.append(owner)
    rows: list[JsonRecord] = []
    for entity in entities:
        material_target = entity
        if _cad_kind(entity) == 'face':
            material_target = _cad_cast("adsk.fusion.BRepFace", entity).body
        elif _cad_kind(entity) == 'occurrence':
            material_target = _cad_cast("adsk.fusion.Occurrence", entity).component
        rows.append({'ref': ctx.ref(entity),
                     'appearance': _style_value(_style_appearance_of(entity)),
                     'material': _style_value(_style_material_of(material_target))})
    appearances = _cad_items(ctx.design.appearances)
    materials = _cad_items(ctx.design.materials)
    duplicate_names: dict[str, dict[str, list[str]]] = {}
    for collection, label in ((appearances, 'appearance'), (materials, 'material')):
        by_name: dict[str, list[str]] = {}
        for item in collection:
            by_name.setdefault(item.name, []).append(item.id)
        duplicate_names[label] = {name: ids for name, ids in by_name.items() if len(ids) > 1}
    density: list[JsonRecord] = []
    for material in materials:
        props = _style_props_by_name(material, 'material')
        density_prop = next((p for name, p in props.items() if 'density' in name.lower()), None)
        density.append({'id': material.id, 'name': material.name,
                        'density': _style_prop_value(getattr(density_prop, 'value', None)) if density_prop is not None else None,
                        'densityMissing': density_prop is None or getattr(density_prop, 'value', None) in (None, 0)})
    warnings: list[str] = [label + ' has duplicate names: ' + ', '.join(names)
                           for label, dup in duplicate_names.items() for names in dup.values()]
    for material_info in density:
        if material_info['densityMissing']:
            warnings.append(_cad_cast(str, material_info['name']) + ' has no density property')
    result: JsonRecord = {'styles': rows, 'count': len(rows), 'definitions': [ctx.ref(d) for d in seen_definitions],
              'appearanceCount': len(appearances), 'materialCount': len(materials),
              'duplicateNames': duplicate_names, 'density': density, 'warnings': warnings}
    status = 'fail' if duplicate_names['appearance'] or duplicate_names['material'] else 'pass'
    return _style_contract(ctx, 'styles.report', result, status=status, read_only=True,
                           warnings=warnings,
                           limitations=['A duplicate name/ID is reported, not assumed equivalent.',
                                        'A missing density is reported, never replaced by a default.'])


def styles_report(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
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
