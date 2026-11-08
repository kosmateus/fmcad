"""GM37 checks, evidence and release: check.set, evidence package/check, deliver.

``check.set`` extends the existing scalar ``check`` engine with richer
scalar/vector/count/Boolean predicates, dependency ordering and distinct
outcomes (pass / fail / error / missing / stale / skipped). It reuses the
existing ``check`` handler through ``ctx.call`` for scalar measurements rather
than duplicating it. ``evidence.package`` and ``evidence.check`` compose a
manifest of declared models/drawings/images/films and report completeness,
staleness and missing evidence. ``deliver`` is the acceptance command: it
composes existing checks and evidence, and returns ``success: false`` on any
fail/blocked/unknown. An empty required checklist is an error. A failed test
is never conflated with an execution error, missing data or stale evidence, and
a source document marked ``valid: true`` or CHECKED_DOCUMENT never counts as
model acceptance.
"""
import math


_EVIDENCE_KINDS = ('model', 'drawing', 'image', 'film')
_PREDICATE_KINDS = ('scalar', 'vector', 'count', 'boolean')
_SOURCE_STATUSES = ('CONFIRMED', 'ESTIMATED', 'OPEN')


_CHECKING_LIMITATIONS = [
    'Declared check and evidence metadata; no files are written and no model acceptance is certified.',
    'A failed test, an execution error, missing data and stale evidence are distinct outcomes and never collapse into one another.',
    'A source document marked valid:true or CHECKED_DOCUMENT is not model acceptance.',
    'An empty required checklist is an error, never a pass.']


def _checking_contract(ctx, operation, result, status='pass', acceptance=False, limitations=()):
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
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


def _compare_scalar(value, expected, tolerance=0.0):
    if tolerance < 0:
        raise ValueError('tolerance must be nonnegative')
    low = high = None
    if 'equals' in expected:
        low = expected['equals'] - tolerance
        high = expected['equals'] + tolerance
    else:
        low = expected.get('min')
        high = expected.get('max')
    if low is not None and high is not None and low > high:
        raise ValueError('expected min exceeds max')
    passed = (low is None or value >= low) and (high is None or value <= high)
    return {'actual': value, 'expected': expected, 'passed': passed, 'method': 'declared-value comparison'}


def _predicate_missing(predicate):
    kind = predicate.get('kind')
    if kind == 'scalar':
        return 'measurement' not in predicate and 'actual' not in predicate
    return 'actual' not in predicate


def _evaluate_predicate(ctx, predicate):
    kind = predicate.get('kind')
    if kind not in _PREDICATE_KINDS:
        raise ValueError('unsupported predicate kind %r' % (kind,))
    if 'expected' not in predicate:
        raise ValueError('%s predicate requires an expected interval/value' % kind)
    if kind == 'scalar':
        if 'measurement' in predicate:
            expected = predicate['expected']
            if not isinstance(expected, dict):
                raise ValueError('scalar expected must be an object')
            check_data = {'measurement': predicate['measurement']}
            if 'min' in expected:
                check_data['min'] = expected['min']
            if 'max' in expected:
                check_data['max'] = expected['max']
            if 'equals' in expected:
                check_data['expected'] = expected['equals']
            if 'tolerance' in predicate:
                check_data['tolerance'] = predicate['tolerance']
            result = ctx.call('check', check_data)
            return {'actual': result['actual'], 'expected': expected, 'passed': result['passed'],
                    'method': 'existing check reuse'}
        actual = predicate['actual']
        if not isinstance(actual, dict) or 'value' not in actual:
            raise ValueError('scalar actual must provide a value')
        return _compare_scalar(actual['value'], predicate['expected'], predicate.get('tolerance', 0.0))
    if kind == 'vector':
        actual = predicate['actual']['components']
        expected_spec = predicate['expected']
        expected = expected_spec['components']
        tolerance = expected_spec.get('tolerance', 0.0)
        if tolerance < 0:
            raise ValueError('vector tolerance must be nonnegative')
        if len(actual) != len(expected):
            raise ValueError('vector predicate component length mismatch')
        passed = all(abs(a - b) <= tolerance for a, b in zip(actual, expected))
        return {'actual': actual, 'expected': expected, 'passed': passed, 'method': 'component-wise vector comparison'}
    if kind == 'count':
        count = predicate['actual']['count']
        return _compare_scalar(count, predicate['expected'], predicate.get('tolerance', 0.0))
    actual = predicate['actual']['value']
    expected = predicate['expected']
    if type(actual) is not bool or type(expected) is not bool:
        raise ValueError('boolean predicate requires boolean actual.value and expected')
    return {'actual': actual, 'expected': expected, 'passed': actual == expected, 'method': 'boolean equality'}


def _is_stale_evidence(item):
    source = item.get('source')
    if source is not None:
        if source.get('status') in ('ESTIMATED', 'OPEN'):
            return True
        if source.get('revision') is not None and item.get('revision') is not None \
                and source['revision'] != item['revision']:
            return True
    approval = item.get('supplierApproval')
    if approval is not None and approval.get('approved') is not True:
        return True
    return False


def _check_set(ctx, data):
    _cad_fields(data, ('checks',), ('schemaVersion', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('check.set requires schemaVersion 1')
    checks = data['checks']
    if not isinstance(checks, list) or not checks:
        raise ValueError('checks must be a nonempty array')
    items = []
    statuses = {}
    for index, spec in enumerate(checks):
        if not isinstance(spec, dict):
            raise ValueError('check %d must be an object' % index)
        item_id = spec.get('id')
        if not isinstance(item_id, str) or not item_id:
            raise ValueError('check %d requires an id' % index)
        dependencies = spec.get('dependsOn', [])
        if not isinstance(dependencies, list):
            raise ValueError('check %r dependsOn must be an array' % item_id)
        skip_reason = None
        for dep in dependencies:
            if dep not in statuses:
                raise ValueError('check %r depends on unknown check %r' % (item_id, dep))
            if statuses[dep] in ('error', 'skipped', 'notEvaluated'):
                skip_reason = 'dependency %r is %s' % (dep, statuses[dep])
                break
        if skip_reason is not None:
            statuses[item_id] = 'skipped'
            items.append({'id': item_id, 'status': 'skipped', 'outcome': 'notEvaluated', 'reason': skip_reason})
            continue
        predicate = spec.get('predicate')
        if not isinstance(predicate, dict) or predicate.get('kind') not in _PREDICATE_KINDS:
            statuses[item_id] = 'error'
            items.append({'id': item_id, 'status': 'error', 'outcome': 'error',
                          'reason': 'invalid predicate'})
            continue
        if _predicate_missing(predicate):
            statuses[item_id] = 'missing'
            items.append({'id': item_id, 'status': 'missing', 'outcome': 'missing',
                          'reason': 'no actual value or measurement declared'})
            continue
        try:
            evaluated = _evaluate_predicate(ctx, predicate)
        except Exception as exc:
            statuses[item_id] = 'error'
            items.append({'id': item_id, 'status': 'error', 'outcome': 'error',
                          'reason': type(exc).__name__ + ': ' + str(exc)})
            continue
        outcome = 'pass' if evaluated['passed'] else 'fail'
        source = spec.get('source')
        if source is not None and not isinstance(source, dict):
            raise ValueError('check %r source must be an object' % item_id)
        if source is not None and source.get('status') in ('ESTIMATED', 'OPEN') and outcome == 'pass':
            outcome = 'stale'
        approval = spec.get('supplierApproval')
        if approval is not None and approval.get('approved') is not True and outcome == 'pass':
            outcome = 'stale'
        statuses[item_id] = outcome
        row = {'id': item_id, 'status': outcome, 'outcome': outcome, **evaluated}
        if source is not None:
            row['source'] = source
        items.append(row)
    outcomes = [item['outcome'] for item in items]
    check_passed = all(o == 'pass' for o in outcomes)
    execution_succeeded = all(o != 'error' for o in outcomes)
    if check_passed:
        status = 'pass'
    elif any(o == 'error' for o in outcomes):
        status = 'blocked'
    elif any(o == 'fail' for o in outcomes):
        status = 'fail'
    else:
        status = 'unknown'
    return _checking_contract(ctx, 'check.set', {
        'items': items, 'checkPassed': check_passed, 'executionSucceeded': execution_succeeded,
        'itemCount': len(items), 'passCount': sum(1 for o in outcomes if o == 'pass'),
        'failCount': sum(1 for o in outcomes if o == 'fail'),
        'errorCount': sum(1 for o in outcomes if o == 'error'),
        'staleCount': sum(1 for o in outcomes if o == 'stale'),
        'missingCount': sum(1 for o in outcomes if o == 'missing'),
        'skippedCount': sum(1 for o in outcomes if o in ('skipped', 'notEvaluated')),
        'executionSucceededIsNotCheckPassed': True}, status=status)


def _evidence_item(spec, index):
    if not isinstance(spec, dict) or 'id' not in spec or 'kind' not in spec or 'path' not in spec:
        raise ValueError('evidence %d requires id, kind and path' % index)
    kind = spec['kind']
    if kind not in _EVIDENCE_KINDS:
        raise ValueError('evidence %r: unsupported kind %r' % (spec['id'], kind))
    return {'id': spec['id'], 'kind': kind, 'path': spec['path'], 'revision': spec.get('revision'),
            'source': spec.get('source'), 'supplierApproval': spec.get('supplierApproval'),
            'gate': spec.get('gate'), 'hash': spec.get('hash')}


def _evidence_package(ctx, data):
    _cad_fields(data, ('evidence',), ('schemaVersion', 'requested', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('evidence.package requires schemaVersion 1')
    evidence = data['evidence']
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('evidence must be a nonempty array')
    items = [_evidence_item(spec, i) for i, spec in enumerate(evidence)]
    requested = data.get('requested')
    if requested is not None and not isinstance(requested, list):
        raise ValueError('requested must be an array of kinds')
    if requested:
        requested_kinds = list(requested)
        present = {item['kind'] for item in items}
        missing = [k for k in requested_kinds if k not in present]
    else:
        requested_kinds = sorted({item['kind'] for item in items})
        missing = []
    stale = [item for item in items if _is_stale_evidence(item)]
    manifest = [{'id': item['id'], 'kind': item['kind'], 'path': item['path'],
                 'included': item['kind'] in requested_kinds, 'revision': item['revision'],
                 'gate': item['gate']} for item in items]
    complete = not missing and not stale
    return _checking_contract(ctx, 'evidence.package', {
        'manifest': manifest, 'requested': requested_kinds, 'missing': missing, 'stale': stale,
        'complete': complete, 'itemCount': len(items)},
        status='pass' if complete else 'unknown',
        limitations=['The manifest lists declared paths, revisions and gates; no files are read, written or verified here.'])


def _evidence_check(ctx, data):
    _cad_fields(data, ('evidence',), ('schemaVersion', 'required', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('evidence.check requires schemaVersion 1')
    evidence = data['evidence']
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('evidence must be a nonempty array')
    items = [_evidence_item(spec, i) for i, spec in enumerate(evidence)]
    required = data.get('required')
    required_kinds = []
    required_ids = []
    if required is not None:
        if not isinstance(required, list):
            raise ValueError('required must be an array')
        for entry in required:
            if entry in _EVIDENCE_KINDS:
                required_kinds.append(entry)
            elif isinstance(entry, str):
                required_ids.append(entry)
    present_kinds = {item['kind'] for item in items}
    present_ids = {item['id'] for item in items}
    missing = []
    missing.extend({'kind': k} for k in required_kinds if k not in present_kinds)
    missing.extend({'id': i} for i in required_ids if i not in present_ids)
    stale = [item for item in items if _is_stale_evidence(item)]
    complete = not missing and not stale
    return _checking_contract(ctx, 'evidence.check', {
        'complete': complete, 'missing': missing, 'stale': stale, 'itemCount': len(items)},
        status='pass' if complete else 'unknown',
        limitations=['Completeness is checked against declared ids/kinds; a missing entry is unresolved evidence, not a failed test.'])


def _deliver(ctx, data):
    _cad_fields(data, ('checks',), ('schemaVersion', 'evidence', 'gate', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('deliver requires schemaVersion 1')
    checks = data['checks']
    if not isinstance(checks, list) or not checks:
        raise ValueError('deliver requires a nonempty required checklist; an empty checklist is not acceptance')
    check_result = ctx.call('check.set', {'schemaVersion': 1, 'checks': checks})
    evidence = data.get('evidence')
    evidence_result = None
    package_result = None
    if evidence is not None:
        evidence_result = ctx.call('evidence.check', {'schemaVersion': 1, 'evidence': evidence})
        package_result = ctx.call('evidence.package', {'schemaVersion': 1, 'evidence': evidence})
    accepted = check_result['status'] == 'pass'
    if evidence_result is not None and evidence_result['status'] != 'pass':
        accepted = False
    statuses = [check_result['status']] + ([evidence_result['status']] if evidence_result is not None else [])
    if accepted:
        status = 'pass'
    elif 'blocked' in statuses:
        status = 'blocked'
    elif 'fail' in statuses:
        status = 'fail'
    else:
        status = 'unknown'
    return _checking_contract(ctx, 'deliver', {
        'accepted': accepted, 'checkSet': check_result, 'evidence': evidence_result,
        'manifest': package_result['manifest'] if package_result is not None else [],
        'missing': package_result['missing'] if package_result is not None else [],
        'stale': package_result['stale'] if package_result is not None else [],
        'gate': data.get('gate'),
        'executionSucceeded': check_result.get('executionSucceeded', True)},
        status=status, acceptance=True,
        limitations=['deliver composes existing checks and evidence; it does not write duplicate exports or add unrequested formats.',
                     'Acceptance means the declared checklist and evidence passed; it never certifies the model itself.'])


CAD_HANDLERS.update({
    'check.set': _check_set,
    'evidence.package': _evidence_package,
    'evidence.check': _evidence_check,
    'deliver': _deliver,
})
