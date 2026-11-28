"""Unscoped string selection during camera context construction."""


def _camera_component_candidates(ctx: "CadContext", name: str) -> "tuple[list[adsk.core.Base], str | None]":
    if name == 'root':
        return [ctx.root], None
    if name in _CAD_ORIGINS:
        return [_cad_cast('adsk.core.Base', getattr(ctx.root, _CAD_ORIGINS[name]))], None
    return _camera_matching_names(ctx.design, ctx.root, name), _camera_scope_attribute(ctx.root, name)


def _camera_matching_names(design: "adsk.fusion.Design", root: "adsk.fusion.Component", name: str) -> "list[adsk.core.Base]":
    # Untyped names also match entities that are not valid component contexts.
    # Their presence affects both ambiguity and the constructor's error.
    matches: list[adsk.core.Base] = []

    def collect(collection: "_CadItemCollection[adsk.core.Base]") -> None:
        for i in range(collection.count):
            item = collection.item(i)
            if getattr(item, 'name', None) == name:
                matches.append(item)

    for prop in ('bRepBodies', 'sketches', 'features', 'constructionPlanes', 'constructionAxes', 'constructionPoints'):
        collect(_cad_cast('_CadItemCollection[adsk.core.Base]', getattr(root, prop)))
    collect(design.allComponents)
    occurrences = root.allOccurrences
    for i in range(occurrences.count):
        occurrence = occurrences.item(i)
        if occurrence.name == name or occurrence.fullPathName == name:
            matches.append(occurrence)
    return matches


def _camera_scope_attribute(root: "adsk.fusion.Component", name: str) -> "str | None":
    alias = _cad_cast('_CadAttributes', root.attributes).itemByName(_CAD_ALIAS_GROUP, name)
    return alias.value if alias else None


def _camera_require_component(entity: "adsk.core.Base") -> None:
    if _cad_type(entity) not in ('Component', 'Occurrence'):
        raise ValueError('component_ref must resolve to a component or occurrence')


def _camera_add_alias_match(ctx: "CadContext", matches: "list[adsk.core.Base]", target: "adsk.core.Base") -> None:
    _camera_add_root_match(ctx.root, matches, target)


def _camera_add_root_match(root: "adsk.fusion.Component", matches: "list[adsk.core.Base]", target: "adsk.core.Base") -> None:
    if _cad_owner(target) == root or _cad_kind(target) in ('component', 'occurrence', 'parameter'):
        matches.append(target)


def _camera_select_component(ctx: "CadContext", name: str, matches: "list[adsk.core.Base]") -> None:
    _camera_apply_component(ctx, _cad_unique(matches, 'Reference ' + name))


def _camera_apply_component(ctx: "CadContext", entity: "adsk.core.Base") -> None:
    kind = _cad_kind(entity)
    if kind == 'occurrence':
        ctx.occurrence = _cad_cast('adsk.fusion.Occurrence', entity)
        ctx.component = ctx.occurrence.component
    elif kind == 'component':
        ctx.component = _cad_cast('adsk.fusion.Component', entity)
    else:
        raise ValueError('component_ref must resolve to a component or occurrence')


def _camera_try_component_name(ctx: "CadContext", name: str) -> "str | None":
    matches, alias = _camera_component_candidates(ctx, name)
    if alias is None:
        _camera_select_component(ctx, name, matches)
    return alias


def _camera_resume_component_name(ctx: "CadContext", name: str, expected: str,
                                  resolve_alias: "Callable[[str], adsk.core.Base]") -> None:
    matches, alias = _camera_component_candidates(ctx, name)
    if alias is None or alias != expected:
        raise RuntimeError('DOCUMENT_STATE_CHANGED: component alias changed during selection')
    target = resolve_alias(alias)
    _camera_add_alias_match(ctx, matches, target)
    _camera_select_component(ctx, name, matches)


def _camera_check_resumed_name(ctx: "CadContext", name: str, expected: str,
                               resolve_alias: "Callable[[str], adsk.core.Base]") -> None:
    if _camera_scope_attribute(ctx.root, name) != expected:
        raise RuntimeError('DOCUMENT_STATE_CHANGED: component alias changed during selection')
    matches = _camera_matching_names(ctx.design, ctx.root, name)
    _camera_add_root_match(ctx.root, matches, resolve_alias(expected))
    _camera_require_component(_cad_unique(matches, 'Reference ' + name))
