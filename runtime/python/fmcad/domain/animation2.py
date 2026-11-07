"""DTO-only rules extracted from assets/cad/animation2.py. No SDK or filesystem access."""
import math as _anim2_domain_math

_ANIM2_EASINGS = ('linear', 'smoothstep', 'easeIn', 'easeOut', 'easeInOut')

_ANIM2_TRACK_TYPES = ('camera', 'visibility', 'section', 'joint', 'occurrence')

_ANIM2_LIMITS = [
    'The sequence is a deterministic evaluated frame manifest, not a native storyboard action sequence.',
    'Native storyboard action authoring is separate from playback and is never claimed here.',
    'Film export runs the declared encoder on the Fusion machine; no fake video file is produced without one.',
    'Camera/visibility/section values are interpolated or stepped plan data, not a rendered-view equivalence proof.',
]

def _anim2_number(value: object, label: str) -> float:
    if type(value) is int:
        number = float(value)
    elif type(value) is float:
        number = value
    else:
        raise ValueError(label + ' must be a finite number')
    if not _anim2_domain_math.isfinite(number):
        raise ValueError(label + ' must be a finite number')
    return number

def _anim2_seconds(value: object) -> float:
    if isinstance(value, str):
        parts = value.strip().split()
        if len(parts) != 2:
            raise ValueError('duration must be a finite positive number of seconds or "<n> s"/"<n> ms"')
        number, unit = _anim2_number(float(parts[0]), 'duration'), parts[1]
        seconds = number if unit == 's' else number / 1000.0 if unit == 'ms' else None
        if seconds is None:
            raise ValueError('duration unit must be s or ms')
    else:
        seconds = _anim2_number(value, 'duration')
    if seconds <= 0:
        raise ValueError('duration must be positive')
    return seconds

def _anim2_direction(value: object) -> "list[float]":
    if not isinstance(value, (list, tuple)):
        raise ValueError('axis must be three finite unitless numbers')
    components = _cad_cast("Sequence[object]", value)
    if len(components) != 3 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or
                                   not _anim2_domain_math.isfinite(x) for x in components):
        raise ValueError('axis must be three finite unitless numbers')
    numeric = [_cad_cast("int | float", x) for x in components]
    norm = _anim2_domain_math.hypot(*numeric)
    if norm == 0:
        raise ValueError('axis cannot be zero')
    return [x / norm for x in numeric]

def _anim2_ease(name: str, t: float) -> float:
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
    raise ValueError('easing must be one of: ' + ', '.join(_ANIM2_EASINGS))

def _anim2_version(data: "JsonObject") -> None:
    if data.get('schemaVersion') != 1:
        raise ValueError('GM36 animation operations require schemaVersion:1')

def _anim2_lerp(a: "Sequence[float]", b: "Sequence[float]", t: float) -> "list[float]":
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]

def _anim2_phases(data: "JsonObject") -> "list[str]":
    phases_value = data.get('phases', [])
    if not isinstance(phases_value, list):
        raise ValueError('phases must be an array of names')
    phases = _cad_cast("Sequence[JsonValue]", phases_value)
    names: list[str] = []
    for phase in phases:
        if not isinstance(phase, str) or not phase.strip():
            raise ValueError('phases entries must be nonempty names')
        if phase in names:
            raise ValueError('duplicate phase name: ' + phase)
        names.append(phase)
    return names if names else ['sequence']

def _anim2_timing(duration: float, fps: int, phase_names: "Sequence[str]") -> "tuple[int, float, list[JsonRecord]]":
    frame_count = int(_anim2_domain_math.floor(duration * fps)) + 1
    if frame_count < 2:
        raise ValueError('duration * fps must span at least one frame interval')
    phase_span = duration / len(phase_names)
    schedule: list[JsonRecord] = [{'name': name, 'startTime': round(i * phase_span, 9),
                 'endTime': round((i + 1) * phase_span, 9),
                 'frameStart': int(i * phase_span * fps),
                 'frameEnd': min(frame_count - 1, int(_anim2_domain_math.ceil((i + 1) * phase_span * fps)))}
                for i, name in enumerate(phase_names)]
    return frame_count, phase_span, schedule

def _anim2_range(value: object, label: str) -> "JsonObject":
    if not isinstance(value, dict) or 'from' not in value or 'to' not in value:
        raise ValueError(label + ' requires from and to expressions')
    return _cad_cast("JsonObject", value)

def _anim2_ref_key(ref: object) -> str:
    if isinstance(ref, dict):
        reference = _cad_cast("JsonObject", ref)
        token = reference.get('token')
        name = reference.get('name')
        return _cad_cast(str, token or name or str(reference))
    return str(ref)
