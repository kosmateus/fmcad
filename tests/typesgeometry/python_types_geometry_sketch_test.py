"""Strict typing contracts for the sketch, sketch-plan and curve adapters."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
ADAPTERS = ROOT / 'runtime/python/fmcad/adapters/fusion'


def functions(path):
    tree = ast.parse(path.read_text())
    return {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}


def annotation_text(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ast.unparse(node)


class GeometrySketchTypeContractTests(unittest.TestCase):
    def test_curve_json_sdk_and_nullable_signatures_are_explicit(self):
        curve = functions(ADAPTERS / 'geometry_curve.py')
        self.assertEqual(annotation_text(curve['_curve_evidence'].args.args[0].annotation), 'CadContext')
        self.assertEqual(annotation_text(curve['_curve_evidence'].args.args[1].annotation), "list['CadEntity']")
        self.assertEqual(annotation_text(curve['_curve_evidence'].returns), 'JsonObject')
        self.assertEqual(annotation_text(curve['_curve_result'].args.args[3].annotation), 'JsonObject')
        self.assertEqual(annotation_text(curve['_curve_result'].args.args[5].annotation), 'JsonValue | None')
        self.assertEqual(annotation_text(curve['_curve_offset_dimension'].returns),
                         'adsk.fusion.SketchDimension | None')

    def test_sketch_and_plan_use_sdk_entities_and_json_records(self):
        sketch = functions(ADAPTERS / 'geometry_sketch.py')
        plan = functions(ADAPTERS / 'geometry_sketch_plan.py')
        self.assertEqual(annotation_text(sketch['_sketch_target'].returns), 'adsk.fusion.Sketch')
        self.assertEqual(annotation_text(sketch['_sketch_result'].returns), 'JsonObject')
        self.assertEqual(annotation_text(plan['_sketch_component_expressions'].args.args[1].annotation),
                         'JsonValue')
        self.assertEqual(annotation_text(plan['_sketch_component_expressions'].returns), 'list[str]')
        self.assertEqual(annotation_text(plan['_sketch_plan_options'].returns),
                         'tuple[int, float, int | float]')
        self.assertEqual(annotation_text(plan['sketch_dimension_plan'].returns), 'JsonObject')
        self.assertEqual(annotation_text(plan['sketch_dimension_apply'].returns), 'JsonObject')

    def test_nullable_point_creation_is_checked_before_sketch_api_use(self):
        sources = (
            ADAPTERS / 'geometry_sketch.py',
            ADAPTERS / 'geometry_sketch_plan.py',
        )
        for path in sources:
            tree = ast.parse(path.read_text())
            parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
            point_creations = [node for node in ast.walk(tree)
                               if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                               and node.func.attr == 'create' and isinstance(node.func.value, ast.Attribute)
                               and node.func.value.attr == 'Point3D']
            for call in point_creations:
                wrapper = parents.get(call)
                with self.subTest(path=path, line=call.lineno):
                    self.assertIsInstance(wrapper, ast.Call)
                    self.assertIsInstance(wrapper.func, ast.Name)
                    self.assertEqual(wrapper.func.id, '_model_ok')
                    self.assertIs(wrapper.args[0], call)

    def test_family_does_not_use_any_or_type_suppression(self):
        for name in ('geometry_curve.py', 'geometry_sketch.py', 'geometry_sketch_plan.py'):
            path = ADAPTERS / name
            tree = ast.parse(path.read_text())
            with self.subTest(path=path):
                self.assertFalse(any(isinstance(node, ast.Name) and node.id == 'Any'
                                     for node in ast.walk(tree)))
                self.assertNotRegex(path.read_text(), r'(?im)^\s*#.*(?:type:\s*ignore|no_type_check|pyright:\s*ignore)')
                for node in ast.walk(tree):
                    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and
                            node.func.id in ('cast', '_geometry_curve_cast', '_geometry_sketch_cast',
                                             '_geometry_sketch_plan_cast')):
                        self.assertTrue(node.args)
                        self.assertNotEqual(annotation_text(node.args[0]), 'Any')


if __name__ == '__main__':
    unittest.main()
