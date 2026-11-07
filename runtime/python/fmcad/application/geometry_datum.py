"""Geometry datum: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'datum'


CAD_HANDLERS.update({'datum.transform': _datum_transform,
                     'joint.frame': _datum_joint_frame,
                     'datum.plane-on-path': _datum_plane_on_path})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'datum'))
