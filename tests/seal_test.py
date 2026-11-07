"""GM15 offline tests: O-ring torus volume, glands, profiles and dock sequences."""
import math
import unittest

import shapes_test as shapes

NAMESPACE = dict(shapes.NAMESPACE)
NAMESPACE['CAD_HANDLERS'] = dict(shapes.NAMESPACE['CAD_HANDLERS'])
exec(compile((shapes.ROOT / 'assets/cad/seal.py').read_text(), 'seal.py', 'exec'), NAMESPACE)


class SealTests(unittest.TestCase):
    def setUp(self):
        self.ctx = shapes.Context()
        shapes.model.TRACE.clear()

    def call(self, operation, data):
        return NAMESPACE['CAD_HANDLERS'][operation](self.ctx, data)

    def test_o_ring_volume_matches_closed_form(self):
        result = self.call('shape.o_ring', {'schemaVersion': 1, 'frame': 'component',
                                            'name': 'ORing', 'id': '10 mm', 'cs': '2 mm'})
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['torus'])
        self.assertAlmostEqual(result['innerDiameter']['value'], 10.0, places=6)
        self.assertAlmostEqual(result['cs']['value'], 2.0, places=6)
        self.assertAlmostEqual(result['meanRadius']['value'], 6.0, places=6)
        self.assertAlmostEqual(result['crossRadius']['value'], 1.0, places=6)
        expected = 2.0 * math.pi ** 2 * 6.0 * 1.0 ** 2
        self.assertAlmostEqual(result['volume']['value'], expected, places=6)
        self.assertIn('feature', result)

    def test_o_ring_rejects_zero_or_oversized_cs(self):
        for cs in ('0 mm', '10 mm', '12 mm'):
            with self.assertRaises(ValueError):
                self.call('shape.o_ring', {'schemaVersion': 1, 'frame': 'component',
                                           'name': 'ORing', 'id': '10 mm', 'cs': cs})

    def test_o_ring_default_plane_contains_revolve_axis(self):
        result = self.call('shape.o_ring', {'schemaVersion': 1, 'frame': 'component',
                                            'name': 'ORing', 'id': '10 mm', 'cs': '2 mm'})
        self.assertEqual(result['status'], 'pass')
        sketch_create = [d for op, d in self.ctx.calls if op == 'sketch.create'][0]
        self.assertEqual(sketch_create['plane'], 'XZ')

    def test_o_ring_rejects_plane_perpendicular_to_axis(self):
        with self.assertRaisesRegex(ValueError, 'contains the axis'):
            self.call('shape.o_ring', {'schemaVersion': 1, 'frame': 'component',
                                       'name': 'ORing', 'id': '10 mm', 'cs': '2 mm',
                                       'plane': 'XY', 'axis': 'Z'})

    def test_o_ring_rejects_x_axis_degenerate_offset(self):
        with self.assertRaisesRegex(ValueError, 'X axis'):
            self.call('shape.o_ring', {'schemaVersion': 1, 'frame': 'component',
                                       'name': 'ORing', 'id': '10 mm', 'cs': '2 mm',
                                       'axis': 'X'})

    def test_gland_squeeze_and_fill_ranges(self):
        result = self.call('seal.gland', {'schemaVersion': 1, 'frame': 'component', 'type': 'radial',
                                          'oRing': {'id': '10 mm', 'cs': '2 mm'}, 'squeeze': 0.15,
                                          'hardStop': {'clearance': '0.05 mm'}})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['gland']['depth']['value'], 1.7, places=6)
        self.assertAlmostEqual(result['squeeze']['nominal'], 0.15, places=6)
        self.assertAlmostEqual(result['fill']['nominal'], 0.75, places=4)
        self.assertEqual(result['hardStop']['role'], 'limits gland compression to the metallic contact; does not set squeeze')

    def test_gland_excessive_squeeze_fails(self):
        result = self.call('seal.gland', {'schemaVersion': 1, 'frame': 'component', 'type': 'radial',
                                          'oRing': {'id': '10 mm', 'cs': '2 mm'}, 'squeeze': 0.5})
        self.assertEqual(result['status'], 'fail')
        squeeze_check = next(c for c in result['checks'] if c['check'] == 'squeeze')
        self.assertEqual(squeeze_check['status'], 'fail')

    def test_gland_requires_depth_or_squeeze(self):
        with self.assertRaises(ValueError):
            self.call('seal.gland', {'schemaVersion': 1, 'frame': 'component', 'type': 'radial',
                                     'oRing': {'id': '10 mm', 'cs': '2 mm'}})

    def test_profile_custom_cross_section_is_not_an_o_ring(self):
        points = [['0 mm', '0 mm'], ['2 mm', '0 mm'], ['2 mm', '1.5 mm'], ['0 mm', '1.5 mm'], ['0 mm', '0 mm']]
        result = self.call('seal.profile', {'schemaVersion': 1, 'frame': 'component',
                                            'crossSection': {'shape': 'custom', 'points': points},
                                            'layout': 'gasket', 'path': {'closed': True, 'length': '80 mm'}})
        self.assertEqual(result['status'], 'pass')
        self.assertFalse(result['crossSection']['isPlainORing'])
        self.assertTrue(result['crossSection']['continuity']['closed'])
        self.assertEqual(result['envelope']['type'], 'sweep')

    def test_profile_open_custom_cross_section_rejected(self):
        points = [['0 mm', '0 mm'], ['2 mm', '0 mm'], ['2 mm', '1.5 mm']]
        with self.assertRaises(ValueError):
            self.call('seal.profile', {'schemaVersion': 1, 'frame': 'component',
                                       'crossSection': {'shape': 'custom', 'points': points},
                                       'layout': 'face', 'axis': 'Z'})

    def test_profile_circle_is_plain_o_ring(self):
        result = self.call('seal.profile', {'schemaVersion': 1, 'frame': 'component',
                                            'crossSection': {'shape': 'circle', 'radius': '1 mm'},
                                            'layout': 'face', 'axis': 'Z'})
        self.assertTrue(result['crossSection']['isPlainORing'])

    def test_evaluate_squeeze_fill_and_missing_gap(self):
        result = self.call('seal.evaluate', {'schemaVersion': 1, 'frame': 'component',
                                             'oRing': {'id': '10 mm', 'cs': '2 mm'},
                                             'gland': {'depth': '1.6 mm', 'width': '2.4 mm'}, 'type': 'radial'})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['squeeze'], 0.2, places=6)
        gap = next(c for c in result['checks'] if c['check'] == 'extrusion-gap')
        self.assertEqual(gap['status'], 'notEvaluated')

    def test_evaluate_seal_exceeds_groove_fails(self):
        result = self.call('seal.evaluate', {'schemaVersion': 1, 'frame': 'component',
                                             'oRing': {'id': '10 mm', 'cs': '2 mm'},
                                             'gland': {'depth': '1.4 mm', 'width': '1.5 mm'}})
        self.assertEqual(result['status'], 'fail')

    def test_dock_seal_before_open_passes_with_margin(self):
        result = self.call('dock.sequence-check', {'schemaVersion': 1, 'frame': 'component', 'connect': [
            {'event': 'lead-in', 'at': '0 mm'}, {'event': 'locator-engage', 'at': '2 mm'},
            {'event': 'seal-contact', 'at': '4 mm'}, {'event': 'valve-open', 'at': '4.6 mm'},
            {'event': 'both-valve-open', 'at': '5 mm'}],
            'axialTolerance': '0.1 mm', 'minimumSealBeforeOpen': '0.5 mm'})
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(result['sealBeforeOpenMargin']['value'], 0.6, places=6)
        self.assertAlmostEqual(result['worstCaseMargin']['value'], 0.5, places=6)

    def test_dock_seal_before_open_fails_when_margin_too_small(self):
        result = self.call('dock.sequence-check', {'schemaVersion': 1, 'frame': 'component', 'connect': [
            {'event': 'seal-contact', 'at': '4 mm'}, {'event': 'valve-open', 'at': '4.2 mm'},
            {'event': 'valve-open', 'at': '4.4 mm'}], 'minimumSealBeforeOpen': '0.5 mm'})
        self.assertEqual(result['status'], 'fail')

    def test_dock_requires_seal_and_valve_events(self):
        with self.assertRaises(ValueError):
            self.call('dock.sequence-check', {'schemaVersion': 1, 'frame': 'component',
                                              'connect': [{'event': 'valve-open', 'at': '4 mm'}]})


if __name__ == '__main__':
    unittest.main()
