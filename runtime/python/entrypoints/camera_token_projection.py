"""Project a revalidated token from canonical selector source, never a body copy."""
import ast
import copy
import json
import sys


def one(tree, name, cls):
    matches = [node for node in tree.body if isinstance(node, cls) and
               (getattr(node, 'name', None) == name or
                (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets)))]
    if len(matches) != 1:
        raise ValueError('Canonical token source changed: ' + name)
    return copy.deepcopy(matches[0])


class Replace(ast.NodeTransformer):
    def __init__(self, names):
        self.names = names

    def visit_Name(self, node):
        return copy.deepcopy(self.names.get(node.id, node))


def project(request):
    ref = json.loads(request['raw'])
    if (type(ref) is not dict or type(ref.get('token')) is not str or not ref['token']
            or ref.get('path') is not None or not set(ref) <= {'token', 'kind', 'name', 'path'}):
        raise ValueError('Not an unscoped token reference')
    source, core = ast.parse(request['source']), ast.parse(request['core'])
    fn = one(source, '_camera_alias_token', ast.FunctionDef)
    unique = one(core, '_cad_unique', ast.FunctionDef)
    kind_fn = one(core, '_cad_kind', ast.FunctionDef)
    type_fn = one(core, '_cad_type', ast.FunctionDef)
    kinds = ast.literal_eval(one(core, '_CAD_KINDS', ast.Assign).value)
    # Refuse changed call semantics instead of silently projecting a new source.
    expected = (
        "data = _cad_cast('JsonObject', json.loads(raw))",
        "candidates = list(ctx.design.findEntityByToken(_cad_cast('str', data['token'])))",
        "kind = data.get('kind')",
        "if kind:\n candidates = [entity for entity in candidates if _cad_kind(entity) == kind]",
        "return _cad_unique(candidates, 'Entity token')",
    )
    if (fn.decorator_list or unique.decorator_list or type_fn.decorator_list or
            len(kind_fn.body) != 2 or
            ast.dump(kind_fn.body[0], include_attributes=False) !=
            ast.dump(ast.parse("name = _cad_type(entity)").body[0], include_attributes=False) or
            len(fn.body) != len(expected) or
            any(ast.dump(a, include_attributes=False) != ast.dump(ast.parse(b).body[0], include_attributes=False)
                for a, b in zip(fn.body, expected)) or
            ast.dump(kind_fn.body[1], include_attributes=False) !=
            ast.dump(ast.parse("return _CAD_KINDS.get(name, 'feature' if name.endswith('Feature') else name)").body[0], include_attributes=False)):
        raise ValueError('Canonical token algorithm changed')
    kind = ref.get('kind')
    receiver = ast.Name(id='design', ctx=ast.Load())
    candidates = copy.deepcopy(fn.body[1])
    call = candidates.value.args[0]
    call.func.value = receiver
    call.args = [ast.Constant(ref['token'])]
    body = [candidates]
    if kind:
        entity = ast.Name(id='entity', ctx=ast.Load())
        if len(type_fn.body) != 1 or not isinstance(type_fn.body[0], ast.Return):
            raise ValueError('Canonical entity type source changed')
        type_expr = Replace({'entity': entity}).visit(type_fn.body[0].value)
        accepted = [key for key, value in kinds.items() if value == kind]
        if isinstance(kind, str) and kind not in kinds and not kind.endswith('Feature'):
            accepted.append(kind)
        test = ast.Compare(left=type_expr, ops=[ast.In()], comparators=[ast.Tuple(elts=[ast.Constant(v) for v in accepted], ctx=ast.Load())])
        if kind == 'feature':
            # The canonical fallback recognizes every *Feature, except overrides.
            name = ast.Name(id='_camera_kind', ctx=ast.Load())
            test.left = ast.NamedExpr(target=ast.Name(id='_camera_kind', ctx=ast.Store()), value=type_expr)
            feature = ast.Call(func=ast.Attribute(value=name, attr='endswith', ctx=ast.Load()), args=[ast.Constant('Feature')], keywords=[])
            blocked = [key for key, value in kinds.items() if key.endswith('Feature') and value != kind]
            if blocked:
                feature = ast.BoolOp(op=ast.And(), values=[feature, ast.Compare(left=name, ops=[ast.NotIn()], comparators=[ast.Tuple(elts=[ast.Constant(v) for v in blocked], ctx=ast.Load())])])
            test = ast.BoolOp(op=ast.Or(), values=[test, feature])
        if not accepted and kind != 'feature':
            # Even an impossible requested kind must retain canonical property
            # reads and their SDK failures, not silently return an early error.
            body.append(ast.For(target=ast.Name(id='entity', ctx=ast.Store()), iter=ast.Name(id='candidates', ctx=ast.Load()),
                                body=[ast.Assign(targets=[ast.Name(id='_', ctx=ast.Store())], value=type_expr)],
                                orelse=[]))
            body.append(ast.AnnAssign(target=ast.Name(id='candidates', ctx=ast.Store()),
                                      annotation=ast.parse('list[adsk.core.Base]', mode='eval').body,
                                      value=ast.List(elts=[], ctx=ast.Load()), simple=1))
        else:
            filtered = copy.deepcopy(fn.body[3].body[0])
            filtered.value.generators[0].ifs = [test]
            body.append(filtered)
    # Inline the canonical uniqueness operation with its constant call arguments.
    replace = Replace({
        'entities': ast.Name(id='candidates', ctx=ast.Load()),
        'label': ast.Constant('Entity token'),
        '_CadItem': ast.Attribute(value=ast.Attribute(value=ast.Name(id='adsk', ctx=ast.Load()), attr='core', ctx=ast.Load()), attr='Base', ctx=ast.Load()),
    })
    body.extend(replace.visit(node) for node in unique.body)
    fn.name = request['symbol']
    fn.args.args = [ast.arg(arg='design', annotation=ast.Constant('adsk.fusion.Design'))]
    fn.body = body
    module = ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[]))
    compile(module, '<camera-token-projection>', 'exec')
    return {'source': ast.unparse(module) + '\n',
            'alwaysEligibleAliasTarget': type(kind) is str and kind in ('component', 'occurrence', 'parameter')}


if __name__ == '__main__':
    json.dump(project(json.load(sys.stdin)), sys.stdout, allow_nan=False)
