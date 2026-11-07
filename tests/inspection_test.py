import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('inspection', ROOT / 'runtime/python/fmcad/domain/inspection.py')
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class InspectionTests(unittest.TestCase):
    def plan(self, reads=None, **limits):
        return dict(reads=reads or [dict(id='one', operation='read', data={})], inventory=['read'],
                    maxItems=100, maxDepth=8, maxStringBytes=2048, maxBytes=65536, **limits)

    def pack(self, value, **limits):
        plan = self.plan()
        plan.update(limits)
        return inspection.inspection_pack(plan, lambda op, data: value, lambda value: value)

    def test_equivalent_read_and_projection(self):
        value = {'entities': [{'name': 'part', 'volume': 2}], 'count': 1}
        self.assertEqual(self.pack(value)['items'][0]['result'], value)
        plan = self.plan()
        plan['reads'][0]['fields'] = ['entities', 'missing']
        result = inspection.inspection_pack(plan, lambda op, data: value, lambda value: value)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['items'][0]['reasons'], ['missingFields'])
        self.assertEqual(result['items'][0]['result'], {'entities': value['entities']})

    def test_large_inventory_and_unicode_output_bound(self):
        result = self.pack({'entities': [{'name': '🙂' * 10000}] * 100000}, maxItems=3, maxStringBytes=17)
        row = result['items'][0]
        self.assertEqual(row['status'], 'partial')
        self.assertEqual(len(row['result']['entities']), 3)
        self.assertLessEqual(len(row['result']['entities'][0]['name'].encode()), 17)
        self.assertEqual(row['reasons'], ['maxItems', 'maxStringBytes'])
        result = self.pack({'entities': ['x' * 8192] * 1000}, maxItems=1000, maxBytes=1024)
        self.assertLessEqual(len(json.dumps(result).encode()), 1024)
        self.assertIn('maxBytes', result['items'][0]['reasons'])

    def test_depth_and_nonpassing_evidence(self):
        self.assertIn('maxDepth', self.pack({'a': {'b': 2}}, maxDepth=1)['items'][0]['reasons'])
        for status in ('fail', 'error', 'skipped', 'notEvaluated', 'unknown', 'unsupported', 'missing', 'stale', 'partial', 'blocked'):
            result = self.pack({'status': status, 'success': True})
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['items'][0]['result']['status'], status)

    def test_projection_work_stops_at_shared_byte_budget(self):
        calls = []
        value = {'entities': ['x' * 8192] * 1000}
        plan = self.plan()
        plan.update(maxItems=1000, maxBytes=1024, maxStringBytes=8192)
        result = inspection.inspection_pack(plan, lambda *_: value, lambda item: calls.append(item) or item)
        self.assertLess(len(calls), 10)
        self.assertEqual(result['status'], 'partial')
        self.assertLessEqual(len(json.dumps(result).encode()), 1024)

    def test_unsupported_and_error_do_not_stop_other_reads(self):
        reads = [dict(id=str(i), operation=op, data={}) for i, op in enumerate(['mutation', 'read', 'read'])]
        calls = []

        def dispatch(op, data):
            calls.append(op)
            if len(calls) == 1:
                raise ValueError('broken read')
            return {'ok': True}

        result = inspection.inspection_pack(self.plan(reads), dispatch, lambda value: value)
        self.assertEqual([row['status'] for row in result['items']], ['unsupported', 'error', 'pass'])
        self.assertEqual(calls, ['read', 'read'])
        self.assertEqual(result['status'], 'partial')

    def test_tiny_budget_omits_rows_explicitly(self):
        reads = [dict(id='x' * 60 + str(i), operation='missing.' + 'a' * 110, data={}) for i in range(100)]
        result = inspection.inspection_pack(self.plan(reads), lambda *_: self.fail('unsupported dispatched'), lambda value: value)
        plan = self.plan(reads)
        plan['maxBytes'] = 1024
        result = inspection.inspection_pack(plan, lambda *_: self.fail('unsupported dispatched'), lambda value: value)
        self.assertLessEqual(len(json.dumps(result).encode()), 1024)
        self.assertGreater(result['omittedReads'], 0)
        self.assertEqual(len(result['items']) + result['omittedReads'], 100)


if __name__ == '__main__':
    unittest.main()
