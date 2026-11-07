"""DTO-only rules extracted from assets/cad/seal.py. No SDK or filesystem access."""
import math as _seal_rules_math

_FRACTIONS = ('squeeze', 'swell', 'stretch', 'fill')

def _seal_fraction(value: object, label: str, maximum: float = 1.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _seal_rules_math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    number = float(value)
    if not 0.0 <= number <= maximum:
        raise ValueError(label + ' must be in [0, ' + str(maximum) + ']')
    return number

_AXIS_DIRECTIONS = {'X': (1.0, 0.0, 0.0), 'Y': (0.0, 1.0, 0.0), 'Z': (0.0, 0.0, 1.0)}

_PLANE_NORMALS = {'XY': (0.0, 0.0, 1.0), 'XZ': (0.0, 1.0, 0.0), 'YZ': (1.0, 0.0, 0.0)}

_E_X = (1.0, 0.0, 0.0)
