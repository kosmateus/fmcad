"""GM25 offline tests: 3D routing centerline, inspection, cut-list and motion states."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/route3d.py').read_text(), 'route3d.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class Route3dTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def test_spatial_route_with_inflection(self):
        data = {'schemaVersion': 1, 'waypoints': [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '10 mm'],
                ['0 mm', '0 mm', '20 mm']], 'up': [0, 0, 1]}
        result = self.call('route.create3d', data)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['state'], 'numerically-solved')
        self.assertGreater(result['arcLength'], 0)
        self.assertIsNotNone(result['minBendRadius'])
        self.assertTrue(result['frames'])
        self.assertIn('position', result['frames'][0])

    def test_known_arc_bend_radius(self):
        data = {'schemaVersion': 1, 'centerline': [['10 mm', '0 mm', '0 mm'],
                ['7.0710678 mm', '7.0710678 mm', '0 mm'], ['0 mm', '10 mm', '0 mm']]}
        result = self.call('route.inspect', data)
        self.assertAlmostEqual(result['minBendRadius'], 1.0, places=3)

    def test_inflection_has_no_zero_bend_radius(self):
        data = {'schemaVersion': 1, 'waypoints': [['0 mm', '0 mm', '0 mm'], ['10 mm', '5 mm', '0 mm'],
                ['20 mm', '0 mm', '0 mm']]}
        result = self.call('route.inspect', data)
        self.assertGreater(result['minBendRadius'], 0)

    def test_cut_list_1_1_l_plus_two_tails(self):
        data = {'schemaVersion': 1, 'length': '100 mm', 'allowanceFactor': 1.1, 'serviceTail': '15 mm'}
        result = self.call('route.cut-list', data)
        self.assertAlmostEqual(result['cutLengthPerPiece'], 140.0, places=5)
        self.assertIn('1.1', result['interpretation'])

    def test_cut_list_no_double_tail(self):
        data = {'schemaVersion': 1, 'length': '100 mm', 'allowanceFactor': 1.1,
                'serviceTail': '15 mm', 'serviceTailModeled': True}
        result = self.call('route.cut-list', data)
        self.assertAlmostEqual(result['cutLengthPerPiece'], 110.0, places=5)
        self.assertTrue(any('not added again' in w for w in result['warnings']))

    def test_motion_states_pan_tilt_product_preserves_length(self):
        data = {'schemaVersion': 1, 'length': '100 mm',
                'pan': {'min': '-45 deg', 'max': '45 deg'}, 'tilt': {'min': '-30 deg', 'max': '30 deg'},
                'minBendRadius': '5 mm'}
        result = self.call('route.motion-states', data)
        self.assertEqual(len(result['states']), 4)
        self.assertTrue(result['lengthPreserved'])
        self.assertTrue(all(s['lengthPreserved'] for s in result['states']))
        self.assertIn('cartesian', result['extremeCoverage'])

    def test_motion_states_set_state_for_explicit_pose(self):
        data = {'schemaVersion': 1, 'length': '100 mm',
                'poses': [{'pan': '0 deg', 'tilt': '0 deg', 'bendRadius': '8 mm'}]}
        result = self.call('route.motion-states', data)
        self.assertEqual(result['states'][0]['state'], 'set')
        self.assertAlmostEqual(result['states'][0]['requiredBendRadius'], 0.8, places=5)

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.call('route.create3d', {'schemaVersion': 1, 'waypoints': [['0 mm', '0 mm', '0 mm']]})
        with self.assertRaises(ValueError):
            self.call('route.cut-list', {'schemaVersion': 1, 'length': '0 mm'})
        with self.assertRaises(ValueError):
            self.call('route.motion-states', {'schemaVersion': 1, 'length': '100 mm'})


if __name__ == '__main__':
    unittest.main()
