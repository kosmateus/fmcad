"""DTO-only rules extracted from assets/cad/dfm.py. No SDK or filesystem access."""
def _dfm_deg(rad: float) -> float:
    return rad * 180.0 / math.pi


def _dfm_vsub(a: "Sequence[float]", b: "Sequence[float]") -> "list[float]":
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _dfm_vdot(a: "Sequence[float]", b: "Sequence[float]") -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _dfm_vnorm(a: "Sequence[float]") -> float:
    return math.sqrt(_dfm_vdot(a, a))

_ZONE_KINDS = {'a-surface', 'fit', 'seal', 'optical', 'parting', 'gate', 'ejector', 'weld', 'custom'}

_PROTECTED_DEFAULT = {'a-surface', 'seal', 'optical'}
