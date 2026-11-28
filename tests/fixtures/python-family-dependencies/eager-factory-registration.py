def _foreign_operation(ctx, data):
    return ctx.call("shape.box", data)


def _family_factory(mode):
    def handler(ctx, data):
        return _foreign_operation(ctx, data) if mode == "impeller" else data

    return handler


CAD_HANDLERS.update({"mechanism.impeller": _family_factory("impeller")})
CAD_HANDLERS.update({
    "mechanism." + mode: _family_factory(mode)
    for mode in ("impeller",)
})
