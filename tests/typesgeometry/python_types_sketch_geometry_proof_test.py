"""Strict source-contract checks for sketch geometry proof units."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'runtime/python/fmcad'
FAMILY = (
    RUNTIME / 'application/sketch_geometry_proof.py',
    RUNTIME / 'adapters/fusion/sketch_geometry_proof.py',
)


def tree(path):
    return ast.parse(path.read_text())


def functions(path):
    return {node.name: node for node in tree(path).body if isinstance(node, ast.FunctionDef)}


def annotation(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ast.unparse(node)


class SketchGeometryProofTypes(unittest.TestCase):
    def test_application_handlers_use_canonical_context_and_json_contracts(self):
        application = functions(FAMILY[0])
        for name in ('sketch_coordinate_check', 'sketch_profile_query'):
            with self.subTest(handler=name):
                handler = application[name]
                self.assertEqual(annotation(handler.args.args[0].annotation), 'CadContext')
                self.assertEqual(annotation(handler.args.args[1].annotation), 'JsonObject')
                self.assertEqual(annotation(handler.returns), 'JsonValue')

    def test_adapter_uses_typed_sdk_and_the_existing_curve_evidence_graph(self):
        adapter = tree(FAMILY[1])
        methods = {node.name: node for node in ast.walk(adapter) if isinstance(node, ast.FunctionDef)}
        self.assertEqual(annotation(methods['coordinate_check'].args.args[1].annotation), 'JsonObject')
        self.assertEqual(annotation(methods['coordinate_check'].returns), 'JsonObject')
        self.assertEqual(annotation(methods['profile_query'].returns), 'JsonObject')
        self.assertTrue(any(isinstance(node, ast.Name) and node.id == '_curve_evidence'
                            for node in ast.walk(adapter)))
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
                             node.func.attr == 'item' and any(
                                 isinstance(arg, ast.Constant) and arg.value == 0 for arg in node.args)
                             for node in ast.walk(adapter)))

    def test_domain_is_sdk_free_and_units_have_no_any_or_suppression_hatches(self):
        application = tree(FAMILY[0])
        domain_functions = functions(FAMILY[0])
        self.assertFalse(any(isinstance(node, ast.Name) and node.id == 'adsk'
                             for node in ast.walk(application)))
        self.assertEqual(annotation(domain_functions['proof_status'].returns), '_SketchProofStatus')
        cast_names = {'cast', '_sketch_proof_cast', '_sketch_geometry_proof_cast'}
        for path in FAMILY:
            source = path.read_text()
            parsed = tree(path)
            with self.subTest(path=path):
                self.assertFalse(any(isinstance(node, ast.Name) and node.id == 'Any'
                                     for node in ast.walk(parsed)))
                self.assertNotRegex(source, r'(?im)^\s*#.*(?:type:\s*ignore|no_type_check|pyright:\s*ignore)')
                for node in ast.walk(parsed):
                    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and
                            node.func.id in cast_names):
                        self.assertTrue(node.args)
                        self.assertNotEqual(annotation(node.args[0]), 'Any')


if __name__ == '__main__':
    unittest.main()
