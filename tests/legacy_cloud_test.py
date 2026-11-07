"""Cloud migration parity, including later diagnostic and deletion contracts."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TypeErasure(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        node = self.generic_visit(node)
        node.returns = None
        for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
            argument.annotation = None
        return node

    def visit_AnnAssign(self, node):
        node = self.generic_visit(node)
        return ast.Assign(targets=[node.target], value=node.value) if node.value is not None else None

    def visit_Call(self, node):
        node = self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == 'cast':
            return node.args[1]
        return node


class CloudMigration(unittest.TestCase):
    def test_ordinary_operations_preserve_executable_definitions(self):
        fixture = ROOT / 'tests/fixtures/history/cloud-9dc58fd.py.txt'
        metadata = json.loads(fixture.with_suffix('.json').read_text())
        self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(), metadata['sha256'])
        old = ast.parse(fixture.read_text())
        current = ast.parse((ROOT / 'runtime/python/fmcad/adapters/fusion/legacy_cloud.py').read_text())
        old_functions = {n.name: n for n in old.body if isinstance(n, ast.FunctionDef)}
        new_functions = {n.name: n for n in current.body if isinstance(n, ast.FunctionDef)}
        differences = {
            'cmd_folder_delete': 'manual_legacy_test checks root rejection before any delete call',
            'cmd_file_move': 'manual_legacy_test checks false acceptance and one move call',
            'cmd_file_editability': 'file_editability_test checks exact results and partial failures',
            'cmd_file_editability_list': 'file_editability_list_test checks exact inventory and errors',
            'run': 'dispatcher receives the same operation and argument list explicitly',
        }
        preserved = 0
        for name, function in old_functions.items():
            if name in differences:
                continue
            with self.subTest(function=name):
                before = TypeErasure().visit(copy.deepcopy(function))
                after = TypeErasure().visit(copy.deepcopy(new_functions[name]))
                self.assertEqual(ast.dump(before), ast.dump(after))
                preserved += 1
        self.assertEqual(preserved, 15)
        self.assertEqual(set(new_functions) - set(old_functions), {'dispatch_cloud'})

        class RenameInputs(ast.NodeTransformer):
            def visit_Name(self, node):
                node.id = {'operation': 'OP', 'args': 'ARGS'}.get(node.id, node.id)
                return node

        dispatch = RenameInputs().visit(copy.deepcopy(new_functions['dispatch_cloud']))
        self.assertEqual([ast.dump(n) for n in old_functions['run'].body],
                         [ast.dump(n) for n in dispatch.body])
        self.assertEqual(ast.dump(new_functions['run'].body[0]),
                         ast.dump(ast.parse('dispatch_cloud(OP, ARGS)').body[0]))


if __name__ == '__main__':
    unittest.main()
