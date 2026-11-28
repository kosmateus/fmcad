def _cad_context_entities(ctx: "CadContext", kind: "str | None", component: "adsk.fusion.Component | None",
                          occurrence: "adsk.fusion.Occurrence | None") -> "Sequence[CadEntity]":
    return _cad_items(ctx.design.allParameters)
