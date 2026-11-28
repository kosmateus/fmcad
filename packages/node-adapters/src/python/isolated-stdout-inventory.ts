/** Trusted AST-only inventory, not caller-code execution or an import hook. */
export const isolatedStdoutInventory = String.raw`
import ast, json, sys
try:
    tree = ast.parse(json.loads(sys.stdin.read(600000))["source"], filename="<stdout-inventory>")
    nodes = list(ast.walk(tree))
    if len(nodes) > 12000:
        raise ValueError("AST inventory budget exceeded")
    imports = any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in nodes)
    names = set()
    for node in nodes:
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
    file_argument = any(
        isinstance(node, ast.Call) and any(
            kw.arg == "file" and not (isinstance(kw.value, ast.Constant) and kw.value.value is None)
            for kw in node.keywords
        ) for node in nodes
    )
    print(json.dumps({"imports": imports, "names": sorted(names), "fileArgument": file_argument}))
except (SyntaxError, ValueError, TypeError, KeyError, RecursionError):
    print(json.dumps({"unsupported": True}))
`;
