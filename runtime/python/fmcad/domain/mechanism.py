"""SDK-free mechanism validation and numerical data operations."""
import math as _mechanism_domain_math
from typing import Literal as _mechanism_Literal, TypedDict as _mechanism_TypedDict


class _ScrewCoupling(_mechanism_TypedDict):
    type: _mechanism_Literal['screw']
    lead: float
    zeroPhase: float
    drivenZero: float


class _RotationCoupling(_mechanism_TypedDict):
    type: _mechanism_Literal['rotation']
    ratio: float
    zeroPhase: float
    drivenZero: float

def _mechanism_version(data: "JsonObject") -> None:
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM17 mechanism operations require schemaVersion:1 and frame:component')

def _mechanism_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _mechanism_domain_math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    return float(value)


def _mechanism_driven(model: _ScrewCoupling | _RotationCoupling, driver: float) -> float:
    """Evaluate a plain-data coupling; no callable capturing a context or entity."""
    if model['type'] == 'screw':
        return model['lead'] * (driver - model['zeroPhase']) / (2.0 * _mechanism_domain_math.pi) + model['drivenZero']
    return model['ratio'] * (driver - model['zeroPhase']) + model['drivenZero']
