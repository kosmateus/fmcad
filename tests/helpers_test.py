import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cad_helpers', pathlib.Path(__file__).parents[1] / 'assets/cad/helpers.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


class Context:
    read_only_operations = ('measure.distance', 'boom')
    component = 'base'
    def call(self, op, data):
        if op == 'boom': raise RuntimeError('partial')
        return {'domain': 'returned'}
    def resolve(self, ref, expected_kind=None):
        if ref == 'ambiguous': raise RuntimeError('ambiguous reference')
        return (ref, expected_kind)


class HelperTest(unittest.TestCase):
    def setUp(self): self.facade = helpers.FMCAD(Context(), True)

    def test_acceptance_flags_and_rejections(self):
        for key in ('accepted', 'checkPassed', 'passed'):
            self.assertEqual(self.facade.require_pass({key: True}), {key: True})
        self.assertEqual(self.facade.require_pass({'accepted': True, 'checkPassed': True, 'passed': True}),
                         {'accepted': True, 'checkPassed': True, 'passed': True})
        rejected = [
            {'success': True}, {'accepted': True, 'passed': False},
            {'accepted': True, 'checkPassed': False}, {'checkPassed': True, 'passed': False},
            {'accepted': False, 'checkPassed': True}, {'passed': 1}, {'accepted': 'true'},
            {'passed': True, 'success': False}, {'passed': True, 'failed': True},
        ]
        rejected.extend({'passed': True, 'status': status} for status in
                        ('unknown', 'partial', 'unavailable', 'unsupported', 'missing', 'stale',
                         'blocked', 'error', 'fail', 'failed', 'not_checked'))
        rejected.extend([
            {'passed': True, 'status': 'pass', 'sampledPassed': True},
            {'passed': True, 'sampledPassed': False},
            {'passed': True, 'status': None},
            {'passed': True, 'unsupported': True},
            {'passed': True, 'supported': False},
            {'passed': True, 'evidenceStatus': 'unsupported'},
            {'passed': True, 'checkOutcome': 'unknown'},
            {'passed': True, 'coverage': 'partial'},
            {'passed': True, 'coverage': 'sampled'},
            {'passed': True, 'precision': 'unknown'},
            {'passed': True, 'restored': False},
        ])
        for result in rejected:
            with self.assertRaises(RuntimeError): self.facade.require_pass(result)

    def test_shared_nonpassing_evidence_fixtures_never_pass(self):
        fixtures = json.loads((pathlib.Path(__file__).parent / 'fixtures/evidence/nonpassing.json').read_text())
        for fixture in fixtures:
            with self.subTest(fixture=fixture['name']):
                with self.assertRaises(RuntimeError): self.facade.require_pass(fixture['result'])

    def test_dispatch_domain_and_readonly(self):
        self.assertEqual(self.facade.call('measure.distance', {}), {'domain': 'returned'})
        self.assertEqual(self.facade.calls[-1]['status'], 'completed')
        with self.assertRaises(RuntimeError): self.facade.call('model.create', {})
        with self.assertRaises(RuntimeError): self.facade.call('boom', {})
        self.assertEqual(self.facade.calls[-1]['effects'], 'unknown')

    def test_resolve_propagates_ambiguity_and_units_delegate(self):
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            self.facade.resolve('ambiguous', 'body')
        self.assertEqual(self.facade.resolve('unique', 'body'), ('unique', 'body'))

    def test_selection_rule_helper_methods_dispatch_inline_manifest_operations(self):
        context = Context()
        calls = []
        context.call = lambda operation, data: calls.append((operation, data)) or {'domain': 'returned'}
        writable = helpers.FMCAD(context, False)
        query = {
            'kind': 'face', 'scope': {'occurrence': 'Part:1'},
            'filters': {'name': 'Face'}, 'expect': 1,
        }
        manifest = {'schemaVersion': 1, 'rule': {'id': 'outer'}}
        self.assertEqual(writable.selection_rule_define('outer', query, [{'name': 'Skip'}]), {'domain': 'returned'})
        self.assertEqual(writable.selection_rule_inspect(manifest), {'domain': 'returned'})
        self.assertEqual(writable.selection_rule_resolve(manifest), {'domain': 'returned'})
        self.assertEqual(writable.selection_rule_check(manifest), {'domain': 'returned'})
        self.assertEqual(calls, [
            ('selection.rule.define', {'ruleId': 'outer', 'query': query, 'exclude': [{'name': 'Skip'}]}),
            ('selection.rule.inspect', {'manifest': manifest}),
            ('selection.rule.resolve', {'manifest': manifest}),
            ('selection.rule.check', {'manifest': manifest}),
        ])

    def test_mechanism_drive_test_helper_preserves_request_and_rejects_readonly_facade(self):
        context = Context()
        calls = []
        context.call = lambda operation, data: calls.append((operation, data)) or {'status': 'unknown'}
        request = {'schemaVersion': 1, 'confirm': True, 'waypoints': [0.0, 0.1]}
        writable = helpers.FMCAD(context, False)
        self.assertEqual(writable.mechanism_drive_test(request), {'status': 'unknown'})
        self.assertEqual(calls, [('mechanism.drive-test', request)])
        with self.assertRaisesRegex(RuntimeError, 'readonly helper dispatch rejected'):
            self.facade.mechanism_drive_test(request)

    def test_component_scope_restores_even_on_dispatch_error(self):
        with self.assertRaisesRegex(RuntimeError, 'partial'):
            self.facade.call('boom', {}, component='scoped')
        self.assertEqual(self.facade._context.component, 'base')
        self.assertEqual(self.facade.calls[-1], {'operation': 'boom', 'status': 'failed', 'effects': 'unknown'})

    def test_emit_is_single_and_terminal_best_effort(self):
        self.facade.emit({'ok': True})
        with self.assertRaises(RuntimeError): self.facade.emit({})
        output = io.StringIO()
        with contextlib.redirect_stdout(output): self.facade._terminal()
        self.assertEqual(output.getvalue().count('FMCAD_RESULT '), 1)
        output = io.StringIO()
        with contextlib.redirect_stdout(output): self.facade._terminal(RuntimeError('partial'))
        self.assertEqual(output.getvalue().count('FMCAD_RESULT '), 1)
        self.assertIn('"success": false', output.getvalue())

    def test_stage_inspection_uses_only_the_injected_authenticated_worker_snapshot(self):
        snapshot = {
            'stage': {'id': 'python.helpers.run', 'requestHash': 'a' * 64},
            'inspection': {'status': 'reconciliationRequired', 'replayAllowed': False},
            'resumePlan': {'nextStage': None, 'automaticResume': False},
        }
        facade = helpers.FMCAD(Context(), stage_context=snapshot)
        self.assertEqual(facade.stage(), snapshot['stage'])
        self.assertEqual(facade.journalInspect(), snapshot['inspection'])
        self.assertEqual(facade.resumePlan(), snapshot['resumePlan'])
        untrusted = helpers.FMCAD(Context())
        with self.assertRaisesRegex(RuntimeError, 'authenticated queued worker'):
            untrusted.stage()
        with self.assertRaisesRegex(RuntimeError, 'authenticated queued worker'):
            untrusted.journalInspect()
        with self.assertRaisesRegex(RuntimeError, 'authenticated queued worker'):
            untrusted.resumePlan()

    def test_parameter_test_routes_synchronous_oracles_and_body_helpers(self):
        calls = []
        with patch.object(helpers, '_measure_parameter_test', side_effect=lambda ctx, spec, case, restored:
                          calls.append((ctx, spec, case, restored)) or {'passed': True}, create=True), \
             patch.object(helpers, '_measure_temporary_body', return_value=('temporary', 'frame', 'body'), create=True) as body, \
             patch.object(helpers, '_measure_compare_bodies', return_value={'equal': True}, create=True) as compare:
            context = Context()
            facade = helpers.FMCAD(context)
            check_case = lambda spec, result: True
            check_restored = lambda spec, result: True
            self.assertEqual(facade.parameter_test({'cases': []}, check_case, check_restored), {'passed': True})
            self.assertEqual(calls, [(context, {'cases': []}, check_case, check_restored)])
            self.assertEqual(facade.temporary_body('body', 'component local'), ('temporary', 'frame', 'body'))
            body.assert_called_once_with(context, 'body', 'component local')
            self.assertEqual(facade.compare_bodies('a', 'b', 'frame', '0 mm^3', '0 mm', '0 deg'), {'equal': True})
            compare.assert_called_once_with(context, 'a', 'b', 'frame', '0 mm^3', '0 mm', '0 deg')

    def test_parameter_test_requires_both_callbacks_and_is_not_readonly(self):
        facade = helpers.FMCAD(Context(), False)
        with self.assertRaisesRegex(TypeError, 'callbacks'):
            facade.parameter_test({'cases': []}, lambda *_: True, None)
        with self.assertRaisesRegex(RuntimeError, 'readonly'):
            self.facade.parameter_test({'cases': []}, lambda *_: True, lambda *_: True)


if __name__ == '__main__': unittest.main()
