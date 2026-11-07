"""Geometry surface: domain; retained cad-v1 shared namespace."""
import math as _geometry_surface_math


_SURFACE_LIMITS = [
    'Native acceptance pending; kernel feasibility is not proven by this contract.',
    'Continuity labels requested at creation are conditions, not measurements; surface.check measures seams separately.',
    'No automatic retry, rollback, styling inference or implicit solid substitution.',
]


_SURFACE_EXTEND_ENUM = {'natural': 'NaturalSurfaceExtendType',
                        'tangent': 'TangentSurfaceExtendType',
                        'perpendicular': 'PerpendicularSurfaceExtendType'}


def _surface_g2_deviation(max_curv_a: float, min_curv_a: float,
                          max_curv_b: float, min_curv_b: float) -> float:
    """Numeric G2 deviation from principal curvature values (1/cm).

    Value-based, not direction-based: for planar/zero-curvature faces the
    principal direction vectors are undefined (zero), so a tensor comparison
    built from those directions would be non-finite. Comparing the principal
    curvature magnitudes stays numeric for planar-planar seams (both zero →
    deviation 0).
    """
    d1 = float(max_curv_a) - float(max_curv_b)
    d2 = float(min_curv_a) - float(min_curv_b)
    if not (_geometry_surface_math.isfinite(d1) and _geometry_surface_math.isfinite(d2)):
        raise ValueError('Surface getCurvature returned non-finite curvature values')
    return max(abs(d1), abs(d2))
