"""SDK-free thread validation and numerical data operations."""
import math as _thread_domain_math
from typing import TypedDict as _thread_TypedDict, cast as _thread_cast


class _ThreadProfile(_thread_TypedDict):
    majorDiameter: float
    minorDiameter: float
    pitchDiameter: float
    pitch: float
    starts: float | None
    lead: float | None
    hand: str
    depth: float
    turnsPerLength: float | None
    flankAngle: float
    rootShape: str
    length: float | None
    runout: float
    clearance: float


def _thread_profile_fields(spec: object, label: str) -> None:
    if not isinstance(spec, dict):
        raise ValueError(label + ' must be an object')
    spec = _thread_cast(dict[str, object], spec)
    unknown = set(spec) - {'majorDiameter', 'minorDiameter', 'pitchDiameter', 'pitch', 'starts',
                           'hand', 'flankAngle', 'rootShape', 'length', 'runout', 'clearance'}
    if unknown:
        raise ValueError(label + ' has unsupported fields: ' + ', '.join(sorted(unknown)))
    if 'majorDiameter' not in spec or 'pitch' not in spec:
        raise ValueError(label + ' requires majorDiameter and pitch')


def _thread_lead(major: float, pitch: float, starts: object,
                 label: str) -> tuple[float | None, float | None]:
    if major <= 0 or pitch <= 0:
        raise ValueError(label + ' majorDiameter and pitch must be positive')
    # Missing starts is unresolved, not an implicit single-start thread.
    if starts is None:
        return None, None
    starts = _thread_number(starts, label + ' starts', minimum=1, integer=True)
    return starts, starts * pitch

def _thread_number(value: object, label: str, minimum: float | None = None,
                   integer: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(label + ' must be a finite number')
    number = float(value)
    if not _thread_domain_math.isfinite(number):
        raise ValueError(label + ' must be finite')
    if integer and number != int(number):
        raise ValueError(label + ' must be an integer')
    if minimum is not None and number < minimum:
        raise ValueError(label + ' must be at least ' + str(minimum))
    return number

def _thread_profile_out(profile: _ThreadProfile) -> "JsonObject":
    def quantity(value: float, units: str) -> "JsonObject":
        return {'value': value, 'units': units}
    return {'majorDiameter': quantity(profile['majorDiameter'], 'mm'),
            'minorDiameter': quantity(profile['minorDiameter'], 'mm'),
            'pitchDiameter': quantity(profile['pitchDiameter'], 'mm'),
            'pitch': quantity(profile['pitch'], 'mm'),
            'starts': profile['starts'],
            'lead': quantity(profile['lead'], 'mm') if profile['lead'] is not None else None,
            'hand': profile['hand'], 'depth': quantity(profile['depth'], 'mm'),
            'turnsPerLength': quantity(profile['turnsPerLength'], '1/mm') if profile['turnsPerLength'] is not None else None,
            'flankAngle': {'value': profile['flankAngle'], 'units': 'rad'},
            'rootShape': profile['rootShape'],
            'length': quantity(profile['length'], 'mm') if profile['length'] is not None else None,
            'runout': quantity(profile['runout'], 'mm'),
            'clearance': quantity(profile['clearance'], 'mm')}
