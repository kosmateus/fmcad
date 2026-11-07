"""DTO-only rules extracted from assets/cad/explode.py. No SDK or filesystem access."""
import math as _explode_domain_math

_EXPLODE_EASINGS = ('linear', 'smoothstep', 'easeIn', 'easeOut', 'easeInOut')

_EXPLODE_LIMITS = [
    'Explosion poses are deterministic interpolations of occurrence transforms; they are not a continuous collision or service-path proof.',
    'Instances are moved, never loose body copies; a moving parent occurrence carries its nested content natively.',
    'Native storyboard action authoring is separate from playback; these frames do not create a native action sequence.',
    'Restoration is not rollback; a restore failure is reported separately and the original error is preserved.',
]

def _explode_number(value: object, label: str) -> float:
    if type(value) is int:
        number = float(value)
    elif type(value) is float:
        number = value
    else:
        raise ValueError(label + ' must be a finite number')
    if not _explode_domain_math.isfinite(number):
        raise ValueError(label + ' must be a finite number')
    return number

def _explode_seconds(value: object) -> float:
    if isinstance(value, str):
        parts = value.strip().split()
        if len(parts) != 2:
            raise ValueError('duration must be a finite positive number of seconds or "<n> s"/"<n> ms"')
        number, unit = _explode_number(float(parts[0]), 'duration'), parts[1]
        seconds = number if unit == 's' else number / 1000.0 if unit == 'ms' else None
        if seconds is None:
            raise ValueError('duration unit must be s or ms')
    else:
        seconds = _explode_number(value, 'duration')
    if seconds <= 0:
        raise ValueError('duration must be positive')
    return seconds

def _explode_direction(value: object) -> "list[float]":
    if not isinstance(value, (list, tuple)):
        raise ValueError('axis must be three finite unitless numbers')
    components = _cad_cast("Sequence[object]", value)
    if len(components) != 3 or any(isinstance(component, bool) or not isinstance(component, (int, float)) or
           not _explode_domain_math.isfinite(component)
           for component in components):
        raise ValueError('axis must be three finite unitless numbers')
    numeric_components = [_cad_cast("int | float", component) for component in components]
    norm = _explode_domain_math.hypot(*numeric_components)
    if norm == 0:
        raise ValueError('axis cannot be zero')
    return [component / norm for component in numeric_components]

def _explode_ease(name: str, t: float) -> float:
    if name == 'linear':
        return t
    if name == 'smoothstep':
        return t * t * (3 - 2 * t)
    if name == 'easeIn':
        return t * t
    if name == 'easeOut':
        return 1 - (1 - t) * (1 - t)
    if name == 'easeInOut':
        return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2
    raise ValueError('easing must be one of: ' + ', '.join(_EXPLODE_EASINGS))

def _explode_version(data: "JsonObject") -> None:
    if data.get('schemaVersion') != 1:
        raise ValueError('GM36 explode operations require schemaVersion:1')

def _explode_ref_key(ref: object) -> "JsonValue":
    if isinstance(ref, dict):
        reference = _cad_cast("JsonObject", ref)
        token = reference.get('token')
        name = reference.get('name')
        return token or name or str(reference)
    return str(ref)
