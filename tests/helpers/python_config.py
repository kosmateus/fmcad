import ast
import json
import sys

request = json.load(sys.stdin)
source = request['script']
compile(source, '<generated-fusion-script>', 'exec')
tree = ast.parse(source)


def value(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [value(item) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {value(k): value(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -value(node.operand)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'loads':
        owner = node.func.value
        is_json = isinstance(owner, ast.Name) and owner.id == 'json'
        is_import = (isinstance(owner, ast.Call) and isinstance(owner.func, ast.Name)
                     and owner.func.id == '__import__' and len(owner.args) == 1
                     and value(owner.args[0]) == 'json')
        if (is_json or is_import) and len(node.args) == 1 and not node.keywords:
            return json.loads(value(node.args[0]))
    raise ValueError('Unsafe or invalid Python config expression: ' + ast.dump(node))


out = {}
for statement in tree.body:
    if isinstance(statement, ast.Assign):
        targets = statement.targets
    elif isinstance(statement, ast.AnnAssign):
        targets = [statement.target]
    else:
        continue
    for target in targets:
        if isinstance(target, ast.Name) and target.id in request['names']:
            out[target.id] = value(statement.value)
print(json.dumps(out))
