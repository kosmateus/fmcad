"""SDK-free spring validation and numerical data operations."""
import math as _spring_domain_math
import re as _spring_domain_re
from collections.abc import Sequence as _spring_Sequence
from typing import TypedDict as _spring_TypedDict


class _SpringParameters(_spring_TypedDict):
    hand: str
    turns: float
    startPhase: float
    radius: float
    pitch: float
    height: float


_SpringFrame = tuple[_spring_Sequence[float],
                     tuple[_spring_Sequence[float], _spring_Sequence[float], _spring_Sequence[float]]]


class _SpringMetrics(_spring_TypedDict):
    turnLength: float
    arcLength: float
    curvature: float
    curvatureRadius: float | None


def _spring_number(value: object, label: str, minimum: float | None = None,
                   integer: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(label + ' must be a finite number')
    number = float(value)
    if not _spring_domain_math.isfinite(number):
        raise ValueError(label + ' must be finite')
    if integer and number != int(number):
        raise ValueError(label + ' must be an integer')
    if minimum is not None and number < minimum:
        raise ValueError(label + ' must be at least ' + str(minimum))
    return number

def _spring_measure(value: object, table: dict[str, float], label: str,
                    default: float | None = None) -> float:
    if default is not None and value is None:
        return default
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if not _spring_domain_math.isfinite(number):
            raise ValueError(label + ' must be finite')
        return number
    if not isinstance(value, str) or not value.strip():
        raise ValueError(label + ' must be a unit-bearing quantity or number')
    match = _spring_domain_re.match(r'^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z0-9/_^]+)$', value.strip())
    if not match:
        raise ValueError(label + ' cannot be parsed as a quantity: ' + value)
    number, unit = float(match.group(1)), match.group(2)
    if unit not in table:
        raise ValueError(label + ' has an unsupported unit: ' + unit)
    return number * table[unit]

def _helix_samples(params: _SpringParameters,
                   samples_per_turn: int = 16) -> list[tuple[float, float, float]]:
    direction = 1.0 if params['hand'] == 'right' else -1.0
    count = max(4, int(round(params['turns'] * samples_per_turn)))
    points: list[tuple[float, float, float]] = []
    for i in range(count + 1):
        t = params['turns'] * i / count
        angle = params['startPhase'] + direction * 2.0 * _spring_domain_math.pi * t
        points.append((params['radius'] * _spring_domain_math.cos(angle),
                       params['radius'] * _spring_domain_math.sin(angle),
                       params['pitch'] * t))
    return points

def _helix_metrics(params: _SpringParameters) -> _SpringMetrics:
    turn_length = _spring_domain_math.hypot(params['pitch'], 2.0 * _spring_domain_math.pi * params['radius'])
    arc_length = turn_length * params['turns']
    curvature = params['radius'] / (params['radius'] ** 2 + (params['pitch'] / (2.0 * _spring_domain_math.pi)) ** 2)
    return {'turnLength': turn_length, 'arcLength': arc_length,
            'curvature': curvature, 'curvatureRadius': 1.0 / curvature if curvature else None}

def _helix_world_points(params: _SpringParameters, frame: _SpringFrame) -> list[list[float]]:
    origin, (ux, uy, uz) = frame
    world: list[list[float]] = []
    for x, y, z in _helix_samples(params):
        world.append([origin[0] + ux[0] * x + uy[0] * y + uz[0] * z,
                      origin[1] + ux[1] * x + uy[1] * y + uz[1] * z,
                      origin[2] + ux[2] * x + uy[2] * y + uz[2] * z])
    return world
