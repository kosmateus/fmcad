"""Offline numerical/evaluator contract tests, not native kernel acceptance."""
import math
from pathlib import Path
import types
import unittest

NS = {'CAD_HANDLERS': {}, 'math': math}
exec(compile((Path(__file__).parents[1]/'assets/cad/curve.py').read_text(), 'curve.py', 'exec'), NS)


class CircleEvaluator:
    def getParameterExtents(self):
        return True, 0, 2*math.pi

    def getStrokes(self, a, b, tolerance):
        return True, [types.SimpleNamespace(x=math.cos(i*math.pi/32), y=math.sin(i*math.pi/32), z=0) for i in range(65)]

    def getCurvature(self, t):
        return True, types.SimpleNamespace(x=-math.cos(t), y=-math.sin(t)), 1

    def getFirstDerivative(self, t):
        return True, types.SimpleNamespace(x=-math.sin(t), y=math.cos(t))


class Curves(unittest.TestCase):
    def test_self_crossing_overlap_and_open_endpoint(self):
        check = NS['_curve_intersections']
        self.assertTrue(check([[[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]]], 1e-6, float('inf')))
        self.assertFalse(check([[[0, 0, 0], [2, 0, 0], [2, 2, 0]]], 1e-6, float('inf')))
        self.assertTrue(check([[[0, 0, 0], [3, 0, 0]], [[1, 0, 0], [2, 0, 0]]], 1e-6, float('inf')))

    def test_signed_normal_circle_offset_and_radius_loss(self):
        entity = types.SimpleNamespace(geometry=types.SimpleNamespace(evaluator=CircleEvaluator()))
        ctx = types.SimpleNamespace(ref=lambda _: 'circle')
        outward = NS['_curve_evidence'](ctx, [entity], .001, 100, float('inf'), offset=2)
        inward = NS['_curve_evidence'](ctx, [entity], .001, 100, float('inf'), offset=-1)
        self.assertFalse(outward['cusps'])
        self.assertTrue(inward['cusps'])
        self.assertTrue(outward['loops'][0]['closed'])
        self.assertEqual(outward['curves'][0]['continuity']['G2'], 'unknown')
        self.assertEqual(outward['status'], 'pass')
        self.assertEqual(inward['status'], 'fail')

    def test_incomplete_curvature_sampling_is_unknown(self):
        class Flaky(CircleEvaluator):
            def getCurvature(self, t):
                return False, None, 0
        entity = types.SimpleNamespace(geometry=types.SimpleNamespace(evaluator=Flaky()))
        evidence = NS['_curve_evidence'](types.SimpleNamespace(ref=lambda _: 'circle'), [entity], .001, 100, float('inf'))
        self.assertEqual(evidence['status'], 'unknown')

    def test_stroke_budget(self):
        entity = types.SimpleNamespace(geometry=types.SimpleNamespace(evaluator=CircleEvaluator()))
        with self.assertRaisesRegex(ValueError, 'maxSamples'):
            NS['_curve_evidence'](types.SimpleNamespace(ref=lambda _: 'circle'), [entity], .001, 10, float('inf'))

    def test_distance_is_normal_not_radial(self):
        self.assertAlmostEqual(NS['_curve_segment_distance']([11, 4, 0], [10, 0, 0], [10, 10, 0]), 1)


if __name__ == '__main__':
    unittest.main()
