"""GM12 offline tests: helix generation, spring evaluation and configuration.

Uses the shared model_test mock namespace; handlers execute, not just compile.
"""
import math
from pathlib import Path
import types
import unittest
import sys
from unittest.mock import patch

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
# Earlier isolated suites may have restored sys.modules after importing model_test.
with patch.dict(sys.modules, {
    'adsk': model.adsk, 'adsk.core': model.adsk.core,
    'adsk.fusion': model.adsk.fusion,
}):
    exec(compile((ROOT / 'assets/cad/spring.py').read_text(), 'spring.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class SpringContext(model.Context):
    def call(self, operation, data):
        return HANDLERS[operation](self, data)


class SpringTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](SpringContext(), data)

    def test_helix_pitch_and_turns_derive_height_and_arc_length(self):
        result = self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                           'pitch': '5.75 mm', 'turns': 8, 'hand': 'right'})
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['radius']['value'], 4.0)
        self.assertAlmostEqual(result['pitch']['value'], 5.75, places=9)
        self.assertEqual(result['turns'], 8)
        self.assertAlmostEqual(result['height']['value'], 46.0)
        turn = math.hypot(5.75, 2 * math.pi * 4.0)
        self.assertAlmostEqual(result['arcLength']['value'], turn * 8, places=9)
        curvature = 4.0 / (4.0 ** 2 + (5.75 / (2 * math.pi)) ** 2)
        self.assertAlmostEqual(result['curvature']['value'], curvature, places=9)

    def test_helix_turns_height_derive_pitch(self):
        result = self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                           'turns': 8, 'height': '46 mm'})
        self.assertAlmostEqual(result['pitch']['value'], 5.75, places=9)

    def test_helix_left_hand_flips_winding(self):
        right = self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                          'pitch': '5.75 mm', 'turns': 1, 'hand': 'right'})
        left = self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                         'pitch': '5.75 mm', 'turns': 1, 'hand': 'left'})
        self.assertEqual(right['hand'], 'right')
        self.assertEqual(left['hand'], 'left')

    def test_helix_contradictory_pitch_and_height_rejected(self):
        with self.assertRaisesRegex(ValueError, 'contradictory'):
            self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                      'pitch': '5.75 mm', 'height': '46 mm', 'turns': 8})
        with self.assertRaisesRegex(ValueError, 'turns and height'):
            self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm'})

    def test_native_representation_is_blocked(self):
        result = self.call('curve.helix', {'schemaVersion': 1, 'frame': 'component', 'radius': '4 mm',
                                           'pitch': '5.75 mm', 'turns': 8, 'representation': 'native'})
        self.assertEqual(result['status'], 'blocked')

    def test_shape_helix_generates(self):
        result = HANDLERS['shape.helix'](model.Context(), {'schemaVersion': 1, 'frame': 'component',
                                                           'radius': '4 mm', 'pitch': '5.75 mm', 'turns': 8})
        self.assertEqual(result['status'], 'pass')
        self.assertIn('arcLength', result)

    def test_p054_spring_stiffness_forces_and_solid_height(self):
        data = {'schemaVersion': 1, 'frame': 'component', 'wireDiameter': '0.5 mm', 'meanDiameter': '8 mm',
                'activeCoils': 6, 'totalCoils': 8, 'freeLength': '35 mm',
                'shearModulus': '77000 N/mm^2', 'density': '7850 kg/m^3',
                'installedLength': '27 mm', 'compressedLength': '17 mm'}
        result = self.call('spring.evaluate', data)
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['stiffness']['value'], 0.19582112630208334, places=12)
        self.assertAlmostEqual(result['solidHeight']['value'], 4.0, places=9)
        forces = {f['state']: f['force']['value'] for f in result['forces']}
        self.assertAlmostEqual(forces['compressed'], 0.19582112630208334 * 18, places=9)
        self.assertAlmostEqual(forces['installed'], 0.19582112630208334 * 8, places=9)

    def test_compressed_below_solid_height_fails(self):
        data = {'schemaVersion': 1, 'frame': 'component', 'wireDiameter': '0.5 mm', 'meanDiameter': '8 mm',
                'activeCoils': 6, 'totalCoils': 8, 'freeLength': '35 mm', 'compressedLength': '3 mm'}
        result = self.call('spring.configure', data)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any(c['check'] == 'material-volume' and c['status'] == 'fail' for c in result['checks']))

    def test_guide_rod_clearance(self):
        data = {'schemaVersion': 1, 'frame': 'component', 'wireDiameter': '0.5 mm', 'meanDiameter': '8 mm',
                'activeCoils': 6, 'totalCoils': 8, 'freeLength': '35 mm',
                'installedLength': '27 mm', 'compressedLength': '17 mm',
                'guide': {'kind': 'rod', 'diameter': '7.4 mm'}}
        result = self.call('spring.configure', data)
        rod = next(c for c in result['checks'] if c['check'] == 'guide-rod')
        self.assertEqual(rod['status'], 'pass')
        self.assertAlmostEqual(rod['clearance']['value'], 0.1, places=9)

    def test_shape_spring_geometry_metrics(self):
        data = {'schemaVersion': 1, 'frame': 'component', 'name': 'Spring', 'wireDiameter': '0.5 mm',
                'meanDiameter': '8 mm', 'activeCoils': 6, 'totalCoils': 8, 'freeLength': '35 mm',
                'endStyle': 'ground', 'hand': 'right'}
        result = self.call('shape.spring', data)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['outerDiameter']['value'], 8.5)
        self.assertEqual(result['innerDiameter']['value'], 7.5)
        self.assertAlmostEqual(result['stiffness']['value'], 79000 * 0.5 ** 4 / (8 * 8 ** 3 * 6), places=9)
        self.assertAlmostEqual(result['solidHeight']['value'], 4.0, places=9)

    def test_shape_spring_affected_has_no_none_and_no_ground_end_claim(self):
        data = {'schemaVersion': 1, 'frame': 'component', 'name': 'Spring', 'wireDiameter': '0.5 mm',
                'meanDiameter': '8 mm', 'activeCoils': 6, 'totalCoils': 8, 'freeLength': '35 mm',
                'endStyle': 'ground', 'hand': 'right'}
        result = self.call('shape.spring', data)
        self.assertIsInstance(result['affected'], list)
        self.assertNotIn(None, result['affected'])
        self.assertEqual(result['affected'], [])
        self.assertTrue(all('produce real end geometry' not in a for a in result['assumptions']))
        self.assertTrue(all('live-validated' not in l for l in result['limitations']))


if __name__ == '__main__':
    unittest.main()
