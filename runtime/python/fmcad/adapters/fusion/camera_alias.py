"""Callback entrypoints for revalidated camera selector attributes."""

_cad_json = fusion_json
_cad_direction = direction


class _CameraAliasRequired(Exception):
    def __init__(self, name: str, raw: str) -> None:
        super().__init__('Additional camera alias source required')
        self.name = name
        self.raw = raw


def _camera_alias_root(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    return ctx.root


def _camera_alias_target(ctx: "CadContext", name: str, attribute: "str | None") -> "adsk.core.Base | None":
    routes = _cad_cast('dict[str, tuple[str, Callable[[CadContext, str], adsk.core.Base]]]',
                       getattr(ctx, '_camera_alias_bindings', {}))
    binding = routes.get(name)
    if binding is not None and binding[0] != attribute:
        raise RuntimeError('DOCUMENT_STATE_CHANGED: component alias changed during selection')
    if attribute is not None:
        if binding is None:
            raise _CameraAliasRequired(name, attribute)
        return binding[1](ctx, attribute)
    return None


def _camera_alias_name(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    ref = _cad_cast('str | JsonObject', json.loads(raw))
    name = ref if isinstance(ref, str) else _cad_cast('str', ref['name'])
    matches, attribute = _camera_component_candidates(ctx, name)
    target = _camera_alias_target(ctx, name, attribute)
    if target is not None:
        _camera_add_alias_match(ctx, matches, target)
    return _cad_unique(matches, 'Reference ' + name)


def _camera_alias_typed_name(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    ref = _cad_cast('JsonObject', json.loads(raw))
    name, kind = _cad_cast('str', ref['name']), _cad_cast('str', ref['kind'])
    entity: adsk.core.Base
    if name == 'root':
        entity = ctx.root
    elif name in _CAD_ORIGINS:
        entity = _cad_cast('adsk.core.Base', getattr(ctx.root, _CAD_ORIGINS[name]))
    else:
        matches: list[adsk.core.Base] = []
        if kind == 'component':
            matches.extend(c for c in _cad_items(ctx.design.allComponents) if c.name == name)
        else:
            matches.extend(o for o in _cad_items(ctx.root.allOccurrences) if o.name == name or o.fullPathName == name)
        alias = _cad_cast('_CadAttributes', ctx.root.attributes).itemByName(_CAD_ALIAS_GROUP, name)
        target = _camera_alias_target(ctx, name, alias.value if alias else None)
        if target is not None and _cad_kind(target) == kind:
            matches.append(target)
        entity = _cad_unique(matches, 'Reference ' + name)
    if _cad_kind(entity) != kind:
        raise ValueError('Expected %s, got %s' % (kind, _cad_kind(entity)))
    return entity


def _camera_alias_token(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    data = _cad_cast('JsonObject', json.loads(raw))
    candidates = list(ctx.design.findEntityByToken(_cad_cast('str', data['token'])))
    kind = data.get('kind')
    if kind:
        candidates = [entity for entity in candidates if _cad_kind(entity) == kind]
    return _cad_unique(candidates, 'Entity token')


def _camera_alias_token_path(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    data = _cad_cast('JsonObject', json.loads(raw))
    candidates = list(ctx.design.findEntityByToken(_cad_cast('str', data['token'])))
    natives = [getattr(entity, 'nativeObject', None) or entity for entity in candidates]
    path = data['path']
    kind = data.get('kind')
    return _cad_unique([entity for entity in _cad_items(ctx.root.allOccurrences)
                        if entity.fullPathName == path and
                        (getattr(entity, 'nativeObject', None) or entity) in natives and
                        (not kind or _cad_kind(entity) == kind)], 'Entity token')


def _camera_alias_occurrence_ref(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    """The persisted occurrence ref has an authoritative token, path and component ref."""
    ref = _cad_cast('JsonObject', json.loads(raw))
    scope_ref = _cad_cast('JsonObject', ref['component'])
    if scope_ref.get('token'):
        component = _cad_unique([item for item in ctx.design.findEntityByToken(_cad_cast('str', scope_ref['token']))
                                 if _cad_kind(item) == 'component'], 'Entity token')
    else:
        component = ctx.root
    tokens = ctx.design.findEntityByToken(_cad_cast('str', ref['token']))
    natives = [getattr(entity, 'nativeObject', None) or entity for entity in tokens]
    return _cad_unique([item for item in _cad_items(ctx.root.allOccurrences) if item.fullPathName == ref['path'] and
                        (getattr(item, 'nativeObject', None) or item) in natives and _cad_owner(item) == component
                        and _cad_kind(item) == 'occurrence'], 'Entity token')


def _camera_alias_invalid(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    json.loads(raw)  # Retain Python's JSONDecodeError for invalid attributes.
    raise TypeError('Entity reference must be a name or reference object')


def _camera_alias_complex_name(ctx: "CadContext", name: str, kind: "str | None",
                               component: "adsk.fusion.Component",
                               occurrence: "adsk.fusion.Occurrence | None") -> "adsk.core.Base":
    candidates = list(_cad_context_entities(ctx, kind, component, occurrence))
    if kind is None:
        candidates += list(_cad_context_entities(ctx, 'component', None, None)) + list(_cad_context_entities(ctx, 'occurrence', None, None))
    matches = [entity for entity in candidates if _cad_cast('str | None', getattr(entity, 'name', None)) == name or
               (_cad_kind(entity) == 'occurrence' and _cad_cast('adsk.fusion.Occurrence', entity).fullPathName == name)]
    alias = _cad_cast('_CadAttributes', ctx.root.attributes).itemByName(_CAD_ALIAS_GROUP, name)
    raw = alias.value if alias else None
    target = _camera_alias_target(ctx, name, raw)
    if target is not None:
        if (not kind or _cad_kind(target) == kind) and (_cad_owner(target) == component or
                _cad_kind(target) in ('component', 'occurrence', 'parameter')):
            context = _cad_cast('adsk.fusion.Occurrence | None', getattr(target, 'assemblyContext', None))
            if occurrence is None or context is None or context == occurrence:
                matches.append(_cad_context_proxy(ctx, target, occurrence))
    return _cad_unique(matches, 'Reference ' + name)


def _camera_alias_resolve_value(ctx: "CadContext", ref: object, kind: "str | None" = None) -> "adsk.core.Base":
    if not isinstance(ref, (str, dict)):
        raise TypeError('Entity reference must be a name or reference object')
    data: JsonObject = {'name': ref} if isinstance(ref, str) else _cad_cast('JsonObject', ref)
    if 'query' in data:
        query = _cad_cast('Callable[[CadContext, JsonObject, str | None], adsk.core.Base]',
                          getattr(ctx, '_camera_alias_query_resolver'))
        return query(ctx, data, kind)
    ref_kind = _cad_cast('str | None', data.get('kind'))
    if kind and ref_kind and kind != ref_kind:
        raise ValueError('Reference kind conflicts with required kind')
    required = kind or ref_kind

    def resolve(value: object, required_kind: "str | None" = None) -> "adsk.core.Base":
        return _camera_alias_resolve_value(ctx, value, required_kind)

    def scope(value: "JsonObject") -> "tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]":
        component, occurrence = ctx.component, ctx.occurrence
        if value.get('component') is not None:
            component = _cad_cast('adsk.fusion.Component', resolve(value['component'], 'component'))
            occurrence = None
        if value.get('occurrence') is not None:
            occurrence = _cad_cast('adsk.fusion.Occurrence', resolve(value['occurrence'], 'occurrence'))
            if value.get('component') is not None and occurrence.component != component:
                raise ValueError('Component and occurrence contexts disagree')
            component = occurrence.component
        return component, occurrence

    # The canonical basic resolver receives injected recursion. Intercept only
    # its non-reserved name branch, precisely where persisted alias bytes are read.
    name = data.get('name')
    if (not data.get('token') and not (required == 'profile' and 'sketch' in data)
            and isinstance(name, str) and name and name != 'root' and name not in _CAD_ORIGINS):
        component, occurrence = scope(data)
        return _camera_alias_complex_name(ctx, name, required, component, occurrence)
    basic = _cad_cast('Callable[[str | JsonObject, str | None, _CadBasicReferenceResolver, Callable[[JsonObject], tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]]], adsk.core.Base]',
                      getattr(ctx, '_cad_resolve_basic_reference'))
    return basic(_cad_cast('str | JsonObject', ref), kind, _cad_cast('_CadBasicReferenceResolver', resolve), scope)


def _camera_alias_basic(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    return _camera_alias_resolve_value(ctx, _cad_cast(object, json.loads(raw)))


def _camera_alias_direct_query(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    return _entity_resolve_reference(ctx, _cad_cast('JsonObject', json.loads(raw)))


def _camera_alias_query(ctx: "CadContext", raw: str) -> "adsk.core.Base":
    # A fresh context is private to this read. Query-internal scope, geometry
    # and filter references must take the same guarded recursive path.
    def resolve(value: object, kind: "str | None" = None) -> "adsk.core.Base":
        return _camera_alias_resolve_value(ctx, value, kind)
    setattr(ctx, 'resolve', resolve)
    setattr(ctx, '_camera_alias_query_resolver', CadContext.resolve)
    return resolve(_cad_cast(object, json.loads(raw)))
