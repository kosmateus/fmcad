"""DTO-only rules extracted from assets/cad/texture.py. No SDK or filesystem access."""
import math as _texture_domain_math
import binascii as _texture_binascii
import struct as _texture_struct
import zlib as _texture_zlib

_HEIGHTMAP_PATTERNS = ('strips', 'grooves', 'waves', 'noise')

def _hash01(x: int, y: int, seed: int) -> float:
    h = (seed & 0xFFFFFFFFFFFFFFFF)
    h ^= (x + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
    h ^= (y + 0xD1B54A32D192ED03) & 0xFFFFFFFFFFFFFFFF
    h = (h ^ (h >> 30)) * 0xBF58476D1CE4E5B9 & 0xFFFFFFFFFFFFFFFF
    h = (h ^ (h >> 27)) * 0x94D049BB133111EB & 0xFFFFFFFFFFFFFFFF
    h ^= h >> 31
    return h / 18446744073709551616.0

def _value_noise(x: float, y: float, seed: int) -> float:
    xi, yi = int(_texture_domain_math.floor(x)), int(_texture_domain_math.floor(y))
    xf, yf = x - xi, y - yi
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a = _hash01(xi, yi, seed)
    b = _hash01(xi + 1, yi, seed)
    c = _hash01(xi, yi + 1, seed)
    d = _hash01(xi + 1, yi + 1, seed)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v

def _heightmap_sample(pattern: str, u: float, v: float, seed: int, amplitude: float) -> float:
    if pattern == 'strips':
        return 0.5 + amplitude * (0.5 - v)
    if pattern == 'grooves':
        frac = u - _texture_domain_math.floor(u)
        return 0.5 + amplitude * (0.5 - min(frac, 1.0 - frac) / 0.5)
    if pattern == 'waves':
        return 0.5 + amplitude * 0.5 * _texture_domain_math.sin(2 * _texture_domain_math.pi * (u + v))
    n = _value_noise(u, v, seed) + 0.5 * _value_noise(2 * u, 2 * v, seed + 7)
    return 0.5 + amplitude * (n / 1.5 - 0.5)

def _heightmap_png(width: int, height: int, rows: "Sequence[Sequence[int]]") -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (_texture_struct.pack('>I', len(payload)) + tag + payload +
                _texture_struct.pack('>I', _texture_binascii.crc32(tag + payload) & 0xFFFFFFFF))

    header = _texture_struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) +
            chunk(b'IDAT', _texture_zlib.compress(raw, 9)) + chunk(b'IEND', b''))
