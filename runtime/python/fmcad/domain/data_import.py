"""DTO-only rules extracted from assets/cad/data_import.py. No SDK or filesystem access."""
import math as _di_math

_DI_GROUP = 'fmcad.dataImport.v1'

def _di_eye() -> "list[int | float]":
    return [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]

def _di_mul(a: "Sequence[int | float]", b: "Sequence[int | float]") -> "list[int | float]":
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]

def _di_inverse(a: "Sequence[int | float]") -> "list[int | float]":
    b = _di_eye()
    for r in range(3):
        for c in range(3):
            b[r * 4 + c] = a[c * 4 + r]
        b[r * 4 + 3] = -sum(a[c * 4 + r] * a[c * 4 + 3] for c in range(3))
    return b

def _di_rigid(value: "Sequence[object]") -> "list[int | float]":
    if not isinstance(value, list) or len(value) != 16:
        raise ValueError('Transform requires 16 finite numbers')
    a: list[int | float] = []
    for coordinate in value:
        if type(coordinate) is int:
            number: int | float = coordinate
        elif type(coordinate) is float:
            number = coordinate
        else:
            raise ValueError('Transform requires 16 finite numbers')
        if not _di_math.isfinite(number):
            raise ValueError('Transform requires 16 finite numbers')
        a.append(number)
    if any(abs(a[12 + i] - (1 if i == 3 else 0)) > 1e-9 for i in range(4)):
        raise ValueError('Invalid homogeneous row')
    for r in range(3):
        for c in range(3):
            if abs(sum(a[k * 4 + r] * a[k * 4 + c] for k in range(3)) - (1 if r == c else 0)) > 1e-9:
                raise ValueError('Scaling/shear is not supported')
    det = a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) + a[2] * (a[4] * a[9] - a[5] * a[8])
    if abs(det - 1) > 1e-9:
        raise ValueError('Reflection/handedness reversal is not supported')
    return a

def _di_same(a: "Sequence[int | float]", b: "Sequence[int | float]",
             tolerance: float = 1e-8) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b))

def _di_metadata(plan: "Mapping[str, object]", **values: "JsonValue") -> "JsonRecord":
    owner, revision, digest = plan['owner'], plan['revision'], plan['digest']
    if owner is not None and not isinstance(owner, str):
        raise ValueError('Import owner must be text or null')
    if revision is not None and not isinstance(revision, str):
        raise ValueError('Import revision must be text or null')
    if not isinstance(digest, str):
        raise ValueError('Import digest must be text')
    result: JsonRecord = {'owner': owner, 'revision': revision, 'digest': digest}
    result.update(values)
    return result
