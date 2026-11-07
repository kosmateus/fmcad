"""Pure PNG diagnostics and readback policy shared by review and shot.pack."""

import binascii
import hashlib as _capture_hashlib
import math as _capture_math
import struct
import zlib
from collections.abc import Iterable as _CaptureIterable, Sequence as _CaptureSequence
from typing import TYPE_CHECKING as _CAPTURE_TYPE_CHECKING, Literal as _CAPTURE_Literal
from typing import NotRequired as _CAPTURE_NotRequired, TypedDict as _CAPTURE_TypedDict
from typing import cast as _CAPTURE_cast


if _CAPTURE_TYPE_CHECKING:
    class _CaptureThresholds(_CAPTURE_TypedDict):
        maxPixels: int
        thumbnailSize: int
        edgeDelta: int
        colorBinBits: int
        minEdgePixelRatio: float
        minLumaStandardDeviation: float
        minDistinctColorBins: int
        duplicateMeanAbsoluteChannelDelta: float
        duplicateSampleDelta: int
        duplicateSampleRatio: float
        similarMeanAbsoluteChannelDelta: float
        similarSampleDelta: int
        similarSampleRatio: float

    class _CapturePixelPolicy(_CAPTURE_TypedDict):
        policy: str
        thresholds: _CaptureThresholds

    class _CaptureDecodedPixels(_CAPTURE_TypedDict):
        width: int
        height: int
        pixelDigest: str
        edgePixelRatio: float
        lumaStandardDeviation: float
        distinctColorBins: int
        thumbnail: list[int]

    class _CaptureFrame(_CAPTURE_TypedDict):
        name: str
        bytes: bytes | bytearray
        width: _CAPTURE_NotRequired[int | None]
        height: _CAPTURE_NotRequired[int | None]
        direction: "JsonValue"


_MAX_PIXELS = 16000000
_THUMBNAIL_SIZE = 32
_EDGE_DELTA = 12
_COLOR_BIN_BITS = 4
PIXEL_POLICY = _CAPTURE_cast("_CapturePixelPolicy", {
    'policy': 'capture-pixels-v1',
    'thresholds': {
        'maxPixels': _MAX_PIXELS,
        'thumbnailSize': _THUMBNAIL_SIZE,
        'edgeDelta': _EDGE_DELTA,
        'colorBinBits': _COLOR_BIN_BITS,
        'minEdgePixelRatio': 0.00002,
        'minLumaStandardDeviation': 1.5,
        'minDistinctColorBins': 3,
        'duplicateMeanAbsoluteChannelDelta': 0.5,
        'duplicateSampleDelta': 4,
        'duplicateSampleRatio': 0.995,
        'similarMeanAbsoluteChannelDelta': 3,
        'similarSampleDelta': 8,
        'similarSampleRatio': 0.98,
    },
})
_PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _png_paeth(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    diagonal_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= diagonal_distance:
        return left
    if above_distance <= diagonal_distance:
        return above
    return upper_left


def decode_capture_png(data: object, expected_width: "int | None" = None,
                       expected_height: "int | None" = None) -> "_CaptureDecodedPixels":
    """Decode bounded 8-bit non-interlaced PNG into canonical RGBA statistics."""
    if not isinstance(data, (bytes, bytearray)) or not data.startswith(_PNG_SIGNATURE):
        raise ValueError('Capture artifact is not a PNG')
    offset = len(_PNG_SIGNATURE)
    header: "tuple[int, int, int, int, int, int, int] | None" = None
    palette: bytes | None = None
    transparency: bytes | None = None
    idat: list[bytes] = []
    data_started = data_ended = ended = False
    while offset < len(data):
        if len(data) - offset < 12:
            raise ValueError('Truncated capture PNG chunk')
        length = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        begin, end = offset + 8, offset + 8 + length
        if end + 4 > len(data):
            raise ValueError('Truncated capture PNG chunk data')
        expected_crc = struct.unpack_from('>I', data, end)[0]
        if (binascii.crc32(data[offset + 4:end]) & 0xffffffff) != expected_crc:
            raise ValueError('Capture PNG chunk CRC mismatch: ' + kind.decode('ascii', 'replace'))
        chunk = bytes(data[begin:end])
        if kind == b'IHDR':
            if header is not None or offset != len(_PNG_SIGNATURE) or length != 13:
                raise ValueError('Invalid capture PNG header')
            header = struct.unpack('>IIBBBBB', chunk)
            if header[4:7] != (0, 0, 0):
                raise ValueError('Unsupported capture PNG compression or filter method')
        elif kind == b'PLTE':
            if data_started or not length or length % 3 or length > 768:
                raise ValueError('Invalid capture PNG palette')
            palette = chunk
        elif kind == b'tRNS':
            if data_started:
                raise ValueError('Invalid capture PNG transparency order')
            transparency = chunk
        elif kind == b'IDAT':
            if data_ended:
                raise ValueError('Nonconsecutive capture PNG image data')
            data_started = True
            idat.append(chunk)
        elif kind == b'IEND':
            if not data_started or length:
                raise ValueError('Invalid capture PNG end')
            ended = True
            offset = end + 4
            break
        else:
            if data_started:
                data_ended = True
            if 65 <= kind[0] <= 90:
                raise ValueError('Unsupported critical capture PNG chunk: ' + kind.decode('ascii'))
        if kind != b'IDAT' and data_started and kind != b'IEND':
            data_ended = True
        offset = end + 4
    if not ended or offset != len(data) or header is None or not idat:
        raise ValueError('Incomplete capture PNG')
    width, height, bit_depth, color_type, compression, filter_method, interlace = header
    if (expected_width is not None and width != expected_width) or \
            (expected_height is not None and height != expected_height) or \
            not width or not height or width * height > _MAX_PIXELS:
        raise ValueError('Capture PNG dimensions do not match the request')
    if bit_depth != 8 or interlace != 0:
        raise ValueError('Unsupported capture PNG pixel encoding')
    channels: int | None = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None or (color_type == 3 and palette is None):
        raise ValueError('Unsupported capture PNG color type or missing palette')
    if transparency is not None and (
            (color_type == 3 and len(transparency) > len(_CAPTURE_cast('bytes', palette)) // 3) or
            (color_type == 0 and len(transparency) != 2) or
            (color_type == 2 and len(transparency) != 6) or
            color_type in (4, 6)):
        raise ValueError('Invalid capture PNG transparency table')
    row_bytes = width * channels
    expected_length = (row_bytes + 1) * height
    inflater = zlib.decompressobj()
    raw = inflater.decompress(b''.join(idat), expected_length + 1)
    if (len(raw) != expected_length or not inflater.eof or inflater.unconsumed_tail or
            inflater.unused_data):
        raise ValueError('Capture PNG pixel stream has an invalid length')

    x_samples: dict[int, int] = {min(width - 1, int((sample + 0.5) * width / _THUMBNAIL_SIZE)): sample
                                 for sample in range(_THUMBNAIL_SIZE)}
    y_samples: dict[int, int] = {min(height - 1, int((sample + 0.5) * height / _THUMBNAIL_SIZE)): sample
                                 for sample in range(_THUMBNAIL_SIZE)}
    thumbnail: list[int] = [0] * (_THUMBNAIL_SIZE * _THUMBNAIL_SIZE * 3)
    previous = bytearray(row_bytes)
    previous_luma: list[float] = [0.0] * width
    histogram: set[int] = set()
    digest = _capture_hashlib.sha256(struct.pack('>II', width, height))
    total = sum_squares = 0.0
    edge_pixels = 0
    cursor = 0
    for y in range(height):
        filter_type = raw[cursor]
        cursor += 1
        if filter_type > 4:
            raise ValueError('Invalid capture PNG row filter')
        current = bytearray(row_bytes)
        for x in range(row_bytes):
            left = current[x - channels] if x >= channels else 0
            above = previous[x]
            upper_left = previous[x - channels] if x >= channels else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            else:
                predictor = _png_paeth(left, above, upper_left)
            current[x] = (raw[cursor] + predictor) & 255
            cursor += 1

        rgba = bytearray(width * 4)
        current_luma = [0.0] * width
        for x in range(width):
            source = x * channels
            pixel: "tuple[int, int, int, int]"
            if color_type == 0:
                gray = current[source]
                pixel = (gray, gray, gray,
                         0 if transparency == struct.pack('>H', gray) else 255)
            elif color_type == 2:
                red, green, blue = current[source:source + 3]
                transparent = (transparency is not None and
                               tuple(struct.unpack('>HHH', transparency)) == (red, green, blue))
                pixel = (red, green, blue, 0 if transparent else 255)
            elif color_type == 3:
                palette_bytes = _CAPTURE_cast('bytes', palette)
                palette_offset = current[source] * 3
                if palette_offset + 2 >= len(palette_bytes):
                    raise ValueError('Capture PNG palette index is out of range')
                pixel = (palette_bytes[palette_offset], palette_bytes[palette_offset + 1],
                         palette_bytes[palette_offset + 2],
                         transparency[current[source]] if transparency is not None and
                         current[source] < len(transparency) else 255)
            elif color_type == 4:
                gray, alpha = current[source:source + 2]
                pixel = (gray, gray, gray, alpha)
            else:
                pixel = (current[source], current[source + 1], current[source + 2], current[source + 3])
            offset_rgba = x * 4
            rgba[offset_rgba:offset_rgba + 4] = bytes(pixel)
            alpha = pixel[3] / 255.0
            red = pixel[0] * alpha + 255.0 * (1.0 - alpha)
            green = pixel[1] * alpha + 255.0 * (1.0 - alpha)
            blue = pixel[2] * alpha + 255.0 * (1.0 - alpha)
            luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            total += luma
            sum_squares += luma * luma
            color_shift = 8 - _COLOR_BIN_BITS
            histogram.add((int(_capture_math.floor(red + 0.5)) >> color_shift) << (_COLOR_BIN_BITS * 2) |
                          (int(_capture_math.floor(green + 0.5)) >> color_shift) << _COLOR_BIN_BITS |
                          int(_capture_math.floor(blue + 0.5)) >> color_shift)
            if ((x > 0 and abs(luma - current_luma[x - 1]) >= _EDGE_DELTA) or
                    (y > 0 and abs(luma - previous_luma[x]) >= _EDGE_DELTA)):
                edge_pixels += 1
            current_luma[x] = luma
            sample_x, sample_y = x_samples.get(x), y_samples.get(y)
            if sample_x is not None and sample_y is not None:
                index = (sample_y * _THUMBNAIL_SIZE + sample_x) * 3
                thumbnail[index:index + 3] = [int(_capture_math.floor(red + 0.5)),
                                               int(_capture_math.floor(green + 0.5)),
                                               int(_capture_math.floor(blue + 0.5))]
        digest.update(rgba)
        previous = current
        previous_luma = current_luma
    count = width * height
    mean = total / count
    result: "_CaptureDecodedPixels" = {
        'width': width,
        'height': height,
        'pixelDigest': digest.hexdigest(),
        'edgePixelRatio': edge_pixels / count,
        'lumaStandardDeviation': _capture_math.sqrt(max(0.0, sum_squares / count - mean * mean)),
        'distinctColorBins': len(histogram),
        'thumbnail': thumbnail,
    }
    return result


def analyze_capture_pixels(frames: "_CaptureIterable[_CaptureFrame]") -> "JsonObject":
    """Return blank failures plus exact/near duplicate diagnostics for PNG frames."""
    thresholds = PIXEL_POLICY['thresholds']
    decoded: list[tuple[str, _CaptureDecodedPixels, tuple[float, float, float]]] = []
    views: list[JsonObject] = []
    for frame in frames:
        pixels = decode_capture_png(frame['bytes'], frame.get('width'), frame.get('height'))
        blank = (pixels['edgePixelRatio'] < thresholds['minEdgePixelRatio'] or
                 pixels['lumaStandardDeviation'] < thresholds['minLumaStandardDeviation'] or
                 pixels['distinctColorBins'] < thresholds['minDistinctColorBins'])
        views.append({
            'name': frame['name'],
            'status': 'blank' if blank else 'nonblank',
            'edgePixelRatio': pixels['edgePixelRatio'],
            'lumaStandardDeviation': pixels['lumaStandardDeviation'],
            'distinctColorBins': pixels['distinctColorBins'],
        })
        direction = frame.get('direction')
        if not isinstance(direction, (list, tuple)) or len(direction) != 3 or \
                any(not isinstance(value, (int, float)) or not _capture_math.isfinite(value) for value in direction):
            raise ValueError('Capture camera direction readback is unavailable')
        numeric_direction = _CAPTURE_cast('_CaptureSequence[int | float]', direction)
        magnitude = _capture_math.sqrt(sum(value * value for value in numeric_direction))
        if magnitude <= 1e-9:
            raise ValueError('Capture camera direction readback is invalid')
        normalized: tuple[float, float, float] = (
            numeric_direction[0] / magnitude,
            numeric_direction[1] / magnitude,
            numeric_direction[2] / magnitude,
        )
        decoded.append((frame['name'], pixels, normalized))
    duplicates: list[JsonObject] = []
    similar: list[JsonObject] = []
    for left in range(len(decoded)):
        for right in range(left + 1, len(decoded)):
            name_a, a, direction_a = decoded[left]
            name_b, b, direction_b = decoded[right]
            if a['width'] != b['width'] or a['height'] != b['height']:
                continue
            if a['pixelDigest'] == b['pixelDigest']:
                direction_dot = sum(x * y for x, y in zip(direction_a, direction_b))
                if direction_dot >= 0.9999:
                    duplicates.append({'left': name_a, 'right': name_b,
                                       'kind': 'exact-decoded-pixels'})
                else:
                    similar.append({'left': name_a, 'right': name_b,
                                    'meanAbsoluteChannelDelta': 0.0,
                                    'reason': 'exact-pixels-distinct-directions'})
                continue
            deltas = [abs(x - y) for x, y in zip(a['thumbnail'], b['thumbnail'])]
            mean_delta = sum(deltas) / len(deltas)
            close_ratio = sum(delta <= thresholds['similarSampleDelta']
                              for delta in deltas) / len(deltas)
            duplicate_close_ratio = sum(delta <= thresholds['duplicateSampleDelta']
                                        for delta in deltas) / len(deltas)
            direction_dot = sum(x * y for x, y in zip(direction_a, direction_b))
            if (direction_dot >= 0.9999 and
                    mean_delta <= thresholds['duplicateMeanAbsoluteChannelDelta'] and
                    duplicate_close_ratio >= thresholds['duplicateSampleRatio']):
                duplicates.append({'left': name_a, 'right': name_b,
                                   'kind': 'near-identical-pixels'})
            elif (mean_delta <= thresholds['similarMeanAbsoluteChannelDelta'] and
                    close_ratio >= thresholds['similarSampleRatio']):
                similar.append({'left': name_a, 'right': name_b,
                                'meanAbsoluteChannelDelta': mean_delta,
                                'reason': 'similar-pixels'})
    failed = any(row['status'] == 'blank' for row in views) or bool(duplicates)
    result = {
        'policy': PIXEL_POLICY['policy'],
        'status': 'failed' if failed else ('review-required' if similar else 'verified'),
        'thresholds': thresholds,
        'views': views,
        'duplicatePairs': duplicates,
        # Similar but distinct projections are surfaced for inspection, not rejected.
        'similarPairs': similar,
    }
    return _CAPTURE_cast('JsonObject', result)


def capture_restore_status(expected: object, actual: object = None,
                           supported: bool = True, readable: bool = True) -> "_CAPTURE_Literal['unsupported', 'unknown', 'failed', 'restored']":
    """Classify restoration from an independent getter, never setter success alone."""
    if not supported:
        return 'unsupported'
    if not readable:
        return 'unknown'
    if actual != expected:
        return 'failed'
    return 'restored'


def capture_apply_status(expected: object, actual: object = None,
                         supported: bool = True, readable: bool = True) -> "_CAPTURE_Literal['verified', 'unsupported', 'unknown']":
    """Classify requested presentation state separately from its later restore."""
    status = capture_restore_status(expected, actual, supported, readable)
    return 'verified' if status == 'restored' else ('unsupported' if status == 'failed' else status)


def capture_aggregate_status(rows: "_CaptureSequence[JsonObject]") -> "_CAPTURE_Literal['failed', 'unsupported', 'unknown', 'verified', 'restored']":
    """Combine independent readback outcomes without upgrading uncertainty."""
    statuses = [row.get('status') for row in rows]
    if 'failed' in statuses:
        return 'failed'
    if 'unsupported' in statuses:
        return 'unsupported'
    if 'unknown' in statuses:
        return 'unknown'
    if 'verified' in statuses:
        return 'verified'
    return 'restored'
