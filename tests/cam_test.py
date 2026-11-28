"""GM14 offline tests: cam profile normal offset, pressure angle, curvature and cycle resolution."""
import math
from pathlib import Path
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
    exec(compile((ROOT / 'assets/cad/cam.py').read_text(), 'cam.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class CamTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def half_cosine(self, **extra):
        data = {'schemaVersion': 1, 'frame': 'component', 'baseRadius': '15 mm', 'rollerRadius': '5 mm',
                'rise': {'law': 'halfCosine', 'lift': '10 mm', 'angle': '240 deg'},
                'followerLine': [0, 1, 0], 'phase': '0 deg', 'direction': 'ccw'}
        data.update(extra)
        return data

    def test_pressure_angle_and_curvature_match_source(self):
        result = self.call('cam.profile', self.half_cosine())
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['maxPressureAngle']['value'], 10.95961788503868, places=4)
        self.assertAlmostEqual(result['minPitchCurvatureRadius']['value'], 18.326658996398017, places=4)

    def test_working_profile_is_normal_offset_not_radial(self):
        result = self.call('cam.profile', self.half_cosine())
        self.assertEqual(result['normalOffset']['value'], 5.0)
        pitch = result['pitchProfile']
        working = result['workingProfile']
        # At the start of rise (radius 15), normal and radial coincide: working radius is 10.
        self.assertAlmostEqual(math.hypot(*working[0]), 10.0, places=6)
        # Every working point is exactly one roller radius from its pitch point (normal offset).
        mid = len(pitch) // 2
        for i in range(0, len(pitch), len(pitch) // 20):
            gap = math.hypot(pitch[i][0] - working[i][0], pitch[i][1] - working[i][1])
            self.assertAlmostEqual(gap, 5.0, places=6)

    def test_samples_reproduce_rise_and_normal_offset(self):
        samples = []
        for deg in range(0, 241, 15):
            theta = math.radians(deg)
            lift = 5.0 * (1.0 - math.cos(math.pi * theta / math.radians(240)))
            samples.append({'angle': '%.1f deg' % deg, 'lift': '%.6f mm' % lift})
        result = self.call('cam.profile', self.half_cosine(rise={'samples': samples}))
        self.assertEqual(result['status'], 'pass')
        pitch = result['pitchProfile']
        self.assertAlmostEqual(math.hypot(*pitch[0]), 15.0, places=4)
        self.assertAlmostEqual(math.hypot(*pitch[-1]), 25.0, places=4)
        self.assertGreater(result['minPitchCurvatureRadius']['value'], 5.0)

    def test_cycle_check_reports_unresolved_release(self):
        result = self.call('cam.cycle-check', {'schemaVersion': 1, 'frame': 'component',
            'rise': {'law': 'halfCosine', 'lift': '10 mm', 'angle': '240 deg'}})
        self.assertEqual(result['cycleStatus'], 'unknown')
        self.assertTrue(any(u['interval'] == 'release' for u in result['unresolvedIntervals']))
        self.assertEqual(result['dropEdgeDynamics'], 'blocked (no proper definition or evidence)')

    def test_cycle_check_with_return_law_resolves_release(self):
        result = self.call('cam.cycle-check', {'schemaVersion': 1, 'frame': 'component',
            'rise': {'law': 'halfCosine', 'lift': '10 mm', 'angle': '240 deg'}, 'returnLaw': 'spring-return'})
        self.assertIn('release', result['resolvedIntervals'])
        self.assertTrue(any(u['interval'] == 'dwell' for u in result['unresolvedIntervals']))
        self.assertEqual(result['cycleStatus'], 'unknown')

    def test_cycle_check_full_cycle_resolves(self):
        result = self.call('cam.cycle-check', {'schemaVersion': 1, 'frame': 'component',
            'rise': {'law': 'halfCosine', 'lift': '10 mm', 'angle': '240 deg'}, 'returnLaw': 'spring-return', 'dwell': {}})
        self.assertEqual(result['cycleStatus'], 'pass')

    def test_evaluate_declared_limits(self):
        result = self.call('cam.evaluate', self.half_cosine(maximumPressureAngle='12 deg', minimumCurvatureRadius='10 mm'))
        self.assertEqual(result['status'], 'pass')
        checks = {c['check']: c['status'] for c in result['checks']}
        self.assertEqual(checks['pressure-angle'], 'pass')
        self.assertEqual(checks['curvature'], 'pass')


if __name__ == '__main__':
    unittest.main()
