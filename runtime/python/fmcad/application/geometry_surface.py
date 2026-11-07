"""Geometry surface: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'surface'


CAD_HANDLERS.update({
    'surface.patch': _surface_patch, 'surface.stitch': _surface_stitch, 'surface.trim': _surface_trim,
    'surface.extend': _surface_extend, 'surface.offset': _surface_offset, 'surface.check': _surface_check,
})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'surface'))
