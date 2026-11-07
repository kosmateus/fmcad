"""SDK-free sheetmetal validation and numerical data operations."""
import math as _sheetmetal_domain_math
from collections.abc import Sequence as _sheetmetal_Sequence
from typing import cast as _sheetmetal_cast

def _sheetmetal_vsub(a: _sheetmetal_Sequence[float], b: _sheetmetal_Sequence[float]) -> list[float]:
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _sheetmetal_vadd(a: _sheetmetal_Sequence[float], b: _sheetmetal_Sequence[float]) -> list[float]:
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _sheetmetal_vscale(a: _sheetmetal_Sequence[float], s: float) -> list[float]:
    return [x * s for x in a]

def _sheetmetal_vdot(a: _sheetmetal_Sequence[float], b: _sheetmetal_Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _sheetmetal_vcross(a: _sheetmetal_Sequence[float], b: _sheetmetal_Sequence[float]) -> list[float]:
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _sheetmetal_vnorm(a: _sheetmetal_Sequence[float]) -> float:
    return _sheetmetal_domain_math.sqrt(_sheetmetal_vdot(a, a))

def _sheetmetal_vunit(a: _sheetmetal_Sequence[float]) -> list[float]:
    n = _sheetmetal_vnorm(a)
    if n == 0:
        raise ValueError('Degenerate zero vector')
    return [x / n for x in a]

def _rotate(v: _sheetmetal_Sequence[float], axis: _sheetmetal_Sequence[float], angle: float) -> list[float]:
    c, s = _sheetmetal_domain_math.cos(angle), _sheetmetal_domain_math.sin(angle)
    axis = _sheetmetal_vunit(axis)
    dot = _sheetmetal_vdot(axis, v)
    return _sheetmetal_vadd(_sheetmetal_vadd(_sheetmetal_vscale(v, c), _sheetmetal_vscale(_sheetmetal_vcross(axis, v), s)), _sheetmetal_vscale(axis, dot * (1 - c)))

def _deg(rad: float) -> float:
    return rad * 180.0 / _sheetmetal_domain_math.pi


_SHEETMETAL_AXES = {'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0]}


def _formed_walk(segments: list["JsonObject"], neutral_radii: dict[int, float]) -> tuple[list[list[float]], list["JsonObject"]]:
    position = [0.0, 0.0, 0.0]
    tangent = [1.0, 0.0, 0.0]
    points = [list(position)]
    mapping: list["JsonObject"] = []
    for seg in segments:
        segment_type = _sheetmetal_cast(str, seg['type'])
        index = _sheetmetal_cast(int, seg['index'])
        if segment_type == 'flat':
            length = _sheetmetal_cast(float, seg['length'])
            position = _sheetmetal_vadd(position, _sheetmetal_vscale(tangent, length))
            mapping.append({'index': index, 'type': 'flat', 'position': list(position),
                            'tangent': list(tangent)})
        else:
            angle = _sheetmetal_cast(float, seg['angle'])
            axis = _SHEETMETAL_AXES[_sheetmetal_cast(str, seg['axis'])]
            radius = neutral_radii[index]
            inward = _sheetmetal_vunit(_sheetmetal_vcross(axis, tangent))
            center = _sheetmetal_vadd(position, _sheetmetal_vscale(inward, radius))
            end_radial = _rotate(_sheetmetal_vscale(inward, -1.0), axis, angle)
            position = _sheetmetal_vadd(center, _sheetmetal_vscale(end_radial, radius))
            tangent = _rotate(tangent, axis, angle)
            mapping.append({'index': index, 'type': 'bend', 'position': list(position),
                            'tangent': list(tangent), 'neutralRadius': radius, 'angle': angle})
        points.append(list(position))
    return points, mapping


def _flat_walk(segments: list["JsonObject"], developed: dict[int, float]) -> tuple[list[list[float]], list["JsonObject"]]:
    position = [0.0, 0.0, 0.0]
    tangent = [1.0, 0.0, 0.0]
    points = [list(position)]
    mapping: list["JsonObject"] = []
    for seg in segments:
        segment_type = _sheetmetal_cast(str, seg['type'])
        index = _sheetmetal_cast(int, seg['index'])
        length = (_sheetmetal_cast(float, seg['length']) if segment_type == 'flat'
                  else developed[index])
        position = _sheetmetal_vadd(position, _sheetmetal_vscale(tangent, length))
        mapping.append({'index': index, 'type': segment_type, 'position': list(position),
                        'developedLength': length if segment_type == 'bend' else None})
        points.append(list(position))
    return points, mapping
