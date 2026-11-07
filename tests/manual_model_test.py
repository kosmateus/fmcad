"""Execute manual examples through real handlers; SDK stubs are not geometry tests."""
import json
import unittest

import model_test as model


MANUAL = json.loads((model.ROOT / 'src/manual/model.json').read_text())


class ManualModelTests(unittest.TestCase):
    def test_every_example_dispatches_and_returns_documented_keys(self):
        self.assertEqual(set(MANUAL), set(model.CATALOG))
        for operation, entry in MANUAL.items():
            for example in entry['examples']:
                with self.subTest(operation=operation, example=example['label']):
                    ctx = model.Context()
                    for alias, key in {
                        'SeedLine': 'line-token', 'SeedCircle': 'circle-token',
                        'MirrorAxis': 'axis-line-token', 'PatternCenter': 'point-token',
                        'SelectedEdge': 'edge-token', 'TopFace': 'top-face-token',
                        'SideFace': 'side-face-token', 'CylinderFace': 'cylinder-face-token',
                        'TargetPlane': 'XY', 'GuideCurve': 'axis-line-token',
                    }.items():
                        ctx.entities[alias] = ctx.entities[key]
                    multi_extrude = operation == 'model.extrude' and 'profiles' in example['data']
                    if multi_extrude:
                        ctx.entities['CutSection'] = ctx.sketch
                        second = model.Entity('Profile', ctx.sketch, name='SecondCutProfile')
                        second.plane = ctx.sketch.referencePlane.geometry
                        second.profileLoops = model.Collection([object()])
                        ctx.sketch.profiles.values.append(second)
                        ctx.entities['Base'].parentComponent = ctx.component
                        original_length = ctx.length
                        ctx.length = lambda expression: 0.5 if expression == 'N20_Depth' else original_length(expression)
                    result = model.HANDLERS[operation](ctx, example['data'])
                    json.dumps(result)
                    if operation.startswith(('model.', 'pattern.')):
                        expected = {'feature', 'bodies', 'healthState', 'message'}
                        if multi_extrude:
                            expected |= {'profileRefs', 'profileCount', 'bodyCount', 'profileBodyMapping'}
                            self.assertEqual(result['profileCount'], 2)
                            self.assertEqual(result['bodyCount'], len(result['bodies']))
                            self.assertEqual(result['profileBodyMapping']['status'], 'unavailable')
                        self.assertEqual(set(result), expected)
                    elif operation.startswith('path.'):
                        self.assertEqual(set(result), {'path', 'count', 'isClosed'})
                        self.assertEqual(result['path']['chain'], 'none')
                        self.assertEqual(model.HANDLERS['path.inspect'](ctx, result['path'])['count'], result['count'])
                    elif operation in ('sketch.geometry', 'sketch.project'):
                        self.assertEqual(set(result), {'entities', 'refs'})
                    elif operation in ('sketch.constrain', 'sketch.pattern'):
                        self.assertEqual(set(result), {'constraint'})
                    elif operation == 'sketch.offset':
                        self.assertEqual(set(result), {'constraint', 'entities', 'refs', 'offsetParameter'})
                    elif operation == 'sketch.mirror':
                        self.assertEqual(set(result), {'entities', 'refs', 'constraints'})
                    elif operation == 'sketch.dimension':
                        self.assertEqual(set(result), {'dimension', 'parameter', 'expression'})
                    elif operation == 'sketch.create':
                        self.assertEqual(set(result), {'sketch'})
                    elif operation == 'sketch.edit':
                        self.assertEqual(set(result), {'sketch', 'edited'})
                    elif operation == 'sketch.check':
                        self.assertEqual(set(result), {'sketch', 'isFullyConstrained', 'profileCount', 'healthState', 'message', 'underconstrained'})
                    elif operation == 'sketch.inspect':
                        self.assertEqual(set(result), {'sketch', 'isFullyConstrained', 'curves', 'points', 'constraints', 'dimensions', 'profiles'})

    def test_foreign_construction_owner_rejected_before_sdk_input_or_add(self):
        ctx = model.Context()
        model.TRACE.clear()
        plane = ctx.entities['XY']
        plane.component = ctx.root
        self.assertIs(model.namespace['_cad_owner'](plane), ctx.root)
        with self.assertRaisesRegex(ValueError, 'native input geometry in the selected component'):
            model.HANDLERS['model.extrude'](ctx, {
                'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0},
                'extent': 'toEntity', 'target': 'XY',
            })
        self.assertFalse(model.TRACE)
        self.assertFalse(ctx.created)


if __name__ == '__main__':
    unittest.main(verbosity=2)
