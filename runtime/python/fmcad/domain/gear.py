"""SDK-free gear validation and numerical data operations."""
import math as _gear_domain_math
from typing import cast as _gear_cast
from typing import TypedDict as _gear_TypedDict


class _GearGeometryParameters(_gear_TypedDict):
    pressureAngle: float
    addendumCoefficient: float
    profileShift: float
    teeth: int
    base: float
    addendum: float

def _gear_system(data: "JsonObject") -> tuple[str, float, float]:
    system = data.get('system', 'metric')
    if system not in ('metric', 'short'):
        raise ValueError('system must be metric or short; use explicit addendum/dedendum coefficients for other systems')
    if system == 'metric':
        ha, hf = 1.0, 1.25
    else:
        ha, hf = 0.8, 1.0
    if 'addendumCoefficient' in data:
        ha = float(_gear_cast(str | int | float | bool, data['addendumCoefficient']))
    if 'dedendumCoefficient' in data:
        hf = float(_gear_cast(str | int | float | bool, data['dedendumCoefficient']))
    if ha <= 0 or hf <= 0:
        raise ValueError('addendum/dedendum coefficients must be positive')
    return system, ha, hf


def _gear_diameter_plan(m: float, z: int, alpha: float, data: "JsonObject") -> "JsonObject":
    """Numerical diameters after the adapter resolves module/angle expressions."""
    system, ha, hf = _gear_system(data)
    x = float(_gear_cast(str | int | float | bool, data.get('profileShift', 0.0)))
    if m <= 0:
        raise ValueError('module must be positive')
    d = m * z
    db = d * _gear_domain_math.cos(alpha)
    da = m * (z + 2 * ha + 2 * x)
    df = m * (z - 2 * hf + 2 * x)
    if df <= 0:
        raise ValueError('root diameter must be positive; increase teeth or profile shift')
    return {'module': m, 'teeth': z, 'pressureAngle': alpha, 'system': system, 'addendumCoefficient': ha,
            'dedendumCoefficient': hf, 'profileShift': x, 'pitch': d, 'base': db, 'addendum': da, 'root': df}

def _gear_undercut(params: _GearGeometryParameters) -> dict[str, bool | int]:
    alpha, ha, x, z = params['pressureAngle'], params['addendumCoefficient'], params['profileShift'], params['teeth']
    sine = _gear_domain_math.sin(alpha)
    minimum = _gear_domain_math.ceil(2 * (ha - x) / (sine * sine)) if sine > 0 else 1
    return {'undercut': z < minimum, 'minimumTeeth': minimum}

def _gear_sample(params: _GearGeometryParameters, tolerance: float) -> tuple[float, float, float, int, float]:
    rb = params['base'] / 2.0
    ra = params['addendum'] / 2.0
    t_max = _gear_domain_math.sqrt(max((ra / rb) ** 2 - 1.0, 0.0))
    if tolerance <= 0:
        tolerance = 1e-6
    step = _gear_domain_math.sqrt(max(8.0 * tolerance / rb, 1e-12))
    count = max(8, int(_gear_domain_math.ceil(t_max / step)))
    error = rb * (t_max / count) ** 2 / 8.0
    return rb, ra, t_max, count, error

def _gear_flank_points(rb: float, rot: float, t_max: float, count: int,
                       mirror: bool) -> list[list[str]]:
    points: list[list[str]] = []
    for i in range(count + 1):
        t = t_max * i / count
        xu = rb * (_gear_domain_math.cos(t) + t * _gear_domain_math.sin(t))
        yu = rb * (_gear_domain_math.sin(t) - t * _gear_domain_math.cos(t))
        x = xu * _gear_domain_math.cos(rot) - yu * _gear_domain_math.sin(rot)
        y = xu * _gear_domain_math.sin(rot) + yu * _gear_domain_math.cos(rot)
        if mirror:
            y = -y
        points.append([str(x) + ' cm', str(y) + ' cm', '0 mm'])
    return points
