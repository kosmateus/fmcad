"""GM37 offline tests: check.set, evidence package/check and deliver."""
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/checking.py').read_text(), 'checking.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Context(model.Context):
    def __init__(self):
        super().__init__()
        self.check_calls = []
        self.check_error = False

    def call(self, operation, data):
        if operation == 'check':
            self.check_calls.append(data)
            if self.check_error:
                raise RuntimeError('measurement execution failed')
            return {'actual': {'value': 1.0, 'units': 'cm', 'dimension': 'length'},
                    'passed': True, 'status': 'pass'}
        return HANDLERS[operation](self, data)


class CheckingTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](Context(), data)

    def test_check_set_declared_scalar_pass(self):
        result = self.call('check.set', {'schemaVersion': 1,
            'checks': [{'id': 'od', 'predicate': {'kind': 'scalar', 'actual': {'value': 25.0},
                                                 'expected': {'min': 24.0, 'max': 26.0}},
                        'source': {'path': 'drawing', 'status': 'CONFIRMED'}}]})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['checkPassed'])
        self.assertTrue(result['executionSucceeded'])

    def test_check_set_scalar_measurement_reuses_check_engine(self):
        context = Context()
        result = HANDLERS['check.set'](context, {'schemaVersion': 1,
            'checks': [{'id': 'vol', 'predicate': {'kind': 'scalar',
                'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}},
                'expected': {'equals': '1 cm^3'}, 'tolerance': '1 mm^3'}}]})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(len(context.check_calls), 1)
        mapped = context.check_calls[0]
        self.assertEqual(mapped['measurement']['operation'], 'measure.volume')
        self.assertEqual(mapped['expected'], '1 cm^3')
        self.assertEqual(mapped['tolerance'], '1 mm^3')

    def test_check_set_continues_after_ordinary_fail(self):
        result = self.call('check.set', {'schemaVersion': 1,
            'checks': [
                {'id': 'a', 'predicate': {'kind': 'scalar', 'actual': {'value': 1.0}, 'expected': {'equals': 5.0}}},
                {'id': 'b', 'predicate': {'kind': 'boolean', 'actual': {'value': True}, 'expected': True}},
            ]})
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['items'][0]['outcome'], 'fail')
        self.assertEqual(result['items'][1]['outcome'], 'pass')

    def test_check_set_execution_error_stops_dependents(self):
        context = Context()
        context.check_error = True
        result = HANDLERS['check.set'](context, {'schemaVersion': 1,
            'checks': [
                {'id': 'gate', 'predicate': {'kind': 'scalar',
                    'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}},
                    'expected': {'min': '1 cm^3'}}},
                {'id': 'later', 'dependsOn': ['gate'],
                 'predicate': {'kind': 'boolean', 'actual': {'value': True}, 'expected': True}},
            ]})
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse(result['executionSucceeded'])
        self.assertEqual(result['items'][0]['outcome'], 'error')
        self.assertEqual(result['items'][1]['outcome'], 'notEvaluated')
        self.assertIn('dependency', result['items'][1]['reason'])

    def test_check_set_vector_count_and_boolean(self):
        result = self.call('check.set', {'schemaVersion': 1,
            'checks': [
                {'id': 'v', 'predicate': {'kind': 'vector', 'actual': {'components': [1.0, 2.0]},
                                          'expected': {'components': [1.0, 2.0], 'tolerance': 0.1}}},
                {'id': 'c', 'predicate': {'kind': 'count', 'actual': {'count': 6}, 'expected': {'equals': 6}}},
                {'id': 'b', 'predicate': {'kind': 'boolean', 'actual': {'value': False}, 'expected': False}},
            ]})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual([i['outcome'] for i in result['items']], ['pass', 'pass', 'pass'])

    def test_check_set_stale_source_is_unknown_not_pass(self):
        result = self.call('check.set', {'schemaVersion': 1,
            'checks': [{'id': 'od', 'predicate': {'kind': 'scalar', 'actual': {'value': 25.0},
                                                 'expected': {'min': 24.0, 'max': 26.0}},
                        'source': {'path': 'drawing', 'status': 'ESTIMATED'}}]})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['items'][0]['outcome'], 'stale')

    def test_check_set_missing_actual_is_missing_not_error(self):
        result = self.call('check.set', {'schemaVersion': 1,
            'checks': [{'id': 'x', 'predicate': {'kind': 'scalar', 'expected': {'equals': 1.0}}}]})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['items'][0]['outcome'], 'missing')
        self.assertTrue(result['executionSucceeded'])

    def test_evidence_package_complete_and_missing(self):
        complete = self.call('evidence.package', {'schemaVersion': 1,
            'evidence': [{'id': 'd', 'kind': 'drawing', 'path': 'drawings/h.svg', 'revision': 'B',
                          'source': {'path': 'drawings', 'revision': 'B', 'status': 'CONFIRMED'}}]})
        self.assertEqual(complete['status'], 'pass')
        self.assertTrue(complete['complete'])
        missing = self.call('evidence.package', {'schemaVersion': 1,
            'evidence': [{'id': 'd', 'kind': 'drawing', 'path': 'drawings/h.svg'}],
            'requested': ['film', 'drawing']})
        self.assertEqual(missing['status'], 'unknown')
        self.assertIn('film', missing['missing'])

    def test_evidence_check_missing_required_and_stale(self):
        missing = self.call('evidence.check', {'schemaVersion': 1,
            'evidence': [{'id': 'd', 'kind': 'drawing', 'path': 'drawings/h.svg'}],
            'required': ['film']})
        self.assertEqual(missing['status'], 'unknown')
        self.assertTrue(any('film' == m.get('kind') for m in missing['missing']))
        stale = self.call('evidence.check', {'schemaVersion': 1,
            'evidence': [{'id': 'd', 'kind': 'drawing', 'path': 'drawings/h.svg',
                          'source': {'status': 'OPEN'}}]})
        self.assertEqual(stale['status'], 'unknown')
        self.assertEqual(len(stale['stale']), 1)

    def test_deliver_passes_and_composes(self):
        result = self.call('deliver', {'schemaVersion': 1,
            'checks': [{'id': 'od', 'predicate': {'kind': 'scalar', 'actual': {'value': 25.0},
                                                 'expected': {'min': 24.0, 'max': 26.0}}}],
            'evidence': [{'id': 'film', 'kind': 'film', 'path': 'evidence/p.mp4',
                          'supplierApproval': {'supplier': 'molder', 'approved': True}}],
            'gate': 'G7'})
        self.assertTrue(result['accepted'])
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['success'])
        self.assertEqual(result['manifest'][0]['id'], 'film')

    def test_deliver_fail_is_not_accepted(self):
        result = self.call('deliver', {'schemaVersion': 1,
            'checks': [{'id': 'od', 'predicate': {'kind': 'scalar', 'actual': {'value': 30.0},
                                                 'expected': {'min': 24.0, 'max': 26.0}}}]})
        self.assertFalse(result['accepted'])
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['success'])

    def test_deliver_unknown_is_not_accepted(self):
        result = self.call('deliver', {'schemaVersion': 1,
            'checks': [{'id': 'x', 'predicate': {'kind': 'scalar', 'expected': {'equals': 1.0}}}]})
        self.assertFalse(result['accepted'])
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['success'])

    def test_deliver_empty_checklist_is_an_error(self):
        with self.assertRaises(ValueError):
            self.call('deliver', {'schemaVersion': 1, 'checks': []})

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.call('check.set', {'schemaVersion': 1, 'checks': []})
        with self.assertRaises(ValueError):
            self.call('evidence.package', {'schemaVersion': 1, 'evidence': []})
        with self.assertRaises(ValueError):
            self.call('deliver', {'schemaVersion': 2,
                'checks': [{'id': 'x', 'predicate': {'kind': 'boolean', 'actual': {'value': True}, 'expected': True}}]})


if __name__ == '__main__':
    unittest.main()
