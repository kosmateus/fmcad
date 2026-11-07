"""Geometry sketch_plan: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'sketch_plan'


CAD_HANDLERS.update({'sketch.dimension-plan': sketch_dimension_plan, 'sketch.dimension-apply': sketch_dimension_apply})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'sketch_plan'))
