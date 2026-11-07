"""Manual examples through real core handlers; SDK fixtures do not verify geometry."""
import copy
import json
from pathlib import Path
import types
import unittest

import core_test as fixtures


ROOT = Path(__file__).resolve().parents[1]
MANUAL = json.loads((ROOT / 'src/manual/core.json').read_text())


class ManualCoreTests(unittest.TestCase):
    def fixture(self, operation, example):
        f = fixtures.CoreTests()
        f.setUp()
        body = f.body('BodyA')
        f.root.constructionPlanes = fixtures.Datums('ConstructionPlane', f.root)
        f.root.constructionAxes = fixtures.Datums('ConstructionAxis', f.root)
        f.root.constructionPoints = fixtures.Datums('ConstructionPoint', f.root)
        sketch = f.profile_sketch(2)
        sketch.profiles.items[1].profileLoops = fixtures.Items([object(), object()])
        face = fixtures.Entity('BRepFace')
        face.body = body
        face.geometry = types.SimpleNamespace(objectType='adsk::core::Cylinder', radius=2.5,
            origin=fixtures.Point(0, 0, 0), axis=fixtures.Point(0, 0, 1))
        body.faces.items.append(face)
        edge = fixtures.Entity('BRepEdge')
        edge.body = body
        vertex = fixtures.Entity('BRepVertex')
        vertex.body = body
        body.edges.items.append(edge)
        body.vertices.items.append(vertex)
        for entity, alias in ((face, 'cylinder_face'), (edge, 'straight_edge'), (vertex, 'corner_vertex')):
            f.register(entity)
            f.ctx.call('entity.alias', {'ref': f.ctx.ref(entity), 'alias': alias})
        if operation == 'datum.axis' and example['data']['mode'] == 'twoPoints':
            f.ctx.call('datum.point', {'name': 'mount_center', 'point': ['0 mm', '0 mm', '25 mm']})
        if operation != 'param.apply' or example['data'].get('overwrite'):
            f.apply([{'name': 'wall', 'expression': '3 mm', 'unit': 'mm',
                      'metadata': {'protected': True, 'source': 'Approved drawing', 'tolerance': '0.2 mm'}},
                     {'name': 'outside', 'expression': '2 * wall + 40 mm', 'unit': 'mm'}])
        selections = f.app.userInterface.activeSelections

        def clear():
            selections.items.clear()
            return True

        selections.clear = clear
        if operation == 'selection.inspect':
            selections.items.append(types.SimpleNamespace(entity=face, point=fixtures.Point(1, 2, 3)))
        f.ctx.created.clear()
        return f

    def test_every_manual_example_dispatches_actual_handler(self):
        seen = set()
        for operation, entry in MANUAL.items():
            for example in entry['examples']:
                with self.subTest(operation=operation, label=example['label']):
                    f = self.fixture(operation, example)
                    result = f.ctx.call(operation, copy.deepcopy(example['data']))
                    self.assertIsInstance(result, dict)
                    json.dumps(result, allow_nan=False)
                    if operation == 'entity.list':
                        self.assertEqual(set(result), {'entities'})
                    elif operation == 'entity.find' and not example['data'].get('unique'):
                        self.assertEqual(result['count'], len(result['entities']))
                    elif operation == 'entity.alias':
                        self.assertEqual(set(result), {'alias', 'ref', 'changed'})
                        self.assertEqual(f.ctx.resolve(result['ref']), f.ctx.resolve(example['data']['ref']))
                    elif operation == 'selection.inspect':
                        self.assertEqual(result['selections'][0]['pointUnits'], 'cm')
                    elif operation == 'selection.highlight':
                        self.assertEqual(result['selectionCount'], len(example['data']['refs']))
                    elif operation == 'param.apply':
                        self.assertTrue(result['prevalidated'])
                        self.assertFalse(result['atomic'])
                        self.assertNotIn('ref', result['parameters'][0])
                    elif operation == 'param.dependencies':
                        self.assertEqual(result['coverage'], 'partial')
                    elif operation.startswith('datum.'):
                        self.assertEqual(result['name'], example['data']['name'])
                        if operation == 'datum.frame':
                            self.assertEqual(len(result['matrix']), 16)
                            self.assertFalse(result['parametric'])
                        elif operation == 'datum.point' and example['data'].get('mode', 'coordinates') == 'coordinates':
                            self.assertEqual(len(result['helpers']), 3)
                            self.assertEqual(len(f.ctx.created), 1)
                    seen.add(operation)
        self.assertEqual(seen, set(MANUAL))

    def test_documented_profile_loop_count_and_index_exclusion(self):
        f = self.fixture('entity.inspect', MANUAL['entity.inspect']['examples'][0])
        with self.assertRaisesRegex(ValueError, 'cannot be combined'):
            f.ctx.call('entity.inspect', {'ref': {'kind': 'profile', 'sketch': 'Section', 'index': 1, 'loopCount': 2}})

    def test_documented_null_tolerance_is_stored(self):
        example = MANUAL['param.apply']['examples'][1]
        f = self.fixture('param.apply', example)
        result = f.ctx.call('param.apply', example['data'])
        self.assertIsNone(result['parameters'][0]['metadata']['tolerance'])
        self.assertFalse(result['parameters'][0]['metadata']['protected'])

    def test_documented_find_none_geometry(self):
        f = self.fixture('entity.find', MANUAL['entity.find']['examples'][0])
        feature = fixtures.Entity('ExampleFeature', 'Geometryless', f.root)
        feature.geometry = None
        f.root.features.items.append(feature)
        self.assertIsNone(f.ctx.describe(feature)['geometry'])
        self.assertEqual(f.ctx.call('entity.find', {'kind': 'feature'}),
                         {'entities': [f.ctx.describe(feature)], 'count': 1})
        self.assertEqual(f.ctx.call('entity.find', {'kind': 'feature', 'filters': {'geometry': 'plane'}}),
                         {'entities': [], 'count': 0})
        self.assertFalse(MANUAL['entity.find']['audit']['bugs'])


if __name__ == '__main__':
    unittest.main()
