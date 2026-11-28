"""Candidate enumeration when all possible query scopes are the pinned root."""


def _entity_candidates(ctx: "CadContext", data: "JsonObject") -> "list[adsk.core.Base]":
    scope = _entity_json_object(data.get('scope', {}), 'scope')
    _cad_fields(scope, optional=('component', 'occurrence', 'body', 'feature'))
    if 'scope' in data and any(key in data for key in ('component', 'occurrence')):
        raise ValueError('scope cannot combine with top-level component/occurrence')
    instances = data.get('instances', False)
    kind = _cad_cast(str, data.get('kind', 'face'))
    contexts: list[adsk.fusion.Occurrence | None] = [None]
    if instances:
        contexts.extend(_cad_items(ctx.root.allOccurrences))
    result: list[adsk.core.Base] = []
    for context in contexts:
        current = context.component if context is not None else ctx.root
        entities: Sequence[adsk.core.Base]
        if kind == 'component' and (instances or 'component' in scope or 'occurrence' in scope or
                                    'component' in data or 'occurrence' in data):
            entities = [current]
        elif kind == 'occurrence':
            entities = ([context] if context is not None else []) if instances else _cad_items(ctx.root.allOccurrences)
        else:
            entities = _cad_context_entities(ctx, kind, current, context)
        for entity in entities:
            if not any(entity == other for other in result):
                result.append(entity)
    return result
