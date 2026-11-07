"""GM13 offline tests: thread catalog, custom profiles, pair checks and the model.thread extension."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/thread.py').read_text(), 'thread.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class ThreadTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def test_catalog_m10_coarse(self):
        result = self.call('thread.catalog', {'schemaVersion': 1, 'frame': 'component', 'system': 'iso-metric-coarse', 'query': 'M10'})
        self.assertEqual(result['status'], 'pass')
        entry = result['entries'][0]
        self.assertEqual(entry['designation'], 'M10')
        self.assertAlmostEqual(entry['pitch']['value'], 1.5)
        self.assertAlmostEqual(entry['lead']['value'], 1.5)
        self.assertAlmostEqual(entry['majorDiameter']['value'], 10.0)

    def test_custom_profile_lead_is_starts_times_pitch(self):
        result = self.call('thread.custom-profile', {'schemaVersion': 1, 'frame': 'component',
            'majorDiameter': '10 mm', 'pitch': '1.5 mm', 'starts': 3, 'hand': 'right'})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['profile']['lead']['value'], 4.5)
        self.assertEqual(result['profile']['starts'], 3)
        self.assertAlmostEqual(result['profile']['turnsPerLength']['value'], 1 / 4.5, places=9)

    def test_custom_profile_rejects_minor_and_pitch_diameter_together(self):
        with self.assertRaisesRegex(ValueError, 'both minorDiameter and pitchDiameter'):
            self.call('thread.custom-profile', {'schemaVersion': 1, 'frame': 'component',
                'majorDiameter': '10 mm', 'minorDiameter': '8 mm', 'pitchDiameter': '9 mm', 'pitch': '1.5 mm'})

    def test_pair_check_rh_pair_passes(self):
        result = self.call('thread.pair-check', {'schemaVersion': 1, 'frame': 'component',
            'external': {'majorDiameter': '10 mm', 'minorDiameter': '8.16 mm', 'pitch': '1.5 mm', 'starts': 1, 'hand': 'right'},
            'internal': {'majorDiameter': '10 mm', 'minorDiameter': '8.38 mm', 'pitch': '1.5 mm', 'starts': 1, 'hand': 'right'}})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['pairFit'], 'pass')
        self.assertAlmostEqual(result['engagementDepth']['value'], (10 - 8.38) / 2, places=9)

    def test_pair_check_hand_mismatch_fails(self):
        result = self.call('thread.pair-check', {'schemaVersion': 1, 'frame': 'component',
            'external': {'majorDiameter': '10 mm', 'minorDiameter': '8.16 mm', 'pitch': '1.5 mm', 'starts': 1, 'hand': 'right'},
            'internal': {'majorDiameter': '10 mm', 'minorDiameter': '8.38 mm', 'pitch': '1.5 mm', 'starts': 1, 'hand': 'left'}})
        self.assertEqual(result['status'], 'fail')

    def test_pair_check_multistart_lead_must_match(self):
        result = self.call('thread.pair-check', {'schemaVersion': 1, 'frame': 'component',
            'external': {'majorDiameter': '10 mm', 'minorDiameter': '8.16 mm', 'pitch': '1.5 mm', 'starts': 2, 'hand': 'right'},
            'internal': {'majorDiameter': '10 mm', 'minorDiameter': '8.38 mm', 'pitch': '3.0 mm', 'starts': 1, 'hand': 'right'}})
        # Both leads are 3 mm but starts differ: must fail on starts.
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(c['check'] == 'starts' and c['status'] == 'fail' for c in result['checks']))

    def test_model_thread_tabular_delegates_to_native(self):
        ctx = model.Context()
        result = HANDLERS['model.thread'](ctx, {'faces': ['cylinder-face-token'], 'internal': False,
            'threadType': 'ISO Metric profile', 'designation': 'M10x1.5', 'class': '6g', 'modeled': True})
        self.assertIn('feature', result)
        self.assertTrue(any(t[0] == 'threadInfo' for t in model.TRACE))

    def test_model_thread_custom_profile_is_recipe(self):
        result = self.call('model.thread', {'faces': ['cylinder-face-token'], 'internal': False,
            'profile': {'majorDiameter': '10 mm', 'pitch': '1.5 mm', 'starts': 2, 'hand': 'right'}})
        self.assertEqual(result['representation'], 'recipe')
        self.assertAlmostEqual(result['lead']['value'], 3.0)
        self.assertEqual(result['starts'], 2)


if __name__ == '__main__':
    unittest.main()
