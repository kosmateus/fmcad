"""DTO-only rules extracted from assets/cad/containment.py. No SDK or filesystem access."""
def _containment_vsub(a: "Sequence[float]", b: "Sequence[float]") -> "list[float]":
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _containment_vdot(a: "Sequence[float]", b: "Sequence[float]") -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _containment_vnorm(a: "Sequence[float]") -> float:
    return math.sqrt(_containment_vdot(a, a))

def _containment_vunit(a: "Sequence[float]") -> "list[float]":
    n = _containment_vnorm(a)
    if n == 0 or not math.isfinite(n):
        raise ValueError('Direction cannot be zero')
    return [x / n for x in a]

def _containment_vscale(a: "Sequence[float]", s: float) -> "list[float]":
    return [x * s for x in a]

def _containment_vadd(a: "Sequence[float]", b: "Sequence[float]") -> "list[float]":
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

def _region_field(data: "JsonObject", key: str, dimension: str = 'length') -> "JsonValue":
    if key not in data:
        raise ValueError('region %s requires %s' % (data.get('type'), key))
    return data[key]

def _signed_cylinder(origin: "Sequence[float]", direction: "Sequence[float]", radius: float, height: float, p: "Sequence[float]") -> float:
    """Signed distance to a capped cylinder: positive inside."""
    q = _containment_vsub(p, origin)
    a = _containment_vdot(q, direction)
    radial_vec = _containment_vsub(q, _containment_vscale(direction, a))
    radial = _containment_vnorm(radial_vec)
    if radial <= radius and 0.0 <= a <= height:
        return min(radius - radial, a, height - a)
    d_radial = max(radial - radius, 0.0)
    d_axial = max(-a, a - height, 0.0)
    if radial <= radius:
        return -d_axial
    if 0.0 <= a <= height:
        return -d_radial
    return -math.hypot(d_radial, d_axial)

def _signed_box(minv: "Sequence[float]", maxv: "Sequence[float]", p: "Sequence[float]") -> float:
    inside = all(minv[i] <= p[i] <= maxv[i] for i in range(3))
    if inside:
        return min(min(p[i] - minv[i], maxv[i] - p[i]) for i in range(3))
    d = 0.0
    for i in range(3):
        d += (minv[i] - p[i]) ** 2 if p[i] < minv[i] else (p[i] - maxv[i]) ** 2 if p[i] > maxv[i] else 0.0
    return -math.sqrt(d)

def _signed_sphere(center: "Sequence[float]", radius: float, p: "Sequence[float]") -> float:
    return radius - _containment_vnorm(_containment_vsub(p, center))

def _region_kind(region: "JsonValue") -> "JsonValue":
    return region.get('type') if isinstance(region, dict) else 'body'

def _classify(distance: float, tolerance: float) -> "Literal['error', 'inside', 'outside', 'boundary']":
    if not math.isfinite(distance):
        return 'error'
    if distance > tolerance:
        return 'inside'
    if distance < -tolerance:
        return 'outside'
    return 'boundary'

def _polyline_distance(points: "Sequence[Sequence[float]]", p: "Sequence[float]") -> float:
    best: float | None = None
    for a, b in zip(points, points[1:]):
        ab = _containment_vsub(b, a)
        ap = _containment_vsub(p, a)
        length = _containment_vnorm(ab)
        t = 0.0 if length == 0 else max(0.0, min(1.0, _containment_vdot(ap, ab) / (length * length)))
        closest = _containment_vadd(a, _containment_vscale(ab, t))
        d = _containment_vnorm(_containment_vsub(p, closest))
        if best is None or d < best:
            best = d
    return best if best is not None else _containment_vnorm(_containment_vsub(points[0], p))

def _containment_point_at_station(centerline: "Sequence[Sequence[float]]", arc_lengths: "Sequence[float]", station: float) -> "Sequence[float]":
    for i in range(len(centerline) - 1):
        if arc_lengths[i + 1] >= station:
            span = arc_lengths[i + 1] - arc_lengths[i]
            t = 0.0 if span == 0 else (station - arc_lengths[i]) / span
            return _containment_vadd(centerline[i], _containment_vscale(_containment_vsub(centerline[i + 1], centerline[i]), t))
    return centerline[-1]

def _containment_circle_union_area(circles: "Sequence[tuple[Sequence[float], float]]", budget: int = 200000) -> float:
    """Deterministic grid estimate of the union area of (center, radius) circles."""
    if not circles:
        return 0.0
    xs = [c[0][0] - c[1] for c in circles] + [c[0][0] + c[1] for c in circles]
    ys = [c[0][1] - c[1] for c in circles] + [c[0][1] + c[1] for c in circles]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    width, height = maxx - minx, maxy - miny
    if width == 0 or height == 0:
        return 0.0
    cells = int(math.sqrt(budget))
    count = 0
    for i in range(cells):
        x = minx + width * (i + 0.5) / cells
        for j in range(cells):
            y = miny + height * (j + 0.5) / cells
            if any((x - c[0][0]) ** 2 + (y - c[0][1]) ** 2 <= c[1] ** 2 for c in circles):
                count += 1
    return count * (width * height) / (cells * cells)
