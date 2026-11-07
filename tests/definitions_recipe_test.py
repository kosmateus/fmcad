"""Actual recipe/feature-edit handlers with an isolated in-memory SDK fixture."""
import json
import enum
import math
from pathlib import Path
import re
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]


class Attributes:
    def __init__(self):
        self.values = {}

    def itemByName(self, group, name):
        return self.values.get((group, name))

    def add(self, group, name, value):
        result = types.SimpleNamespace(value=value)
        self.values[group, name] = result
        return result


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    @property
    def markerPosition(self):
        return self.count

    def item(self, index):
        return self.values[index]


def fields(data, required=(), optional=()):
    if not isinstance(data, dict) or set(required) - data.keys() or data.keys() - set(required) - set(optional):
        raise ValueError('Invalid fields')


def unique(values, label):
    if len(values) != 1:
        raise ValueError(label + ': expected one match')
    return values[0]


def require(value, label):
    if value is None or value is False:
        raise RuntimeError(label)
    return value


class Context:
    def __init__(self, namespace):
        self.ns = namespace
        self.root = types.SimpleNamespace(attributes=Attributes())
        self.doc_file_id = 'file-1'
        self.doc = types.SimpleNamespace(dataFile=types.SimpleNamespace(id='file-1'))
        self.design = types.SimpleNamespace(designType=1, timeline=Collection(), allParameters=Collection(), computeAll=lambda: True)
        self.entities = {}
        self.edits = []

    def assert_identity(self):
        if self.doc_file_id is not None and self.doc.dataFile.id != self.doc_file_id:
            raise ValueError('identity mismatch')

    def ref(self, entity):
        return {'token': entity.name}

    def resolve(self, ref, kind=None):
        return self.entities[ref['token']]

    def describe(self, entity):
        return self.ref(entity)

    def _expression(self, expression, units, unitless=False):
        if not isinstance(expression, str) or not expression.endswith(' mm'):
            raise ValueError('Invalid dimension expression')
        return expression, float(expression[:-3]) / 10

    def call(self, operation, data):
        self.edits.append((operation, data))
        return self.ns['_assembly_history'](self, data, 'edit')

    def feature(self, name, expression='10 mm'):
        feature = types.SimpleNamespace(name=name, objectType='adsk::fusion::ExtrudeFeature', attributes=Attributes(), isSuppressed=False)
        self.entities[name] = feature
        self.design.timeline.values.append(types.SimpleNamespace(entity=feature, healthState=0))
        self.design.allParameters.values.append(types.SimpleNamespace(name='d_' + name, createdBy=feature, expression=expression, unit='cm', role='AlongDistance'))
        return feature


def namespace():
    ns = {'json': json, 'math': math, 're': re, 'CAD_HANDLERS': {}, '_cad_fields': fields, '_cad_unique': unique,
          '_cad_cast': lambda _type, value: value,
          '_cad_require_result': require, '_cad_items': lambda c: c.values,
          '_cad_kind': lambda entity: 'feature',
          'adsk': types.SimpleNamespace(fusion=types.SimpleNamespace(
              DesignTypes=types.SimpleNamespace(ParametricDesignType=1),
              FeatureHealthStates=types.SimpleNamespace(HealthyFeatureHealthState=0)))}
    # Use the actual existing selector/editor rather than a duplicate test implementation.
    assembly = (ROOT / 'runtime/python/fmcad/adapters/fusion/assembly.py').read_text()
    exec(assembly[assembly.index('def _assembly_feature_plan'):assembly.index('def _assembly_handler')], ns)
    exec(compile((ROOT / 'assets/cad/definitions.py').read_text(), 'definitions.py', 'exec'), ns)
    return ns


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.ns = namespace()
        self.ctx = Context(self.ns)
        self.recipe = {'id': 'fixture', 'bindings': [
            {'parameter': 'height', 'input': 'distance', 'target': {'$ref': 'solid.result.feature'}, 'role': 'AlongDistance'}]}
        self.hash = 'a' * 64

    def call(self, operation, data):
        return self.ns['CAD_HANDLERS'][operation](self.ctx, data)

    def begin(self):
        return self.call('definition.recipe', {'action': 'begin', 'recipe': self.recipe, 'sourceHash': self.hash,
            'source': {'operations': [{'id': 'solid'}], 'parameters': {'height': '10 mm'}}})

    def complete(self, name='solid'):
        return self.call('definition.recipe', {'action': 'complete', 'recipe': self.recipe, 'sourceHash': self.hash,
            'bindings': [{**self.recipe['bindings'][0], 'target': {'token': name}}], 'created': [{'token': name}]})

    def ready(self):
        self.begin()
        self.ctx.feature('solid')
        return self.complete()

    def regenerate(self, **changes):
        return self.call('definition.regenerate', {'id': 'fixture', 'expectedRevision': 1,
            'sourceHash': self.hash, 'parameters': {'height': '15 mm'}, **changes})

    def record(self):
        return json.loads(self.ctx.root.attributes.itemByName('fmcad.recipes.v1', 'fixture').value)

    def test_durable_source_dry_run_and_two_in_place_revisions(self):
        self.assertEqual(self.ready()['recipeStatus'], 'ready')
        self.assertEqual(self.record()['source']['parameters'], {'height': '10 mm'})
        before = json.dumps(self.record(), sort_keys=True)
        plan = self.regenerate()
        self.assertFalse(plan['applied'])
        self.assertEqual(plan['plan'][0]['unit'], 'cm')
        self.assertEqual(before, json.dumps(self.record(), sort_keys=True))
        self.assertEqual(self.ctx.edits, [])
        result = self.regenerate(dryRun=False)
        self.assertTrue(result['applied'])
        self.assertEqual(result['revision'], 2)
        self.assertEqual(self.ctx.design.allParameters.item(0).expression, '15 mm')
        self.assertEqual(self.ctx.design.timeline.count, 1)
        self.regenerate(dryRun=False, expectedRevision=2, parameters={'height': '20 mm'})
        self.assertEqual(self.record()['revision'], 3)
        self.assertEqual(self.ctx.design.timeline.count, 1)

    def test_sketch_snapshot_serializes_sdk_vector_outputs_and_detects_edits(self):
        # SWIG vectors are iterable, not Python lists or Fusion Base objects.
        class Vector:
            def __init__(self, values):
                self.values = values

            def __iter__(self):
                return iter(self.values)

        self.ns['enum'] = enum
        core = (ROOT / 'assets/cad/core.py').read_text()
        exec(core[core.index('def _cad_type'):core.index('def _cad_geometry')], self.ns)
        point = types.SimpleNamespace(objectType='adsk::core::Point3D', x=1, y=2, z=3)
        data = (True, Vector([point]), 2, Vector([0., 0., 1., 1.]), True, Vector([1.]), False)
        curve = types.SimpleNamespace(objectType='adsk::fusion::SketchCircle', isConstruction=False,
                                      isFixed=False, geometry=types.SimpleNamespace(
                                          asNurbsCurve=types.SimpleNamespace(getData=lambda: data)))
        sketch = types.SimpleNamespace(objectType='adsk::fusion::Sketch', name='Section',
            sketchCurves=Collection([curve]), sketchPoints=Collection(),
            geometricConstraints=Collection(), sketchDimensions=Collection())
        self.ns['_CAD_KINDS'] = {'Sketch': 'sketch'}
        snapshot = self.ns['_definition_state'](self.ctx, sketch)
        self.assertEqual(snapshot['curves'][0]['data'], [
            [{'type': 'Point3D', 'xyz': [1., 2., 3.]}], 2, [0., 0., 1., 1.], True, [1.], False])
        json.dumps(snapshot, allow_nan=False)
        point.x = 4
        self.assertNotEqual(snapshot, self.ns['_definition_state'](self.ctx, sketch))

    def test_missing_recipe_and_pin_refuse_before_mutation(self):
        with self.assertRaisesRegex(ValueError, 'Missing durable'):
            self.regenerate()
        self.ctx.doc_file_id = None
        with self.assertRaisesRegex(ValueError, 'pinned'):
            self.begin()
        self.assertEqual(self.ctx.root.attributes.values, {})

    def test_incomplete_build_cannot_replay_or_regenerate(self):
        self.begin()
        self.ctx.feature('seed')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.begin()
        with self.assertRaisesRegex(ValueError, 'state conflict'):
            self.regenerate()
        self.assertEqual(self.record()['status'], 'building')

    def test_complete_never_adopts_unreported_or_preexisting_entities(self):
        self.ctx.feature('foreign')
        self.begin()
        self.ctx.feature('solid')
        with self.assertRaisesRegex(ValueError, 'Unattributed'):
            self.complete('foreign')
        self.assertIsNone(self.ctx.entities['foreign'].attributes.itemByName('fmcad.recipeOwner.v1', 'id'))

    def test_changed_baseline_prevents_ownership_commit(self):
        self.ctx.feature('foreign')
        self.begin()
        self.ctx.design.allParameters.item(0).expression = '12 mm'
        self.ctx.feature('solid')
        with self.assertRaisesRegex(ValueError, 'User edit'):
            self.complete()

    def test_foreign_later_history_blocks_downstream(self):
        self.ready()
        self.ctx.feature('foreign')
        with self.assertRaisesRegex(ValueError, 'Downstream'):
            self.regenerate(dryRun=False)
        self.assertEqual(self.ctx.edits, [])

    def test_user_parameter_dependency_edit_blocks_regeneration(self):
        user = types.SimpleNamespace(name='external', expression='10 mm', unit='cm')
        self.ctx.design.allParameters.values.append(user)
        self.ready()
        user.expression = '12 mm'
        with self.assertRaisesRegex(ValueError, 'dependency conflict'):
            self.regenerate(dryRun=False)
        self.assertEqual(self.ctx.edits, [])

    def test_user_edit_ownership_loss_and_wrong_revision_or_source(self):
        self.ready()
        for kwargs in [{'sourceHash': 'b' * 64}, {'expectedRevision': 2}, {'parameters': {'count': '2 mm'}}]:
            with self.assertRaises(ValueError):
                self.regenerate(dryRun=False, **kwargs)
        self.ctx.design.allParameters.item(0).expression = '11 mm'
        with self.assertRaisesRegex(ValueError, 'User edit'):
            self.regenerate(dryRun=False)
        self.ctx.design.allParameters.item(0).expression = '10 mm'
        self.ctx.entities['solid'].attributes.values.clear()
        with self.assertRaisesRegex(ValueError, 'ownership'):
            self.regenerate(dryRun=False)
        self.assertEqual(self.ctx.edits, [])

    def test_invalid_units_preflight_all_before_assignment(self):
        self.ready()
        with self.assertRaisesRegex(ValueError, 'dimension'):
            self.regenerate(dryRun=False, parameters={'height': 99})
        self.assertEqual(self.ctx.edits, [])
        self.assertEqual(self.record()['status'], 'ready')

    def test_recompute_failure_retains_uncertainty_and_no_retry(self):
        self.ready()
        self.ctx.design.computeAll = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'recompute'):
            self.regenerate(dryRun=False)
        self.assertEqual(self.record()['status'], 'updating')
        self.assertEqual(self.ctx.design.allParameters.item(0).expression, '15 mm')
        with self.assertRaisesRegex(ValueError, 'state conflict'):
            self.regenerate(dryRun=False)
        self.assertEqual(len(self.ctx.edits), 1)

    def test_ambiguous_native_role_is_not_first_match(self):
        self.begin()
        feature = self.ctx.feature('solid')
        self.ctx.design.allParameters.values.append(types.SimpleNamespace(name='other', createdBy=feature, expression='10 mm', unit='cm', role='AlongDistance'))
        with self.assertRaisesRegex(ValueError, 'one match'):
            self.complete()

    def test_silent_native_assignment_failure_is_not_accepted(self):
        self.ready()
        self.ctx.call = lambda operation, data: {'applied': True}
        with self.assertRaisesRegex(RuntimeError, 'readback differs'):
            self.regenerate(dryRun=False)
        self.assertEqual(self.record()['status'], 'updating')

    def test_sketch_snapshot_detects_exact_control_data_changes(self):
        self.ns['_cad_kind'] = lambda entity: 'sketch'
        self.ns['_cad_json'] = lambda value: value
        self.ns['_cad_xyz'] = lambda point: [point.x, point.y, point.z]
        control = [1, 2, 3]
        curve = types.SimpleNamespace(objectType='SketchLine', isConstruction=False, isFixed=False,
            geometry=types.SimpleNamespace(asNurbsCurve=types.SimpleNamespace(
                getData=lambda: (True, control.copy(), 1, [0, 0, 1, 1], False, [], False))))
        sketch = types.SimpleNamespace(name='s', objectType='Sketch', sketchCurves=Collection([curve]),
            sketchPoints=Collection(), geometricConstraints=Collection(), sketchDimensions=Collection())
        before = self.ns['_definition_state'](self.ctx, sketch)
        control[1] = 4
        after = self.ns['_definition_state'](self.ctx, sketch)
        self.assertNotEqual(before, after)


if __name__ == '__main__':
    unittest.main()
