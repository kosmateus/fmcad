"""Execute manual inputs with real measurement handlers and offline SDK fixtures."""
import copy
import json
from pathlib import Path
import types
import unittest

import core_test
import measure_test as fixtures


ROOT = Path(__file__).resolve().parents[1]
MANUAL = json.loads((ROOT / 'src/manual/measure.json').read_text())


class ManualMeasureTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.MeasureTests()
        f.setUp()
        f.root.attributes = core_test.Attributes()
        f.add(fixtures.Body('BodyB', f.root, (2, 0, 0), (3, 1, 1)))
        f.add(fixtures.Body('Witness', f.root, (.25, .25, .25), (.75, .75, .75)))
        f.add(fixtures.Body('RequiredMaterial', f.root, (.1, .1, .1), (.9, .9, .9)))
        cylinder = f.face('Cyl', fixtures.Entity('Cylinder', 'cylinder', radius=2.5,
            axis=fixtures.Point(0, 0, 1), origin=fixtures.Point()))
        front = f.face('Front', fixtures.Entity('Plane', 'front', origin=fixtures.Point(), normal=fixtures.Point(0, 0, 1)))
        back = f.face('Back', fixtures.Entity('Plane', 'back', origin=fixtures.Point(0, 0, 0.5), normal=fixtures.Point(0, 0, -1)))
        edge = fixtures.Entity('BRepEdge', 'Edge', body=f.body, length=1.0)
        f.add(edge)
        for entity, alias in ((cylinder, 'cylinder_face'), (front, 'front_face'), (back, 'back_face'), (edge, 'straight_edge')):
            f.call('entity.alias', {'ref': f.ctx.ref(entity), 'alias': alias})
        f.root.xConstructionAxis = fixtures.Entity('ConstructionAxis', 'X', parentComponent=f.root)
        f.root.yConstructionAxis = fixtures.Entity('ConstructionAxis', 'Y', parentComponent=f.root)
        f.root.originConstructionPoint = fixtures.Entity('ConstructionPoint', 'origin', parentComponent=f.root, geometry=fixtures.Point())
        f.root.xYConstructionPlane = fixtures.Entity('ConstructionPlane', 'XY', parentComponent=f.root,
            geometry=fixtures.Entity('Plane', 'xy', origin=fixtures.Point(), normal=fixtures.Point(0, 0, 1)))
        for name, xyz in (('angle_start', (1, 0, 0)), ('angle_end', (0, 1, 0))):
            point = fixtures.Entity('ConstructionPoint', name, parentComponent=f.root, geometry=fixtures.Point(*xyz))
            f.add(point)
            f.root.constructionPoints.values.append(point)
        sketch = fixtures.Entity('Sketch', 'Section', parentComponent=f.root,
            profiles=fixtures.Collection(), sketchPoints=fixtures.Collection())
        profile = fixtures.Entity('Profile', 'Profile', parentSketch=sketch, profileLoops=fixtures.Collection([object(), object()]),
            areaProperties=lambda accuracy: types.SimpleNamespace(area=3.0))
        sketch.profiles.values.append(profile)
        f.root.sketches.values.append(sketch)
        f.add(sketch)
        f.add(profile)
        section_edge = fixtures.Entity('BRepEdge', 'SectionEdge', length=2,
            geometry=fixtures.Entity('Circle3D', 'circle', center=fixtures.Point(), normal=fixtures.Point(0, 0, 1), radius=1))
        fixtures.MANAGER.section = types.SimpleNamespace(edges=fixtures.Collection([section_edge]))
        return f

    def test_every_manual_example_dispatches_actual_handler(self):
        seen = set()
        for operation, entry in MANUAL.items():
            for example in entry['examples']:
                with self.subTest(operation=operation, label=example['label']):
                    f = self.fixture()
                    result = f.call(operation, copy.deepcopy(example['data']))
                    self.assertIsInstance(result, dict)
                    json.dumps(result, allow_nan=False)
                    if operation in ('audit', 'snapshot'):
                        self.assertEqual(result['schema'], 'fmcad.measure.snapshot.v1')
                        self.assertIn('bodyDefinitions', result['counts'])
                    elif operation == 'report':
                        self.assertFalse(result['metadataVerified'])
                        self.assertEqual(result['status']['acceptance'], 'notEvaluated')
                    elif operation == 'status':
                        self.assertEqual(result['acceptance'], 'notEvaluated')
                    elif operation == 'diff':
                        self.assertEqual(result['changes'][0]['path'], '/document/name')
                    elif operation == 'parameter.test':
                        self.assertTrue(result['restored'])
                        self.assertIsNone(result['error'])
                        self.assertEqual(f.parameter.expression, result['originalExpression'])
                    elif operation == 'assembly.motion_check':
                        self.assertFalse(result['continuousMotionVerified'])
                        self.assertNotIn('passed', result)
                        self.assertEqual(len(result['samples']), len(example['data']['translations']))
                    elif operation in ('assembly.interference', 'assembly.clearance'):
                        self.assertEqual(result['overlapVolume']['units'], 'mm3')
                        self.assertEqual(result['distance']['units'], 'mm')
                    elif operation == 'check':
                        self.assertEqual(set(result), {'id', 'source', 'actual', 'acceptance', 'passed', 'status'})
                    elif operation == 'measure.section':
                        self.assertEqual(result['edgeCount'], 1)
                        self.assertEqual(result['curves'][0]['lengthUnits'], 'cm')
                    elif operation == 'measure.section-series':
                        self.assertEqual(result['status'], 'unknown')
                        self.assertFalse(result['coverageDetail']['continuous'])
                        self.assertIsNone(result['stations'][0]['area'])
                    elif operation == 'measure.witness-check':
                        self.assertEqual(result['status'], 'pass')
                        self.assertFalse(result['coverageDetail']['sampled'])
                    elif operation == 'measure.bounds':
                        self.assertEqual(len(result['size']), 3)
                        self.assertNotIn('value', result)
                    elif operation.startswith('measure.baseline.'):
                        self.assertEqual(result['status'], 'unsupported')
                        self.assertFalse(result['passed'])
                        self.assertEqual(result['precision'], 'exact')
                    elif operation.startswith('geometry.'):
                        self.assertEqual(result['operation'], operation)
                        self.assertEqual(result['status'], 'unknown')
                        self.assertIsNone(result['passed'])
                    else:
                        self.assertIsInstance(result['value'], float)
                        self.assertIn('dimension', result)
                    seen.add(operation)
        self.assertEqual(seen, set(MANUAL))

    def test_nested_check_exclusivity_and_report_object_gate(self):
        f = self.fixture()
        check = copy.deepcopy(MANUAL['check']['examples'][0]['data'])
        with self.assertRaisesRegex(ValueError, 'OR min/max'):
            f.call('check', dict(check, min='0 mm^3'))
        with self.assertRaisesRegex(ValueError, 'metadata must be an object'):
            f.call('report', {'metadata': []})
        with self.assertRaisesRegex(ValueError, 'only apply'):
            f.call('measure.distance', {'a': 'BodyA', 'b': 'BodyB', 'space': 'assembly'})

    def test_snapshot_result_not_envelope_and_nullable_after(self):
        f = self.fixture()
        before = f.call('snapshot', {})
        self.assertFalse(f.call('diff', {'before': before, 'after': None})['changed'])
        with self.assertRaisesRegex(ValueError, 'snapshot data'):
            f.call('diff', {'before': {'success': True, 'result': before}, 'after': before})

    def test_documented_failed_motion_and_report_result_shapes(self):
        f = self.fixture()
        motion = f.call('assembly.motion_check', MANUAL['assembly.motion_check']['examples'][0]['data'])
        self.assertFalse(motion['sampledPassed'])
        self.assertNotIn('passed', motion)
        report = f.call('report', {'checks': [{'measurement': {'operation': 'measure.volume', 'data': {'ref': 'BodyA'}}, 'min': '2 cm^3'}]})
        self.assertEqual(report['checkOutcome'], 'fail')
        self.assertNotIn('passed', report)
        self.assertIsInstance(report['status'], dict)


if __name__ == '__main__':
    unittest.main()
