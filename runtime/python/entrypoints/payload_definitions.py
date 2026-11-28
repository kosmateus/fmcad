"""Offline extraction of exact canonical definitions, never source execution."""
import ast
import json
import sys
import textwrap


def bindings(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return [alias.asname or (alias.name.split('.')[0]
                if isinstance(node, ast.Import) else alias.name)
                for alias in node.names]
    targets = node.targets if isinstance(node, ast.Assign) else (
        [node.target] if isinstance(node, ast.AnnAssign) else [])
    return [child.id for target in targets for child in ast.walk(target)
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store)]


class NullSpecializer(ast.NodeTransformer):
    """Fold only identity tests with None for explicitly pinned arguments."""
    def __init__(self, names):
        self.names = names

    def predicate(self, node):
        if (isinstance(node, ast.Compare) and len(node.ops) == 1
                and isinstance(node.left, ast.Name) and node.left.id in self.names
                and isinstance(node.comparators[0], ast.Constant)
                and node.comparators[0].value is None):
            if isinstance(node.ops[0], ast.Is):
                return True
            if isinstance(node.ops[0], ast.IsNot):
                return False
        if isinstance(node, ast.BoolOp):
            for expr in node.values:
                value = self.predicate(expr)
                if value is None:
                    return None
                if isinstance(node.op, ast.And) and not value:
                    return False
                if isinstance(node.op, ast.Or) and value:
                    return True
            return value
        return None

    def visit_If(self, node):
        value = self.predicate(node.test)
        if value is None:
            return self.generic_visit(node)
        return self.generic_visit(ast.Module(body=node.body if value else node.orelse,
                                             type_ignores=[])).body

    def visit_IfExp(self, node):
        value = self.predicate(node.test)
        return self.generic_visit(node) if value is None else self.visit(node.body if value else node.orelse)


def project_class(node, members, bindings):
    if not isinstance(node, ast.ClassDef) or not members or len(set(members)) != len(members):
        raise ValueError('Expected a class and unique requested methods')
    if set(bindings) - set(members):
        raise ValueError('Bindings for unselected class method')
    methods = []
    for method in node.body:
        if isinstance(method, ast.Expr) and isinstance(method.value, ast.Constant) and isinstance(method.value.value, str):
            continue
        if not isinstance(method, ast.FunctionDef):
            raise ValueError('Class initialization needs an explicit source plan')
        if method.name not in members:
            continue
        names = bindings.get(method.name, {})
        if names:
            parameters = {arg.arg for arg in method.args.posonlyargs + method.args.args + method.args.kwonlyargs}
            if not set(names) <= parameters or any(v is not None for v in names.values()):
                raise ValueError('Only known null arguments are supported')
            for child in ast.walk(method):
                if child is not method and isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    raise ValueError('Cannot project arguments through nested scopes')
                if (isinstance(child, ast.Name) and child.id in names and not isinstance(child.ctx, ast.Load)
                        or isinstance(child, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and child.name in names
                        or isinstance(child, ast.MatchMapping) and child.rest in names
                        or isinstance(child, ast.alias) and (child.asname or child.name.split('.')[0]) in names):
                    raise ValueError('Pinned argument is rebound')
            method = NullSpecializer(names).visit(method)
            if not method.body:
                method.body = [ast.Pass()]
        methods.append(method)
    if sorted(method.name for method in methods) != sorted(members):
        raise ValueError('Missing or ambiguous class member')
    node.body = methods
    return ast.unparse(node) + '\n'


def extract_definition(source, symbol, import_name=None, guard=None, members=None, bindings_plan=None, type_only=False):
    tree = ast.parse(source)
    if bindings_plan is not None and members is None or members is not None and import_name is not None:
        raise ValueError('Invalid class projection reference')
    statements = tree.body
    if guard is not None:
        statements = [child for statement in statements
                      if isinstance(statement, ast.If)
                      and isinstance(statement.test, ast.Name)
                      and statement.test.id == guard and not statement.orelse
                      for child in statement.body]
    if import_name is not None:
        matches = []
        for statement in statements:
            if isinstance(statement, (ast.Import, ast.ImportFrom)):
                for alias in statement.names:
                    path = alias.name if isinstance(statement, ast.Import) else (
                        (statement.module or '') + '.' + alias.name)
                    bound = alias.asname or (alias.name.split('.')[0]
                            if isinstance(statement, ast.Import) else alias.name)
                    if path == import_name and bound == symbol:
                        if isinstance(statement, ast.Import):
                            matches.append(ast.Import(names=[alias]))
                        elif statement.level == 0:
                            matches.append(ast.ImportFrom(module=statement.module,
                                                          names=[alias], level=0))
        if len(matches) != 1:
            raise ValueError('Expected one exact canonical import: ' + import_name)
        selected = ast.unparse(matches[0]) + '\n'
    else:
        matches = [node for node in statements if symbol in bindings(node)]
        if len(matches) != 1 or bindings(matches[0]) != [symbol]:
            raise ValueError('Expected one unambiguous canonical definition: ' + symbol)
        node = matches[0]
        if members is not None:
            return project_class(node, members, bindings_plan or {})
        decorators = getattr(node, 'decorator_list', [])
        first = min([node.lineno] + [item.lineno for item in decorators])
        lines = source.splitlines(keepends=True)
        selected = ''.join(lines[first - 1:node.end_lineno - 1])
        selected += lines[node.end_lineno - 1].encode('utf-8')[:node.end_col_offset].decode('utf-8') + '\n'
    if guard is not None and not type_only:
        return 'if ' + guard + ':\n' + ''.join('    ' + line for line in selected.splitlines(keepends=True))
    return textwrap.dedent(selected) if type_only else selected


def main():
    request = json.load(sys.stdin)
    json.dump([{'id': item['id'],
                'source': extract_definition(item['source'], item['symbol'],
                                             item.get('importName'), item.get('guard'),
                                             item.get('members'), item.get('bindings'), item.get('typeOnly', False))}
               for item in request['definitions']], sys.stdout)


if __name__ == '__main__':
    main()
