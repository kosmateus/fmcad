"""DTO-only rules extracted from assets/cad/optics.py. No SDK or filesystem access."""
import math as _optics_domain_math


def _optics_vsub(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _optics_vadd(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _optics_vscale(a: "Sequence[int | float]", s: "int | float") -> "list[int | float]":
    return [x * s for x in a]

def _optics_vdot(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "int | float":
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _optics_vcross(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _optics_vnorm(a: "Sequence[int | float]") -> float:
    return _optics_domain_math.sqrt(_optics_vdot(a, a))

def _optics_vunit(a: "Sequence[int | float]") -> "list[float]":
    n = _optics_vnorm(a)
    if n == 0 or not _optics_domain_math.isfinite(n):
        raise ValueError('Direction cannot be zero or non-finite')
    return [x / n for x in a]

def _optics_point2_in_poly(p: "Sequence[int | float]",
                           poly: "Sequence[Sequence[int | float]]") -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > p[1]) != (yj > p[1])) and (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _optics_poly2_area(poly: "Sequence[Sequence[int | float]]") -> float:
    n = len(poly)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0

def _optics_require_schema(data: "JsonObject") -> int:
    if type(data.get('schemaVersion', 1)) is not int or data.get('schemaVersion', 1) != 1:
        raise ValueError('schemaVersion 1 is required')
    return 1


def _optics_rect_corners(origin: "Sequence[int | float]", d: "Sequence[int | float]",
                         h: "Sequence[int | float]", v: "Sequence[int | float]",
                         dist: float, half_h: float, half_v: float) -> "list[list[int | float]]":
    w = dist * _optics_domain_math.tan(half_h)
    ht = dist * _optics_domain_math.tan(half_v)
    center = _optics_vadd(origin, _optics_vscale(d, dist))
    return [
        _optics_vadd(_optics_vadd(center, _optics_vscale(h, -w)), _optics_vscale(v, -ht)),
        _optics_vadd(_optics_vadd(center, _optics_vscale(h, w)), _optics_vscale(v, -ht)),
        _optics_vadd(_optics_vadd(center, _optics_vscale(h, w)), _optics_vscale(v, ht)),
        _optics_vadd(_optics_vadd(center, _optics_vscale(h, -w)), _optics_vscale(v, ht)),
    ]

def _optics_sensor_classify(sensor: "JsonObject", point: "Sequence[int | float]") -> str:
    origin = _cad_cast("Sequence[int | float]", sensor['origin'])
    direction = _cad_cast("Sequence[int | float]", sensor['d'])
    horizontal = _cad_cast("Sequence[int | float]", sensor['h'])
    vertical = _cad_cast("Sequence[int | float]", sensor['v'])
    tan_horizontal = _cad_cast("int | float", sensor['tan_h'])
    tan_vertical = _cad_cast("int | float", sensor['tan_v'])
    near = _cad_cast("int | float", sensor['near'])
    far = _cad_cast("int | float", sensor['far'])
    w = _optics_vsub(point, origin)
    dist = _optics_vnorm(w)
    if dist < 1e-12:
        return 'outside'
    wd = _optics_vdot(w, direction)
    if wd <= 0:
        return 'outside'
    if abs(_optics_vdot(w, horizontal)) / wd > tan_horizontal:
        return 'outside'
    if abs(_optics_vdot(w, vertical)) / wd > tan_vertical:
        return 'outside'
    if dist < near:
        return 'near'
    if dist > far:
        return 'far'
    return 'covered'

def _optics_ray_box(origin: "Sequence[int | float]", d: "Sequence[int | float]",
                    minv: "Sequence[int | float]", maxv: "Sequence[int | float]") -> "float | None":
    tmin, tmax = -_optics_domain_math.inf, _optics_domain_math.inf
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if origin[i] < minv[i] or origin[i] > maxv[i]:
                return None
            continue
        inv = 1.0 / d[i]
        t1 = (minv[i] - origin[i]) * inv
        t2 = (maxv[i] - origin[i]) * inv
        if t1 > t2:
            t1, t2 = t2, t1
        tmin = max(tmin, t1)
        tmax = min(tmax, t2)
    if tmax < 0:
        return None
    entry = tmin if tmin > 0 else 0.0
    return entry if entry <= tmax else None

def _optics_ray_disk(origin: "Sequence[int | float]", d: "Sequence[int | float]",
                     center: "Sequence[int | float]", normal: "Sequence[int | float]",
                     radius: float) -> "float | None":
    denom = _optics_vdot(d, normal)
    if abs(denom) < 1e-12:
        return None
    t = _optics_vdot(_optics_vsub(center, origin), normal) / denom
    if t <= 1e-12:
        return None
    hit = _optics_vadd(origin, _optics_vscale(d, t))
    return t if _optics_vnorm(_optics_vsub(hit, center)) <= radius else None

def _optics_ray_polygon(origin: "Sequence[int | float]", d: "Sequence[int | float]",
                        poly_origin: "Sequence[int | float]", normal: "Sequence[int | float]",
                        u: "Sequence[int | float]",
                        points2: "Sequence[Sequence[int | float]]") -> "float | None":
    denom = _optics_vdot(d, normal)
    if abs(denom) < 1e-12:
        return None
    t = _optics_vdot(_optics_vsub(poly_origin, origin), normal) / denom
    if t <= 1e-12:
        return None
    hit = _optics_vadd(origin, _optics_vscale(d, t))
    v = _optics_vcross(normal, u)
    rel = _optics_vsub(hit, poly_origin)
    return t if _optics_point2_in_poly([_optics_vdot(rel, u), _optics_vdot(rel, v)], points2) else None

def _optics_line_line_distance(p1: "Sequence[int | float]", d1: "Sequence[int | float]",
                               p2: "Sequence[int | float]", d2: "Sequence[int | float]") -> float:
    a = _optics_vdot(d1, d1)
    b = _optics_vdot(d1, d2)
    c = _optics_vdot(d2, d2)
    w0 = _optics_vsub(p1, p2)
    dd = _optics_vdot(d1, w0)
    ee = _optics_vdot(d2, w0)
    denom = a * c - b * b
    if abs(denom) < 1e-12:
        return _optics_vnorm(_optics_vcross(d1, _optics_vsub(p2, p1)))
    s = (b * ee - c * dd) / denom
    t = (a * ee - b * dd) / denom
    return _optics_vnorm(_optics_vsub(_optics_vadd(p1, _optics_vscale(d1, s)), _optics_vadd(p2, _optics_vscale(d2, t))))

def _optics_line_box_intersects(origin: "Sequence[int | float]", d: "Sequence[int | float]",
                                minv: "Sequence[int | float]",
                                maxv: "Sequence[int | float]") -> bool:
    tmin, tmax = 0.0, _optics_domain_math.inf
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if origin[i] < minv[i] or origin[i] > maxv[i]:
                return False
            continue
        inv = 1.0 / d[i]
        t1 = (minv[i] - origin[i]) * inv
        t2 = (maxv[i] - origin[i]) * inv
        if t1 > t2:
            t1, t2 = t2, t1
        tmin = max(tmin, t1)
        tmax = min(tmax, t2)
        if tmin > tmax:
            return False
    return True
