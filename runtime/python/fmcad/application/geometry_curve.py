"""Geometry curve: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'curve'


def _curve_profile_file(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    return curve_fit(ctx, data, 'sketch.profile-file')


CAD_HANDLERS.update({'sketch.profile-file': _curve_profile_file, 'curve.fit': curve_fit,
                     'curve.inspect': curve_inspect, 'curve.offset': curve_offset, 'curve.offset-edit': curve_offset_edit})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'curve'))
