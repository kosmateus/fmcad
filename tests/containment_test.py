"""GM20 offline tests: analytic containment, corridor clearance and region occupancy."""
import math
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import model_test as model


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = dict(model.namespace)
NAMESPACE['CAD_HANDLERS'] = dict(model.HANDLERS)
exec(compile((ROOT / 'assets/cad/containment.py').read_text(), 'containment.py', 'exec'), NAMESPACE)
HANDLERS = NAMESPACE['CAD_HANDLERS']


class FakeBRepFace:
    def __init__(self, body, axis, side):
        self.body, self.axis, self.side = body, axis, side

    def distance_to(self, point):
        coordinates = (point.x, point.y, point.z)
        closest = list(coordinates)
        closest[self.axis] = self.body.bounds[self.side][self.axis]
        for axis in range(3):
            if axis != self.axis:
                closest[axis] = min(max(closest[axis], self.body.bounds['min'][axis]),
                                    self.body.bounds['max'][axis])
        return math.sqrt(sum((coordinates[axis] - closest[axis]) ** 2 for axis in range(3)))


class FakeBRepBody:
    def __init__(self, lower=(0.0, 0.0, 0.0), upper=(1.0, 1.0, 1.0),
                 supports_containment=True, unknown_containment=False):
        self.bounds = {'min': list(lower), 'max': list(upper)}
        self.supports_containment = supports_containment
        self.unknown_containment = unknown_containment
        self.faces = model.Collection([FakeBRepFace(self, axis, side)
                                       for axis in range(3) for side in ('min', 'max')])
        self.assemblyContext = None
        # The SDK property exists and returns None for a native body.
        self.nativeObject = None

    def __getattribute__(self, name):
        if name == 'pointContainment' and not object.__getattribute__(self, 'supports_containment'):
            raise AttributeError(name)
        return object.__getattribute__(self, name)

    def pointContainment(self, point):
        if self.unknown_containment:
            return model.adsk.fusion.PointContainment.UnknownPointContainment
        values = (point.x, point.y, point.z)
        if any(values[axis] < self.bounds['min'][axis] or values[axis] > self.bounds['max'][axis]
               for axis in range(3)):
            return model.adsk.fusion.PointContainment.PointOutsidePointContainment
        if any(values[axis] == self.bounds['min'][axis] or values[axis] == self.bounds['max'][axis]
               for axis in range(3)):
            return model.adsk.fusion.PointContainment.PointOnPointContainment
        return model.adsk.fusion.PointContainment.PointInsidePointContainment

    def transformBy(self, transform):
        corners = [model.Point(*(self.bounds['min'][axis] if bit[axis] == 0 else self.bounds['max'][axis]
                                for axis in range(3)))
                   for bit in ((x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1))]
        transformed = [transform.point(point) for point in corners]
        self.bounds = {
            'min': [min((point.x, point.y, point.z)[axis] for point in transformed) for axis in range(3)],
            'max': [max((point.x, point.y, point.z)[axis] for point in transformed) for axis in range(3)],
        }


class FakeTemporaryBRepManager:
    active = None

    @classmethod
    def get(cls):
        return cls.active

    def __init__(self):
        self.copies = []
        self.transforms = []

    def copy(self, body):
        target = FakeBRepBody(tuple(body.bounds['min']), tuple(body.bounds['max']),
                              body.supports_containment, body.unknown_containment)
        self.copies.append((body, target))
        return target

    def transform(self, body, transform):
        self.transforms.append((body, transform))
        body.transformBy(transform)
        return True


class FakeMeasureManager:
    def __init__(self):
        self.measurements = []

    def measureMinimumDistance(self, face, point):
        self.measurements.append((face, point))
        return types.SimpleNamespace(value=face.distance_to(point))


class ContainmentTests(unittest.TestCase):
    def call(self, operation, data):
        return HANDLERS[operation](model.Context(), data)

    def cylinder(self, **extra):
        data = {'schemaVersion': 1, 'region': {'type': 'cylinder', 'origin': ['0 mm', '0 mm', '0 mm'],
                'direction': [0, 0, 1], 'radius': '5 mm', 'height': '10 mm'},
                'points': [['0 mm', '0 mm', '5 mm']], 'boundaryTolerance': '0.01 mm'}
        data.update(extra)
        return data

    def test_inside_outside_and_boundary_classification(self):
        result = self.call('measure.contains', self.cylinder(points=[
            ['0 mm', '0 mm', '5 mm'], ['6 mm', '0 mm', '5 mm'], ['4.999 mm', '0 mm', '5 mm']]))
        self.assertEqual(result['status'], 'pass')
        self.assertEqual([r['classification'] for r in result['results']],
                         ['inside', 'outside', 'boundary'])
        self.assertEqual(result['counts'], {'inside': 1, 'outside': 1, 'boundary': 1,
                                           'error': 0, 'unknown': 0})

    def test_ring_keeps_open_channel(self):
        data = {'schemaVersion': 1, 'region': {'type': 'ring', 'origin': ['0 mm', '0 mm', '0 mm'],
                'direction': [0, 0, 1], 'outerRadius': '8 mm', 'innerRadius': '3 mm', 'height': '5 mm'},
                'points': [['1 mm', '0 mm', '2.5 mm'], ['5 mm', '0 mm', '2.5 mm']]}
        result = self.call('measure.contains', data)
        self.assertEqual([r['classification'] for r in result['results']], ['outside', 'inside'])

    def test_box_and_sphere_signed_distance(self):
        box = {'schemaVersion': 1, 'region': {'type': 'box', 'min': ['0 mm', '0 mm', '0 mm'],
               'max': ['10 mm', '10 mm', '10 mm']}, 'points': [['5 mm', '5 mm', '5 mm'], ['12 mm', '5 mm', '5 mm']]}
        result = self.call('measure.contains', box)
        self.assertEqual([r['classification'] for r in result['results']], ['inside', 'outside'])
        self.assertAlmostEqual(result['results'][1]['signedDistance'], -0.2, places=5)
        sphere = {'schemaVersion': 1, 'region': {'type': 'sphere', 'center': ['0 mm', '0 mm', '0 mm'],
                  'radius': '10 mm'}, 'points': [['0 mm', '0 mm', '0 mm']]}
        self.assertEqual(self.call('measure.contains', sphere)['results'][0]['classification'], 'inside')

    def test_union_of_regions(self):
        data = {'schemaVersion': 1, 'region': {'type': 'union', 'regions': [
                {'type': 'sphere', 'center': ['0 mm', '0 mm', '0 mm'], 'radius': '5 mm'},
                {'type': 'sphere', 'center': ['10 mm', '0 mm', '0 mm'], 'radius': '5 mm'}]},
                'points': [['7 mm', '0 mm', '0 mm']]}
        self.assertEqual(self.call('measure.contains', data)['results'][0]['classification'], 'inside')

    def test_invalid_region_and_negative_tolerance_rejected(self):
        with self.assertRaises(ValueError):
            self.call('measure.contains', self.cylinder(boundaryTolerance='-1 mm'))
        with self.assertRaises(ValueError):
            self.call('measure.contains', self.cylinder(region={'type': 'torus'}))

    def native_call(self, ctx, points, measure_manager=None):
        manager = FakeTemporaryBRepManager()
        measure_manager = measure_manager or FakeMeasureManager()
        ctx.app = types.SimpleNamespace(measureManager=measure_manager)
        FakeTemporaryBRepManager.active = manager
        enum = types.SimpleNamespace(PointInsidePointContainment=0, PointOnPointContainment=1,
                                     PointOutsidePointContainment=2, UnknownPointContainment=3)
        data = {'schemaVersion': 1, 'region': {'type': 'body', 'ref': 'NativeBody'},
                'points': points, 'boundaryTolerance': '0.01 mm'}
        with patch.object(model.adsk.fusion, 'TemporaryBRepManager', FakeTemporaryBRepManager, create=True), \
                patch.object(model.adsk.fusion, 'PointContainment', enum, create=True):
            result = HANDLERS['measure.contains'](ctx, data)
        return result, manager, measure_manager

    def test_native_uses_temporary_body_point_containment_and_face_distance(self):
        ctx = model.Context()
        body = FakeBRepBody()
        ctx.entities['NativeBody'] = body
        result, manager, measure_manager = self.native_call(ctx, [
            ['5 mm', '5 mm', '5 mm'],
            ['0.005 mm', '5 mm', '5 mm'],
            ['0 mm', '5 mm', '5 mm'],
            ['10.005 mm', '5 mm', '5 mm'],
            ['12 mm', '5 mm', '5 mm'],
        ])
        self.assertFalse(hasattr(manager, 'pointContainment'))
        self.assertIs(manager.copies[0][0], body)
        self.assertIsNot(manager.copies[0][1], body)
        self.assertEqual([row['classification'] for row in result['results']],
                         ['inside', 'boundary', 'boundary', 'boundary', 'outside'])
        self.assertAlmostEqual(result['results'][0]['signedDistance'], 0.5)
        self.assertAlmostEqual(result['results'][1]['signedDistance'], 0.0005)
        self.assertAlmostEqual(result['results'][3]['signedDistance'], -0.0005)
        self.assertAlmostEqual(result['results'][4]['signedDistance'], -0.2)
        self.assertEqual(result['counts'], {'inside': 1, 'outside': 1, 'boundary': 3,
                                           'error': 0, 'unknown': 0})
        self.assertEqual(result['status'], 'pass')
        self.assertIn('Native BRepBody.pointContainment has no tolerance', result['limitations'][0])
        self.assertIn('minimum distance to the copied body faces', result['limitations'][0])
        self.assertIn('Unsupported or unknown SDK results remain unknown', result['limitations'][0])
        self.assertEqual(ctx.created, [])
        self.assertEqual(body.bounds, {'min': [0.0, 0.0, 0.0], 'max': [1.0, 1.0, 1.0]})
        self.assertTrue(all(face.body is manager.copies[0][1]
                            for face, _point in measure_manager.measurements))

    def test_native_occurrence_transform_applies_to_temporary_copy_only(self):
        ctx = model.Context()
        native = FakeBRepBody()
        transform = model.RigidTransform(translation=(10.0, 0.0, 0.0))
        occurrence = types.SimpleNamespace(transform2=transform)
        proxy = types.SimpleNamespace(nativeObject=native, assemblyContext=occurrence)
        ctx.entities['NativeBody'] = proxy
        result, manager, _measure_manager = self.native_call(ctx, [['10.5 cm', '0.5 cm', '0.5 cm']])
        target = manager.copies[0][1]
        self.assertEqual(result['results'][0]['classification'], 'inside')
        self.assertEqual(manager.transforms, [(target, transform)])
        self.assertEqual(target.bounds, {'min': [10.0, 0.0, 0.0], 'max': [11.0, 1.0, 1.0]})
        self.assertEqual(native.bounds, {'min': [0.0, 0.0, 0.0], 'max': [1.0, 1.0, 1.0]})
        self.assertEqual(ctx.created, [])

    def test_native_missing_or_unknown_sdk_containment_fails_closed(self):
        for body in (FakeBRepBody(supports_containment=False), FakeBRepBody(unknown_containment=True)):
            with self.subTest(body=body):
                ctx = model.Context()
                ctx.entities['NativeBody'] = body
                result, _manager, _measure_manager = self.native_call(ctx, [['5 mm', '5 mm', '5 mm']])
                self.assertEqual(result['status'], 'unknown')
                self.assertFalse(result['success'])
                self.assertEqual(result['results'][0]['classification'], 'unknown')
                self.assertTrue(result['results'][0]['reason'])
                self.assertEqual(result['counts']['unknown'], 1)

    def test_native_missing_face_distance_is_unknown_not_inside(self):
        ctx = model.Context()
        ctx.entities['NativeBody'] = FakeBRepBody()
        result, _manager, _measure_manager = self.native_call(ctx, [['5 mm', '5 mm', '5 mm']],
                                                               measure_manager=types.SimpleNamespace())
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['results'][0]['classification'], 'unknown')
        self.assertEqual(result['results'][0]['signedDistance'], None)
        self.assertIn('Minimum distance', result['results'][0]['reason'])
        self.assertFalse(result['success'])

    def test_corridor_clearance_and_intrusion(self):
        data = {'schemaVersion': 1, 'path': [['0 mm', '0 mm', '0 mm'], ['0 mm', '10 mm', '0 mm'],
                ['0 mm', '20 mm', '0 mm']], 'radius': '2 mm',
                'obstacles': [{'point': ['3 mm', '5 mm', '0 mm']}, {'point': ['0.5 mm', '5 mm', '0 mm']}],
                'minimumClearance': '0.5 mm'}
        result = self.call('measure.corridor', data)
        self.assertAlmostEqual(result['occupancy'][0]['clearance'], 0.1, places=5)
        self.assertFalse(result['occupancy'][0]['intrudes'])
        self.assertAlmostEqual(result['occupancy'][1]['clearance'], -0.15, places=5)
        self.assertTrue(result['occupancy'][1]['intrudes'])
        self.assertEqual(result['intrusions'], 1)
        self.assertAlmostEqual(result['arcLength'], 2.0, places=5)

    def test_region_occupancy_and_section(self):
        data = {'schemaVersion': 1, 'region': {'type': 'box', 'min': ['0 mm', '0 mm', '0 mm'],
                'max': ['10 mm', '10 mm', '10 mm']},
                'occupants': [{'point': ['5 mm', '5 mm', '5 mm'], 'radius': '2 mm'},
                              {'point': ['20 mm', '5 mm', '5 mm']}],
                'sections': [{'z': '5 mm'}]}
        result = self.call('measure.region', data)
        self.assertEqual(result['occupiedCount'], 1)
        self.assertEqual(result['sections'][0]['occupantCount'], 1)
        self.assertGreater(result['sections'][0]['occupiedUnionArea'], 0)


if __name__ == '__main__':
    unittest.main()
