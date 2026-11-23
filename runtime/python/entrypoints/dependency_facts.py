"""Parse dependency facts offline. Never import or execute submitted Python."""
import ast
import builtins
import copy
import inspect
import json
import symtable
import sys


class Unknown(Exception):
    pass


def tree_index(tree):
    """Collect the same breadth-first order and parent links in one walk."""
    nodes, parents = [tree], {}
    for node in nodes:
        for child in ast.iter_child_nodes(node):
            parents[child] = node
            nodes.append(child)
    return nodes, parents


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


def imports_namespace_access(nodes):
    return any(isinstance(node, ast.ImportFrom) and node.module == 'builtins'
               and any(alias.name in {'getattr', 'hasattr', 'globals', 'locals', 'vars',
                                      'eval', 'exec', '__import__', 'dir', '*'}
                       for alias in node.names) for node in nodes)


def finite_membership_domains(parsed, user_tree):
    trees = [tree for _, tree in parsed] + [user_tree]
    nodes = [node for tree in trees for node in ast.walk(tree)]
    parents = {child: node for node in nodes for child in ast.iter_child_nodes(node)}
    if imports_namespace_access(nodes):
        return {}
    if any((isinstance(node, ast.Name)
            and node.id in {'globals', 'locals', 'vars', 'eval', 'exec',
                            '__builtins__', 'getattr', 'hasattr'})
           or (isinstance(node, ast.Name) and node.id in {'type', 'str'}
               and not isinstance(node.ctx, ast.Load))
           or (isinstance(node, ast.arg) and node.arg in {'type', 'str'})
           or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
               and node.name in {'type', 'str'})
           or (isinstance(node, ast.alias) and (node.asname or node.name.split('.')[0]) in {'type', 'str'})
           or (isinstance(node, ast.Attribute)
               and node.attr in {'__globals__', '__dict__', '__getattribute__',
                                 '__getattr__', 'getattr', 'hasattr'})
           or (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
               and node.func.id in {'getattr', 'hasattr'})
           for node in nodes):
        return {}
    domains = {}
    for _, tree in parsed:
        for statement in tree.body:
            if not (isinstance(statement, ast.Assign) and len(statement.targets) == 1
                    and isinstance(statement.targets[0], ast.Name)):
                continue
            target, expression = statement.targets[0], statement.value
            uses = [node for node in nodes if isinstance(node, ast.Name) and node.id == target.id]
            if any(node is not target and not (
                    isinstance(node.ctx, ast.Load) and isinstance(parents.get(node), ast.Compare)
                    and len(parents[node].ops) == 1
                    and isinstance(parents[node].ops[0], (ast.In, ast.NotIn))
                    and parents[node].comparators == [node]) for node in uses):
                continue
            if any((isinstance(node, ast.arg) and node.arg == target.id)
                   or (isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef))
                       and node.name == target.id)
                   or (isinstance(node, ast.alias)
                       and (node.asname or node.name.split('.')[0]) in (target.id, '*'))
                   or (isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                       and node.name == target.id)
                   or (isinstance(node, ast.MatchMapping) and node.rest == target.id)
                   for node in nodes):
                continue
            try:
                if isinstance(expression, (ast.Set, ast.Tuple, ast.List)):
                    values = constant(expression, {})
                elif isinstance(expression, ast.SetComp) and len(expression.generators) == 1:
                    generator = expression.generators[0]
                    if not isinstance(generator.target, ast.Name) or generator.ifs or generator.is_async:
                        continue
                    values = [constant(expression.elt, {generator.target.id: value})
                              for value in constant(generator.iter, {})]
                else:
                    continue
                if values and all(isinstance(value, str) for value in values):
                    domains[target.id] = sorted(set(values))
            except (Unknown, TypeError):
                continue
    return domains


def registrations(tree, registry_names=('CAD_HANDLERS',), depth=0, functions=None):
    if depth > 8:
        raise Unknown()
    bindings, dictionaries, handlers = {}, {}, {}
    indirect = {}
    if functions is None:
        functions = {node.name: [node] for node in tree.body if isinstance(node, ast.FunctionDef)}
    seen = set()
    nodes, parents = tree_index(tree)
    for node in nodes:
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
    for node in nodes:
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


def guarded_operation_choices(node, parents, domains, casts):
    while (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
           and node.func.id in casts and len(node.args) == 2 and not node.keywords):
        node = node.args[1]
    # Re-reading a subscript/property may produce another value or invoke user
    # code. Only an unchanged local exact string can carry a dominating proof.
    if not isinstance(node, ast.Name):
        raise Unknown()
    scope, statement = parents.get(node), node
    while scope is not None and not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
        statement, scope = scope, parents.get(scope)
    if scope is None or statement not in scope.body:
        raise Unknown()
    if not isinstance(statement, (ast.Return, ast.Assign, ast.AnnAssign, ast.Expr)):
        raise Unknown()
    dispatch = parents.get(node)
    while dispatch is not None and dispatch is not statement:
        if (isinstance(dispatch, ast.Call) and isinstance(dispatch.func, ast.Attribute)
                and dispatch.func.attr == 'call'):
            break
        dispatch = parents.get(dispatch)
    if dispatch is None or dispatch is statement:
        raise Unknown()
    if any(isinstance(part, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom,
                             ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp))
           or (isinstance(part, ast.Call) and part is not dispatch
               and not (isinstance(part.func, ast.Name) and part.func.id in casts))
           for part in ast.walk(statement)):
        raise Unknown()
    index = scope.body.index(statement)
    for guard_index, guard in enumerate(scope.body[:index]):
        if not (isinstance(guard, ast.If) and not guard.orelse
                and len(guard.body) == 1 and isinstance(guard.body[0], ast.Raise)
                and isinstance(guard.test, ast.Compare) and len(guard.test.ops) == 1
                and isinstance(guard.test.ops[0], ast.NotIn)
                and isinstance(guard.test.comparators[0], ast.Name)
                and ast.dump(guard.test.left, include_attributes=False) == ast.dump(node, include_attributes=False)):
            continue
        name = guard.test.comparators[0].id
        if name not in domains:
            continue
        bindings = [part for part in ast.walk(scope)
                    if isinstance(part, ast.Name) and part.id == node.id
                    and not isinstance(part.ctx, ast.Load)]
        if (len(bindings) > 1 or any(
                not (isinstance(parents.get(binding), (ast.Assign, ast.AnnAssign))
                     and parents[binding] in scope.body
                     and parents[binding].end_lineno < guard.lineno)
                for binding in bindings)):
            continue
        if any((isinstance(part, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                and part.name == node.id)
               or (isinstance(part, ast.MatchMapping) and part.rest == node.id)
               or (isinstance(part, (ast.Global, ast.Nonlocal)) and node.id in part.names)
               for part in ast.walk(scope)):
            continue
        exact_string = False
        for check in scope.body[:guard_index]:
            test = check.test if isinstance(check, ast.If) else None
            if (isinstance(test, ast.Compare) and len(test.ops) == 1
                    and isinstance(test.ops[0], ast.IsNot) and not check.orelse
                    and len(check.body) == 1 and isinstance(check.body[0], ast.Raise)
                    and isinstance(test.left, ast.Call) and isinstance(test.left.func, ast.Name)
                    and test.left.func.id == 'type' and not test.left.keywords
                    and len(test.left.args) == 1 and isinstance(test.left.args[0], ast.Name)
                    and test.left.args[0].id == node.id
                    and isinstance(test.comparators[0], ast.Name)
                    and test.comparators[0].id == 'str'
                    and all(parents[binding].end_lineno < check.lineno for binding in bindings)):
                exact_string = True
        if not exact_string:
            continue
        if any((isinstance(part, ast.arg) and part.arg == name)
               or (isinstance(part, ast.Name) and part.id == name and not isinstance(part.ctx, ast.Load))
               for part in ast.walk(scope)):
            continue
        # Only read-only validation branches may intervene. A call/mutation
        # invalidates the guard proof, even if its name sounds like validation.
        intervening = scope.body[guard_index + 1:index]
        if any(not (isinstance(check, ast.If) and not check.orelse
                    and all(isinstance(part, ast.Raise) for part in check.body)
                    and not any(isinstance(part, (ast.Call, ast.NamedExpr, ast.Await, ast.Yield))
                                for part in ast.walk(check.test))) for check in intervening):
            continue
        return domains[name]
    raise Unknown()


def operation_choices(node, parents, domains=None, casts=()):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return operation_choices(node.body, parents, domains, casts) + operation_choices(node.orelse, parents, domains, casts)
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
    if domains:
        return guarded_operation_choices(node, parents, domains, casts)
    raise Unknown()


def facts(tree, filename, *, user=False, method=None, unit=None, casts=(), operation_domains=None):
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
    nodes, parents = tree_index(tree)
    annotations = set()
    for node in nodes:
        for field in ('annotation', 'returns'):
            annotation = getattr(node, field, None)
            if annotation is not None:
                annotations.update(ast.walk(annotation))
        if (isinstance(node, ast.Call) and node.args and isinstance(node.func, ast.Name)
                and node.func.id in casts):
            annotations.update(ast.walk(node.args[0]))
    for node in nodes:
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
                    operations.update(operation_choices(operation, parents, operation_domains, casts))
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


def call_signature(function):
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
    return inspect.Signature(parameters)


def binds_call(function, call):
    if any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords):
        return False
    try:
        call_signature(function).bind(*[None for _ in call.args], **{kw.arg: None for kw in call.keywords})
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


def inert_builtin_annotation(node, shadowed=()):
    if isinstance(node, ast.Constant):
        return node.value is None or node.value is Ellipsis or isinstance(node.value, str)
    builtins = {'list', 'dict', 'tuple', 'set', 'frozenset', 'type', 'str', 'int', 'float', 'bool', 'bytes', 'object'}
    if isinstance(node, ast.Name):
        return node.id in builtins and node.id not in shadowed
    if isinstance(node, ast.Tuple):
        return all(inert_builtin_annotation(item, shadowed) for item in node.elts)
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        return (node.value.id in {'list', 'dict', 'tuple', 'set', 'frozenset', 'type'}
                and node.value.id not in shadowed and inert_builtin_annotation(node.slice, shadowed))
    return False


def inert_exception_base(node, shadowed):
    if not isinstance(node, ast.Name) or node.id in shadowed:
        return False
    base = getattr(builtins, node.id, None)
    return isinstance(base, type) and issubclass(base, BaseException)


def inert_binding(node, protocols=(), shadowed=()):
    if inert_function(node):
        return True
    if isinstance(node, ast.Assign):
        return all(isinstance(target, ast.Name) for target in node.targets) and inert_value(node.value)
    if isinstance(node, ast.AnnAssign):
        return (isinstance(node.target, ast.Name) and (inert_value(node.annotation) or inert_builtin_annotation(node.annotation, shadowed))
                and (node.value is None or inert_value(node.value)))
    if isinstance(node, ast.ClassDef):
        protocol = len(node.bases) == 1 and isinstance(node.bases[0], ast.Name) and node.bases[0].id in protocols
        exception = len(node.bases) == 1 and inert_exception_base(node.bases[0], shadowed)
        body = copy.deepcopy(node.body)
        if protocol:
            for member in body:
                if isinstance(member, ast.FunctionDef) and all(
                        isinstance(decorator, ast.Name) and decorator.id in ('property', 'staticmethod', 'classmethod')
                        for decorator in member.decorator_list):
                    member.decorator_list = []
        return ((not node.bases or protocol or exception) and not node.keywords and not node.decorator_list
                and not getattr(node, 'type_params', []) and all(
                    inert_binding(child, shadowed=shadowed) or isinstance(child, ast.Pass)
                    or (isinstance(child, ast.Expr) and isinstance(child.value, ast.Constant))
                    for child in body))
    return False


def prior_function_binding(value, statement, tree, nodes):
    if not isinstance(value, ast.Name):
        return False
    bindings = [node for node in nodes
                if ((isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                     and node.name == value.id)
                    or (isinstance(node, ast.Name) and node.id == value.id
                        and not isinstance(node.ctx, ast.Load))
                    or (isinstance(node, ast.arg) and node.arg == value.id)
                    or (isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                        and node.name == value.id)
                    or (isinstance(node, ast.MatchMapping) and node.rest == value.id)
                    or (isinstance(node, ast.alias)
                        and (node.asname or node.name.split('.')[0]) == value.id))]
    return (len(bindings) == 1 and bindings[0] in tree.body
            and isinstance(bindings[0], ast.FunctionDef)
            and inert_function(bindings[0])
            and bindings[0].end_lineno < statement.lineno)


def removable_registration(node, functions, tree=None, context=()):
    if (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Subscript)):
        target = node.targets[0]
        if (isinstance(target.value, ast.Name) and target.value.id == 'CAD_HANDLERS'
                and isinstance(target.slice, ast.Constant)
                and isinstance(target.slice.value, str)
                and tree is not None
                and prior_function_binding(node.value, node, tree,
                                           [item for candidate in [tree, *context]
                                            for item in ast.walk(candidate)])):
            return [target.slice.value]
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


def inert_typeddict(node, aliases, shadowed, field_qualifiers=()):
    """Standard TypedDict fields without evaluated user-defined type operators."""
    def annotation(value, union=False):
        if isinstance(value, ast.Constant):
            return value.value is None or (not union and isinstance(value.value, str))
        if isinstance(value, ast.Name):
            return value.id in {'str', 'int', 'float', 'bool', 'bytes', 'object'} - shadowed
        if isinstance(value, ast.Subscript) and isinstance(value.value, ast.Name):
            name = value.value.id
            if name in shadowed:
                return False
            if name in field_qualifiers:
                return not union and annotation(value.slice)
            if name in {'list', 'dict', 'tuple', 'set', 'frozenset', 'type'}:
                arguments = value.slice.elts if isinstance(value.slice, ast.Tuple) else [value.slice]
                return all(annotation(arg) or (isinstance(arg, ast.Constant) and arg.value is Ellipsis)
                           for arg in arguments)
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
                            and alias.name in ('TYPE_CHECKING', 'Protocol', 'TypedDict', 'Required', 'NotRequired')):
                        names.add(alias.asname or alias.name.split('.')[0])
    return names


def reflection_attribute_keys(expression, parents, nodes):
    """A finite literal key domain, never inferred from parameter annotations."""
    try:
        value = constant(expression, {})
        if isinstance(value, str):
            return {value}
    except (Unknown, TypeError):
        pass
    if isinstance(expression, ast.IfExp):
        return (reflection_attribute_keys(expression.body, parents, nodes)
                | reflection_attribute_keys(expression.orelse, parents, nodes))
    if isinstance(expression, ast.Subscript):
        mapping = expression.value
        if isinstance(mapping, ast.Name):
            if any((isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                    and node.name == mapping.id)
                   or (isinstance(node, ast.alias)
                       and (node.asname or node.name.split('.')[0]) == mapping.id)
                   or (isinstance(node, ast.arg) and node.arg == mapping.id)
                   or (isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                       and node.name == mapping.id)
                   or (isinstance(node, ast.MatchMapping) and node.rest == mapping.id)
                   for node in nodes):
                raise Unknown()
            stores = [node for node in nodes if isinstance(node, ast.Name)
                      and node.id == mapping.id and not isinstance(node.ctx, ast.Load)]
            if len(stores) != 1:
                raise Unknown()
            assignment = parents.get(stores[0])
            if not isinstance(assignment, (ast.Assign, ast.AnnAssign)):
                raise Unknown()
            for use in nodes:
                if not (isinstance(use, ast.Name) and use.id == mapping.id
                        and isinstance(use.ctx, ast.Load)):
                    continue
                access = parents.get(use)
                subscript = (isinstance(access, ast.Subscript) and access.value is use
                             and isinstance(access.ctx, ast.Load))
                membership = (isinstance(access, ast.Compare)
                              and all(isinstance(op, (ast.In, ast.NotIn)) for op in access.ops)
                              and use in access.comparators)
                if not (subscript or membership):
                    raise Unknown()
            mapping = assignment.value
        if isinstance(mapping, ast.Dict):
            keys = set()
            for value in mapping.values:
                keys.update(reflection_attribute_keys(value, parents, nodes))
            return keys
    if isinstance(expression, ast.Name):
        ancestor = parents.get(expression)
        while ancestor is not None:
            if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                break
            generators = ([ancestor] if isinstance(ancestor, ast.For)
                          else ancestor.generators if isinstance(
                              ancestor, (ast.GeneratorExp, ast.ListComp, ast.SetComp, ast.DictComp)) else [])
            for generator in generators:
                if expression in ast.walk(generator.iter):
                    continue
                targets = list(ast.walk(generator.target))
                matches = [node for node in targets if isinstance(node, ast.Name)
                           and node.id == expression.id]
                if len(matches) != 1:
                    continue
                writes = [node for node in ast.walk(ancestor) if isinstance(node, ast.Name)
                          and node.id == expression.id and not isinstance(node.ctx, ast.Load)]
                if writes != matches:
                    raise Unknown()
                iterable = generator.iter
                if isinstance(iterable, ast.Name):
                    scope = parents.get(iterable)
                    while scope is not None and not isinstance(
                            scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module)):
                        scope = parents.get(scope)
                    if scope is None:
                        raise Unknown()
                    scope_nodes = list(ast.walk(scope))
                    writes = [node for node in scope_nodes if isinstance(node, ast.Name)
                              and node.id == iterable.id and not isinstance(node.ctx, ast.Load)]
                    if len(writes) != 1:
                        raise Unknown()
                    declaration = parents.get(writes[0])
                    if not (isinstance(declaration, (ast.Assign, ast.AnnAssign))
                            and declaration in scope.body
                            and declaration.end_lineno < iterable.lineno
                            and isinstance(declaration.value, ast.Tuple)
                            and all(isinstance(item, ast.Constant) and isinstance(item.value, str)
                                    for item in declaration.value.elts)
                            and not any((isinstance(node, ast.arg) and node.arg == iterable.id)
                                        or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                                            and node.name == iterable.id)
                                        or (isinstance(node, ast.alias)
                                            and (node.asname or node.name.split('.')[0]) == iterable.id)
                                        or (isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                                            and node.name == iterable.id)
                                        or (isinstance(node, ast.MatchMapping) and node.rest == iterable.id)
                                        for node in scope_nodes)):
                        raise Unknown()
                    iterable = declaration.value
                values = constant(iterable, {})
                def project(target, value):
                    if target is matches[0]:
                        return [value]
                    if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (list, tuple)):
                        if len(target.elts) != len(value):
                            raise Unknown()
                        return [item for child, part in zip(target.elts, value)
                                for item in project(child, part)]
                    return []
                keys = {item for value in values for item in project(generator.target, value)}
                if all(isinstance(item, str) for item in keys):
                    return keys
            ancestor = parents.get(ancestor)
    raise Unknown()


def registry_alias_expansions(unit, tree, context=()):
    """Prove a literal mapping is private and consumed only by registry update."""
    nodes = [node for candidate in [tree, *context] for node in ast.walk(candidate)]
    parents = {child: node for node in nodes for child in ast.iter_child_nodes(node)}
    if imports_namespace_access(nodes):
        return []
    for node in nodes:
        if isinstance(node, ast.Name) and node.id in {'getattr', 'hasattr'}:
            parent = parents.get(node)
            if not (isinstance(node.ctx, ast.Load) and isinstance(parent, ast.Call)
                    and parent.func is node):
                return []
        if isinstance(node, ast.Attribute) and node.attr in {'getattr', 'hasattr'}:
            return []
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id in {'getattr', 'hasattr'}):
            try:
                attributes = reflection_attribute_keys(node.args[1], parents, nodes)
            except (Unknown, IndexError, TypeError):
                return []
            if any(attribute.startswith('__') for attribute in attributes):
                return []
    if any((isinstance(node, ast.Attribute)
            and node.attr in {'__globals__', '__dict__', '__builtins__',
                              '__getattribute__', '__getattr__',
                              'globals', 'locals', 'vars', 'eval', 'exec'})
           or (isinstance(node, ast.Name) and node.id == '__builtins__')
           or (isinstance(node, ast.ImportFrom)
               and any(alias.name == '*' for alias in node.names))
           or (isinstance(node, ast.Constant)
               and node.value in ('__globals__', '__dict__', '__builtins__'))
           for node in nodes):
        return []
    lines = unit['source'].encode('utf-8').splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    result = []
    for statement in tree.body:
        if isinstance(statement, ast.AnnAssign):
            target, mapping = statement.target, statement.value
        elif isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target, mapping = statement.targets[0], statement.value
        else:
            continue
        if not isinstance(target, ast.Name) or not isinstance(mapping, ast.Dict):
            continue
        unsafe_reflection = False
        for node in nodes:
            if not (isinstance(node, ast.Name)
                    and node.id in {'globals', 'locals', 'vars', 'eval', 'exec'}):
                continue
            call = parents.get(node)
            access = parents.get(call)
            lookup = parents.get(access)
            # A literal lookup of another global does not expose this mapping.
            if not (node.id == 'globals' and isinstance(node.ctx, ast.Load)
                    and isinstance(call, ast.Call) and call.func is node
                    and not call.args and not call.keywords
                    and isinstance(access, ast.Attribute) and access.value is call
                    and access.attr == 'get' and isinstance(lookup, ast.Call)
                    and lookup.func is access and 1 <= len(lookup.args) <= 2
                    and not lookup.keywords
                    and isinstance(lookup.args[0], ast.Constant)
                    and isinstance(lookup.args[0].value, str)
                    and lookup.args[0].value != target.id):
                unsafe_reflection = True
                break
        if unsafe_reflection:
            continue
        uses = [node for node in nodes if isinstance(node, ast.Name) and node.id == target.id]
        if len(uses) != 2 or target not in uses:
            continue
        if any((isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == target.id)
               or (isinstance(node, ast.alias)
                   and (node.asname or node.name.split('.')[0]) == target.id)
               or (isinstance(node, ast.arg) and node.arg == target.id)
               or (isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar))
                   and node.name == target.id)
               for node in nodes):
            continue
        load = next(node for node in uses if node is not target)
        call = parents.get(load)
        if not (isinstance(load.ctx, ast.Load) and isinstance(call, ast.Call)
                and call.args == [load] and not call.keywords
                and isinstance(call.func, ast.Attribute) and call.func.attr == 'update'
                and isinstance(call.func.value, ast.Name) and call.func.value.id == 'CAD_HANDLERS'
                and isinstance(parents.get(call), ast.Expr)
                and parents.get(call) in tree.body
                and call.lineno > statement.end_lineno):
            continue
        entries = []
        for key, value in zip(mapping.keys, mapping.values):
            if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
                break
            inert_lambda = (isinstance(value, ast.Lambda) and not value.args.defaults
                            and not any(value.args.kw_defaults))
            bound_function = prior_function_binding(value, statement, tree, nodes)
            if not (bound_function or inert_lambda):
                break
            entries.append(dict(operation=key.value,
                                source=repr(key.value) + ': ' + ast.get_source_segment(unit['source'], value)))
        else:
            if len({entry['operation'] for entry in entries}) != len(entries):
                continue
            result.append(dict(unit=unit['id'],
                               byteStart=starts[mapping.lineno - 1] + mapping.col_offset,
                               byteEnd=starts[mapping.end_lineno - 1] + mapping.end_col_offset,
                               entries=entries))
    return result


def registry_expansions(unit, tree, functions, context=()):
    """Finite comprehension values are inert closures; never evaluate user code."""
    rows = registry_alias_expansions(unit, tree, context)
    lines = unit['source'].encode('utf-8').splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    for statement in tree.body:
        if not isinstance(statement, ast.Expr):
            continue
        if removable_registration(statement, functions) is None:
            continue
        mapping = statement.value.args[0]
        if not isinstance(mapping, ast.DictComp) or len(mapping.generators) != 1:
            continue
        generator = mapping.generators[0]
        if not isinstance(generator.target, ast.Name) or generator.ifs or generator.is_async:
            continue
        try:
            values = constant(generator.iter, {})
            if not isinstance(values, (list, tuple)) or any(type(value) not in (str, int, bool, type(None)) for value in values):
                continue
            entries = []
            for value in values:
                class Bind(ast.NodeTransformer):
                    def visit_Name(self, node):
                        if isinstance(node.ctx, ast.Load) and node.id == generator.target.id:
                            return ast.copy_location(ast.Constant(value=value), node)
                        return node
                handler = Bind().visit(copy.deepcopy(mapping.value))
                key = constant(mapping.key, {generator.target.id: value})
                if not isinstance(key, str) or not inert_handler_value(handler, functions):
                    raise Unknown()
                entries.append(dict(operation=key, source=repr(key) + ': ' + ast.unparse(handler)))
            if len({row['operation'] for row in entries}) != len(entries):
                continue
            rows.append(dict(unit=unit['id'],
                             byteStart=starts[mapping.lineno - 1] + mapping.col_offset,
                             byteEnd=starts[mapping.end_lineno - 1] + mapping.end_col_offset,
                             entries=entries))
        except (Unknown, TypeError, ValueError):
            continue
    return rows


def decorator_preserves_parameter(function, parameter, functions, wraps):
    positional = function.args.posonlyargs + function.args.args
    names = [arg.arg for arg in positional]
    if parameter not in names:
        return False
    index = names.index(parameter)
    for decorator in function.decorator_list:
        factory = decorator.func if isinstance(decorator, ast.Call) else decorator
        if not isinstance(factory, ast.Name) or len(functions.get(factory.id, [])) != 1:
            return False
        candidate = functions[factory.id][0]
        applied = closure_result(candidate, set(), wraps) if isinstance(decorator, ast.Call) else candidate
        if applied is None:
            return False
        parameters = applied.args.posonlyargs + applied.args.args
        if not parameters:
            return False
        handler = parameters[0].arg
        wrapper = closure_result(applied, {handler}, wraps)
        if wrapper is None:
            return False
        wrapper_parameters = wrapper.args.posonlyargs + wrapper.args.args
        parent = {child: node for statement in wrapper.body for node in ast.walk(statement)
                  for child in ast.iter_child_nodes(node)}
        invocations = []
        for node, owner in parent.items():
            if isinstance(node, ast.Name) and node.id == handler:
                if not isinstance(owner, ast.Call) or owner.func is not node:
                    return False
                invocations.append(owner)
        if not invocations:
            return False
        protected = {arg.arg for arg in wrapper_parameters}
        protected.update(arg.arg for arg in (wrapper.args.vararg, wrapper.args.kwarg) if arg is not None)
        if any(isinstance(node, ast.Name) and node.id in protected and isinstance(node.ctx, (ast.Store, ast.Del))
               for statement in wrapper.body for node in ast.walk(statement)):
            return False
        for call in invocations:
            if index < len(wrapper_parameters):
                if len(call.args) <= index or not isinstance(call.args[index], ast.Name) or call.args[index].id != wrapper_parameters[index].arg:
                    return False
            else:
                prefix = len(wrapper_parameters)
                if (wrapper.args.vararg is None or len(call.args) != prefix + 1
                        or not isinstance(call.args[-1], ast.Starred)
                        or not isinstance(call.args[-1].value, ast.Name)
                        or call.args[-1].value.id != wrapper.args.vararg.arg):
                    return False
            if (wrapper.args.kwarg is None or len(call.keywords) != 1
                    or call.keywords[0].arg is not None
                    or not isinstance(call.keywords[0].value, ast.Name)
                    or call.keywords[0].value.id != wrapper.args.kwarg.arg):
                return False
        for node, owner in parent.items():
            if isinstance(node, ast.Name) and wrapper.args.kwarg and node.id == wrapper.args.kwarg.arg:
                if not isinstance(owner, ast.keyword) or owner.arg is not None or parent.get(owner) not in invocations:
                    return False
    return True


def literal_argument_rewrites(parsed, user_tree, functions, wraps):
    """Closed direct-call bindings. Unknown callers or rebinding veto a parameter."""
    decorated_safe = 'setattr' not in shadowed_names(parsed)
    unique = {name: values[0] for name, values in functions.items()
              if len(values) == 1 and (not values[0].decorator_list
                                      or (decorated_safe and inert_decorated_function(values[0], functions, wraps)))}
    collisions = set()
    for tree in [*(tree for _, tree in parsed), user_tree]:
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                collisions.add(node.id)
            elif isinstance(node, ast.arg):
                collisions.add(node.arg)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node is not unique.get(node.name):
                collisions.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                collisions.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
    unique = {name: node for name, node in unique.items() if name not in collisions}
    parents, scopes = {}, {}
    def index(node, scope):
        scopes[node] = scope
        nested = node if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)) else scope
        for child in ast.iter_child_nodes(node):
            parents[child] = node
            index(child, nested)
    for _, tree in parsed:
        index(tree, None)
    index(user_tree, None)
    calls = {name: [] for name in unique}
    escaped = set()
    for node, parent in parents.items():
        if not isinstance(node, ast.Name) or node.id not in unique or not isinstance(node.ctx, ast.Load):
            continue
        if isinstance(parent, ast.Call) and parent.func is node:
            calls[node.id].append(parent)
        else:
            escaped.add(node.id)
    unique = {name: node for name, node in unique.items() if name not in escaped and calls[name]}
    bindings = {node: {} for node in unique.values()}
    scope_locals = {}
    for scope in set(scopes.values()):
        if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            local = {part.arg for part in ast.walk(scope.args) if isinstance(part, ast.arg)}
            local.update(part.id for part in ast.walk(scope)
                         if isinstance(part, ast.Name) and isinstance(part.ctx, (ast.Store, ast.Del)))
            scope_locals[scope] = local
    def environment(node):
        result = {}
        chain = []
        scope = scopes.get(node)
        while scope is not None:
            chain.append(scope)
            scope = scopes.get(scope)
        for scope in reversed(chain):
            if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                for name in scope_locals[scope]:
                    result.pop(name, None)
                result.update(bindings.get(scope, {}))
            elif isinstance(scope, ast.ClassDef):
                result.clear()
        return result
    def scalar(node, local):
        if isinstance(node, ast.Constant) and type(node.value) in (str, int, bool, type(None)):
            return node.value
        if isinstance(node, ast.Name) and node.id in local:
            return local[node.id]
        raise Unknown()
    changed = True
    while changed:
        changed = False
        for name, function in unique.items():
            parameters = function.args.posonlyargs + function.args.args
            defaults = dict(zip([arg.arg for arg in parameters[-len(function.args.defaults):]], function.args.defaults)) if function.args.defaults else {}
            defaults.update({arg.arg: value for arg, value in zip(function.args.kwonlyargs, function.args.kw_defaults) if value is not None})
            modified = {part.id for part in ast.walk(function) if isinstance(part, ast.Name) and isinstance(part.ctx, (ast.Store, ast.Del))}
            modified.update(name for part in ast.walk(function) if isinstance(part, (ast.Global, ast.Nonlocal)) for name in part.names)
            candidate = {}
            for parameter in parameters + function.args.kwonlyargs:
                if parameter.arg in modified or (function.decorator_list and not decorator_preserves_parameter(function, parameter.arg, functions, wraps)):
                    continue
                values = []
                for call in calls[name]:
                    if not binds_call(function, call):
                        break
                    bound = call_signature(function).bind(*call.args, **{kw.arg: kw.value for kw in call.keywords})
                    argument = bound.arguments.get(parameter.arg, defaults.get(parameter.arg))
                    try:
                        values.append(scalar(argument, environment(call) if parameter.arg in bound.arguments else {}))
                    except Unknown:
                        break
                else:
                    if values and all(type(value) is type(values[0]) and value == values[0] for value in values):
                        candidate[parameter.arg] = values[0]
            if candidate != bindings[function]:
                bindings[function] = candidate
                changed = True
    edits = []
    for unit, tree in parsed:
        lines = unit['source'].encode('utf-8').splitlines(keepends=True)
        starts = [0]
        for line in lines:
            starts.append(starts[-1] + len(line))
        for function in tree.body:
            if function not in bindings or not bindings[function]:
                continue
            # Bindings select branches, never replace argument objects or defaults.
            body = ast.Module(body=function.body, type_ignores=[])
            original_source = ast.unparse(function)
            before = ast.dump(body, include_attributes=False)
            rewritten = prune_literal_branches(body, environment)
            if ast.dump(rewritten, include_attributes=False) == before:
                continue
            clone = copy.copy(function)
            clone.body = rewritten.body
            replacement = ast.unparse(clone)
            if not preserves_lexical_bindings(original_source, replacement):
                continue
            start_line = min([function.lineno] + [node.lineno for node in function.decorator_list])
            edits.append(dict(unit=unit['id'], byteStart=starts[start_line - 1] + function.col_offset,
                              byteEnd=starts[function.end_lineno - 1] + function.end_col_offset,
                              source=replacement))
    return edits


def preserves_lexical_bindings(original, selected):
    def tables(source):
        result = {}
        def visit(table, prefix):
            key = (*prefix, table.get_name(), str(table.get_type()))
            if key in result:
                raise Unknown()
            result[key] = table
            for child in table.get_children():
                visit(child, key)
        visit(symtable.symtable(source, '<specialization>', 'exec'), ())
        return result
    try:
        if sum(isinstance(node, (ast.Yield, ast.YieldFrom)) for node in ast.walk(ast.parse(original))) != sum(
                isinstance(node, (ast.Yield, ast.YieldFrom)) for node in ast.walk(ast.parse(selected))):
            return False
        before, after = tables(original), tables(selected)
        for key, scope in after.items():
            previous = before.get(key)
            if previous is None:
                return False
            for symbol in scope.get_symbols():
                if not symbol.is_referenced():
                    continue
                old = previous.lookup(symbol.get_name())
                for flag in ('is_local', 'is_global', 'is_nonlocal', 'is_free', 'is_parameter'):
                    if getattr(symbol, flag)() != getattr(old, flag)():
                        return False
        return True
    except (Unknown, SyntaxError, KeyError):
        return False


def prune_literal_branches(tree, environment):
    def value(node):
        if isinstance(node, ast.Name) and node.id in environment(node):
            return environment(node)[node.id]
        if isinstance(node, ast.Constant) and type(node.value) in (str, int, bool, type(None)):
            return node.value
        if isinstance(node, (ast.Tuple, ast.List)):
            return tuple(value(item) for item in node.elts)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not value(node.operand)
        if isinstance(node, ast.BoolOp):
            result = value(node.values[0])
            for expression in node.values[1:]:
                if isinstance(node.op, ast.And) and not result:
                    return result
                if isinstance(node.op, ast.Or) and result:
                    return result
                result = value(expression)
            return result
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = value(node.left), value(node.comparators[0])
            operation = node.ops[0]
            if isinstance(operation, ast.Eq):
                return left == right
            if isinstance(operation, ast.NotEq):
                return left != right
            if isinstance(operation, (ast.Is, ast.IsNot)) and (left is None or right is None or type(left) is bool or type(right) is bool):
                result = left is right
                return not result if isinstance(operation, ast.IsNot) else result
            if isinstance(operation, (ast.In, ast.NotIn)) and isinstance(right, (tuple, str)):
                result = left in right
                return not result if isinstance(operation, ast.NotIn) else result
        raise Unknown()
    class Prune(ast.NodeTransformer):
        def visit_If(self, node):
            try:
                branch = node.body if value(node.test) else node.orelse
            except (Unknown, TypeError):
                return self.generic_visit(node)
            result = []
            for statement in branch:
                transformed = self.visit(statement)
                result.extend(transformed if isinstance(transformed, list) else [transformed])
            return result or [ast.copy_location(ast.Pass(), node)]
        def visit_IfExp(self, node):
            try:
                return self.visit(node.body if value(node.test) else node.orelse)
            except (Unknown, TypeError):
                return self.generic_visit(node)
        def generic_visit(self, node):
            node = super().generic_visit(node)
            for field in ('body', 'orelse', 'finalbody'):
                statements = getattr(node, field, None)
                if isinstance(statements, list):
                    for index, statement in enumerate(statements):
                        if isinstance(statement, (ast.Return, ast.Raise)):
                            setattr(node, field, statements[:index + 1])
                            break
            return node
    return Prune().visit(tree)


def receiver_method_facts(parsed, user_tree, functions):
    """Flow-insensitive receiver sets; unresolved escape retains the whole class.

    Names across lexical scopes are deliberately unioned (an over-approximation),
    never inferred from a spelling convention or a type annotation.
    """
    trees = [tree for _, tree in parsed] + [user_tree]
    nodes = [node for tree in trees for node in ast.walk(tree)]
    parents = {child: node for node in nodes for child in ast.iter_child_nodes(node)}
    classes = {}
    duplicates = set()
    for unit, tree in parsed:
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            if node.name in classes:
                duplicates.add(node.name)
            classes[node.name] = (unit, node)
    shadowed = {node.arg for node in nodes if isinstance(node, ast.arg)}
    shadowed.update(node.id for node in nodes if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)))
    shadowed.update(alias.asname or alias.name.split('.')[0] for node in nodes
                    if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names)
    classes = {name: pair for name, pair in classes.items() if name not in duplicates | shadowed
               and not pair[1].bases and not pair[1].keywords and not pair[1].decorator_list
               and not any(isinstance(member, ast.FunctionDef) and member.name in ('__getattr__', '__getattribute__') for member in pair[1].body)}
    methods = {name: {member.name: member for member in tree.body if isinstance(member, ast.FunctionDef)}
               for name, (_, tree) in classes.items()}
    points = {}
    escaped = set()
    used = {name: set() for name in classes}
    bound_receivers = {}
    method_receivers = {}
    for name, members in methods.items():
        for member in members.values():
            parameters = member.args.posonlyargs + member.args.args
            if not parameters or member.decorator_list:
                escaped.add(name)
                continue
            receiver = parameters[0].arg
            method_receivers[member] = receiver
            if any(isinstance(part, ast.Name) and part.id == receiver and isinstance(part.ctx, (ast.Store, ast.Del))
                   for part in ast.walk(member)):
                escaped.add(name)
                continue
            def bind(node):
                if node is not member and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                    if any(isinstance(part, ast.arg) and part.arg == receiver for part in ast.walk(node)):
                        escaped.add(name)
                        return
                if isinstance(node, ast.Name) and node.id == receiver:
                    bound_receivers[node] = name
                for child in ast.iter_child_nodes(node):
                    bind(child)
            bind(member)
    def add(name, values):
        previous = points.setdefault(name, set())
        count = len(previous)
        previous.update(values)
        return len(previous) != count
    def receivers(node):
        if node in bound_receivers:
            return {bound_receivers[node]}
        if isinstance(node, ast.Name):
            return points.get(node.id, set())
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in classes:
            return {node.func.id}
        return set()
    local_names = {node.arg for node in nodes if isinstance(node, ast.arg)}
    local_names.update(alias.asname or alias.name.split('.')[0] for node in nodes
                       if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names)
    for node in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(node is not candidate for candidate in functions.get(node.name, [])):
            local_names.add(node.name)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in functions:
            owner = parents.get(node)
            if not isinstance(owner, ast.Call) or owner.func is not node:
                local_names.add(node.id)
    safe_functions = {name: values[0] for name, values in functions.items()
                      if len(values) == 1 and name not in local_names and not values[0].decorator_list}
    resolved_calls = set()
    ambiguous = set()
    changed = True
    while changed:
        changed = False
        for node in nodes:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if all(isinstance(target, ast.Name) for target in targets):
                    for target in targets:
                        changed |= add(target.id, receivers(node.value))
            if not isinstance(node, ast.Call):
                continue
            targets = []
            args = node.args
            if isinstance(node.func, ast.Name) and node.func.id in safe_functions:
                targets.append(safe_functions[node.func.id])
            elif isinstance(node.func, ast.Attribute):
                owners = receivers(node.func.value)
                if owners and all(node.func.attr in methods[owner] and not methods[owner][node.func.attr].decorator_list for owner in owners):
                    targets.extend(methods[owner][node.func.attr] for owner in owners)
                    args = [node.func.value, *args]
            for target in targets:
                call = ast.Call(func=node.func, args=args, keywords=node.keywords)
                if not binds_call(target, call):
                    continue
                bound = call_signature(target).bind(*args, **{kw.arg: kw.value for kw in node.keywords})
                if any(isinstance(value, (tuple, dict)) and value for value in bound.arguments.values()):
                    continue
                resolved_calls.add(node)
                for name, value in bound.arguments.items():
                    if method_receivers.get(target) == name:
                        continue
                    changed |= add(name, receivers(value))
                    if not receivers(value):
                        ambiguous.add(name)
                for parameter in target.args.posonlyargs + target.args.args + target.args.kwonlyargs:
                    if parameter.arg not in bound.arguments:
                        ambiguous.add(parameter.arg)
    known = set(safe_functions.values()) | {method for members in methods.values() for method in members.values()}
    for node in nodes:
        if isinstance(node, ast.arg):
            owner = parents.get(parents.get(node))
            if owner not in known:
                ambiguous.add(node.arg)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and not receivers(node.value):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            ambiguous.update(target.id for target in targets if isinstance(target, ast.Name))
    for name in ambiguous:
        escaped.update(points.get(name, set()))
    for node in nodes:
        parent = parents.get(node)
        if isinstance(node, ast.Name) and node.id in classes and isinstance(node.ctx, ast.Load):
            if not (isinstance(parent, ast.Call) and parent.func is node):
                escaped.add(node.id)
        if isinstance(node, ast.Attribute):
            for owner in receivers(node.value):
                if node.attr.startswith('__') or (isinstance(node.ctx, (ast.Store, ast.Del)) and node.attr in methods[owner]):
                    escaped.add(owner)
                used[owner].add(node.attr)
                if node.attr in methods[owner] and not (isinstance(parent, ast.Call) and parent.func is node):
                    escaped.add(owner)
        owners = receivers(node)
        if not owners or (isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load)):
            continue
        if isinstance(parent, ast.Attribute) and parent.value is node:
            continue
        if isinstance(parent, (ast.Assign, ast.AnnAssign)) and parent.value is node:
            targets = parent.targets if isinstance(parent, ast.Assign) else [parent.target]
            if all(isinstance(target, ast.Name) for target in targets):
                continue
        call = parent if isinstance(parent, ast.Call) else parents.get(parent) if isinstance(parent, ast.keyword) else None
        if call in resolved_calls:
            continue
        escaped.update(owners)
    result = []
    for name, (unit, node) in classes.items():
        counts = {}
        for member in node.body:
            if isinstance(member, ast.FunctionDef):
                counts[member.name] = counts.get(member.name, 0) + 1
        result.append(dict(unit=unit['id'], name=name, escaped=name in escaped, used=sorted(used[name]),
                           methods=[dict(name=member.name, start=member.lineno, end=member.end_lineno,
                                         column=member.col_offset, removable=inert_function(member) and counts[member.name] == 1)
                                    for member in node.body if isinstance(member, ast.FunctionDef)]))
    return result


def typing_guard_modules(parsed):
    """Recognize qualified flags only while their module namespace cannot escape."""
    aliases = {alias.asname or alias.name for _, tree in parsed for node in tree.body
               if isinstance(node, ast.Import) for alias in node.names if alias.name == 'typing'}
    for _, tree in parsed:
        if not aliases:
            break
        nodes, parents = tree_index(tree)
        for node in nodes:
            if isinstance(node, ast.Name) and node.id in aliases:
                parent = parents.get(node)
                if not (isinstance(node.ctx, ast.Load) and isinstance(parent, ast.Attribute)
                        and parent.value is node and parent.attr == 'TYPE_CHECKING'
                        and isinstance(parent.ctx, ast.Load)):
                    aliases.discard(node.id)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                aliases.discard(node.name)
            if isinstance(node, ast.arg):
                aliases.discard(node.arg)
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    if not (isinstance(node, ast.Import) and alias.name == 'typing'):
                        aliases.discard(alias.asname or alias.name.split('.')[0])
    return aliases


def analyse(request):
    units, facade, spans, symbols, definitions, expansions = [], {}, {}, {}, [], []
    try:
        user_tree = ast.parse(request['source'], filename='<user>')
        if request.get('generated', False) and not any(
                isinstance(node, ast.FunctionDef) and node.name == 'run' for node in user_tree.body):
            return dict(unsupported=True, reason='No executable entrypoint in source fragment')
        user_facts = facts(user_tree, '<user>', user=not request.get('generated', False))
        if user_facts['opaque']:
            # Core policy necessarily retains the full inventory for this root.
            # Do not repeatedly parse megabytes that cannot change that decision.
            return dict(unsupported=True, reason='Opaque entrypoint requires complete namespace')
    except SyntaxError:
        # The ordinary checker owns user syntax diagnostics.
        return dict(unsupported=True)
    parsed = [(unit, ast.parse(unit['source'], filename=unit['filename'])) for unit in request['units']]
    casts = {alias.asname or alias.name for _, tree in parsed for node in ast.walk(tree)
              if isinstance(node, ast.ImportFrom) and node.module == 'typing'
               for alias in node.names if alias.name == 'cast'}
    for tree in [*(tree for _, tree in parsed), user_tree]:
        for node in ast.walk(tree):
            if isinstance(node, ast.arg):
                casts.discard(node.arg)
            elif isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                casts.discard(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                casts.discard(node.name)
            elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)):
                casts.discard(node.name)
            elif isinstance(node, ast.MatchMapping):
                casts.discard(node.rest)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    if not (isinstance(node, ast.ImportFrom) and node.module == 'typing'
                            and alias.name == 'cast'):
                        casts.discard(alias.asname or alias.name.split('.')[0])
    type_guards = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                   if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                   for alias in node.names if alias.name == 'TYPE_CHECKING'}
    shadowed = shadowed_names(parsed)
    type_guards.difference_update(shadowed)
    guard_modules = typing_guard_modules(parsed)
    protocols = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                 if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                 for alias in node.names if alias.name == 'Protocol'}
    protocols.difference_update(shadowed)
    typed_dicts = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                  if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                  for alias in node.names if alias.name == 'TypedDict'} - shadowed
    field_qualifiers = {alias.asname or alias.name for _, tree in parsed for node in tree.body
                        if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                        for alias in node.names if alias.name in ('Required', 'NotRequired')} - shadowed
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
    operation_domains = finite_membership_domains(parsed, user_tree)
    for unit, tree in parsed:
        if request.get('specialize', False):
            expansions.extend(registry_expansions(
                unit, tree, functions,
                [candidate for _, candidate in parsed if candidate is not tree] + [user_tree]))
        if unit['id'] == 'helpers':
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and node.name == 'FMCAD':
                    retained = []
                    for member in node.body:
                        if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            facade[member.name] = facts(ast.Module(body=[member], type_ignores=[]),
                                                       unit['filename'], method=member.name, unit='helpers', casts=casts)
                            spans[member.name] = [min([member.lineno] + [d.lineno for d in member.decorator_list]),
                                                  member.end_lineno]
                        else:
                            retained.append(member)
                    node.body = retained or [ast.Pass()]
        entry = facts(tree, unit['filename'], unit=unit['id'], casts=casts,
                      operation_domains=operation_domains)
        class Eager(ast.NodeTransformer):
            def visit(self, node):
                # Copy only visited nodes; function bodies are never visited.
                return super().visit(copy.copy(node))

            def generic_visit(self, node):
                for field, value in ast.iter_fields(node):
                    if isinstance(value, list):
                        setattr(node, field, list(value))
                return super().generic_visit(node)

            def visit_FunctionDef(self, node):
                node.body = [ast.copy_location(ast.Pass(), node)]
                return node

            visit_AsyncFunctionDef = visit_FunctionDef

        eager = Eager().visit(tree)
        entry['eager'] = facts(eager, unit['filename'], unit=unit['id'], casts=casts,
                               operation_domains=operation_domains)
        entry['opaque'] = entry['eager']['opaque']
        statements = []
        for node in tree.body:
            if isinstance(node, ast.If) and not node.orelse:
                shell = copy.copy(node)
                shell.body = [ast.Pass()]
                statements.append((shell, False))
                typing_only = ((isinstance(node.test, ast.Name) and node.test.id in type_guards)
                               or (isinstance(node.test, ast.Attribute) and node.test.attr == 'TYPE_CHECKING'
                                   and isinstance(node.test.value, ast.Name) and node.test.value.id in guard_modules))
                statements.extend((child, typing_only) for child in node.body)
            else:
                statements.append((node, False))
        for node, typing_only in statements:
            statement = ast.Module(body=[node], type_ignores=[])
            registration = removable_registration(
                node, functions, tree,
                [candidate for _, candidate in parsed if candidate is not tree] + [user_tree])
            if (registration is not None and isinstance(node, ast.Expr)
                    and isinstance(node.value.args[0], ast.Dict)):
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
                    row = facts(ast.Module(body=[ast.Expr(value=value)], type_ignores=[]),
                                unit['filename'], unit=unit['id'], casts=casts)
                    definitions.append(dict(row, unit=unit['id'], start=key.lineno,
                                            end=value.end_lineno, column=key.col_offset,
                                            byteStart=start, byteEnd=end, removable=False,
                                            registration=[constant(key, {})]))
                statement.body[0] = copy.copy(node)
                statement.body[0].value = copy.copy(node.value)
                statement.body[0].value.args = [ast.Dict(keys=[], values=[]), *node.value.args[1:]]
                registration = None
            dependency = facts(statement, unit['filename'], unit=unit['id'], casts=casts,
                               operation_domains=operation_domains)
            # Only declarations whose creation has no calls are removable here.
            # Decorators, defaults and class initialization remain real roots;
            # their bodies must never be replaced by checker-only stubs.
            definition = dict(dependency, unit=unit['id'],
                                    start=min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])]),
                                    end=node.end_lineno, column=node.col_offset,
                                    removable=typing_only or inert_binding(node, protocols, shadowed)
                                    or inert_typeddict(node, typed_dicts, shadowed, field_qualifiers)
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
    literal_rewrites = literal_argument_rewrites(parsed, user_tree, functions, wraps) if request.get('specialize', False) and not expansions else []
    receiver_facts = receiver_method_facts(parsed, user_tree, functions) if request.get('specialize', False) and not expansions and not literal_rewrites else []
    return dict(unsupported=False, facts=dict(units=units, facade=facade,
                symbols=symbols, user=user_facts, definitions=definitions, registryExpansions=expansions,
                literalRewrites=literal_rewrites,
                receiverClasses=receiver_facts,
                facadeRequired=not request.get('generated', False) or any(
                    isinstance(node, ast.Name) and node.id == 'FMCAD' for node in ast.walk(user_tree))), spans=spans)


if __name__ == '__main__':
    json.dump(analyse(json.load(sys.stdin)), sys.stdout, ensure_ascii=True, allow_nan=False)
