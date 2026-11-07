"""Extract literal compile/exec inputs for offline analysis; never execute them."""
import ast
import json
import sys


def literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    # The generated pythonValue form: __import__('json').loads(<JSON string>).
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'loads' and len(node.args) == 1
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Name)
            and node.func.value.func.id == '__import__'
            and len(node.func.value.args) == 1
            and isinstance(node.func.value.args[0], ast.Constant)
            and node.func.value.args[0].value == 'json'):
        encoded = literal(node.args[0])
        value = json.loads(encoded) if encoded is not None else None
        return value if isinstance(value, str) else None
    return None


def extract(source, filename, units, seen, depth=0):
    if depth > 32:
        raise ValueError('Nested literal compile depth exceeds 32')
    tree = ast.parse(source, filename=filename)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id != 'compile' or len(node.args) < 2:
            continue
        code, name = literal(node.args[0]), literal(node.args[1])
        if code is None or name is None:
            continue
        if name in seen:
            if seen[name] != code:
                raise ValueError('Conflicting embedded source filename: ' + name)
            continue
        seen[name] = code
        units.append({'filename': name, 'source': code})
        extract(code, name, units, seen, depth + 1)


if __name__ == '__main__':
    request = json.load(sys.stdin)
    result = []
    extract(request['source'], '<fmcad-wire>', result, {})
    json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False)
