"""Keep the migrated scalar adapter's retained dimension selection intact."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
HISTORICAL = ROOT / 'tests/fixtures/modeling-python-history/measure.py'
ADAPTER = ROOT / 'runtime/python/fmcad/adapters/fusion/measure.py'


def dimension_expression(path):
    tree = ast.parse(path.read_text())
    function = next(node for node in tree.body
                    if isinstance(node, ast.FunctionDef) and node.name == '_measure_scalar')
    assignment = next(node for node in function.body
                      if isinstance(node, ast.Assign) and
                      any(isinstance(target, ast.Name) and target.id == 'dimension'
                           for target in node.targets))
    return assignment.value


def dimension_value(expression, mode):
    return eval(compile(ast.Expression(expression), '<dimension-expression>', 'eval'),
                {'__builtins__': {}, 'mode': mode, '_cad_cast': lambda unused_type, value: value})


def without_static_cast(expression):
    class StripCast(ast.NodeTransformer):
        def visit_Call(self, call):
            if isinstance(call.func, ast.Name) and call.func.id == '_cad_cast':
                return self.visit(call.args[1])
            return self.generic_visit(call)

    return ast.dump(StripCast().visit(expression), include_attributes=False)


class MeasureScalarParityTests(unittest.TestCase):
    def test_dimension_selection_preserves_frozen_mapping_with_static_narrowing(self):
        current = dimension_expression(ADAPTER)
        historical = dimension_expression(HISTORICAL)
        self.assertEqual(
            without_static_cast(current),
            ast.dump(historical, include_attributes=False),
        )
        for mode in ('diameter', 'radius', 'distance', 'angle', 'length', 'area',
                     'volume', 'mass', 'thickness'):
            self.assertEqual(dimension_value(current, mode), dimension_value(historical, mode), mode)


if __name__ == '__main__':
    unittest.main()
