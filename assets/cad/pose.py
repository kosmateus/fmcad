"""Compatibility loader for standalone offline fixtures.

Prepared bundles load the manifest-declared runtime units first; this guard is
then a no-op. There is only one implementation of each handler and helper.
"""
if not globals().get('_fmcad_pose_runtime_loaded', False):
    from pathlib import Path as _fmcad_compat_path
    _fmcad_compat_root = _fmcad_compat_path.cwd()
    for _fmcad_compat_layer in ('domain', 'adapters/fusion'):
        _fmcad_compat_file = (_fmcad_compat_root / 'runtime/python/fmcad' /
                              _fmcad_compat_layer / 'pose.py')
        exec(compile(_fmcad_compat_file.read_text(), str(_fmcad_compat_file), 'exec'), globals())
