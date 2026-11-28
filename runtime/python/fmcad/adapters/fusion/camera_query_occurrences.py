def _entity_candidates(ctx: "CadContext", data: "JsonObject") -> "list[adsk.core.Base]":
    return _cad_cast('list[adsk.core.Base]', _cad_dedup(_cad_items(ctx.root.allOccurrences)))
