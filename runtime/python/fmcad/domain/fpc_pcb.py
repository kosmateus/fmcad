"""DTO-only rules extracted from assets/cad/fpc_pcb.py. No SDK or filesystem access."""
import math as _fpc_domain_math


def _polygon_area(poly: "Sequence[Sequence[int | float]]") -> float:
    n = len(poly)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0

def _point_in_polygon(p: "Sequence[int | float]",
                      poly: "Sequence[Sequence[int | float]]") -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if ((yi > p[1]) != (yj > p[1])) and (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _circle_union_area(circles: "Sequence[tuple[Sequence[int | float], int | float]]",
                       budget: "int | float" = 200000) -> float:
    if not circles:
        return 0.0
    xs = [c[0][0] - c[1] for c in circles] + [c[0][0] + c[1] for c in circles]
    ys = [c[0][1] - c[1] for c in circles] + [c[0][1] + c[1] for c in circles]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    width, height = maxx - minx, maxy - miny
    if width == 0 or height == 0:
        return 0.0
    cells = int(_fpc_domain_math.sqrt(budget))
    count = 0
    for i in range(cells):
        x = minx + width * (i + 0.5) / cells
        for j in range(cells):
            y = miny + height * (j + 0.5) / cells
            if any((x - c[0][0]) ** 2 + (y - c[0][1]) ** 2 <= c[1] ** 2 for c in circles):
                count += 1
    return count * (width * height) / (cells * cells)

def _fpc_vsub(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _fpc_vadd(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _fpc_vscale(a: "Sequence[int | float]", s: "int | float") -> "list[int | float]":
    return [x * s for x in a]

def _fpc_vdot(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "int | float":
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _fpc_vcross(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

def _fpc_vnorm(a: "Sequence[int | float]") -> float:
    return _fpc_domain_math.sqrt(_fpc_vdot(a, a))

def _fpc_vunit(a: "Sequence[int | float]") -> "list[float]":
    n = _fpc_vnorm(a)
    if n == 0:
        raise ValueError('Degenerate zero vector')
    return [x / n for x in a]

def _fpc_rotate(v: "Sequence[int | float]", axis: "Sequence[int | float]",
                angle: float) -> "list[int | float]":
    c, s = _fpc_domain_math.cos(angle), _fpc_domain_math.sin(angle)
    axis = _fpc_vunit(axis)
    dot = _fpc_vdot(axis, v)
    return _fpc_vadd(_fpc_vadd(_fpc_vscale(v, c), _fpc_vscale(_fpc_vcross(axis, v), s)),
                     _fpc_vscale(axis, dot * (1 - c)))

_AXES: dict[str, list[float]] = {
    'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0]}
