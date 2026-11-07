"""Finite regional comparison DTO rules. No SDK, solver, store or sampling."""
import math as _regional_math


class RegionalGeometryUnavailable(RuntimeError):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def regional_geometry_request(data: "JsonValue", operation: str) -> "dict[str, dict[str, list[JsonValue]]]":
    if operation not in ('geometry.delta', 'geometry.compare-region'):
        raise ValueError('Unsupported regional geometry operation')
    required = {'before', 'after', 'frame'}
    if operation == 'geometry.compare-region':
        required.add('allowed')
    optional = {'allowed', 'protected', 'operationBudget', 'timeBudgetMs', 'schemaVersion'}
    if not isinstance(data, dict) or required - set(data) or set(data) - required - optional:
        raise ValueError('Regional comparison requires before, after, frame and only documented fields')
    request = data
    if type(request.get('schemaVersion', 1)) is not int or request.get('schemaVersion', 1) != 1:
        raise ValueError('Regional comparison requires schemaVersion 1')
    frame = request['frame']
    if not isinstance(frame, dict) or set(frame) != {'space', 'component'} or frame['space'] not in ('assembly', 'component local'):
        raise ValueError('frame must explicitly identify space and component')
    for field, default in (('operationBudget', 256), ('timeBudgetMs', 10000)):
        value = request.get(field, default)
        maximum = 10000 if field == 'operationBudget' else 300000
        if type(value) is not int or value < 1 or value > maximum:
            raise ValueError('%s must be an integer from 1 to %d' % (field, maximum))
    for field in ('before', 'after'):
        _regional_reference(request[field])
    _regional_reference(frame['component'])
    masks: dict[str, dict[str, list[JsonValue]]] = {}
    for field in ('allowed', 'protected'):
        spec_value = request.get(field, {'include': [], 'exclude': []})
        if not isinstance(spec_value, dict):
            raise ValueError('%s requires include and optional exclude arrays of solid refs' % field)
        spec = spec_value
        if 'include' not in spec or set(spec) - {'include', 'exclude'}:
            raise ValueError('%s requires include and optional exclude arrays of solid refs' % field)
        masks[field] = {}
        for part in ('include', 'exclude'):
            refs = spec.get(part, [])
            if not isinstance(refs, list) or len(refs) > 1000:
                raise ValueError('%s.%s must be an array of at most 1000 refs' % (field, part))
            for ref in refs:
                _regional_reference(ref)
            masks[field][part] = refs
    return masks


def _regional_reference(ref: "JsonValue") -> None:
    if not ((isinstance(ref, str) and ref.strip()) or (isinstance(ref, dict) and ref)):
        raise ValueError('Regional operands must be explicit entity references, not points or sampled regions')


def regional_geometry_nonnegative(value: "JsonValue") -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not _regional_math.isfinite(value) or value < 0:
        raise RegionalGeometryUnavailable('invalid-measurement', 'Kernel returned an invalid finite volume')
    return float(value)


def regional_geometry_contract(operation: str, frame: "JsonValue") -> "JsonRecord":
    result: "JsonRecord" = {
        'schemaVersion': 1, 'operation': operation, 'status': 'unknown',
        'passed': None, 'success': False, 'precision': 'unknown', 'coverage': 'unknown',
        'method': 'temporary BRep Boolean A-B/B-A with finite union masks',
        'frame': frame, 'units': {'length': 'cm', 'volume': 'cm^3'},
        'associativity': 'snapshot', 'documentIdentity': None,
        'delta': None, 'controls': None, 'comparison': None, 'provenance': [],
        'mutation': {'documentModifiedByOperation': False, 'temporaryCopiesOnly': True},
        'limitations': [
            'Finite solid volume coverage only; zero-volume face/edge changes and topology identity are not certified.',
            'No sampling, tolerance-based acceptance, geometry repair, persistent temporary bodies or automatic rollback.',
            'Port turns may contain indivisible SDK calls; budgets are checked before and after turns, not cancellation.',
            'Native Fusion qualification is separate from offline analytic fixture verification.'
        ]}
    return result
