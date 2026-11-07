"""Geometry curve: domain; retained cad-v1 shared namespace."""
import math as _geometry_curve_math


def _curve_distance(a: list[float] | tuple[float, ...], b: list[float] | tuple[float, ...]) -> float:
    return _geometry_curve_math.sqrt(sum((x-y)**2 for x, y in zip(a, b)))


def _curve_segment_distance(p: list[float] | tuple[float, ...],
                           a: list[float] | tuple[float, ...],
                           b: list[float] | tuple[float, ...]) -> float:
    delta = [y-x for x, y in zip(a, b)]
    norm = sum(x*x for x in delta)
    t = max(0, min(1, sum((x-y)*z for x, y, z in zip(p, a, delta))/norm)) if norm else 0
    return _curve_distance(p, [x+t*y for x, y in zip(a, delta)])
