"""Queries in a fresh pinned root context with no dynamic scope references."""


def _cad_context_scope(ctx: "CadContext", data: "JsonObject") -> "tuple[adsk.fusion.Component, adsk.fusion.Occurrence | None]":
    return ctx.root, None


def _cad_context_entities(ctx: "CadContext", kind: "str | None", component: "adsk.fusion.Component | None",
                          occurrence: "adsk.fusion.Occurrence | None") -> "Sequence[CadEntity]":
    return _cad_items(ctx.design.allComponents)


def _entity_candidates(ctx: "CadContext", data: "JsonObject") -> "list[adsk.core.Base]":
    return [ctx.root]
