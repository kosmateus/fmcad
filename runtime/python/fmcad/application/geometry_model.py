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


CAD_HANDLERS.update({'model.' + mode: _model_handler(mode) for mode in (
    'extrude', 'revolve', 'sweep', 'loft', 'hole', 'shell', 'thicken', 'combine',
    'split', 'fillet', 'chamfer', 'draft', 'thread', 'mirror')})


CAD_HANDLERS.update({'pattern.' + mode: _model_handler(mode) for mode in ('circular', 'rectangular', 'path')})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'model'))
