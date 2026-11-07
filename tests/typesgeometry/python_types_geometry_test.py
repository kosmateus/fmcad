"""Focused geometry typing contracts and unchanged JSON-vector validation."""
import ast
import importlib.util
from pathlib import Path
from typing import cast
import unittest


ROOT = Path(__file__).resolve().parents[2]
GEOMETRY = ROOT / 'runtime/python/fmcad'


def load_domain(name):
    path = GEOMETRY / 'domain' / f'geometry_{name}.py'
    spec = importlib.util.spec_from_file_location(f'geometry_types_{name}', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'Cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GeometryTypeContractTests(unittest.TestCase):
    @staticmethod
    def annotation_name(annotation):
        if isinstance(annotation, ast.Name):
            return annotation.id
        if isinstance(annotation, ast.Constant):
            return annotation.value
        return None

    def test_family_context_and_json_parameters_are_explicit(self):
        for layer in ('application', 'adapters/fusion'):
            for path in (GEOMETRY / layer).glob('geometry_*.py'):
                with self.subTest(path=path):
                    tree = ast.parse(path.read_text())
                    functions = [node for node in ast.walk(tree)
                                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
                    for function in functions:
                        arguments = {arg.arg: arg.annotation for arg in
                                     function.args.posonlyargs + function.args.args + function.args.kwonlyargs}
                        if 'ctx' in arguments:
                            self.assertEqual(self.annotation_name(arguments['ctx']), 'CadContext',
                                             f'{path}:{function.lineno} ctx')
                        if 'data' in arguments:
                            expected = 'object' if (
                                (path.name == 'geometry_feature.py' and function.name == 'handler')
                                or (path.name == 'geometry_model.py' and function.name == '_model_path')
                            ) else 'JsonObject'
                            self.assertEqual(self.annotation_name(arguments['data']), expected,
                                             f'{path}:{function.lineno} data')

    def test_domain_vector_validation_and_projection_are_unchanged(self):
        vector = load_domain('datum')._datum_vector
        self.assertEqual(vector([1, 2.5, -3]), [1, 2.5, -3])
        self.assertEqual(vector((0, 0.5, 1)), [0, 0.5, 1])
        for value in (None, [1, 2], [1, True, 3], [1, float('inf'), 3], {'x': 1}):
            with self.subTest(value=value), self.assertRaisesRegex(
                    ValueError, 'Vector requires three finite unitless numbers'):
                vector(value)

    def test_model_nested_json_shapes_are_checked_before_narrowing(self):
        path = GEOMETRY / 'adapters/fusion/geometry_model.py'
        tree = ast.parse(path.read_text())
        helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                   and node.name in ('_model_json_object', '_model_json_array')]
        namespace = {'_geometry_model_cast': cast}
        exec(compile(ast.Module(body=helpers, type_ignores=[]), str(path), 'exec'), namespace)
        object_value = namespace['_model_json_object']({'kind': 'path'}, 'test')
        self.assertEqual(object_value, {'kind': 'path'})
        self.assertEqual(namespace['_model_json_array']([1, 'x'], 'test'), [1, 'x'])
        for value in (None, [], 'path'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'test must be an object'):
                namespace['_model_json_object'](value, 'test')
        with self.assertRaisesRegex(ValueError, 'test keys must be strings'):
            namespace['_model_json_object']({1: 'invalid JSON key'}, 'test')
        for value in (None, {}, 'not an array'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'test must be an array'):
                namespace['_model_json_array'](value, 'test')

    def test_changed_runtime_sources_have_no_any_or_suppression_escape_hatches(self):
        for layer in ('domain', 'application', 'adapters/fusion'):
            for path in (GEOMETRY / layer).glob('geometry_*.py'):
                source = path.read_text()
                tree = ast.parse(source)
                with self.subTest(path=path):
                    self.assertFalse(any(isinstance(node, ast.Name) and node.id == 'Any'
                                         for node in ast.walk(tree)))
                    self.assertNotRegex(source, r'(?im)^\s*#.*(?:type:\s*ignore|no_type_check)')


if __name__ == '__main__':
    unittest.main()
