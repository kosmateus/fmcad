"""GM29 texture heightmap generation.

Deterministic, tileable PNG heightmaps (strips, grooves, waves, value noise)
written with the standard library only (zlib + struct), so no product/color is
hardcoded and no third-party imaging dependency is assumed. Every output is a
function of width/height/seed/amplitude/period/pattern, so the same parameters
reproduce byte-identical pixels. See docs/APPEARANCES.md.
"""
import hashlib as _texture_hashlib
import math as _texture_math
from pathlib import Path


def _texture_path(ctx: "CadContext", data: "JsonObject") -> Path:
    value = data['path']
    if not isinstance(value, str) or not value.strip():
        raise ValueError('path must be a nonempty absolute Fusion-machine path')
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Use an absolute path on the machine running Fusion; the integrator maps client paths')
    if path.suffix.lower() != '.png':
        raise ValueError('Expected extension: .png')
    if not path.parent.is_dir():
        raise ValueError('Output parent directory must already exist on the Fusion machine')
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('Output must be a regular file, not a directory or symbolic link')
    if path.exists():
        if data.get('overwrite') is not True:
            raise ValueError('Existing output requires overwrite: true and confirm: true')
        ctx.require_confirm(data)
    return path


def texture_heightmap(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    _cad_fields(data, ('path',), ('width', 'height', 'seed', 'amplitude', 'period', 'pattern', 'tileable',
                                  'overwrite', 'confirm'))
    path = _texture_path(ctx, data)
    width_value, height_value = data.get('width', 256), data.get('height', 256)
    if type(width_value) is not int or type(height_value) is not int or not 1 <= width_value <= 16384 or not 1 <= height_value <= 16384:
        raise ValueError('width/height must be integers from 1 to 16384')
    width, height = width_value, height_value
    seed_value = data.get('seed', 0)
    if type(seed_value) is not int:
        raise ValueError('seed must be an integer')
    seed = seed_value
    amplitude_value = data.get('amplitude', 1.0)
    if type(amplitude_value) not in (int, float):
        raise ValueError('amplitude must be a finite number between 0 and 1')
    amplitude = _cad_cast("int | float", amplitude_value)
    if not _texture_math.isfinite(amplitude) or not 0.0 <= amplitude <= 1.0:
        raise ValueError('amplitude must be a finite number between 0 and 1')
    period_value = data.get('period', 16)
    if type(period_value) not in (int, float):
        raise ValueError('period must be a positive pixel count')
    period = _cad_cast("int | float", period_value)
    if not _texture_math.isfinite(period) or period <= 0:
        raise ValueError('period must be a positive pixel count')
    pattern = _cad_cast(str, data.get('pattern', 'waves'))
    if pattern not in _HEIGHTMAP_PATTERNS:
        raise ValueError('pattern must be one of ' + ', '.join(_HEIGHTMAP_PATTERNS))
    tileable_value = data.get('tileable', True)
    if type(tileable_value) is not bool:
        raise ValueError('tileable must be boolean')
    tileable = tileable_value

    scale = float(period)
    rows: list[list[int]] = []
    for y in range(height):
        v = y / scale if tileable else y
        row: list[int] = []
        for x in range(width):
            u = x / scale if tileable else x
            value = _heightmap_sample(pattern, u, v, seed, float(amplitude))
            value = max(0.0, min(1.0, value))
            row.append(int(round(value * 255.0)))
        rows.append(row)

    png = _heightmap_png(width, height, rows)
    Path(path).write_bytes(png)
    parameters: JsonRecord = {'width': width, 'height': height, 'seed': seed, 'amplitude': amplitude,
                  'period': period, 'pattern': pattern, 'tileable': tileable,
                  'valueRange': [0.0, 1.0], 'depth': 8, 'channels': 1}
    return {'file': {'path': str(path), 'exists': True, 'bytes': len(png),
                     'pathHost': 'machine running Fusion', 'geometryVerified': False},
             'parameters': parameters, 'sha256': _texture_hashlib.sha256(png).hexdigest(),
            'deterministic': True,
            'limitations': ['8-bit single-channel grayscale heightmap; no color, alpha, or 16-bit depth.',
                            'The PNG is written to the Fusion host; use appearance.texture to connect it as a bump map.',
                            'Value noise is a fixed deterministic hash, not a perceptual or physics-based height field.']}


CAD_HANDLERS.update({'texture.heightmap': texture_heightmap})
