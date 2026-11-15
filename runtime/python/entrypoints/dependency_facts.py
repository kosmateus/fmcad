"""Parse dependency facts offline. Never import or execute submitted Python."""
import ast
import copy
import inspect
import json
import symtable
import sys


class Unknown(Exception):
    pass


def constant(node, bindings):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name) and node.id in bindings:
        return bindings[node.id]
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return [constant(item, bindings) for item in node.elts]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return constant(node.left, bindings) + constant(node.right, bindings)
    raise Unknown()


def dictionary_keys(node, bindings, dictionaries):
    if isinstance(node, ast.Name) and node.id in dictionaries:
        return dictionaries[node.id]
    if isinstance(node, ast.Dict):
        result = {}
        for key, value in zip(node.keys, node.values):
            result.update(dictionary_keys(value, bindings, dictionaries) if key is None
                          else {constant(key, bindings): value})
        return result
    if isinstance(node, ast.DictComp) and len(node.generators) == 1:
        gen = node.generators[0]
        if not isinstance(gen.target, ast.Name) or gen.ifs or gen.is_async:
            raise Unknown()
        return {constant(node.key, {**bindings, gen.target.id: value}): node.value
                for value in constant(gen.iter, bindings)}
    raise Unknown()


def registrations(tree, registry_names=('CAD_HANDLERS',), depth=0, functions=None):
    if depth > 8:
        raise Unknown()
    bindings, dictionaries, handlers = {}, {}, {}
    indirect = {}
    if functions is None:
        functions = {node.name: [node] for node in tree.body if isinstance(node, ast.FunctionDef)}
    seen = set()
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Name) or node.id not in registry_names or not isinstance(node.ctx, ast.Load):
            continue
        parent = parents.get(node)
        if isinstance(parent, ast.Attribute) and parent.value is node and parent.attr in ('owner', 'update', 'pop', 'get', 'dispatch'):
            continue
        if isinstance(parent, ast.Subscript) and parent.value is node:
            continue
        if isinstance(parent, ast.Compare):
            continue
        if (isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name)
                and parent.func.id == 'hasattr' and parent.args and parent.args[0] is node):
            continue
        if isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name) and parent.func.id in functions:
            for function in functions[parent.func.id]:
                parameters = function.args.posonlyargs + function.args.args
                if node not in parent.args or len(parent.args) > len(parameters):
                    raise Unknown()
                parameter = parameters[parent.args.index(node)].arg
                # A nested scope can shadow the registry parameter; do not infer
                # an alias through that scope without a binding proof.
                if any(isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
                       and any((isinstance(binding, ast.arg) and binding.arg == parameter)
                               or (isinstance(binding, ast.Name) and binding.id == parameter and isinstance(binding.ctx, ast.Store))
                               for binding in ast.walk(child))
                       for statement in function.body for child in ast.walk(statement)):
                    raise Unknown()
                indirect.update(registrations(ast.Module(body=function.body, type_ignores=[]), (parameter,), depth + 1, functions))
            continue
        # An escaped/aliased registry can register arbitrary operations. Its
        # absence from the literal index is not evidence that it is unused.
        raise Unknown()
    # Registration keys are data, not callable bodies. Keep all owners for an
    # operation so ordered ownership transfers retain the existing semantics.
    statements = [(node, {}) for node in reversed(tree.body)]
    while statements:
        node, local = statements.pop()
        if isinstance(node, ast.For):
            if not any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                       and isinstance(call.func.value, ast.Name) and call.func.value.id in registry_names
                       and call.func.attr in ('update', 'pop') for call in ast.walk(node)):
                continue
            targets = node.target.elts if isinstance(node.target, (ast.Tuple, ast.List)) else [node.target]
            iterator = node.iter
            if (isinstance(iterator, ast.Call) and isinstance(iterator.func, ast.Attribute)
                    and iterator.func.attr == 'items' and isinstance(iterator.func.value, ast.Dict)
                    and not iterator.args and not iterator.keywords):
                dictionary = iterator.func.value
                iterator = ast.Tuple(elts=[ast.Tuple(elts=[key, value], ctx=ast.Load())
                                          for key, value in zip(dictionary.keys, dictionary.values)], ctx=ast.Load())
            if not isinstance(iterator, (ast.Tuple, ast.List)) or node.orelse:
                raise Unknown()
            for row in reversed(iterator.elts):
                values = row.elts if isinstance(row, (ast.Tuple, ast.List)) and len(targets) > 1 else [row]
                if len(values) != len(targets):
                    raise Unknown()
                nested = dict(local)
                for target, value in zip(targets, values):
                    if not isinstance(target, ast.Name):
                        raise Unknown()
                    try:
                        nested[target.id] = constant(value, {**bindings, **local})
                    except Unknown:
                        # Callable captures are referenced separately by the
                        # symbol graph, never evaluated as registration keys.
                        pass
                statements.extend((child, nested) for child in reversed(node.body))
            continue
        current = {**bindings, **local}
        value = getattr(node, 'value', None)
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else [])
        for target in targets:
            if isinstance(target, ast.Name) and value is not None:
                try:
                    bindings[target.id] = constant(value, current)
                except (Unknown, TypeError):
                    pass
                try:
                    dictionaries[target.id] = dictionary_keys(value, current, dictionaries)
                except (Unknown, TypeError):
                    pass
        if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                and isinstance(value.func.value, ast.Name)
                and value.func.value.id in registry_names and value.func.attr == 'update'):
            if len(value.args) != 1 or value.keywords:
                raise Unknown()
            seen.add(id(value))
            handlers.update(dictionary_keys(value.args[0], current, dictionaries))
        if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                and isinstance(value.func.value, ast.Name)
                and value.func.value.id in registry_names and value.func.attr == 'pop'):
            if not value.args:
                raise Unknown()
            seen.add(id(value))
            handlers.setdefault(constant(value.args[0], current), ast.Constant(value=None))
        for target in targets:
            if (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                    and target.value.id in registry_names):
                handlers[constant(target.slice, current)] = value
                seen.add(id(target))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id in registry_names
                and node.func.attr in ('update', 'pop', 'setdefault', 'clear', '__setitem__', '__delitem__')
                and id(node) not in seen):
            raise Unknown()
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
                and node.value.id in registry_names and isinstance(node.ctx, (ast.Store, ast.Del))
                and id(node) not in seen):
            raise Unknown()
    if any(not isinstance(item, str) for item in handlers):
        raise Unknown()
    return {**indirect, **{key: sorted({node.id for node in ast.walk(value)
                         if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)})
            for key, value in handlers.items()}}


def operation_choices(node, parents):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return operation_choices(node.body, parents) + operation_choices(node.orelse, parents)
    if isinstance(node, ast.Name):
        parent = parents.get(node)
        while parent is not None and not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if isinstance(parent, ast.For):
                targets = parent.target.elts if isinstance(parent.target, (ast.Tuple, ast.List)) else [parent.target]
                for index, target in enumerate(targets):
                    if isinstance(target, ast.Name) and target.id == node.id:
                        if any(isinstance(item, ast.Name) and item.id == node.id and isinstance(item.ctx, ast.Store)
                               for statement in parent.body for item in ast.walk(statement)):
                            raise Unknown()
                        iterator = parent.iter
                        if (isinstance(iterator, ast.Call) and isinstance(iterator.func, ast.Attribute)
                                and iterator.func.attr == 'items' and isinstance(iterator.func.value, ast.Dict)):
                            dictionary = iterator.func.value
                            rows = [ast.Tuple(elts=[key, value], ctx=ast.Load())
                                    for key, value in zip(dictionary.keys, dictionary.values)]
                        elif isinstance(iterator, (ast.Tuple, ast.List)):
                            rows = iterator.elts
                        else:
                            raise Unknown()
                        choices = [constant(row.elts[index] if len(targets) > 1 and isinstance(row, (ast.Tuple, ast.List)) else row, {})
                                   for row in rows]
                        if all(isinstance(value, str) for value in choices):
                            return choices
                        raise Unknown()
            parent = parents.get(parent)
        root = node
        while root in parents:
            root = parents[root]
        stores = [item for item in ast.walk(root) if isinstance(item, ast.Name)
                  and item.id == node.id and isinstance(item.ctx, (ast.Store, ast.Del))]
        shadowed = any(isinstance(item, ast.arg) and item.arg == node.id for item in ast.walk(root))
        if len(stores) == 1 and not shadowed:
            assignment = parents.get(stores[0])
            if isinstance(assignment, (ast.Assign, ast.AnnAssign)) and isinstance(assignment.value, ast.Constant):
                if isinstance(assignment.value.value, str):
                    return [assignment.value.value]
    raise Unknown()


def facts(tree, filename, *, user=False, method=None, unit=None, casts=()):
    source = ast.unparse(tree)
    table = symtable.symtable(source, filename, 'exec')
    defines = {symbol.get_name() for symbol in table.get_symbols()
               if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()}
    imports = {symbol.get_name() for symbol in table.get_symbols() if symbol.is_imported()}
    references = set()

    def scope(table):
        references.update(symbol.get_name() for symbol in table.get_symbols()
                          if symbol.is_global() and symbol.is_referenced())
        for child in table.get_children():
            scope(child)

    scope(table)
    operations, methods, calls = set(), set(), set()
    opaque = False
    if user:
        # A closed, ordinary Python subset. Anything that may expose an external
        # callable or reflect into frames/globals retains the complete runtime.
        # This is dependency analysis, not a sandbox or an execution guarantee.
        safe_builtins = {'None', 'True', 'False', 'str', 'int', 'float', 'bool', 'len',
                         'list', 'tuple', 'dict', 'set', 'frozenset', 'range', 'enumerate',
                         'zip', 'min', 'max', 'sum', 'abs', 'round', 'all', 'any', 'sorted',
                         'reversed', 'print', 'isinstance', 'Exception', 'RuntimeError',
                         'ValueError', 'TypeError', 'AssertionError', 'FMCAD'}
        if references - defines - safe_builtins:
            opaque = True
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    annotations = set()
    for node in ast.walk(tree):
        for field in ('annotation', 'returns'):
            annotation = getattr(node, field, None)
            if annotation is not None:
                annotations.update(ast.walk(annotation))
        if (isinstance(node, ast.Call) and node.args and isinstance(node.func, ast.Name)
                and node.func.id in casts):
            annotations.update(ast.walk(node.args[0]))
    for node in ast.walk(tree):
        # Forward annotations and cast/type-alias arguments also need providers
        # in the real checker. Over-inclusion here is conservative.
        if node in annotations and isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                annotation = ast.parse(node.value, mode='eval')
                references.update(item.id for item in ast.walk(annotation) if isinstance(item, ast.Name))
            except (SyntaxError, ValueError):
                pass
        if user and isinstance(node, ast.Name) and node.id == 'FMCAD':
            parent = parents.get(node)
            if not (isinstance(parent, ast.Attribute) and parent.value is node
                    and not parent.attr.startswith('_')):
                opaque = True
        if user and isinstance(node, (ast.Import, ast.ImportFrom)):
            # Imported code may reflect into the facade's globals. It cannot be
            # proven closed merely by inspecting this submitted source.
            opaque = True
        if isinstance(node, ast.Attribute):
            receiver = node.value
            if user and not (isinstance(receiver, ast.Name) and receiver.id == 'FMCAD'):
                opaque = True
            if isinstance(receiver, ast.Name) and (receiver.id == 'FMCAD' or (receiver.id == 'self' and unit == 'helpers')):
                if user:
                    parent = parents.get(node)
                    if not isinstance(parent, ast.Call) or parent.func is not node:
                        opaque = True
                methods.add(node.attr)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Name):
                    calls.add(decorator.id)
        if not isinstance(node, ast.Call):
            if (unit != 'core' and isinstance(node, ast.Compare) and len(node.ops) == 1
                    and isinstance(node.ops[0], (ast.In, ast.NotIn))
                    and isinstance(node.comparators[0], ast.Name)
                    and node.comparators[0].id == 'CAD_HANDLERS'):
                try:
                    operations.update(operation_choices(node.left, parents))
                except Unknown:
                    opaque = True
            if (unit != 'core' and isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load)
                    and isinstance(node.value, ast.Name) and node.value.id == 'CAD_HANDLERS'):
                try:
                    operations.update(operation_choices(node.slice, parents))
                except Unknown:
                    opaque = True
            if isinstance(node, ast.Compare) and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str):
                if any(isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == 'globals'
                       for value in node.comparators):
                    references.add(node.left.value)
            continue
        if isinstance(node.func, ast.Name):
            calls.add(node.func.id)
            if node.func.id in ('eval', 'exec', 'compile', '__import__', 'locals', 'vars', 'dir'):
                opaque = True
            if user and node.func.id in ('globals', 'getattr', 'setattr', 'delattr', 'type'):
                opaque = True
            if node.func.id == 'globals':
                parent = parents.get(node)
                if isinstance(parent, ast.Subscript) and isinstance(parent.slice, ast.Constant) and isinstance(parent.slice.value, str):
                    references.add(parent.slice.value)
                elif not isinstance(parent, (ast.Attribute, ast.Compare)):
                    opaque = True
            if (unit == 'helpers' and node.func.id in ('getattr', 'setattr', 'delattr') and node.args
                    and isinstance(node.args[0], ast.Name) and node.args[0].id == 'self'):
                opaque = True
        if (unit != 'core' and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == 'CAD_HANDLERS'
                and node.func.attr in ('get', 'dispatch')):
            key = node.args[1] if node.func.attr == 'dispatch' and len(node.args) > 1 else (node.args[0] if node.args else None)
            try:
                operations.update(operation_choices(key, parents))
            except Unknown:
                opaque = True
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'call':
            # This is the canonical facade-to-context dispatch bridge. Its
            # operation comes from the already analysed public call sites.
            receiver = node.func.value
            bridge = (unit == 'helpers' and method == 'call' and isinstance(receiver, ast.Attribute)
                      and receiver.attr == '_context' and isinstance(receiver.value, ast.Name)
                      and receiver.value.id == 'self' and len(node.args) == 2 and not node.keywords
                      and isinstance(node.args[0], ast.Name) and node.args[0].id == 'operation'
                      and isinstance(node.args[1], ast.Name) and node.args[1].id == 'data')
            if not bridge:
                operation = node.args[0] if node.args else next(
                    (kw.value for kw in node.keywords if kw.arg == 'operation'), None)
                try:
                    operations.update(operation_choices(operation, parents))
                except Unknown:
                    opaque = True
        if (isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Call)
                and isinstance(node.func.value.func, ast.Name)
                and node.func.value.func.id == 'globals'):
            if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                references.add(node.args[0].value)
            else:
                opaque = True
    return dict(defines=sorted(defines), references=[] if user else sorted(references - imports),
                operations=sorted(operations), methods=sorted(methods), calls=sorted(calls - imports), opaque=opaque)


def inert_function(node):
    """A definition without executable decorators/defaults/attribute lookups."""
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.decorator_list:
        return False
    arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    arguments += [arg for arg in (node.args.vararg, node.args.kwarg) if arg is not None]
    expressions = [node.returns, *(arg.annotation for arg in arguments),
                   *node.args.defaults, *node.args.kw_defaults]
    return not getattr(node, 'type_params', []) and all(
        expression is None or inert_value(expression) for expression in expressions)


def inert_handler_value(node, functions):
    if isinstance(node, (ast.Name, ast.Constant)):
        return True
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        return False
    candidates = functions.get(node.func.id, [])
    if not candidates or not all(isinstance(arg, (ast.Name, ast.Constant))
                                 for arg in [*node.args, *(kw.value for kw in node.keywords)]):
        return False
    for function in candidates:
        if function.decorator_list or not binds_call(function, node):
            return False
        body = [child for child in function.body if not (
            isinstance(child, ast.Expr) and isinstance(child.value, ast.Constant)
            and isinstance(child.value.value, str))]
        if not body:
            return False
        declarations, result = body[:-1], body[-1]
        if not all(inert_function(child) for child in declarations):
            return False
        if not (isinstance(result, ast.Return) and isinstance(result.value, ast.Name)
                and result.value.id in {child.name for child in declarations}):
            return False
    return True


def closure_result(function, function_parameters, wraps):
    """Prove a small closure factory mutates only functions it just allocated."""
    local = {}
    for statement in function.body:
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
            continue
        if isinstance(statement, ast.FunctionDef):
            declaration = copy.deepcopy(statement)
            declaration.decorator_list = []
            if not inert_function(declaration):
                return None
            for decorator in statement.decorator_list:
                if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name)
                        and decorator.func.id in wraps and len(decorator.args) == 1 and not decorator.keywords
                        and isinstance(decorator.args[0], ast.Name)
                        and decorator.args[0].id in function_parameters | local.keys()):
                    return None
            local[statement.name] = statement
            continue
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
            call = statement.value
            if (isinstance(call.func, ast.Name) and call.func.id == 'setattr'
                    and len(call.args) == 3 and not call.keywords
                    and isinstance(call.args[0], ast.Name) and call.args[0].id in local
                    and isinstance(call.args[1], ast.Constant) and isinstance(call.args[1].value, str)
                    and inert_value(call.args[2])):
                continue
        if isinstance(statement, ast.Return) and isinstance(statement.value, ast.Name):
            return local.get(statement.value.id)
        return None
    return None


def inert_decorated_function(node, functions, wraps):
    if not isinstance(node, ast.FunctionDef) or not node.decorator_list:
        return False
    declaration = copy.deepcopy(node)
    declaration.decorator_list = []
    if not inert_function(declaration):
        return False
    for decorator in node.decorator_list:
        factory = decorator.func if isinstance(decorator, ast.Call) else decorator
        if not isinstance(factory, ast.Name) or factory.id not in functions:
            return False
        if isinstance(decorator, ast.Call) and not all(
                inert_value(arg) for arg in [*decorator.args, *(kw.value for kw in decorator.keywords)]):
            return False
        for candidate in functions[factory.id]:
            if candidate.decorator_list:
                return False
            if isinstance(decorator, ast.Call) and not binds_call(candidate, decorator):
                return False
            applied = closure_result(candidate, set(), wraps) if isinstance(decorator, ast.Call) else candidate
            if applied is None:
                return False
            parameters = applied.args.posonlyargs + applied.args.args
            application = ast.Call(func=ast.Name(id='_decorator', ctx=ast.Load()), args=[ast.Constant(value=None)], keywords=[])
            if (not parameters or not binds_call(applied, application)
                    or closure_result(applied, {parameters[0].arg}, wraps) is None):
                return False
    return True


def binds_call(function, call):
    if any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords):
        return False
    parameters = []
    positional = function.args.posonlyargs + function.args.args
    default_start = len(positional) - len(function.args.defaults)
    for index, arg in enumerate(positional):
        kind = inspect.Parameter.POSITIONAL_ONLY if index < len(function.args.posonlyargs) else inspect.Parameter.POSITIONAL_OR_KEYWORD
        parameters.append(inspect.Parameter(arg.arg, kind, default=None if index >= default_start else inspect.Parameter.empty))
    if function.args.vararg:
        parameters.append(inspect.Parameter(function.args.vararg.arg, inspect.Parameter.VAR_POSITIONAL))
    for arg, default in zip(function.args.kwonlyargs, function.args.kw_defaults):
        parameters.append(inspect.Parameter(arg.arg, inspect.Parameter.KEYWORD_ONLY,
                                            default=None if default is not None else inspect.Parameter.empty))
    if function.args.kwarg:
        parameters.append(inspect.Parameter(function.args.kwarg.arg, inspect.Parameter.VAR_KEYWORD))
    try:
        inspect.Signature(parameters).bind(*[None for _ in call.args], **{kw.arg: None for kw in call.keywords})
    except TypeError:
        return False
    return True


def inert_value(node):
    if isinstance(node, (ast.Name, ast.Constant)):
        return True
    if isinstance(node, (ast.Tuple, ast.List)):
        return all(inert_value(item) for item in node.elts)
    if isinstance(node, ast.Dict):
        return all(isinstance(key, ast.Constant) and inert_value(value)
                   for key, value in zip(node.keys, node.values))
    return False


def inert_binding(node, protocols=()):
    if inert_function(node):
        return True
    if isinstance(node, ast.Assign):
        return all(isinstance(target, ast.Name) for target in node.targets) and inert_value(node.value)
    if isinstance(node, ast.AnnAssign):
        return (isinstance(node.target, ast.Name) and inert_value(node.annotation)
                and (node.value is None or inert_value(node.value)))
    if isinstance(node, ast.ClassDef):
        protocol = len(node.bases) == 1 and isinstance(node.bases[0], ast.Name) and node.bases[0].id in protocols
        body = copy.deepcopy(node.body)
        if protocol:
            for member in body:
                if isinstance(member, ast.FunctionDef) and all(
                        isinstance(decorator, ast.Name) and decorator.id in ('property', 'staticmethod', 'classmethod')
                        for decorator in member.decorator_list):
                    member.decorator_list = []
        return ((not node.bases or protocol) and not node.keywords and not node.decorator_list
                and not getattr(node, 'type_params', []) and all(
                    inert_binding(child) or isinstance(child, ast.Pass)
                    or (isinstance(child, ast.Expr) and isinstance(child.value, ast.Constant))
                    for child in body))
    return False


def removable_registration(node, functions):
    value = node.value if isinstance(node, ast.Expr) else None
    if not (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
            and isinstance(value.func.value, ast.Name) and value.func.value.id == 'CAD_HANDLERS'
            and value.func.attr == 'update' and len(value.args) == 1 and not value.keywords):
        return None
    try:
        entries = dictionary_keys(value.args[0], {}, {})
    except (Unknown, TypeError):
        return None
    if all(isinstance(key, str) and inert_handler_value(handler, functions)
           for key, handler in entries.items()):
        return sorted(entries)
    return None


def inert_typeddict(node, aliases, shadowed):
    """Standard TypedDict fields without evaluated user-defined type operators."""
    def annotation(value, union=False):
        if isinstance(value, ast.Constant):
            return value.value is None or (not union and isinstance(value.value, str))
        if isinstance(value, ast.Name):
            return value.id in {'str', 'int', 'float', 'bool', 'bytes', 'object'} - shadowed
        if isinstance(value, ast.BinOp) and isinstance(value.op, ast.BitOr):
            return (annotation(value.left, True) and annotation(value.right, True)
                    and any(isinstance(part, ast.Name) for part in ast.walk(value)))
        return False
    return (isinstance(node, ast.ClassDef) and len(node.bases) == 1
            and isinstance(node.bases[0], ast.Name) and node.bases[0].id in aliases
            and not node.keywords and not node.decorator_list and not getattr(node, 'type_params', [])
            and all(isinstance(member, ast.Pass)
                    or (isinstance(member, ast.Expr) and isinstance(member.value, ast.Constant)
                        and isinstance(member.value.value, str))
                    or (isinstance(member, ast.AnnAssign) and isinstance(member.target, ast.Name)
                        and member.value is None and annotation(member.annotation))
                    for member in node.body))


def shadowed_names(parsed):
    names = set()
    for _, tree in parsed:
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                names.add(node.id)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    if not (isinstance(node, ast.ImportFrom) and node.module == 'typing'
                            and alias.name in ('TYPE_CHECKING', 'Protocol', 'TypedDict')):
                        names.add(alias.asname or alias.name.split('.')[0])
    return names


def analyse(request):
    units, facade, spans, symbols, definitions = [], {}, {}, {}, []
    try:
        user_tree = ast.parse(request['source'], filename='<user>')
        if request.get('generated', False) and not any(
                isinstance(node, ast.FunctionDef) and node.name == 'run' for node in user_tree.body):
            return dict(unsupported=True, reason='No executable entrypoint in source fragment')
        user_facts = facts(user_tree, '<user>', user=not request.get('generated', False))
    except SyntaxError:
        # The ordinary checker owns user syntax diagnostics.
        return dict(unsupported=True)
    parsed = [(unit, ast.parse(unit['source'], filename=unit['filename'])) for unit in request['units']]
    casts = {alias.asname or alias.name for _, tree in parsed for node in ast.walk(tree)
             if isinstance(node, ast.ImportFrom) and node.module == 'typing'
              for alias in node.names if alias.name == 'cast'}
    type_guards = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                   if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                   for alias in node.names if alias.name == 'TYPE_CHECKING'}
    shadowed = shadowed_names(parsed)
    type_guards.difference_update(shadowed)
    protocols = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                 if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                 for alias in node.names if alias.name == 'Protocol'}
    protocols.difference_update(shadowed)
    typed_dicts = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                  if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                  for alias in node.names if alias.name == 'TypedDict'} - shadowed
    if shadowed.intersection(('property', 'staticmethod', 'classmethod')):
        protocols.clear()
    functions = {}
    for _, tree in parsed:
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                functions.setdefault(node.name, []).append(node)
    rebound = {node.id for _, tree in parsed for node in ast.walk(tree)
               if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}
    functions = {name: nodes for name, nodes in functions.items() if name not in rebound}
    wraps = {alias.asname or alias.name for _, tree in parsed for node in tree.body
             if isinstance(node, ast.ImportFrom) and node.module == 'functools'
             for alias in node.names if alias.name == 'wraps'} - rebound - functions.keys()
    if 'setattr' in shadowed:
        wraps.clear()
    for unit, tree in parsed:
        if unit['id'] == 'helpers':
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and node.name == 'FMCAD':
                    retained = []
                    for member in node.body:
                        if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            facade[member.name] = facts(ast.Module(body=[copy.deepcopy(member)], type_ignores=[]),
                                                       unit['filename'], method=member.name, unit='helpers', casts=casts)
                            spans[member.name] = [min([member.lineno] + [d.lineno for d in member.decorator_list]),
                                                  member.end_lineno]
                        else:
                            retained.append(member)
                    node.body = retained or [ast.Pass()]
        entry = facts(tree, unit['filename'], unit=unit['id'], casts=casts)
        class Eager(ast.NodeTransformer):
            def visit_FunctionDef(self, node):
                node.body = [ast.copy_location(ast.Pass(), node)]
                return node

            visit_AsyncFunctionDef = visit_FunctionDef

        eager = Eager().visit(copy.deepcopy(tree))
        entry['eager'] = facts(eager, unit['filename'], unit=unit['id'], casts=casts)
        entry['opaque'] = entry['eager']['opaque']
        statements = []
        for node in tree.body:
            if isinstance(node, ast.If) and not node.orelse:
                shell = copy.deepcopy(node)
                shell.body = [ast.Pass()]
                statements.append((shell, False))
                typing_only = isinstance(node.test, ast.Name) and node.test.id in type_guards
                statements.extend((child, typing_only) for child in node.body)
            else:
                statements.append((node, False))
        for node, typing_only in statements:
            statement = ast.Module(body=[copy.deepcopy(node)], type_ignores=[])
            registration = removable_registration(node, functions)
            if registration is not None and isinstance(node.value.args[0], ast.Dict):
                mapping = node.value.args[0]
                encoded_lines = unit['source'].encode('utf-8').splitlines(keepends=True)
                def offset(line, column):
                    return sum(len(part) for part in encoded_lines[:line - 1]) + column
                for index, (key, value) in enumerate(zip(mapping.keys, mapping.values)):
                    start = offset(key.lineno, key.col_offset)
                    if index + 1 < len(mapping.keys):
                        following = mapping.keys[index + 1]
                        end = offset(following.lineno, following.col_offset)
                    else:
                        end = offset(mapping.end_lineno, mapping.end_col_offset - 1)
                    row = facts(ast.Module(body=[ast.Expr(value=copy.deepcopy(value))], type_ignores=[]),
                                unit['filename'], unit=unit['id'], casts=casts)
                    definitions.append(dict(row, unit=unit['id'], start=key.lineno,
                                            end=value.end_lineno, column=key.col_offset,
                                            byteStart=start, byteEnd=end, removable=False,
                                            registration=[constant(key, {})]))
                statement.body[0].value.args[0] = ast.Dict(keys=[], values=[])
                registration = None
            dependency = facts(statement, unit['filename'], unit=unit['id'], casts=casts)
            # Only declarations whose creation has no calls are removable here.
            # Decorators, defaults and class initialization remain real roots;
            # their bodies must never be replaced by checker-only stubs.
            definition = dict(dependency, unit=unit['id'],
                                    start=min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])]),
                                    end=node.end_lineno, column=node.col_offset,
                                    removable=typing_only or inert_binding(node, protocols)
                                    or inert_typeddict(node, typed_dicts, shadowed)
                                    or ('setattr' not in shadowed and inert_decorated_function(node, functions, wraps)))
            if registration is not None:
                definition['registration'] = registration
            definitions.append(definition)
            for name in dependency['defines']:
                if name != 'CAD_HANDLERS':
                    symbols.setdefault(name, []).append(dependency)
        try:
            handlers = registrations(tree, functions=functions)
        except Unknown:
            # An unrecognised registration could own any requested operation.
            return dict(unsupported=True, unit=unit['id'])
        units.append(dict(entry, id=unit['id'], dependencies=unit['dependencies'], handlers=list(handlers), handlerReferences=handlers))
    return dict(unsupported=False, facts=dict(units=units, facade=facade,
                symbols=symbols, user=user_facts, definitions=definitions,
                facadeRequired=not request.get('generated', False) or any(
                    isinstance(node, ast.Name) and node.id == 'FMCAD' for node in ast.walk(user_tree))), spans=spans)


if __name__ == '__main__':
    json.dump(analyse(json.load(sys.stdin)), sys.stdout, ensure_ascii=True, allow_nan=False)
