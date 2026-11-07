"""DTO-only rules extracted from assets/cad/interference.py. No SDK or filesystem access."""
def _interference_version(data: "JsonObject") -> None:
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM19 operations require schemaVersion:1 and frame:component')

def _pair_id(a: "JsonValue", b: "JsonValue") -> str:
    return _cad_cast(str, _ref_key(a)) + ':' + _cad_cast(str, _ref_key(b))

def _ref_key(ref: "JsonValue") -> "JsonValue":
    if isinstance(ref, dict):
        return ref.get('token') or ref.get('name') or ref.get('path') or json.dumps(ref, sort_keys=True)
    return str(ref)

def _aabb_overlap(a: "Mapping[str, JsonValue]", b: "Mapping[str, JsonValue]", margin: float = 0.0) -> bool:
    for i in range(3):
        if _cad_cast("Sequence[float]", a['min'])[i] > _cad_cast("Sequence[float]", b['max'])[i] + margin or \
                _cad_cast("Sequence[float]", b['min'])[i] > _cad_cast("Sequence[float]", a['max'])[i] + margin:
            return False
    return True

def _aabb_union(bounds: "Sequence[Mapping[str, JsonValue]]") -> "JsonObject":
    low = [min(_cad_cast("Sequence[float]", b['min'])[i] for b in bounds) for i in range(3)]
    high = [max(_cad_cast("Sequence[float]", b['max'])[i] for b in bounds) for i in range(3)]
    return {'min': low, 'max': high}

_LENGTH_TO_CM = {'mm': 0.1, 'cm': 1.0, 'm': 100.0, 'in': 2.54}


def _envelope_rotate_point(p: "Sequence[float]", axis: "Sequence[float]", angle: float) -> "list[float]":
    c = math.cos(angle)
    s = math.sin(angle)
    x, y, z = p
    ux, uy, uz = axis
    dot = x * ux + y * uy + z * uz
    return [ux * dot * (1 - c) + x * c + (uy * z - uz * y) * s,
            uy * dot * (1 - c) + y * c + (uz * x - ux * z) * s,
            uz * dot * (1 - c) + z * c + (ux * y - uy * x) * s]
