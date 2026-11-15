"""Parse dependency facts offline. Never import or execute submitted Python."""
import ast
import copy
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


def registrations(tree):
    bindings, dictionaries, handlers = {}, {}, {}
    seen = set()
    # Registration keys are data, not callable bodies. Keep all owners for an
    # operation so ordered ownership transfers retain the existing semantics.
    statements = [(node, {}) for node in reversed(tree.body)]
    while statements:
        node, local = statements.pop()
        if isinstance(node, ast.For):
            if not any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                       and isinstance(call.func.value, ast.Name) and call.func.value.id == 'CAD_HANDLERS'
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
                and value.func.value.id == 'CAD_HANDLERS' and value.func.attr == 'update'):
            if len(value.args) != 1 or value.keywords:
                raise Unknown()
            seen.add(id(value))
            handlers.update(dictionary_keys(value.args[0], current, dictionaries))
        if (isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute)
                and isinstance(value.func.value, ast.Name)
                and value.func.value.id == 'CAD_HANDLERS' and value.func.attr == 'pop'):
            if not value.args:
                raise Unknown()
            seen.add(id(value))
            handlers.setdefault(constant(value.args[0], current), ast.Constant(value=None))
        for target in targets:
            if (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                    and target.value.id == 'CAD_HANDLERS'):
                handlers[constant(target.slice, current)] = value
                seen.add(id(target))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == 'CAD_HANDLERS'
                and node.func.attr in ('update', 'pop', 'setdefault', 'clear', '__setitem__', '__delitem__')
                and id(node) not in seen):
            raise Unknown()
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
                and node.value.id == 'CAD_HANDLERS' and isinstance(node.ctx, (ast.Store, ast.Del))
                and id(node) not in seen):
            raise Unknown()
    if any(not isinstance(item, str) for item in handlers):
        raise Unknown()
    return {key: sorted({node.id for node in ast.walk(value)
                         if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)})
            for key, value in handlers.items()}


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


def facts(tree, filename, *, user=False, method=None, unit=None):
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
                and (node.func.id == 'cast' or node.func.id.endswith('_cast'))):
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
            if isinstance(receiver, ast.Name) and receiver.id == ('FMCAD' if user else 'self') and (user or unit == 'helpers'):
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


def analyse(request):
    units, facade, spans, symbols = [], {}, {}, {}
    try:
        user_tree = ast.parse(request['source'], filename='<user>')
        user_facts = facts(user_tree, '<user>', user=True)
    except SyntaxError:
        # The ordinary checker owns user syntax diagnostics.
        return dict(unsupported=True)
    for unit in request['units']:
        tree = ast.parse(unit['source'], filename=unit['filename'])
        if unit['id'] == 'helpers':
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and node.name == 'FMCAD':
                    retained = []
                    for member in node.body:
                        if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            facade[member.name] = facts(ast.Module(body=[copy.deepcopy(member)], type_ignores=[]),
                                                       unit['filename'], method=member.name, unit='helpers')
                            spans[member.name] = [min([member.lineno] + [d.lineno for d in member.decorator_list]),
                                                  member.end_lineno]
                        else:
                            retained.append(member)
                    node.body = retained or [ast.Pass()]
        entry = facts(tree, unit['filename'], unit=unit['id'])
        class Eager(ast.NodeTransformer):
            def visit_FunctionDef(self, node):
                node.body = [ast.copy_location(ast.Pass(), node)]
                return node

            visit_AsyncFunctionDef = visit_FunctionDef

        eager = Eager().visit(copy.deepcopy(tree))
        entry['eager'] = facts(eager, unit['filename'], unit=unit['id'])
        entry['opaque'] = entry['eager']['opaque']
        for node in tree.body:
            statement = ast.Module(body=[copy.deepcopy(node)], type_ignores=[])
            dependency = facts(statement, unit['filename'], unit=unit['id'])
            for name in dependency['defines']:
                if name != 'CAD_HANDLERS':
                    symbols.setdefault(name, []).append(dependency)
        try:
            handlers = registrations(tree)
        except Unknown:
            # An unrecognised registration could own any requested operation.
            return dict(unsupported=True, unit=unit['id'])
        units.append(dict(entry, id=unit['id'], dependencies=unit['dependencies'], handlers=list(handlers), handlerReferences=handlers))
    return dict(unsupported=False, facts=dict(units=units, facade=facade,
                symbols=symbols, user=user_facts), spans=spans)


if __name__ == '__main__':
    json.dump(analyse(json.load(sys.stdin)), sys.stdout, ensure_ascii=True, allow_nan=False)
