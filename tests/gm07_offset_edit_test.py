"""GM07 native offset dimension edit and SketchCurveVector contract tests.

Offline SDK-shape tests with mocked collections; no Fusion kernel claims. The
SketchCurveVector case reproduces the live GM07 crash where offset child curves
came back as an iterable vector without a .count property.
"""
import json
import types
import unittest

import model_test as base


NS = dict(base.namespace, CAD_HANDLERS=dict(base.HANDLERS))
sdk = types.SimpleNamespace(core=types.SimpleNamespace(**vars(base.adsk.core)),
                            fusion=types.SimpleNamespace(**vars(base.adsk.fusion)))
NS['adsk'] = sdk
sdk.fusion.OffsetConstraint = types.SimpleNamespace(cast=lambda e: e if getattr(e, 'offsetFlag', None) else None)
exec(compile((base.ROOT / 'assets/cad/curve.py').read_text(), 'curve.py', 'exec'), NS)


def _identity(ctx):
    return {'creationId': ctx.doc.creationId, 'name': ctx.doc.name}


NS['_sketch_identity'] = _identity


class Parameter:
    def __init__(self, name, expression='5 mm'):
        self.name = name
        self.unit = 'cm'
        self.value = 0.5
        self._expression = expression

    @property
    def expression(self):
        return self._expression

    @expression.setter
    def expression(self, value):
        self._expression = value


class OffsetConstraint(base.Entity):
    offsetFlag = True

    def __init__(self, sketch, parameter=None):
        super().__init__('OffsetConstraint', sketch)
        self.dimension = None if parameter is None else types.SimpleNamespace(parameter=parameter)
        self.childCurves = []


class CurveVector:
    """Iterable SDK SketchCurveVector shape: no .count, no .item."""
    def __init__(self, curves):
        self.curves = curves

    def __iter__(self):
        return iter(self.curves)


class VectorConstraints(base.Constraints):
    def addOffset2(self, inp):
        base.TRACE.append(('offset',))
        result = base.Entity('OffsetConstraint', self.sketch)
        result.childCurves = CurveVector([base.Entity('SketchLine', self.sketch)])
        return result


class Context(base.Context):
    def __init__(self):
        super().__init__()
        self.doc = types.SimpleNamespace(creationId='gm07-doc', name='GM07')
        self.offset_parameter = Parameter('d203')
        self.user_parameter = Parameter('wall', '1 cm')
        self.constraint_sketch = base.Sketch(self.component)
        self.constraint = OffsetConstraint(self.constraint_sketch, self.offset_parameter)
        self.constraint_sketch.geometricConstraints = base.Collection([self.constraint])
        self.component.sketches = base.Collection([self.constraint_sketch])
        self.design = types.SimpleNamespace(
            allParameters=base.Collection([self.offset_parameter, self.user_parameter]),
            allComponents=base.Collection([self.component]))

    def assert_identity(self):
        pass

    def resolve(self, ref, kind=None):
        if kind == 'parameter' and isinstance(ref, dict):
            name = ref.get('name') or ref.get('token')
            matches = [p for p in self.design.allParameters.values if p.name == name]
            if len(matches) != 1:
                raise ValueError('parameter not found')
            return matches[0]
        return super().resolve(ref, kind)

    def call(self, operation, data):
        return NS['CAD_HANDLERS'][operation](self, data)


class OffsetEditTests(unittest.TestCase):
    def setUp(self):
        base.TRACE.clear()
        self.ctx = Context()

    def edit(self, **patch):
        return self.ctx.call('curve.offset-edit',
                             {'schemaVersion': 1, 'frame': 'sketch', 'parameter': 'd203', 'distance': '8 mm', **patch})

    def test_edit_updates_native_parameter_and_reports_envelope(self):
        result = self.edit()
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['operation'], 'curve.offset-edit')
        self.assertEqual(result['documentIdentity']['creationId'], 'gm07-doc')
        self.assertEqual(result['associativity'], 'nativeExpression')
        self.assertEqual(result['frame']['space'], 'sketch')
        self.assertEqual(result['before']['expression'], '5 mm')
        self.assertEqual(result['after']['expression'], '8 mm')
        self.assertEqual(result['parameter']['name'], 'd203')
        self.assertEqual(self.ctx.offset_parameter.expression, '8 mm')
        json.dumps(result)

    def test_reference_target_and_unknown_and_non_offset_parameters(self):
        result = self.ctx.call('curve.offset-edit',
                               {'schemaVersion': 1, 'frame': 'sketch',
                                'parameter': {'name': 'd203', 'kind': 'parameter'}, 'distance': '9 mm'})
        self.assertEqual(result['after']['expression'], '9 mm')
        with self.assertRaisesRegex(ValueError, 'not found'):
            self.edit(parameter='missing')
        with self.assertRaisesRegex(ValueError, 'does not control'):
            self.edit(parameter='wall')

    def test_deleted_dimension_is_not_editable(self):
        self.ctx.constraint.dimension = None
        with self.assertRaisesRegex(ValueError, 'does not control'):
            self.edit()

    def test_sketch_offset_handles_iterable_vector_without_count(self):
        self.ctx.sketch.geometricConstraints = VectorConstraints(self.ctx.sketch)
        result = base.HANDLERS['sketch.offset'](self.ctx, {'sketch': 'Section', 'entities': ['line-token'], 'distance': '5 mm'})
        self.assertIn('constraint', result)
        self.assertEqual(len(result['entities']), 1)
        self.assertIsNone(result['offsetParameter'])
        json.dumps(result)

    def test_sketch_offset_reports_native_dimension_parameter_name(self):
        parameter = Parameter('d400')
        self.ctx.sketch.geometricConstraints = VectorConstraints(self.ctx.sketch)
        self.ctx.sketch.geometricConstraints.addOffset2 = lambda inp: OffsetConstraint(self.ctx.sketch, parameter)
        result = base.HANDLERS['sketch.offset'](self.ctx, {'sketch': 'Section', 'entities': ['line-token'], 'distance': '5 mm'})
        self.assertEqual(result['offsetParameter'], 'd400')


if __name__ == '__main__':
    unittest.main()
