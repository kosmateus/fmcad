"""SDK-free fastener validation and numerical data operations."""
import math as _fastener_domain_math
import re as _fastener_domain_re
from typing import TypedDict as _fastener_TypedDict


class _LocatingHole(_fastener_TypedDict):
    x: "JsonValue"
    y: "JsonValue"
    diameter: float
    clearance: float

def _num(value: object, label: str, minimum: float | None = None, integer: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _fastener_domain_math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    number = float(value)
    if integer and number != int(number):
        raise ValueError(label + ' must be an integer')
    if minimum is not None and number < minimum:
        raise ValueError(label + ' must be at least ' + str(minimum))
    return number

def _locating_dof(scheme: str, holes: list[_LocatingHole],
                  tight_threshold_mm: float) -> tuple[int, bool, int]:
    """Return constrained in-plane DOF and an over-constraint verdict."""
    tight = [h for h in holes if h['clearance'] <= tight_threshold_mm]
    if scheme == 'pin-slot':
        dof = 3
        over = len(tight) > 2
    elif scheme == 'two-pin':
        dof = 4
        over = True
    elif scheme == '2-2-2':
        dof = 3
        over = len(tight) > 2
    else:
        raise ValueError('scheme must be pin-slot, two-pin or 2-2-2')
    return dof, over, len(tight)

def _pressure_mpa(value: object) -> float:
    table = {'Pa': 1e-6, 'kPa': 1e-3, 'MPa': 1.0, 'GPa': 1e3,
             'N/mm^2': 1.0, 'N/mm2': 1.0, 'N/m^2': 1e-6, 'psi': 0.006894757293168, 'ksi': 6.894757293168}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError('material modulus/yield require a unit-bearing pressure quantity')
    match = _fastener_domain_re.match(r'^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z0-9/_^]+)$', value.strip())
    if not match:
        raise ValueError('cannot parse pressure quantity: ' + value)
    number, unit = float(match.group(1)), match.group(2)
    if unit not in table:
        raise ValueError('unsupported pressure unit: ' + unit)
    return number * table[unit]

def _barb_profile_points(bore: float, crests: list[float], roots: list[float],
                         lengths: list[float], tube_od: float) -> list[tuple[float, float]]:
    """Closed polyline in (x, y) mm for revolve about X (hose axis)."""
    points = [(0.0, bore / 2.0), (0.0, crests[0] / 2.0)]
    x = 0.0
    for i in range(len(crests)):
        x += lengths[i]
        points.append((x, crests[i] / 2.0))
        points.append((x, roots[i] / 2.0))
        if i < len(crests) - 1:
            points.append((x, crests[i + 1] / 2.0))
    points.append((x, tube_od / 2.0))
    tail = x + lengths[-1]
    points.append((tail, tube_od / 2.0))
    points.append((tail, bore / 2.0))
    cleaned = [points[0]]
    for p in points[1:]:
        if _fastener_domain_math.hypot(p[0] - cleaned[-1][0], p[1] - cleaned[-1][1]) > 1e-9:
            cleaned.append(p)
    if _fastener_domain_math.hypot(cleaned[-1][0] - cleaned[0][0], cleaned[-1][1] - cleaned[0][1]) > 1e-9:
        cleaned.append(cleaned[0])
    return cleaned
