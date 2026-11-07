"""GM28 offline tests: frusta, coverage, occlusion and sensor alignment."""
import math
from pathlib import Path
import unittest

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/optics.py').read_text(), 'optics.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class OpticsTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def frustum(self, **extra):
        data = {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm'], 'direction': [0, 0, 1], 'up': [0, 1, 0]},
                'fov': {'horizontal': '60 deg', 'vertical': '40 deg'},
                'ranges': {'near': '10 mm', 'far': '100 mm'}}
        data.update(extra)
        return data

    def test_frustum_basis_and_corners(self):
        result = self.call('optics.frustum', self.frustum())
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['axis'], [0, 0, 1])
        self.assertEqual(result['horizontal'], [0, 1, 0])
        self.assertEqual(result['vertical'], [-1, 0, 0])
        self.assertAlmostEqual(result['halfAngles']['horizontal'], math.pi / 6, places=5)
        self.assertAlmostEqual(result['halfAngles']['vertical'], math.radians(20), places=5)
        near = result['corners']['near']
        self.assertEqual(len(near), 4)
        self.assertAlmostEqual(near[0][0], 1.0 * math.tan(math.radians(20)), places=5)
        self.assertAlmostEqual(near[0][1], -1.0 * math.tan(math.radians(30)), places=5)
        self.assertAlmostEqual(near[0][2], 1.0, places=5)
        self.assertFalse(result['windowLimited'])

    def test_window_edge_limits_the_cone(self):
        result = self.call('optics.frustum', self.frustum(window={'distance': '50 mm', 'width': '20 mm', 'height': '20 mm'}))
        self.assertTrue(result['windowLimited'])
        expected = math.atan(1.0 / 5.0)
        self.assertAlmostEqual(result['effectiveHalfAngles']['horizontal'], expected, places=5)
        self.assertAlmostEqual(result['effectiveHalfAngles']['vertical'], expected, places=5)
        self.assertLess(result['effectiveHalfAngles']['horizontal'], result['halfAngles']['horizontal'])

    def test_frustum_rejects_bad_ranges(self):
        with self.assertRaises(ValueError):
            self.call('optics.frustum', self.frustum(ranges={'near': '10 mm', 'far': '5 mm'}))
        with self.assertRaises(ValueError):
            self.call('optics.frustum', self.frustum(fov={'horizontal': '180 deg', 'vertical': '40 deg'}))

    def test_coverage_union_is_below_sum_with_dead_zones(self):
        data = {'schemaVersion': 1,
                'sensors': [
                    {'name': 'camA', 'pupil': {'origin': ['-20 mm', '0 mm', '30 mm'], 'direction': [0.5, 0, -0.866], 'up': [0, 1, 0]}, 'fov': {'horizontal': '40 deg', 'vertical': '30 deg'}, 'ranges': {'near': '1 mm', 'far': '100 mm'}},
                    {'name': 'camB', 'pupil': {'origin': ['20 mm', '0 mm', '30 mm'], 'direction': [-0.5, 0, -0.866], 'up': [0, 1, 0]}, 'fov': {'horizontal': '40 deg', 'vertical': '30 deg'}, 'ranges': {'near': '1 mm', 'far': '100 mm'}}],
                'targets': [{'name': 'board', 'origin': ['0 mm', '0 mm', '0 mm'], 'normal': [0, 0, 1], 'u': [1, 0, 0],
                             'outline': [['-30 mm', '-30 mm'], ['30 mm', '-30 mm'], ['30 mm', '30 mm'], ['-30 mm', '30 mm']]}],
                'samplingBudget': 40000}
        result = self.call('optics.coverage', data)
        target = result['targets'][0]
        self.assertGreater(target['unionCoveredArea'], 0)
        self.assertGreater(target['sumIndividualArea'], target['unionCoveredArea'])
        self.assertGreater(target['coveredFraction'], 0)
        self.assertLess(target['coveredFraction'], 1)
        self.assertGreater(target['deadZoneFraction'], 0)

    def test_coverage_reports_near_field_gap(self):
        data = {'schemaVersion': 1,
                'sensors': [{'name': 'cam', 'pupil': {'origin': ['0 mm', '0 mm', '30 mm'], 'direction': [0, 0, -1]},
                             'fov': {'horizontal': '60 deg', 'vertical': '60 deg'}, 'ranges': {'near': '50 mm', 'far': '200 mm'}}],
                'targets': [{'name': 'board', 'origin': ['0 mm', '0 mm', '0 mm'], 'normal': [0, 0, 1], 'u': [1, 0, 0],
                             'outline': [['-10 mm', '-10 mm'], ['10 mm', '-10 mm'], ['10 mm', '10 mm'], ['-10 mm', '10 mm']]}],
                'samplingBudget': 40000}
        result = self.call('optics.coverage', data)
        target = result['targets'][0]
        self.assertGreater(target['nearFieldGapFraction'], 0.9)
        self.assertLess(target['coveredFraction'], 0.05)

    def test_occlusion_baffle_blocks_line(self):
        data = {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
                'rays': [{'target': ['0 mm', '0 mm', '50 mm']}],
                'obstacles': [{'name': 'baffle', 'kind': 'baffle', 'shape': {'type': 'disk', 'origin': ['0 mm', '0 mm', '25 mm'], 'normal': [0, 0, 1], 'radius': '4 mm'}}]}
        result = self.call('optics.occlusion', data)
        self.assertEqual(result['rays'][0]['result'], 'blocked')
        self.assertEqual(result['rays'][0]['obstacleName'], 'baffle')
        self.assertEqual(result['blockedCount'], 1)

    def test_occlusion_declared_window_passes(self):
        data = {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
                'rays': [{'target': ['0 mm', '0 mm', '50 mm']}],
                'obstacles': [{'name': 'window', 'kind': 'window', 'transmittance': 0.9, 'shape': {'type': 'disk', 'origin': ['0 mm', '0 mm', '25 mm'], 'normal': [0, 0, 1], 'radius': '8 mm'}}]}
        result = self.call('optics.occlusion', data)
        self.assertEqual(result['rays'][0]['result'], 'window')
        self.assertAlmostEqual(result['rays'][0]['transmittance'], 0.9)
        self.assertEqual(result['transparentCount'], 1)

    def test_occlusion_render_transparent_surface_is_not_physically_transparent(self):
        data = {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
                'rays': [{'target': ['0 mm', '0 mm', '50 mm']}],
                'obstacles': [{'name': 'fake-window', 'kind': 'window', 'shape': {'type': 'disk', 'origin': ['0 mm', '0 mm', '25 mm'], 'normal': [0, 0, 1], 'radius': '8 mm'}}]}
        result = self.call('optics.occlusion', data)
        self.assertEqual(result['rays'][0]['result'], 'blocked')

    def test_occlusion_transparent_by_default_policy(self):
        data = {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
                'rays': [{'target': ['0 mm', '0 mm', '50 mm']}],
                'policy': {'transparentByDefault': True},
                'obstacles': [{'name': 'window', 'kind': 'window', 'shape': {'type': 'disk', 'origin': ['0 mm', '0 mm', '25 mm'], 'normal': [0, 0, 1], 'radius': '8 mm'}}]}
        result = self.call('optics.occlusion', data)
        self.assertEqual(result['rays'][0]['result'], 'window')

    def test_occlusion_clear_line_and_box_obstacle(self):
        clear = self.call('optics.occlusion', {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
            'rays': [{'target': ['0 mm', '0 mm', '50 mm']}]})
        self.assertEqual(clear['rays'][0]['result'], 'clear')
        boxed = self.call('optics.occlusion', {'schemaVersion': 1, 'pupil': {'origin': ['0 mm', '0 mm', '0 mm']},
            'rays': [{'target': ['0 mm', '0 mm', '50 mm']}],
            'obstacles': [{'name': 'wall', 'kind': 'opaque', 'shape': {'type': 'box', 'min': ['-10 mm', '-10 mm', '20 mm'], 'max': ['10 mm', '10 mm', '30 mm']}}]})
        self.assertEqual(boxed['rays'][0]['result'], 'blocked')
        self.assertEqual(boxed['rays'][0]['obstacleName'], 'wall')

    def test_sensor_aligned(self):
        data = {'schemaVersion': 1,
                'sensor': {'name': 'ir', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                'reference': {'name': 'magnet', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                'limits': {'angle': '5 deg', 'offset': '0.5 mm'}}
        result = self.call('sensor.alignment-check', data)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['aligned'])
        self.assertAlmostEqual(result['angleDeviation'], 0.0, places=6)
        self.assertEqual(result['violations'], [])

    def test_sensor_angle_and_offset_violations(self):
        data = {'schemaVersion': 1,
                'sensor': {'name': 'ir', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, math.sin(math.radians(10)), math.cos(math.radians(10))]},
                'reference': {'name': 'magnet', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                'limits': {'angle': '5 deg', 'offset': '0.5 mm'}}
        result = self.call('sensor.alignment-check', data)
        self.assertEqual(result['status'], 'fail')
        self.assertFalse(result['aligned'])
        self.assertAlmostEqual(result['angleDeviationDegrees'], 10.0, places=3)
        self.assertTrue(any('angle' in v for v in result['violations']))

        offset = {'schemaVersion': 1,
                  'sensor': {'name': 'ir', 'origin': ['1 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                  'reference': {'name': 'magnet', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                  'limits': {'angle': '5 deg', 'offset': '0.5 mm'}}
        result = self.call('sensor.alignment-check', offset)
        self.assertFalse(result['aligned'])
        self.assertAlmostEqual(result['lateralOffset'], 0.1, places=5)

    def test_sensor_forbidden_material_zone(self):
        data = {'schemaVersion': 1,
                'sensor': {'name': 'ir', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                'reference': {'name': 'magnet', 'origin': ['0 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1]},
                'limits': {'angle': '5 deg', 'offset': '0.5 mm'},
                'forbiddenZones': [{'name': 'magnet-zone', 'type': 'box', 'min': ['0 mm', '0 mm', '0 mm'], 'max': ['10 mm', '10 mm', '10 mm']}]}
        result = self.call('sensor.alignment-check', data)
        self.assertEqual(result['status'], 'fail')
        self.assertIn('magnet-zone', result['forbiddenZoneIntersections'])
        self.assertTrue(any('forbidden' in v for v in result['violations']))


if __name__ == '__main__':
    unittest.main()
