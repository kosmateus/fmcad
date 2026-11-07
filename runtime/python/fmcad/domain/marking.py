"""DTO-only rules extracted from assets/cad/marking.py. No SDK or filesystem access."""
import math as _marking_domain_math


_MARK_KINDS = ('text', 'symbol', 'arrow')

_REPRESENTATIONS = ('annotation', 'emboss', 'engrave')

_PROTECTED_ZONES = ('optical', 'seal', 'a-surface')

_MARKING_ZONE_KINDS = ('optical', 'seal', 'a-surface', 'fit', 'custom')

_MARKING_SOURCE_STATUSES = ('CONFIRMED', 'ESTIMATED', 'OPEN')

def _marking_vsub(a: "Sequence[float]", b: "Sequence[float]") -> "list[float]":
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

def _marking_vdot(a: "Sequence[float]", b: "Sequence[float]") -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def _marking_vnorm(a: "Sequence[float]") -> float:
    return _marking_domain_math.sqrt(_marking_vdot(a, a))

def _marking_deg(rad: float) -> float:
    return rad * 180.0 / _marking_domain_math.pi

def _marking_box_overlap(a: "JsonObject", b: "JsonObject") -> bool:
    a_min = _cad_cast("Sequence[float]", a['min'])
    a_max = _cad_cast("Sequence[float]", a['max'])
    b_min = _cad_cast("Sequence[float]", b['min'])
    b_max = _cad_cast("Sequence[float]", b['max'])
    return all(a_min[i] <= b_max[i] and b_min[i] <= a_max[i] for i in range(3))

_MARKING_LIMITATIONS = [
    'User text/symbol content is preserved verbatim; no translation is applied.',
    'Native emboss/engrave geometry authoring is gated and reported as notEvaluated, never silently replaced by an image.',
    'Occupancy is an axis-aligned box from declared dimensions; text advance width and real glyph extents are not measured.',
    'MIN/MAX derivation and arrow/flow matching are verified against declared levels and flows, not a solver result.']

def _occupancy(mark: "JsonObject") -> "JsonRecord":
    width = _cad_cast(float, mark['width'])
    height = _cad_cast(float, mark['height'])
    depth = _cad_cast("float | None", mark['depth'])
    stroke = _cad_cast(float, mark['stroke'])
    pos = _cad_cast("Sequence[float]", mark['position'])
    half_width = width / 2.0
    half_height = height / 2.0
    half_depth = ((depth if depth is not None else stroke) or 0.0) / 2.0
    return {'min': [pos[0] - half_width, pos[1] - half_height, pos[2] - half_depth],
            'max': [pos[0] + half_width, pos[1] + half_height, pos[2] + half_depth],
            'size': [width, height, (depth if depth is not None else stroke) or 0.0],
            'units': 'cm'}
