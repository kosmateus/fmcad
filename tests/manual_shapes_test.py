"""Manual contracts using real recipes/model handlers and offline SDK doubles."""
import json
import unittest

import shapes_test as shapes


MANUAL = json.loads((shapes.ROOT / 'src/manual/shapes.json').read_text())
BASE = {'feature', 'bodies', 'healthState', 'message'}


class ManualShapesTests(unittest.TestCase):
    def test_all_examples_and_conditional_return_contracts(self):
        catalog = json.loads((shapes.ROOT / 'src/catalog/shapes.json').read_text())
        self.assertEqual(set(MANUAL), set(catalog))
        for operation, entry in MANUAL.items():
            for example in entry['examples']:
                with self.subTest(operation=operation, example=example['label']):
                    ctx = shapes.Context()
                    for name in ('DuctSection', 'WireSection', 'RibSection', 'WebSection'):
                        ctx.entities[name] = ctx.sketch
                    ctx.entities['SeedLine'] = ctx.entities['line-token']
                    ctx.entities['HelicalEdge'] = ctx.entities['edge-token']
                    ctx.entities['SeedFeature'] = ctx.entities['seed']
                    data = example['data']
                    result = ctx.call(operation, data)
                    json.dumps(result)
                    expected = set(BASE)
                    if operation in ('shape.box', 'shape.cylinder', 'shape.tube', 'shape.ring', 'shape.cone'):
                        expected |= {'helpers', 'recipe'}
                        self.assertEqual(len(result['helpers']), 3 if operation == 'shape.cone' else 1)
                    elif 'profileData' in data or 'waypoints' in data:
                        expected |= {'helpers', 'refs', 'recipe', 'atomic', 'dependencies', 'isFullyConstrained'}
                        if 'waypoints' in data:
                            expected.add('path')
                            self.assertEqual(set(result['path']), {'curves', 'chain'})
                    elif operation == 'shape.slot' and 'profile' not in data:
                        expected |= {'helpers', 'recipe', 'atomic', 'dependencies', 'slotGeometry'}
                        self.assertEqual(len(result['helpers']), 10)
                        self.assertEqual(len(result['slotGeometry']), 6)
                    elif operation == 'shape.bolt_circle' and 'entities' not in data:
                        expected |= {'helpers', 'recipe', 'atomic', 'dependencies', 'seed'}
                        self.assertEqual(len(result['helpers']), 5)
                        self.assertEqual(set(result['seed']), BASE)
                        pattern = next(d for op, d in ctx.calls if op == 'pattern.circular')
                        self.assertEqual(pattern['entities'], [result['seed']['feature']])
                    self.assertEqual(set(result), expected)

    def test_documented_slot_participants_failure_is_after_helpers(self):
        ctx = shapes.Context()
        with self.assertRaisesRegex(ValueError, 'participants are supported only'):
            ctx.call('shape.slot', {'name': 'Slot', 'length': '30 mm', 'width': '6 mm',
                'thickness': '2 mm', 'operation': 'newBody', 'participants': ['Base']})
        self.assertEqual(ctx.component.sketches.count, 1)
        self.assertEqual(ctx.component.constructionPoints.count, 2)
        self.assertEqual(ctx.component.sketches.item(0).sketchCurves.count, 5)
        self.assertTrue(MANUAL['shape.slot']['audit']['bugs'])

    def test_documented_generated_profile_token_roundtrip_failure(self):
        for operation in ('shape.slot', 'shape.revolved_profile'):
            with self.subTest(operation=operation):
                ctx = shapes.Context()
                ctx.unavailable_profile_tokens = True
                data = next(e['data'] for e in MANUAL[operation]['examples']
                            if 'profile' not in e['data'])
                with self.assertRaisesRegex(ValueError, 'Entity token: expected one match, found 0'):
                    ctx.call(operation, data)
                self.assertEqual(ctx.component.sketches.count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
