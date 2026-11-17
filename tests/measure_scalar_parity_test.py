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
    return ast.dump(assignment.value, include_attributes=False)


class MeasureScalarParityTests(unittest.TestCase):
    def test_dimension_selection_matches_frozen_python_source(self):
        self.assertEqual(dimension_expression(ADAPTER), dimension_expression(HISTORICAL))


if __name__ == '__main__':
    unittest.main()
