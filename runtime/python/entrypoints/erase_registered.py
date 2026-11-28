"""Lower a compiler-owned Python program. Do not evaluate it or its literals."""
import ast
import json
import sys


class Erase(ast.NodeTransformer):
    def __init__(self, tree):
        self.casts = {alias.asname or alias.name for node in ast.walk(tree)
                      if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                      for alias in node.names if alias.name == 'cast'}
        for node in ast.walk(tree):
            if ((isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load) and node.id in self.casts)
                    or isinstance(node, ast.arg) and node.arg in self.casts):
                raise ValueError('Shadowed cast in registered program')

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in self.casts:
            if len(node.args) != 2 or node.keywords or not isinstance(node.args[0], (ast.Constant, ast.Name)):
                raise ValueError('Unsupported registered type cast')
            return self.visit(node.args[1])
        return self.generic_visit(node)

    def visit_If(self, node):
        if isinstance(node.test, ast.Name) and node.test.id == 'TYPE_CHECKING':
            if node.orelse:
                raise ValueError('Unexpected runtime branch in typing block')
            return None
        return self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module == 'typing':
            node.names = [alias for alias in node.names if alias.name not in ('TYPE_CHECKING', 'cast')]
            if not node.names:
                return None
        return node

    def visit_AnnAssign(self, node):
        if node.value is None:
            return None
        return ast.copy_location(ast.Assign(targets=[node.target], value=self.visit(node.value)), node)

    def visit_FunctionDef(self, node):
        node.returns = None
        node.type_comment = None
        return self.generic_visit(node)

    def visit_arg(self, node):
        node.annotation = None
        node.type_comment = None
        return node

    def visit_Expr(self, node):
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return None
        return self.generic_visit(node)


def erase(source):
    tree = ast.parse(source)
    protocol_names = {alias.asname or alias.name for node in tree.body
                      if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                      for alias in node.names if alias.name == 'Protocol'}
    protocols = {node.name for node in tree.body if isinstance(node, ast.ClassDef)
                 and len(node.bases) == 1 and isinstance(node.bases[0], ast.Name)
                 and node.bases[0].id in protocol_names and not node.keywords and not node.decorator_list
                 and all(isinstance(member, ast.AnnAssign) and member.value is None
                         or isinstance(member, ast.FunctionDef) and not member.decorator_list
                         and len(member.body) == 1 and isinstance(member.body[0], ast.Expr)
                         and isinstance(member.body[0].value, ast.Constant) and member.body[0].value.value is Ellipsis
                         for member in node.body)}
    lowered = ast.fix_missing_locations(Erase(tree).visit(tree))
    lowered.body = [node for node in lowered.body
                    if not (isinstance(node, ast.ClassDef) and node.name in protocols)]
    names = {node.id for node in ast.walk(lowered) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
    if names & protocols:
        raise ValueError('Registered protocol read by executable code')
    for node in lowered.body[:]:
        if isinstance(node, ast.ImportFrom) and node.module == 'typing':
            node.names = [alias for alias in node.names if (alias.asname or alias.name) in names]
            if not node.names:
                lowered.body.remove(node)
    text = ast.unparse(lowered)
    compact = '\n'.join(line for line in text.splitlines() if line.strip()) + '\n'
    # Never alter significant whitespace inside a multiline literal.
    result = compact if ast.dump(ast.parse(compact)) == ast.dump(lowered) else text + '\n'
    compile(result, '<registered-payload>', 'exec')
    return result


if __name__ == '__main__':
    json.dump(erase(json.load(sys.stdin)), sys.stdout)
