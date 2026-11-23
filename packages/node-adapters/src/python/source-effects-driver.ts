/** Trusted isolated analyzer. It parses caller text, never compiles/executes/imports it. */
export const sourceEffectsDriver = String.raw`
import ast, json, sys

class Unproven(Exception):
    pass

UNKNOWN = ("opaque",)
NONE = ("const", None)
NUMBER = ("number",)
STRING = ("string",)
BOOL = ("bool",)
SAFE_BUILTINS = {
    name: ("builtin", name) for name in (
        "print", "len", "str", "int", "float", "bool", "object", "sorted",
        "list", "tuple", "range", "type", "ValueError", "RuntimeError",
        "AssertionError", "Exception", "enumerate", "abs", "min", "max",
    )
}

def refuse(message):
    raise Unproven(message)

def union(values):
    result = []
    for value in values:
        for item in (value[1] if value[0] == "union" else (value,)):
            if item not in result:
                result.append(item)
    return result[0] if len(result) == 1 else ("union", tuple(result)) if result else NONE

def alternatives(value):
    return value[1] if value[0] == "union" else (value,)

def plain(value):
    if value[0] == "union":
        return all(plain(x) for x in value[1])
    if value[0] in ("const", "number", "string", "bool"):
        return True
    if value[0] == "sequence":
        return plain(value[1])
    if value[0] == "tuple":
        return all(plain(x) for x in value[1])
    if value[0] == "dict":
        return all(plain(x) for _, x in value[1])
    return False

def condition(value):
    # Only the declared nullable SDK metadata handles have known truth semantics.
    if not all(plain(x) or x[0] in ("document", "datafile") for x in alternatives(value)):
        refuse("Unknown truth/iteration protocol")

class Scope:
    def __init__(self, parent=None, locals=()):
        self.parent = parent
        self.values = {name: UNKNOWN for name in locals}
    def get(self, name):
        if name in self.values:
            return self.values[name]
        if self.parent is not None:
            return self.parent.get(name)
        if name in SAFE_BUILTINS:
            return SAFE_BUILTINS[name]
        refuse("Unresolved symbol: " + name)

def local_names(body):
    result = set()
    def walk(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            result.add(node.name)
            return
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            return
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            result.add(node.id)
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for item in node.names:
                result.add(item.asname or item.name.split(".")[0])
        if isinstance(node, ast.ExceptHandler) and node.name:
            result.add(node.name)
        for child in ast.iter_child_nodes(node):
            walk(child)
    for statement in body:
        walk(statement)
    return result

class Analyzer:
    def __init__(self):
        self.steps = 0
        self.active = set()
    def step(self):
        self.steps += 1
        if self.steps > 30000:
            refuse("Analysis budget exceeded")
    def bind(self, target, value, scope):
        if value[0] in ("frames-length-only", "stream-type"):
            refuse("Introspection result may only be consumed immediately")
        if isinstance(target, ast.Name):
            if target.id.startswith("__"):
                refuse("Protected namespace store")
            scope.values[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            for i, child in enumerate(target.elts):
                self.bind(child, self.item(value, ("const", i)), scope)
        else:
            refuse("Attribute/subscript/unsupported store")
    def item(self, value, key):
        result = []
        for v in alternatives(value):
            if not plain(key):
                refuse("Unknown indexing protocol")
            if v[0] == "sequence":
                result.append(v[1])
            elif v[0] == "tuple":
                if key[0] == "const" and type(key[1]) is int and -len(v[1]) <= key[1] < len(v[1]):
                    result.append(v[1][key[1]])
                else:
                    result.extend(v[1])
            elif v[0] == "dict":
                if key[0] == "const":
                    matches = [x for k, x in v[1] if k == key[1]]
                    if not matches:
                        refuse("Unresolved dictionary key")
                    result.extend(matches)
                else:
                    result.extend(x for _, x in v[1])
            elif plain(v) and v[0] in ("const", "string"):
                result.append(STRING)
            else:
                refuse("Unknown indexing receiver")
        return union(result)
    def element(self, value):
        result = []
        for v in alternatives(value):
            if v[0] == "sequence":
                result.append(v[1])
            elif v[0] == "tuple":
                result.extend(v[1])
            elif v[0] == "dict":
                result.extend(("const", key) for key, _ in v[1])
            elif v[0] == "string" or v[0] == "const" and isinstance(v[1], str):
                result.append(STRING)
            else:
                refuse("Unknown iterable protocol")
        return union(result)
    def attribute(self, value, name):
        table = {
            ("module:adsk", "core"): ("module", "adsk.core"),
            ("module:adsk.core", "Application"): ("sdk-class", "Application"),
            ("sdk-class:Application", "get"): ("safe-call", "application.get"),
            ("application", "documents"): ("sequence", ("document",)),
            ("application", "activeDocument"): ("union", (("document",), NONE)),
            ("document", "creationId"): STRING, ("document", "name"): STRING,
            ("document", "isSaved"): BOOL, ("document", "isModified"): BOOL,
            ("document", "dataFile"): ("union", (("datafile",), NONE)),
            ("datafile", "id"): STRING,
            ("module:json", "dumps"): ("safe-call", "json.dumps"),
            ("module:inspect", "stack"): ("safe-call", "inspect.stack"),
            ("module:sys", "stdout"): ("stream",), ("module:sys", "stderr"): ("stream",),
            ("stream", "write"): ("safe-call", "stream.write"),
            ("stream-type", "__name__"): STRING,
        }
        result = []
        for v in alternatives(value):
            # A nullable SDK handle may raise AttributeError on None; that is
            # not a product effect. Never allow a different unknown receiver.
            if v == NONE:
                continue
            receiver = v[0] + ":" + v[1] if v[0] in ("module", "sdk-class") else v[0]
            if (receiver, name) not in table:
                refuse("Unproven member: " + receiver + "." + name)
            result.append(table[(receiver, name)])
        if not result:
            refuse("No proven attribute receiver")
        return union(result)
    def expression(self, node, scope):
        self.step()
        if isinstance(node, ast.Constant):
            if type(node.value) not in (str, int, float, bool, type(None)):
                refuse("Unsupported literal")
            return ("const", node.value)
        if isinstance(node, ast.Name):
            return scope.get(node.id)
        if isinstance(node, ast.Attribute):
            return self.attribute(self.expression(node.value, scope), node.attr)
        if isinstance(node, ast.Subscript):
            return self.item(self.expression(node.value, scope), self.expression(node.slice, scope))
        if isinstance(node, ast.Call):
            if any(k.arg is None for k in node.keywords) or any(isinstance(x, ast.Starred) for x in node.args):
                refuse("Dynamic argument expansion")
            function = self.expression(node.func, scope)
            args = [self.expression(x, scope) for x in node.args]
            keywords = {k.arg: self.expression(k.value, scope) for k in node.keywords}
            return self.call(function, args, keywords)
        if isinstance(node, ast.Lambda):
            if node.args.defaults or node.args.kw_defaults or node.args.vararg or node.args.kwarg:
                refuse("Unsupported lambda signature")
            return ("function", node, scope, ())
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            items = tuple(self.expression(x, scope) for x in node.elts)
            if isinstance(node, ast.Set) and not all(plain(x) for x in items):
                refuse("Unknown hash protocol")
            return ("tuple", items) if isinstance(node, ast.Tuple) else ("sequence", union(items))
        if isinstance(node, ast.Dict):
            items = []
            for k, v in zip(node.keys, node.values):
                if not isinstance(k, ast.Constant) or type(k.value) not in (str, int, float, bool, type(None)):
                    refuse("Dynamic dictionary key")
                items.append((k.value, self.expression(v, scope)))
            return ("dict", tuple(items))
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp)):
            inner = Scope(scope)
            for generator in node.generators:
                if generator.is_async:
                    refuse("Async comprehension")
                self.bind(generator.target, self.element(self.expression(generator.iter, inner)), inner)
                for test in generator.ifs:
                    condition(self.expression(test, inner))
            if isinstance(node, ast.DictComp):
                refuse("Dynamic comprehension keys")
            value = self.expression(node.elt, inner)
            if isinstance(node, ast.SetComp) and not plain(value):
                refuse("Unknown hash protocol")
            return ("sequence", value)
        if isinstance(node, ast.IfExp):
            condition(self.expression(node.test, scope))
            return union([self.expression(node.body, scope), self.expression(node.orelse, scope)])
        if isinstance(node, ast.BoolOp):
            values = [self.expression(x, scope) for x in node.values]
            for value in values:
                condition(value)
            return union(values)
        if isinstance(node, ast.Compare):
            values = [self.expression(node.left, scope)] + [self.expression(x, scope) for x in node.comparators]
            for i, op in enumerate(node.ops):
                if not isinstance(op, (ast.Is, ast.IsNot)) and not (plain(values[i]) and plain(values[i+1])):
                    refuse("Unknown comparison protocol")
            return BOOL
        if isinstance(node, (ast.UnaryOp, ast.BinOp)):
            values = [self.expression(x, scope) for x in ([node.operand] if isinstance(node, ast.UnaryOp) else [node.left, node.right])]
            if not all(plain(x) for x in values):
                refuse("Unknown operator protocol")
            return BOOL if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not) else union(values)
        if isinstance(node, ast.JoinedStr):
            for piece in node.values:
                if isinstance(piece, ast.FormattedValue):
                    if not plain(self.expression(piece.value, scope)):
                        refuse("Unknown formatting protocol")
                    if piece.format_spec:
                        self.expression(piece.format_spec, scope)
            return STRING
        refuse("Unsupported expression: " + type(node).__name__)
    def call(self, function, args, keywords):
        self.step()
        return union([self.call_one(f, args, keywords) for f in alternatives(function)])
    def call_one(self, function, args, keywords):
        kind = function[0]
        if kind == "function":
            node, closure, defaults = function[1:]
            if node in self.active:
                refuse("Recursive call graph")
            signature = node.args
            if signature.vararg or signature.kwarg or signature.kwonlyargs:
                refuse("Unsupported function signature")
            parameters = signature.posonlyargs + signature.args
            names = [x.arg for x in parameters]
            if len(args) > len(names) or any(k not in names for k in keywords):
                refuse("Unresolved argument binding")
            bound = dict(zip(names, args))
            for name, value in keywords.items():
                if name in bound or name in [x.arg for x in signature.posonlyargs]:
                    refuse("Invalid argument binding")
                bound[name] = value
            for name, value in zip(names[len(names)-len(defaults):], defaults):
                if name not in bound:
                    bound[name] = value
            if len(bound) != len(names):
                refuse("Unresolved argument binding")
            scope = Scope(closure, local_names(node.body) if isinstance(node, ast.FunctionDef) else ())
            scope.values.update(bound)
            self.active.add(node)
            try:
                if isinstance(node, ast.Lambda):
                    return self.expression(node.body, scope)
                returns = []
                falls_through = self.block(node.body, scope, returns)
                return union(returns + ([NONE] if falls_through else []))
            finally:
                self.active.remove(node)
        if kind == "safe-call":
            name = function[1]
            if name == "application.get" and not args and not keywords:
                return ("application",)
            if name == "inspect.stack" and not args and not keywords:
                return ("frames-length-only",)
            if name == "json.dumps" and len(args) == 1 and plain(args[0]) and all(
                k in ("ensure_ascii", "sort_keys", "indent", "separators", "allow_nan") and plain(v)
                for k, v in keywords.items()
            ):
                return STRING
            if name == "stream.write" and len(args) == 1 and plain(args[0]) and not keywords:
                return NUMBER
            refuse("Unproven primitive call: " + name)
        if kind != "builtin":
            refuse("Unknown callable")
        name = function[1]
        if name == "print":
            if not all(plain(x) for x in args):
                refuse("Unknown print conversion")
            for k, v in keywords.items():
                if k == "file":
                    if v != ("stream",):
                        refuse("Unknown output stream")
                elif k not in ("sep", "end", "flush") or not plain(v):
                    refuse("Unknown print option")
            return NONE
        if name == "len" and len(args) == 1 and not keywords:
            if args[0][0] == "frames-length-only":
                return NUMBER
            self.element(args[0])
            return NUMBER
        if name == "type" and args == [("stream",)] and not keywords:
            return ("stream-type",)
        if name == "sorted" and len(args) == 1 and set(keywords) <= {"key", "reverse"}:
            element = self.element(args[0])
            if "key" in keywords:
                key = self.call(keywords["key"], [element], {})
                if not plain(key):
                    refuse("Unknown ordering key")
            elif not plain(element):
                refuse("Unknown comparison protocol")
            if "reverse" in keywords:
                condition(keywords["reverse"])
            return ("sequence", element)
        if name in ("list", "tuple") and len(args) == 1 and not keywords:
            return ("sequence", self.element(args[0]))
        if name == "enumerate" and len(args) == 1 and not keywords:
            return ("sequence", ("tuple", (NUMBER, self.element(args[0]))))
        if name == "range" and 1 <= len(args) <= 3 and all(plain(x) for x in args) and not keywords:
            return ("sequence", NUMBER)
        if name in ("str", "int", "float", "bool", "abs", "min", "max") and all(plain(x) for x in args) and not keywords:
            return STRING if name == "str" else NUMBER
        if name in ("ValueError", "RuntimeError", "AssertionError", "Exception") and all(plain(x) for x in args) and not keywords:
            return ("exception",)
        refuse("Unsupported builtin call: " + name)
    def annotation(self, node, scope):
        if node is not None and not (isinstance(node, ast.Name) and self.expression(node, scope)[0] == "builtin"):
            refuse("Unsupported evaluated annotation")
    def block(self, statements, scope, returns):
        for node in statements:
            self.step()
            if isinstance(node, ast.FunctionDef):
                if node.name.startswith("__") or node.decorator_list or node.args.vararg or node.args.kwarg or node.args.kwonlyargs:
                    refuse("Decorated/protected/unsupported function definition")
                for arg in node.args.posonlyargs + node.args.args:
                    self.annotation(arg.annotation, scope)
                self.annotation(node.returns, scope)
                defaults = tuple(self.expression(x, scope) for x in node.args.defaults)
                scope.values[node.name] = ("function", node, scope, defaults)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.ImportFrom):
                    if node.level or node.module not in ("adsk.core", "json", "sys", "inspect"):
                        refuse("Unproven import")
                    for alias in node.names:
                        if (alias.asname or alias.name).startswith("__"):
                            refuse("Protected import binding")
                        value = self.attribute(("module", node.module), alias.name)
                        scope.values[alias.asname or alias.name] = value
                else:
                    for alias in node.names:
                        if alias.name not in ("adsk", "adsk.core", "json", "sys", "inspect"):
                            refuse("Unproven import")
                        if (alias.asname or alias.name).startswith("__"):
                            refuse("Protected import binding")
                        scope.values[alias.asname or alias.name.split(".")[0]] = ("module", alias.name if alias.asname else alias.name.split(".")[0])
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                if isinstance(node, ast.AnnAssign):
                    self.annotation(node.annotation, scope)
                value = self.expression(node.value, scope) if node.value is not None else UNKNOWN
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    self.bind(target, value, scope)
            elif isinstance(node, ast.Expr):
                value = self.expression(node.value, scope)
                if value[0] in ("frames-length-only", "stream-type"):
                    refuse("Unconsumed introspection result")
            elif isinstance(node, ast.Return):
                returns.append(self.expression(node.value, scope) if node.value else NONE)
                return False
            elif isinstance(node, ast.Raise):
                if node.cause or not node.exc or self.expression(node.exc, scope) != ("exception",):
                    refuse("Unproven raised value")
                return False
            elif isinstance(node, ast.Assert):
                condition(self.expression(node.test, scope))
                if node.msg and not plain(self.expression(node.msg, scope)):
                    refuse("Unknown assertion message")
            elif isinstance(node, ast.If):
                refuse("Statement branch closure dataflow is unsupported")
            elif isinstance(node, ast.Try):
                if node.handlers or node.orelse:
                    refuse("Exception handler dataflow is unsupported")
                # Every expression may raise. Without stores in the body,
                # every exceptional edge reaches finally with the same locals.
                if any(not isinstance(x, (ast.Expr, ast.Return, ast.Raise, ast.Assert, ast.Pass))
                       for x in node.body):
                    refuse("Try-body stores/control flow are unsupported")
                body_falls_through = self.block(node.body, scope, returns)
                finally_falls_through = self.block(node.finalbody, scope, returns)
                if not body_falls_through or not finally_falls_through:
                    return False
            elif isinstance(node, ast.For):
                refuse("Statement loop closure dataflow is unsupported")
            elif not isinstance(node, ast.Pass):
                refuse("Unsupported statement: " + type(node).__name__)
        return True
    def analyze(self, source):
        tree = ast.parse(source, filename="<source-effect-input>", mode="exec")
        if sum(1 for _ in ast.walk(tree)) > 12000:
            refuse("AST budget exceeded")
        scope = Scope()
        self.block(tree.body, scope, [])
        if "run" in scope.values:
            result = self.call(scope.values["run"], [UNKNOWN], {})
            if not plain(result):
                refuse("Entrypoint returns an opaque/protected value")

try:
    request = json.loads(sys.stdin.read(600000))
    Analyzer().analyze(request["source"])
    print(json.dumps({"proven": True, "reasons": []}))
except (Unproven, SyntaxError, ValueError, TypeError, KeyError, RecursionError) as error:
    print(json.dumps({"proven": False, "reasons": [str(error)[:240]]}))
`;
