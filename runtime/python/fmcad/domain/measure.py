"""DTO-only rules extracted from assets/cad/measure.py. No SDK or filesystem access."""

_MEASURE_INTERNAL = {'length': 'cm', 'area': 'cm^2', 'volume': 'cm^3', 'mass': 'kg', 'angle': 'rad'}

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
