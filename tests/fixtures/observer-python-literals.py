"""Read only whitelisted Python literal metadata from observer test scripts."""

import ast
import json
import sys


values: dict[str, object] = {}
names = {'_ATOMIC_STATUS_REQUEST', '_AA_REQUEST', '_qr_binding_value', '_qr_binding', '_qr_path'}


def literal(node: ast.expr) -> object:
    try:
        return ast.literal_eval(node)
    except (TypeError, ValueError):
        pass
    if isinstance(node, ast.Name) and node.id in values:
        return values[node.id]
    if isinstance(node, ast.Call):
        if (isinstance(node.func, ast.Attribute) and node.func.attr == 'loads' and len(node.args) == 1 and
                ((isinstance(node.func.value, ast.Name) and node.func.value.id == '_qr_json') or
                 (isinstance(node.func.value, ast.Call) and isinstance(node.func.value.func, ast.Name) and
                  node.func.value.func.id == '__import__' and len(node.func.value.args) == 1 and
                  ast.literal_eval(node.func.value.args[0]) == 'json' and not node.func.value.keywords))):
            encoded = literal(node.args[0])
            if not isinstance(encoded, str):
                raise ValueError('Expected literal JSON metadata')
            return json.loads(encoded)
        if isinstance(node.func, ast.Name) and node.func.id == '_qr_cast' and len(node.args) == 2:
            return literal(node.args[1])
        if isinstance(node.func, ast.Name) and node.func.id == '_qr_object' and len(node.args) == 1:
            return literal(node.args[0])
    raise ValueError('Fixture metadata must be a literal, not executable code')


tree = ast.parse(sys.stdin.read())
statements: list[ast.stmt] = []
for root in tree.body:
    statements.append(root)
    if isinstance(root, (ast.FunctionDef, ast.AsyncFunctionDef)) and root.name in ('_qr_execute', 'run'):
        statements.extend(root.body)

for statement in statements:
    target = None
    value = None
    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
        target, value = statement.target.id, statement.value
    elif isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
        target, value = statement.targets[0].id, statement.value
    if target in names and value is not None:
        values[target] = literal(value)

print(json.dumps(values, allow_nan=False))
