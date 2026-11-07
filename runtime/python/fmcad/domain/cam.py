"""DTO-only rules extracted from assets/cad/cam.py. No SDK or filesystem access."""
import math as _cam_domain_math

def _interpolate(xs: "Sequence[float]", ys: "Sequence[float]", x: float) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    for i in range(len(xs) - 1):
        if xs[i] <= x <= xs[i + 1]:
            t = (x - xs[i]) / (xs[i + 1] - xs[i])
            return ys[i] + t * (ys[i + 1] - ys[i])
    return ys[-1]

def _cam_normal(r: float, rp: float, theta: float) -> "list[float]":
    """Unit outward normal of the pitch curve at angle theta (CCW cam)."""
    tangent = [rp * _cam_domain_math.cos(theta) - r * _cam_domain_math.sin(theta),
               rp * _cam_domain_math.sin(theta) + r * _cam_domain_math.cos(theta)]
    norm = _cam_domain_math.hypot(*tangent)
    tangent = [t / norm for t in tangent]
    # CCW curve: outward normal is tangent rotated -90 degrees.
    return [tangent[1], -tangent[0]]
