"""Offline fake-SDK regressions for the canonical measurement runtime family."""
import math
import pathlib
import types
import unittest

import measure_test as fake_sdk


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = dict(fake_sdk.NS)
RUNTIME['CAD_HANDLERS'] = dict(fake_sdk.NS['CAD_HANDLERS'])
runtime_adsk = types.ModuleType('adsk')
runtime_adsk.core = fake_sdk.adsk.core
runtime_adsk.fusion = types.ModuleType('adsk.fusion')
runtime_adsk.fusion.__dict__.update(vars(fake_sdk.adsk.fusion))
RUNTIME['adsk'] = runtime_adsk


def _load_runtime_family() -> None:
    files = (
        'runtime/python/fmcad/domain/values.py',
        'runtime/python/fmcad/adapters/fusion/values.py',
        'runtime/python/fmcad/domain/measure.py',
        'runtime/python/fmcad/domain/containment.py',
        'runtime/python/fmcad/domain/interference.py',
        'runtime/python/fmcad/domain/checking.py',
        'runtime/python/fmcad/domain/dfm.py',
        'runtime/python/fmcad/application/checking.py',
        'runtime/python/fmcad/adapters/fusion/checking.py',
        'runtime/python/fmcad/adapters/fusion/containment.py',
        'runtime/python/fmcad/adapters/fusion/dfm.py',
        'runtime/python/fmcad/adapters/fusion/interference.py',
        'runtime/python/fmcad/adapters/fusion/measure.py',
    )
    for filename in files:
        source = (ROOT / filename).read_text()
        exec(compile(source, filename, 'exec'), RUNTIME)


_load_runtime_family()
runtime_adsk.fusion.PointContainment = types.SimpleNamespace(
    PointInsidePointContainment=0,
    PointOnPointContainment=1,
    PointOutsidePointContainment=2,
    UnknownPointContainment=3,
)


class MeasurementRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fake = object.__new__(fake_sdk.MeasureTests)
        fake_sdk.MeasureTests.setUp(self.fake)
        self.ctx = self.fake.ctx
        self.fake.health.isGroup = False
        self.fake.health.isRolledBack = False
        self.fake.health.entity = None
        self.fake.health.entityToken = 'timeline-1'
        self.fake.health.objectType = 'adsk::fusion::TimelineObject'

        def dispatch(context, operation, data):
            return RUNTIME['CAD_HANDLERS'][operation](context, data)

        self.ctx.call = types.MethodType(dispatch, self.ctx)

    def call(self, operation, data):
        result = self.ctx.call(operation, data)
        return result

    def test_measurement_and_temporary_boolean_failure_remain_explicit(self):
        geometry = fake_sdk.Entity('Cylinder', 'cylinder', radius=1.25)
        self.fake.face('CylinderFace', geometry)
        result = self.call('measure.diameter', {'ref': {'token': 'CylinderFace'}})
        self.assertEqual((result['value'], result['units']), (25.0, 'mm'))

        obstacle = fake_sdk.Body('Obstacle', self.fake.root, low=(0.5, 0, 0), high=(1.5, 1, 1))
        self.fake.add(obstacle)
        fake_sdk.MANAGER.boolean_ok = False
        with self.assertRaisesRegex(RuntimeError, 'Temporary intersection'):
            self.call('assembly.interference', {'a': 'BodyA', 'b': 'Obstacle'})
        fake_sdk.MANAGER.boolean_ok = True

    def test_section_wire_and_kernel_failure_are_distinct(self):
        plane = fake_sdk.Entity(
            'ConstructionPlane', 'SectionPlane', parentComponent=self.fake.root,
            geometry=fake_sdk.Entity('Plane', 'plane', origin=fake_sdk.Point(), normal=fake_sdk.Point(0, 0, 1)),
        )
        self.fake.add(plane)
        edge = fake_sdk.Entity(
            'BRepEdge', 'SectionEdge', length=2 * math.pi,
            geometry=fake_sdk.Entity('Circle3D', 'circle', center=fake_sdk.Point(),
                                      normal=fake_sdk.Point(0, 0, 1), radius=1),
        )
        fake_sdk.MANAGER.section = types.SimpleNamespace(edges=fake_sdk.Collection([edge]))
        section = self.call('measure.section', {'body': 'BodyA', 'plane': {'token': 'SectionPlane'}})
        self.assertAlmostEqual(section['totalLength']['value'], 20 * math.pi)
        self.assertEqual(section['edgeCount'], 1)

        fake_sdk.MANAGER.section = None
        with self.assertRaisesRegex(RuntimeError, 'no intersection or kernel failure'):
            self.call('measure.section', {'body': 'BodyA', 'plane': {'token': 'SectionPlane'}})

    def test_native_containment_is_unknown_when_face_distance_is_unavailable(self):
        self.fake.body.pointContainment = lambda point: (
            runtime_adsk.fusion.PointContainment.PointInsidePointContainment
            if point.x < 0.5 else runtime_adsk.fusion.PointContainment.PointOutsidePointContainment
        )
        result = self.call('measure.contains', {
            'region': {'type': 'body', 'ref': 'BodyA'},
            'points': [['0 mm', '0 mm', '0 mm'], ['10 mm', '0 mm', '0 mm']],
            'boundaryTolerance': '0.01 mm',
        })
        self.assertEqual([row['classification'] for row in result['results']], ['unknown', 'unknown'])
        self.assertEqual(result['counts'], {'inside': 0, 'outside': 0, 'boundary': 0, 'error': 0, 'unknown': 2})
        self.assertEqual(result['status'], 'unknown')
        self.assertTrue(all('Minimum distance' in row['reason'] for row in result['results']))

    def test_evidence_and_status_keep_unknown_separate_from_acceptance(self):
        evidence = self.call('evidence.check', {
            'evidence': [{'id': 'model', 'kind': 'model', 'path': 'part.f3d', 'revision': '1'}],
            'required': ['drawing'],
        })
        self.assertEqual(evidence['status'], 'unknown')
        self.assertEqual(evidence['missing'], [{'kind': 'drawing'}])

        status = self.call('status', {})
        self.assertEqual(status['observedHealth'], 'noReportedIssues')
        self.assertEqual(status['acceptance'], 'notEvaluated')

    def test_parameter_budget_returns_partial_and_does_not_start_a_case(self):
        before = list(self.fake.parameter.writes)
        result = self.call('parameter.test', {
            'confirm': True,
            'timeBudgetMs': 1,
            'cases': [{'id': 'not-started', 'assign': [{'parameter': 'width', 'expression': '20 mm'}]}],
        })
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['cases'][0]['status'], 'skipped')
        self.assertEqual(self.fake.parameter.writes, before)


if __name__ == '__main__':
    unittest.main()
