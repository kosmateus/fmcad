"""DTO-only rules extracted from assets/cad/appearance.py. No SDK or filesystem access."""

_STYLE_LIMITS = [
    'Appearance and physical material are separate properties; assigning one never implies the other.',
    'A face override can mask a body style; inspect the concrete entity, not an assumed effective style.',
    'A missing density or coating is reported, never fabricated; measure mass separately.',
]

def _style_resolution_warning(kind: str, style_id: str,
                              resolution: "_StyleResolutionInfo") -> "str | None":
    if not resolution['ambiguous']:
        return None
    return ('%s ID %r is not unique; deterministically resolved to %r (precedence %s) among %d candidates'
            % (kind, style_id, resolution['selected']['name'], resolution['precedence'],
               len(resolution['candidates'])))

_PROJECTIONS = {'automatic': 'AutomaticTextureMapProjection', 'planar': 'PlanarTextureMapProjection',
                'box': 'BoxTextureMapProjection', 'spherical': 'SphericalTextureMapProjection',
                'cylindrical': 'CylindricalTextureMapProjection'}
