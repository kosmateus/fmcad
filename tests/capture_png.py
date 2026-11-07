"""Small deterministic PNG fixtures for offline capture-integrity tests."""
import binascii
import struct
import zlib


def _chunk(name, data):
    value = name + data
    return struct.pack('>I', len(data)) + value + struct.pack('>I', binascii.crc32(value) & 0xffffffff)


def png_bytes(width, height, seed=0, blank=False, compression_level=-1, variant_delta=0):
    rows = []
    for y in range(height):
        row = bytearray(width * 4)
        for x in range(width):
            offset = x * 4
            row[offset:offset + 4] = b'\xf0\xf0\xf0\xff'
            if not blank and width // 8 <= x < width * 7 // 8 and height // 8 <= y < height * 7 // 8:
                edge = x in (width // 8, width * 7 // 8 - 1) or y in (height // 8, height * 7 // 8 - 1)
                stripe = (x + seed * 7) % max(3, width // 5) < max(1, width // 12)
                if edge or stripe:
                    row[offset:offset + 4] = b'\x18\x18\x18\xff'
                else:
                    row[offset:offset + 4] = bytes((40 + seed * 17 % 180,
                                                    50 + seed * 29 % 170,
                                                    60 + seed * 41 % 160, 255))
            if not blank and variant_delta and x == width // 2 and y == height // 2:
                row[offset] = min(255, row[offset] + variant_delta)
        rows.append(b'\x00' + row)
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', header) +
            _chunk(b'IDAT', zlib.compress(b''.join(rows), compression_level)) + _chunk(b'IEND', b''))
