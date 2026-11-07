"""Finite geometry evidence policy; no SDK or sampled-to-exact promotion."""
import json as _section_json
import math as _section_math
import time as _section_time
from typing import Callable as _SectionCallable, ParamSpec as _SectionParamSpec
from typing import TypeVar as _SectionTypeVar, cast as _section_cast


_SectionCallArgs = _SectionParamSpec('_SectionCallArgs')
_SectionCallResult = _SectionTypeVar('_SectionCallResult')


class _SectionWitnessBudget:
    def __init__(self, data: "JsonObject") -> None:
        limits_value = data.get('limits', {})
        if not isinstance(limits_value, dict):
            raise ValueError('Unsupported section/witness limits')
        limits = limits_value
        if set(limits) - {'stations', 'edges', 'kernelCalls', 'bytes', 'timeMs'}:
            raise ValueError('Unsupported section/witness limits')
        defaults = {'stations': 64, 'edges': 4096, 'kernelCalls': 512, 'bytes': 1048576, 'timeMs': 30000}
        maxima = {'stations': 256, 'edges': 16384, 'kernelCalls': 4096, 'bytes': 4194304, 'timeMs': 120000}
        self.limits: dict[str, int] = {}
        for key, default in defaults.items():
            value = limits.get(key, default)
            if type(value) is not int or not 1 <= value <= maxima[key]:
                raise ValueError('Invalid limit: ' + key)
            self.limits[key] = value
        self.calls: int = 0
        self.started: float = _section_time.monotonic()

    def call(self, function: "_SectionCallable[_SectionCallArgs, _SectionCallResult]",
             *args: "_SectionCallArgs.args", **kwargs: "_SectionCallArgs.kwargs") -> "_SectionCallResult":
        if self.calls >= self.limits['kernelCalls'] or (_section_time.monotonic() - self.started) * 1000 >= self.limits['timeMs']:
            raise RuntimeError('Section/witness work budget exhausted')
        self.calls += 1
        # SDK calls are indivisible: this deadline prevents admission, not cancellation.
        return function(*args, **kwargs)

    def finish(self, result: "JsonRecord") -> "JsonRecord":
        result['kernelCalls'] = self.calls
        if len(_section_json.dumps(result, allow_nan=False).encode('utf-8')) > self.limits['bytes']:
            raise ValueError('Section/witness output byte budget exceeded')
        return result


def _section_witness_number(value: "JsonValue", label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _section_math.isfinite(value):
        raise ValueError(label + ' must be finite')
    return float(value)


def _section_witness_verdict(residual: "JsonValue", tolerance: "int | float") -> str:
    residual = _section_witness_number(residual, 'Residual volume')
    if residual < 0:
        raise ValueError('Residual volume must be nonnegative')
    return 'pass' if residual <= tolerance else 'fail'


def _section_witness_base(operation: str, frame: "JsonValue") -> "JsonRecord":
    return {'schemaVersion': 1, 'operation': operation, 'frame': frame,
            'units': {'length': 'cm', 'area': 'cm^2', 'volume': 'cm^3', 'angle': 'rad'},
            'associativity': 'snapshot', 'affected': [],
            'precision': 'kernel',
            'precisionDetail': {'method': 'native BRep kernel', 'exact': False,
                                'kernelTolerance': 'SDK controlled; not certified by this operation'},
            'limitations': ['No model mutation or geometry repair.',
                            'Time budget gates calls; an admitted SDK call cannot be interrupted.',
                            'Offline tests are not native Fusion qualification.']}
