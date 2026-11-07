"""Checks/evidence orchestration over injected measurement and dispatch effects.

No SDK handles or filesystem access; partial/stale/unknown retain their status.
Composition supplies the pure fields validator and predicate/contract rules.
"""
if '_Protocol' in globals():
    class _CheckingContract(_Protocol):
        def __call__(self, operation: str, result: "JsonObject", *, status: str = 'pass',
                     acceptance: bool = False, limitations: "Sequence[str]" = ()) -> "JsonObject": ...


    class _CheckingEvaluator(_Protocol):
        def __call__(self, predicate: "JsonObject") -> "JsonObject": ...


    class _CheckingDispatcher(_Protocol):
        def __call__(self, operation: str, data: "JsonObject") -> "JsonObject": ...


def checking_predicate(predicate: "JsonObject", scalar_measurement: "Callable[[JsonObject], JsonObject]") -> "JsonObject":
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
            result = scalar_measurement(check_data)
            return {'actual': result['actual'], 'expected': expected, 'passed': result['passed'],
                    'method': 'existing check reuse'}
        actual = predicate['actual']
        if not isinstance(actual, dict) or 'value' not in actual:
            raise ValueError('scalar actual must provide a value')
        return _compare_scalar(_cad_cast(float, actual['value']), _cad_cast("JsonObject", predicate['expected']),
                               _cad_cast(float, predicate.get('tolerance', 0.0)))
    if kind == 'vector':
        actual_spec = _cad_cast("JsonObject", predicate['actual'])
        expected_spec = predicate['expected']
        expected_spec = _cad_cast("JsonObject", expected_spec)
        actual = _cad_cast("Sequence[float]", actual_spec['components'])
        expected = _cad_cast("Sequence[float]", expected_spec['components'])
        tolerance = _cad_cast(float, expected_spec.get('tolerance', 0.0))
        if tolerance < 0:
            raise ValueError('vector tolerance must be nonnegative')
        if len(actual) != len(expected):
            raise ValueError('vector predicate component length mismatch')
        passed = all(abs(a - b) <= tolerance for a, b in zip(actual, expected))
        return {'actual': actual, 'expected': expected, 'passed': passed, 'method': 'component-wise vector comparison'}
    if kind == 'count':
        count = _cad_cast(float, _cad_cast("JsonObject", predicate['actual'])['count'])
        return _compare_scalar(count, _cad_cast("JsonObject", predicate['expected']),
                               _cad_cast(float, predicate.get('tolerance', 0.0)))
    actual_spec = _cad_cast("JsonObject", predicate['actual'])
    expected = predicate['expected']
    actual = actual_spec['value']
    if type(actual) is not bool or type(expected) is not bool:
        raise ValueError('boolean predicate requires boolean actual.value and expected')
    return {'actual': actual, 'expected': expected, 'passed': actual == expected, 'method': 'boolean equality'}


def checking_set(data: "JsonObject", evaluate: "_CheckingEvaluator", contract: "_CheckingContract") -> "JsonObject":
    _cad_fields(data, ('checks',), ('schemaVersion', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('check.set requires schemaVersion 1')
    checks = data['checks']
    if not isinstance(checks, list) or not checks:
        raise ValueError('checks must be a nonempty array')
    items: list[JsonObject] = []
    statuses: dict[str, str] = {}
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
            dependency_id = _cad_cast(str, dep)
            if dependency_id not in statuses:
                raise ValueError('check %r depends on unknown check %r' % (item_id, dep))
            if statuses[dependency_id] in ('error', 'skipped', 'notEvaluated'):
                skip_reason = 'dependency %r is %s' % (dep, statuses[dependency_id])
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
            evaluated = evaluate(predicate)
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
        if approval is not None:
            approval = _cad_cast("JsonObject", approval)
        if approval is not None and approval.get('approved') is not True and outcome == 'pass':
            outcome = 'stale'
        statuses[item_id] = outcome
        row = {'id': item_id, 'status': outcome, 'outcome': outcome, **evaluated}
        if source is not None:
            row['source'] = source
        items.append(row)
    outcomes = [_cad_cast(str, item['outcome']) for item in items]
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
    return contract('check.set', {
        'items': items, 'checkPassed': check_passed, 'executionSucceeded': execution_succeeded,
        'itemCount': len(items), 'passCount': sum(1 for o in outcomes if o == 'pass'),
        'failCount': sum(1 for o in outcomes if o == 'fail'),
        'errorCount': sum(1 for o in outcomes if o == 'error'),
        'staleCount': sum(1 for o in outcomes if o == 'stale'),
        'missingCount': sum(1 for o in outcomes if o == 'missing'),
        'skippedCount': sum(1 for o in outcomes if o in ('skipped', 'notEvaluated')),
        'executionSucceededIsNotCheckPassed': True}, status=status)


def checking_evidence_package(data: "JsonObject", contract: "_CheckingContract") -> "JsonObject":
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
        present = {_cad_cast(str, item['kind']) for item in items}
        missing = [k for k in requested_kinds if k not in present]
    else:
        requested_kinds = sorted({_cad_cast(str, item['kind']) for item in items})
        missing = []
    stale = [item for item in items if _is_stale_evidence(item)]
    manifest: list[JsonObject] = [{'id': item['id'], 'kind': item['kind'], 'path': item['path'],
                 'included': item['kind'] in requested_kinds, 'revision': item['revision'],
                 'gate': item['gate']} for item in items]
    complete = not missing and not stale
    return contract('evidence.package', {
        'manifest': manifest, 'requested': requested_kinds, 'missing': missing, 'stale': stale,
        'complete': complete, 'itemCount': len(items)},
        status='pass' if complete else 'unknown',
        limitations=['The manifest lists declared paths, revisions and gates; no files are read, written or verified here.'])


def checking_evidence_check(data: "JsonObject", contract: "_CheckingContract") -> "JsonObject":
    _cad_fields(data, ('evidence',), ('schemaVersion', 'required', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('evidence.check requires schemaVersion 1')
    evidence = data['evidence']
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('evidence must be a nonempty array')
    items = [_evidence_item(spec, i) for i, spec in enumerate(evidence)]
    required = data.get('required')
    required_kinds: list[str] = []
    required_ids: list[str] = []
    if required is not None:
        if not isinstance(required, list):
            raise ValueError('required must be an array')
        for entry in required:
            if isinstance(entry, str) and entry in _EVIDENCE_KINDS:
                required_kinds.append(entry)
            elif isinstance(entry, str):
                required_ids.append(entry)
    present_kinds = {_cad_cast(str, item['kind']) for item in items}
    present_ids = {_cad_cast(str, item['id']) for item in items}
    missing: list[JsonObject] = []
    missing.extend({'kind': k} for k in required_kinds if k not in present_kinds)
    missing.extend({'id': i} for i in required_ids if i not in present_ids)
    stale = [item for item in items if _is_stale_evidence(item)]
    complete = not missing and not stale
    return contract('evidence.check', {
        'complete': complete, 'missing': missing, 'stale': stale, 'itemCount': len(items)},
        status='pass' if complete else 'unknown',
        limitations=['Completeness is checked against declared ids/kinds; a missing entry is unresolved evidence, not a failed test.'])


def checking_deliver(data: "JsonObject", dispatch: "_CheckingDispatcher", contract: "_CheckingContract") -> "JsonObject":
    _cad_fields(data, ('checks',), ('schemaVersion', 'evidence', 'gate', 'frame'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('deliver requires schemaVersion 1')
    checks = data['checks']
    if not isinstance(checks, list) or not checks:
        raise ValueError('deliver requires a nonempty required checklist; an empty checklist is not acceptance')
    check_result = dispatch('check.set', {'schemaVersion': 1, 'checks': checks})
    evidence = data.get('evidence')
    evidence_result = None
    package_result = None
    if evidence is not None:
        evidence_result = dispatch('evidence.check', {'schemaVersion': 1, 'evidence': evidence})
        package_result = dispatch('evidence.package', {'schemaVersion': 1, 'evidence': evidence})
    accepted = check_result['status'] == 'pass'
    if evidence_result is not None and evidence_result['status'] != 'pass':
        accepted = False
    statuses = [_cad_cast(str, check_result['status'])] + ([_cad_cast(str, evidence_result['status'])] if evidence_result is not None else [])
    if accepted:
        status = 'pass'
    elif 'blocked' in statuses:
        status = 'blocked'
    elif 'fail' in statuses:
        status = 'fail'
    else:
        status = 'unknown'
    return contract('deliver', {
        'accepted': accepted, 'checkSet': check_result, 'evidence': evidence_result,
        'manifest': package_result['manifest'] if package_result is not None else [],
        'missing': package_result['missing'] if package_result is not None else [],
        'stale': package_result['stale'] if package_result is not None else [],
        'gate': data.get('gate'),
        'executionSucceeded': check_result.get('executionSucceeded', True)},
        status=status, acceptance=True,
        limitations=['deliver composes existing checks and evidence; it does not write duplicate exports or add unrequested formats.',
                     'Acceptance means the declared checklist and evidence passed; it never certifies the model itself.'])
