"""Offline compatibility facade; bundles initialize explicit geometry units first.

No handler implementation lives here. Set _FMCAD_GEOMETRY_ROOT when executing
this legacy source outside a checkout; installed Fusion bundles never read files.
"""
if 'shapes' not in globals().get('_FMCAD_GEOMETRY_LOADED', ()):
    from pathlib import Path as _geometry_Path
    _geometry_candidates = [globals().get('_FMCAD_GEOMETRY_ROOT'), globals().get('__file__'), _geometry_Path.cwd()]
    _geometry_root = None
    for _geometry_candidate in _geometry_candidates:
        if _geometry_candidate is None:
            continue
        _geometry_candidate = _geometry_Path(_geometry_candidate).resolve()
        for _geometry_parent in (_geometry_candidate, *_geometry_candidate.parents):
            if (_geometry_parent / 'runtime/python/fmcad/domain/geometry_shapes.py').is_file():
                _geometry_root = _geometry_parent
                break
        if _geometry_root is not None:
            break
    if _geometry_root is None:
        raise RuntimeError('Geometry compatibility source requires the runtime checkout or explicit bundled units')
    for _geometry_layer in ('domain', 'adapters/fusion', 'application'):
        _geometry_source = _geometry_root / ('runtime/python/fmcad/' + _geometry_layer + '/geometry_shapes.py')
        exec(compile(_geometry_source.read_text(encoding='utf8'), str(_geometry_source), 'exec'), globals())
