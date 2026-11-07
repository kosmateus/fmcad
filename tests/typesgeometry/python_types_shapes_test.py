"""Focused shape-adapter typing boundaries and runtime JSON guards."""
import ast
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / 'runtime/python/fmcad/adapters/fusion/geometry_shapes.py'


def load_adapter():
    spec = importlib.util.spec_from_file_location('geometry_shapes_types', ADAPTER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'Cannot load {ADAPTER}')
    module = importlib.util.module_from_spec(spec)
    module.__dict__['_cad_scoped_step'] = lambda *args, **kwargs: lambda function: function
    spec.loader.exec_module(module)
    return module


class ShapesTypeContractTests(unittest.TestCase):
    def test_adapter_functions_have_complete_annotations(self):
        tree = ast.parse(ADAPTER.read_text())
        functions = [node for node in ast.walk(tree)
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        self.assertTrue(functions)
        for function in functions:
            arguments = (function.args.posonlyargs + function.args.args + function.args.kwonlyargs)
            with self.subTest(function=function.name):
                self.assertIsNotNone(function.returns, f'{function.name} return')
                for argument in arguments:
                    self.assertIsNotNone(argument.annotation, f'{function.name}.{argument.arg}')

    def test_cap_face_picks_upper_or_lower_extreme(self):
        adapter = load_adapter()

        class Point:
            def __init__(self, z):
                self.x, self.y, self.z = 0.0, 0.0, z

        class Face:
            def __init__(self, z):
                self.centroid = Point(z)

        class Body:
            faces = [Face(-2.0), Face(0.0), Face(3.0)]

        class Context:
            def resolve(self, reference, kind):
                return Body()

        adapter._cad_items = list
        adapter._cad_xyz = lambda point: [point.x, point.y, point.z]
        self.assertEqual(adapter._shapes_cap_face(Context(), 'body', (0.0, 0.0, 1.0), True).centroid.z, 3.0)
        self.assertEqual(adapter._shapes_cap_face(Context(), 'body', (0.0, 0.0, 1.0), False).centroid.z, -2.0)

    def test_adapter_has_no_any_or_suppression_escape_hatches(self):
        source = ADAPTER.read_text()
        tree = ast.parse(source)
        self.assertFalse(any(isinstance(node, ast.Name) and node.id == 'Any'
                             for node in ast.walk(tree)))
        self.assertNotRegex(source, r'(?im)^\s*#.*(?:type:\s*ignore|no_type_check)')


if __name__ == '__main__':
    unittest.main()
