"""DTO-only rules extracted from assets/cad/checking.py. No SDK or filesystem access."""

_EVIDENCE_KINDS = ('model', 'drawing', 'image', 'film')

_PREDICATE_KINDS = ('scalar', 'vector', 'count', 'boolean')

_SOURCE_STATUSES = ('CONFIRMED', 'ESTIMATED', 'OPEN')

_CHECKING_LIMITATIONS = [
    'Declared check and evidence metadata; no files are written and no model acceptance is certified.',
    'A failed test, an execution error, missing data and stale evidence are distinct outcomes and never collapse into one another.',
    'A source document marked valid:true or CHECKED_DOCUMENT is not model acceptance.',
    'An empty required checklist is an error, never a pass.']

def _compare_scalar(value: float, expected: "JsonObject", tolerance: float = 0.0) -> "JsonObject":
    if tolerance < 0:
        raise ValueError('tolerance must be nonnegative')
    low = high = None
    if 'equals' in expected:
        low = _cad_cast(float, expected['equals']) - tolerance
        high = _cad_cast(float, expected['equals']) + tolerance
    else:
        low = _cad_cast(float | None, expected.get('min'))
        high = _cad_cast(float | None, expected.get('max'))
    if low is not None and high is not None and low > high:
        raise ValueError('expected min exceeds max')
    passed = (low is None or value >= low) and (high is None or value <= high)
    return {'actual': value, 'expected': expected, 'passed': passed, 'method': 'declared-value comparison'}

def _predicate_missing(predicate: "JsonObject") -> bool:
    kind = predicate.get('kind')
    if kind == 'scalar':
        return 'measurement' not in predicate and 'actual' not in predicate
    return 'actual' not in predicate

def _is_stale_evidence(item: "JsonObject") -> bool:
    source = item.get('source')
    if source is not None:
        source = _cad_cast("JsonObject", source)
        if source.get('status') in ('ESTIMATED', 'OPEN'):
            return True
        if source.get('revision') is not None and item.get('revision') is not None \
                and source['revision'] != item['revision']:
            return True
    approval = item.get('supplierApproval')
    if approval is not None and _cad_cast("JsonObject", approval).get('approved') is not True:
        return True
    return False

def _evidence_item(spec: "JsonValue", index: int) -> "JsonObject":
    if not isinstance(spec, dict) or 'id' not in spec or 'kind' not in spec or 'path' not in spec:
        raise ValueError('evidence %d requires id, kind and path' % index)
    kind = spec['kind']
    if _cad_cast(str, kind) not in _EVIDENCE_KINDS:
        raise ValueError('evidence %r: unsupported kind %r' % (spec['id'], kind))
    return {'id': spec['id'], 'kind': kind, 'path': spec['path'], 'revision': spec.get('revision'),
            'source': spec.get('source'), 'supplierApproval': spec.get('supplierApproval'),
            'gate': spec.get('gate'), 'hash': spec.get('hash')}


def checking_contract(identity: "JsonValue", operation: str, result: "JsonObject", status: str = 'pass', acceptance: bool = False, limitations: "Sequence[str]" = ()) -> "JsonObject":
    merged = dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'deg'},
                  frame={'space': 'component'}, associativity='snapshot',
                  warnings=[], method='GM37 check/evidence evaluation',
                  limitations=list(_CHECKING_LIMITATIONS) + list(limitations),
                  provenance={'requirement': 'GM37', 'source': 'docs/CHECKS.md'}, affected=[])
    merged.update(result)
    merged['status'] = status
    if acceptance:
        merged['passed'] = status == 'pass'
        merged['success'] = status == 'pass'
    else:
        if status == 'pass':
            merged['passed'] = True
        elif status in ('fail', 'blocked'):
            merged['passed'] = False
        merged['success'] = status in ('pass', 'unknown')
    return merged
