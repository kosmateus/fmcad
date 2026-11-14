"""DTO-only rules extracted from assets/cad/measure.py. No SDK or filesystem access."""
import math as _measurement_rules_math

_MEASURE_UNITS = {
    'length': {'mm': 10.0, 'cm': 1.0, 'm': 0.01, 'in': 1 / 2.54},
    'area': {'mm2': 100.0, 'cm2': 1.0, 'm2': 0.0001},
    'volume': {'mm3': 1000.0, 'cm3': 1.0, 'm3': 0.000001},
    'mass': {'kg': 1.0, 'g': 1000.0},
    'angle': {'deg': 180 / _measurement_rules_math.pi, 'rad': 1.0},
}


def _measure_value(value: float, dimension: "Literal['length', 'area', 'volume', 'mass', 'angle']", data: "JsonObject") -> "JsonObject":
    units = _cad_cast(str, data.get('units', next(iter(_MEASURE_UNITS[dimension]))))
    if units not in _MEASURE_UNITS[dimension]:
        raise ValueError('Unsupported %s units: %s' % (dimension, units))
    value = float(value) * _MEASURE_UNITS[dimension][units]
    if not _measurement_rules_math.isfinite(value):
        raise ValueError('Measurement is non-finite')
    return {'value': value, 'units': units, 'dimension': dimension}


_MEASURE_INTERNAL = {'length': 'cm', 'area': 'cm^2', 'volume': 'cm^3', 'mass': 'kg', 'angle': 'rad'}

# Best-effort scheduler reserve, charged inside timeBudgetMs: 1000 ms per case
# plus 250 ms per assigned parameter. Fusion calls are indivisible and unbounded.

_PARAMETER_TEST_DEFAULT_BUDGET_MS = 180000

_PARAMETER_TEST_RESTORE_BASE_MS = 1000

_PARAMETER_TEST_RESTORE_ASSIGNMENT_MS = 250

_PARAMETER_TEST_MAX_CASES = 1000

_PARAMETER_TEST_MAX_ASSIGNMENTS = 10000

def _measure_health_passed(rows: "Sequence[JsonObject]", require_owner: bool = False) -> bool:
    for row in rows:
        if row.get('duplicate') is True:
            continue
        if row.get('isGroup') is True:
            if row.get('state') not in ('HealthyFeatureHealthState', 'unknown') or \
                    row.get('suppressed') or row.get('rolledBack'):
                return False
            continue
        if require_owner and row.get('ownerUnknown'):
            return False
        if not (row.get('state') == 'HealthyFeatureHealthState' or
                row.get('state') == 'SuppressedFeatureHealthState' and row.get('suppressedAllowed')):
            return False
        if row.get('rolledBack'):
            return False
    return True

def _measure_restore_error(case_id: "JsonValue", stage: str, message: object) -> "JsonObject":
    return {'caseId': case_id, 'stage': stage, 'message': str(message)}
