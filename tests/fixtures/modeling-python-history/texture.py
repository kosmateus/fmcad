"""GM29 texture heightmap generation.

Deterministic, tileable PNG heightmaps (strips, grooves, waves, value noise)
written with the standard library only (zlib + struct), so no product/color is
hardcoded and no third-party imaging dependency is assumed. Every output is a
function of width/height/seed/amplitude/period/pattern, so the same parameters
reproduce byte-identical pixels. See docs/APPEARANCES.md.
"""
import binascii
import hashlib
import math
import struct
import zlib
from pathlib import Path


_HEIGHTMAP_PATTERNS = ('strips', 'grooves', 'waves', 'noise')


def _texture_path(ctx, data):
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


def _hash01(x, y, seed):
    h = (seed & 0xFFFFFFFFFFFFFFFF)
    h ^= (x + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
    h ^= (y + 0xD1B54A32D192ED03) & 0xFFFFFFFFFFFFFFFF
    h = (h ^ (h >> 30)) * 0xBF58476D1CE4E5B9 & 0xFFFFFFFFFFFFFFFF
    h = (h ^ (h >> 27)) * 0x94D049BB133111EB & 0xFFFFFFFFFFFFFFFF
    h ^= h >> 31
    return h / 18446744073709551616.0


def _value_noise(x, y, seed):
    xi, yi = int(math.floor(x)), int(math.floor(y))
    xf, yf = x - xi, y - yi
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a = _hash01(xi, yi, seed)
    b = _hash01(xi + 1, yi, seed)
    c = _hash01(xi, yi + 1, seed)
    d = _hash01(xi + 1, yi + 1, seed)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def _heightmap_sample(pattern, u, v, seed, amplitude):
    if pattern == 'strips':
        return 0.5 + amplitude * (0.5 - v)
    if pattern == 'grooves':
        frac = u - math.floor(u)
        return 0.5 + amplitude * (0.5 - min(frac, 1.0 - frac) / 0.5)
    if pattern == 'waves':
        return 0.5 + amplitude * 0.5 * math.sin(2 * math.pi * (u + v))
    n = _value_noise(u, v, seed) + 0.5 * _value_noise(2 * u, 2 * v, seed + 7)
    return 0.5 + amplitude * (n / 1.5 - 0.5)


def _heightmap_png(width, height, rows):
    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload +
                struct.pack('>I', binascii.crc32(tag + payload) & 0xFFFFFFFF))

    header = struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) +
            chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def texture_heightmap(ctx, data):
    _cad_fields(data, ('path',), ('width', 'height', 'seed', 'amplitude', 'period', 'pattern', 'tileable',
                                  'overwrite', 'confirm'))
    path = _texture_path(ctx, data)
    width, height = data.get('width', 256), data.get('height', 256)
    if type(width) is not int or type(height) is not int or not 1 <= width <= 16384 or not 1 <= height <= 16384:
        raise ValueError('width/height must be integers from 1 to 16384')
    seed = data.get('seed', 0)
    if type(seed) is not int:
        raise ValueError('seed must be an integer')
    amplitude = data.get('amplitude', 1.0)
    if type(amplitude) not in (int, float) or not math.isfinite(amplitude) or not 0.0 <= amplitude <= 1.0:
        raise ValueError('amplitude must be a finite number between 0 and 1')
    period = data.get('period', 16)
    if type(period) not in (int, float) or not math.isfinite(period) or period <= 0:
        raise ValueError('period must be a positive pixel count')
    pattern = data.get('pattern', 'waves')
    if pattern not in _HEIGHTMAP_PATTERNS:
        raise ValueError('pattern must be one of ' + ', '.join(_HEIGHTMAP_PATTERNS))
    tileable = data.get('tileable', True)
    if type(tileable) is not bool:
        raise ValueError('tileable must be boolean')

    scale = float(period)
    rows = []
    for y in range(height):
        v = y / scale if tileable else y
        row = []
        for x in range(width):
            u = x / scale if tileable else x
            value = _heightmap_sample(pattern, u, v, seed, float(amplitude))
            value = max(0.0, min(1.0, value))
            row.append(int(round(value * 255.0)))
        rows.append(row)

    png = _heightmap_png(width, height, rows)
    Path(path).write_bytes(png)
    parameters = {'width': width, 'height': height, 'seed': seed, 'amplitude': amplitude,
                  'period': period, 'pattern': pattern, 'tileable': tileable,
                  'valueRange': [0.0, 1.0], 'depth': 8, 'channels': 1}
    return {'file': {'path': str(path), 'exists': True, 'bytes': len(png),
                     'pathHost': 'machine running Fusion', 'geometryVerified': False},
            'parameters': parameters, 'sha256': hashlib.sha256(png).hexdigest(),
            'deterministic': True,
            'limitations': ['8-bit single-channel grayscale heightmap; no color, alpha, or 16-bit depth.',
                            'The PNG is written to the Fusion host; use appearance.texture to connect it as a bump map.',
                            'Value noise is a fixed deterministic hash, not a perceptual or physics-based height field.']}


CAD_HANDLERS.update({'texture.heightmap': texture_heightmap})
