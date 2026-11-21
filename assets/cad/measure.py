"""Offline compatibility loader for the canonical modeling runtime.

Prepared bundles already contain these units and perform no checkout reads.
Standalone callers outside the checkout may set _FMCAD_RUNTIME_ROOT explicitly.
"""
if '_measure_space' not in globals():
    from pathlib import Path as _modeling_compat_Path
    _modeling_compat_root = None
    for _modeling_compat_candidate in (globals().get('_FMCAD_RUNTIME_ROOT'),
                                      globals().get('__file__'), _modeling_compat_Path.cwd()):
        if _modeling_compat_candidate is None:
            continue
        _modeling_compat_candidate = _modeling_compat_Path(_modeling_compat_candidate).resolve()
        for _modeling_compat_parent in (_modeling_compat_candidate, *_modeling_compat_candidate.parents):
            if (_modeling_compat_parent / 'runtime/python/fmcad/adapters/fusion/measure.py').is_file():
                _modeling_compat_root = _modeling_compat_parent
                break
        if _modeling_compat_root is not None:
            break
    if _modeling_compat_root is None:
        raise RuntimeError('Modeling compatibility source requires the runtime checkout or explicit bundled units')
    for _modeling_compat_unit in ('runtime/python/fmcad/domain/measure.py', 'runtime/python/fmcad/adapters/fusion/measure.py'):
        _modeling_compat_source = _modeling_compat_root / _modeling_compat_unit
        exec(compile(_modeling_compat_source.read_text(encoding='utf8'), str(_modeling_compat_source), 'exec'), globals())
