"""SDK-free sequence validation and numerical data operations."""
import math as _sequence_domain_math
from collections.abc import Sequence as _sequence_Sequence
from typing import cast as _sequence_cast

def _sequence_vsub(a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> list[float]:
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _sequence_vadd(a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> list[float]:
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _sequence_vscale(a: _sequence_Sequence[float], s: float) -> list[float]:
    return [x * s for x in a]

def _sequence_vdot(a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _sequence_vcross(a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> list[float]:
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _sequence_vnorm(a: _sequence_Sequence[float]) -> float:
    return _sequence_domain_math.sqrt(_sequence_vdot(a, a))

def _sequence_vunit(a: _sequence_Sequence[float]) -> list[float]:
    n = _sequence_vnorm(a)
    if n == 0 or not _sequence_domain_math.isfinite(n):
        raise ValueError('Direction cannot be zero or non-finite')
    return [x / n for x in a]

def _dir2(value: object) -> list[float]:
    if not isinstance(value, (list, tuple)):
        raise ValueError('direction must be two finite unitless numbers')
    coordinates = _sequence_cast(list[object] | tuple[object, ...], value)
    if len(coordinates) != 2:
        raise ValueError('direction must be two finite unitless numbers')
    for coordinate in coordinates:
        if (isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or
                not _sequence_domain_math.isfinite(coordinate)):
            raise ValueError('direction must be two finite unitless numbers')
    vector = _sequence_cast(list[int | float] | tuple[int | float, ...], coordinates)
    n = _sequence_domain_math.hypot(*vector)
    if n == 0:
        raise ValueError('direction cannot be zero')
    return [vector[0] / n, vector[1] / n]

def _seg_intersect(p1: _sequence_Sequence[float], p2: _sequence_Sequence[float],
                   q1: _sequence_Sequence[float], q2: _sequence_Sequence[float]) -> bool:
    def cross(o: _sequence_Sequence[float], a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    d1, d2 = cross(q1, q2, p1), cross(q1, q2, p2)
    d3, d4 = cross(p1, p2, q1), cross(p1, p2, q2)
    return ((d1 > 0 > d2) or (d1 < 0 < d2)) and ((d3 > 0 > d4) or (d3 < 0 < d4))

def _point_in_poly(p: _sequence_Sequence[float], poly: _sequence_Sequence[_sequence_Sequence[float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > p[1]) != (yj > p[1])) and (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _polys_overlap(a: _sequence_Sequence[_sequence_Sequence[float]], b: _sequence_Sequence[_sequence_Sequence[float]]) -> bool:
    for i in range(len(a)):
        for j in range(len(b)):
            if _seg_intersect(a[i], a[(i + 1) % len(a)], b[j], b[(j + 1) % len(b)]):
                return True
    return any(_point_in_poly(p, b) for p in a) or any(_point_in_poly(p, a) for p in b)

def _point_seg_dist(p: _sequence_Sequence[float], a: _sequence_Sequence[float], b: _sequence_Sequence[float]) -> float:
    ab = [b[0] - a[0], b[1] - a[1]]
    ap = [p[0] - a[0], p[1] - a[1]]
    denom = ab[0] * ab[0] + ab[1] * ab[1]
    t = (ap[0] * ab[0] + ap[1] * ab[1]) / denom if denom else 0.0
    t = max(0.0, min(1.0, t))
    return _sequence_domain_math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]))

def _point_poly_dist(p: _sequence_Sequence[float], poly: _sequence_Sequence[_sequence_Sequence[float]]) -> float:
    inside = _point_in_poly(p, poly)
    d = min(_point_seg_dist(p, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))
    return -d if inside else d

def _poly_dist(a: _sequence_Sequence[_sequence_Sequence[float]], b: _sequence_Sequence[_sequence_Sequence[float]]) -> float:
    return min([_point_poly_dist(p, b) for p in a] + [_point_poly_dist(p, a) for p in b])

def _require_schema(data: "JsonObject") -> int:
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('schemaVersion 1 is required')
    return 1

def _point_to_box_dist(p: _sequence_Sequence[float], minv: _sequence_Sequence[float], maxv: _sequence_Sequence[float]) -> float:
    q = [max(minv[i], min(maxv[i], p[i])) for i in range(3)]
    return _sequence_vnorm(_sequence_vsub(p, q))

def _angle_between(a: _sequence_Sequence[float] | None, b: _sequence_Sequence[float] | None) -> float:
    if a is None or b is None:
        return 0.0
    d = _sequence_vdot(_sequence_vunit(a), _sequence_vunit(b))
    d = max(-1.0, min(1.0, d))
    return _sequence_domain_math.acos(d)
