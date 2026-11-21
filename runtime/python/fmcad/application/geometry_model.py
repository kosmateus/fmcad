"""Geometry model: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'model'


CAD_HANDLERS.update({
    'sketch.create': model_sketch_create, 'sketch.inspect': model_sketch_inspect,
    'sketch.edit': model_sketch_edit, 'sketch.geometry': model_sketch_geometry,
    'sketch.constrain': model_sketch_constrain, 'sketch.dimension': model_sketch_dimension,
    'sketch.project': model_sketch_project, 'sketch.offset': model_sketch_offset,
    'sketch.mirror': model_sketch_mirror, 'sketch.pattern': model_sketch_pattern,
    'sketch.check': model_sketch_check, 'path.create': model_path_create,
    'path.inspect': model_path_create,
})


def _model_handler(mode: str) -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return model_feature(ctx, data, mode)
    return handler


CAD_HANDLERS.update({'model.extrude': model_extrude})


def model_revolve(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'revolve')


def model_sweep(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'sweep')


def model_loft(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'loft')


def model_hole(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'hole')


def model_shell(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'shell')


def model_thicken(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'thicken')


def model_combine(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'combine')


def model_split(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'split')


def model_fillet(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'fillet')


def model_chamfer(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'chamfer')


def model_draft(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'draft')


def model_thread(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'thread')


def model_mirror(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'mirror')


def model_pattern_circular(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'circular')


def model_pattern_rectangular(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'rectangular')


def model_pattern_path(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return model_feature(ctx, data, 'path')


CAD_HANDLERS.update({
    'model.revolve': model_revolve, 'model.sweep': model_sweep, 'model.loft': model_loft,
    'model.hole': model_hole, 'model.shell': model_shell, 'model.thicken': model_thicken,
    'model.combine': model_combine, 'model.split': model_split, 'model.fillet': model_fillet,
    'model.chamfer': model_chamfer, 'model.draft': model_draft, 'model.thread': model_thread,
    'model.mirror': model_mirror,
})


CAD_HANDLERS.update({'pattern.circular': model_pattern_circular,
                     'pattern.rectangular': model_pattern_rectangular,
                     'pattern.path': model_pattern_path})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'model'))
