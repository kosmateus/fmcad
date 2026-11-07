"""Leased scratch-only callback failure and no-forward-work budget cases."""

DOC_NAME = 'Scratch'
ARGS = {}


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(_context):
    identity = FMCAD.call('document.status', {})
    if identity.get('fileId') != ARGS.get('fileId') or identity.get('projectId') != ARGS.get('projectId') or \
            identity.get('folderId') != ARGS.get('folderId'):
        raise RuntimeError('Parameter-failure scratch identity differs from assigned project/folder/file IDs')
    parameter = FMCAD.resolve('IW74_Width', 'parameter')
    bodies = FMCAD.call('entity.list', {'kind': 'body', 'component': 'root'})['entities']
    _require(len(bodies) == 1, 'Expected exactly one parameter-test seed body before geometry fixture')
    body = bodies[0]
    original_expression = parameter.expression
    volume = FMCAD.call('measure.volume', {'ref': body, 'units': 'mm3'})
    frame = volume['context']
    baseline = FMCAD.temporary_body(body, frame)

    def fail_case(_spec, _case):
        raise RuntimeError('intentional native callback failure')

    def verify_restore(_spec, _restored):
        comparison = FMCAD.compare_bodies(baseline, body, frame,
                                          '1 mm^3', '0.01 mm', '0.01 deg')
        return {'passed': comparison['equal'], 'comparison': comparison}

    failed = FMCAD.parameter_test({
        'confirm': True,
        'timeBudgetMs': 120000,
        'cases': [{'id': 'callback-throws',
                   'assign': [{'parameter': 'IW74_Width', 'expression': '17 mm'}]}],
    }, fail_case, verify_restore)
    case = failed['cases'][0]
    _require(failed.get('status') == 'fail' and failed.get('passed') is False,
             'Callback exception must fail the native parameter test')
    _require('intentional native callback failure' in (case.get('primaryError') or ''),
             'Callback exception was not retained as primary error')
    _require(case.get('restored') is True and case.get('restoredCallbackPassed') is True,
             'Callback exception did not execute and verify local restoration')
    _require(parameter.expression == original_expression, 'Callback failure left parameter expression changed')

    def unused_callback(_spec, _payload):
        return True

    budgeted = FMCAD.parameter_test({
        'confirm': True,
        'timeBudgetMs': 1,
        'cases': [{'id': 'reserve-exceeds-budget',
                   'assign': [{'parameter': 'IW74_Width', 'expression': '19 mm'}]}],
    }, unused_callback, unused_callback)
    _require(budgeted.get('passed') is False and budgeted.get('status') == 'partial' and
             budgeted.get('budgetExhausted') is True and budgeted['coverage']['skipped'] == 1,
             'Short native budget must skip required work, not report acceptance')
    _require(budgeted['cases'][0]['status'] == 'skipped', 'Budget fixture unexpectedly started a setter')
    _require(parameter.expression == original_expression, 'Budget preflight changed parameter expression')
    return {'callbackStatus': failed['status'], 'callbackPrimaryError': case['primaryError'],
            'callbackRestored': case['restored'], 'restoredCallbackPassed': case['restoredCallbackPassed'],
            'budgetStatus': budgeted['status'], 'budgetExceeded': budgeted['budgetExceeded'],
            'budgetExhausted': budgeted['budgetExhausted'], 'budgetCases': budgeted['coverage'],
            'expressionRestored': parameter.expression == original_expression}
