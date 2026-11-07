"""SDK-free route3d validation and numerical data operations."""
import math as _route3d_domain_math
from collections.abc import Sequence as _route3d_Sequence

def _route3d_vsub(a: _route3d_Sequence[float], b: _route3d_Sequence[float]) -> list[float]:
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _route3d_vadd(a: _route3d_Sequence[float], b: _route3d_Sequence[float]) -> list[float]:
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _route3d_vscale(a: _route3d_Sequence[float], s: float) -> list[float]:
    return [x * s for x in a]

def _route3d_vdot(a: _route3d_Sequence[float], b: _route3d_Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _route3d_vcross(a: _route3d_Sequence[float], b: _route3d_Sequence[float]) -> list[float]:
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _route3d_vnorm(a: _route3d_Sequence[float]) -> float:
    return _route3d_domain_math.sqrt(_route3d_vdot(a, a))

def _route3d_vunit(a: _route3d_Sequence[float]) -> list[float]:
    n = _route3d_vnorm(a)
    if n == 0 or not _route3d_domain_math.isfinite(n):
        raise ValueError('Degenerate zero-length tangent')
    return [x / n for x in a]

def _catmull_rom(p0: _route3d_Sequence[float], p1: _route3d_Sequence[float],
                 p2: _route3d_Sequence[float], p3: _route3d_Sequence[float], t: float) -> list[float]:
    t2, t3 = t * t, t * t * t
    return [0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
                   (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3) for i in range(3)]

def _sample_centerline(waypoints: list[list[float]], samples_per_segment: int = 20,
                       interpolation: str = 'spline') -> list[list[float]]:
    if interpolation == 'polyline':
        return [list(p) for p in waypoints]
    points: list[list[float]] = []
    for i in range(len(waypoints) - 1):
        p0 = waypoints[max(i - 1, 0)]
        p1 = waypoints[i]
        p2 = waypoints[i + 1]
        p3 = waypoints[min(i + 2, len(waypoints) - 1)]
        for s in range(samples_per_segment):
            points.append(_catmull_rom(p0, p1, p2, p3, s / samples_per_segment))
    points.append(list(waypoints[-1]))
    return points

def _arc_length(points: _route3d_Sequence[_route3d_Sequence[float]]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += _route3d_vnorm(_route3d_vsub(b, a))
    return total

def _circumradius(a: _route3d_Sequence[float], b: _route3d_Sequence[float], c: _route3d_Sequence[float]) -> float:
    ab = _route3d_vnorm(_route3d_vsub(b, a))
    bc = _route3d_vnorm(_route3d_vsub(c, b))
    ca = _route3d_vnorm(_route3d_vsub(a, c))
    area = 0.5 * _route3d_vnorm(_route3d_vcross(_route3d_vsub(b, a), _route3d_vsub(c, a)))
    if area == 0:
        return _route3d_domain_math.inf
    return (ab * bc * ca) / (4.0 * area)

def _bend_radii(points: _route3d_Sequence[_route3d_Sequence[float]]) -> list[float]:
    radii: list[float] = []
    for i in range(1, len(points) - 1):
        radii.append(_circumradius(points[i - 1], points[i], points[i + 1]))
    return radii

def _transport_frames(points: _route3d_Sequence[_route3d_Sequence[float]], up: _route3d_Sequence[float]) -> list[dict[str, list[float]]]:
    frames: list[dict[str, list[float]]] = []
    up = _route3d_vunit(up)
    for i, point in enumerate(points):
        if i < len(points) - 1:
            tangent = _route3d_vunit(_route3d_vsub(points[i + 1], points[i]))
        else:
            tangent = _route3d_vunit(_route3d_vsub(points[i], points[i - 1]))
        parallel = _route3d_vdot(tangent, up)
        if abs(parallel) > 1.0 - 1e-6:
            continue
        normal = _route3d_vunit(_route3d_vsub(up, _route3d_vscale(tangent, parallel)))
        binormal = _route3d_vcross(tangent, normal)
        frames.append({'position': list(point), 'tangent': tangent, 'normal': normal, 'binormal': binormal})
    return frames

def _segment_distance(a: _route3d_Sequence[float], b: _route3d_Sequence[float],
                      c: _route3d_Sequence[float], d: _route3d_Sequence[float]) -> float:
    ab = _route3d_vsub(b, a)
    cd = _route3d_vsub(d, c)
    r = _route3d_vsub(a, c)
    denom = _route3d_vdot(ab, ab) * _route3d_vdot(cd, cd) - _route3d_vdot(ab, cd) ** 2
    if denom > 1e-12:
        s = (_route3d_vdot(ab, cd) * _route3d_vdot(r, cd) - _route3d_vdot(cd, cd) * _route3d_vdot(r, ab)) / denom
        s = max(0.0, min(1.0, s))
    else:
        s = 0.0
    t = (_route3d_vdot(ab, cd) * s + _route3d_vdot(r, cd)) / _route3d_vdot(cd, cd) if _route3d_vdot(cd, cd) > 1e-12 else 0.0
    t = max(0.0, min(1.0, t))
    pa = _route3d_vadd(a, _route3d_vscale(ab, s))
    pc = _route3d_vadd(c, _route3d_vscale(cd, t))
    return _route3d_vnorm(_route3d_vsub(pa, pc))

def _point_at_station(points: _route3d_Sequence[_route3d_Sequence[float]], station: float) -> list[float]:
    walked = 0.0
    for i in range(len(points) - 1):
        segment = _route3d_vnorm(_route3d_vsub(points[i + 1], points[i]))
        if walked + segment >= station:
            t = 0.0 if segment == 0 else (station - walked) / segment
            return _route3d_vadd(points[i], _route3d_vscale(_route3d_vsub(points[i + 1], points[i]), t))
        walked += segment
    return list(points[-1])

def _route_self_contact(centerline: _route3d_Sequence[_route3d_Sequence[float]]) -> float:
    best = _route3d_domain_math.inf
    n = len(centerline)
    for i in range(n - 1):
        for j in range(i + 2, n - 1):
            d = _segment_distance(centerline[i], centerline[i + 1], centerline[j], centerline[j + 1])
            if d < best:
                best = d
    return best

def _to_mm(value_cm: float) -> float:
    return value_cm * 10.0

def _pose_required_radius(length: float, pan: float, tilt: float) -> float:
    sweep = abs(pan) + abs(tilt)
    if sweep < 1e-9:
        return _route3d_domain_math.inf
    return length / sweep
