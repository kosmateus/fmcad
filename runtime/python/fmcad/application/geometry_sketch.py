"""Geometry sketch: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'sketch'


# Explicit ownership transfer from the legacy module; refuse an unexpected
# registration rather than silently replacing another extension's handler.
# Legacy functions remain the implementation for unchanged variants.
for _sketch_operation, _sketch_legacy in {
    'sketch.geometry': model_sketch_geometry, 'sketch.dimension': model_sketch_dimension,
    'sketch.edit': model_sketch_edit, 'sketch.check': model_sketch_check,
    'sketch.constrain': model_sketch_constrain,
}.items():
    if CAD_HANDLERS.get(_sketch_operation) is not _sketch_legacy:
        raise RuntimeError('Unexpected sketch handler owner: ' + _sketch_operation)
    CAD_HANDLERS.pop(_sketch_operation)


CAD_HANDLERS.update({'sketch.build': sketch_build, 'sketch.geometry': sketch_geometry,
    'sketch.dimension': sketch_dimension, 'sketch.edit': sketch_edit, 'sketch.transform': sketch_transform,
    'sketch.check': sketch_check, 'sketch.constrain': sketch_constrain})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'sketch'))
