"""AST-only source inventory. Invoked with -I -S; never imports input modules."""
import ast
import json
import sys
import io
import tokenize
import re
import hashlib
import pathlib


def literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'loads' and len(node.args) == 1
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Name)
            and node.func.value.func.id == '__import__'
            and len(node.func.value.args) == 1
            and isinstance(node.func.value.args[0], ast.Constant)
            and node.func.value.args[0].value == 'json'):
        text = literal(node.args[0])
        value = json.loads(text) if text is not None else None
        return value if isinstance(value, str) else None
    return None


def inspect(unit, declared_units):
    source = unit['source']
    original_source = source
    unit = dict(unit, sha256=hashlib.sha256(source.encode('utf-8')).hexdigest())
    # Suppression directives cannot downgrade the submitted source. Blanking
    # comments preserves every position and all executable bytes/AST semantics.
    lines = source.splitlines(keepends=True)
    directives = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT and re.search(r'(?:based)?pyright\s*:|type\s*:\s*ignore', token.string, re.I):
                row, column = token.start
                directives.append(row)
                lines[row - 1] = lines[row - 1][:column] + ' ' * len(token.string) + lines[row - 1][column + len(token.string):]
    except (tokenize.TokenError, IndentationError):
        pass
    source = ''.join(lines)
    unit = dict(unit, source=source, directives=directives)
    try:
        tree = ast.parse(source, filename=unit['filename'])
    except SyntaxError:
        # The real typechecker owns syntax diagnostics and positions.
        return dict(unit, originalSource=original_source, insert=0, embedded=[], gaps=[], early=[], top_calls=[], has_run=False, run_line=1)
    insert = 0
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            insert = node.end_lineno
        elif isinstance(node, ast.ImportFrom) and node.module == '__future__':
            insert = node.end_lineno
        else:
            break
    embedded, gaps, replacements = [], [], []
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in ('exec', 'compile', 'eval'):
            parent = parents.get(node)
            if not isinstance(parent, ast.Call) or parent.func is not node:
                gaps.append(node.lineno)
        if ((isinstance(node, ast.Name) and node.id == 'no_type_check')
                or (isinstance(node, ast.Attribute) and node.attr in ('no_type_check', 'no_type_check_decorator'))
                or (isinstance(node, ast.alias) and node.name in ('no_type_check', 'no_type_check_decorator'))):
            gaps.append(node.lineno)
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        name = node.func.id
        if name not in ('exec', 'compile', 'eval'):
            continue
        if name == 'exec' and node.args and isinstance(node.args[0], ast.Call) and isinstance(node.args[0].func, ast.Name) and node.args[0].func.id == 'compile':
            continue  # compile is visited independently
        code = literal(node.args[0]) if node.args else None
        filename = literal(node.args[1]) if name == 'compile' and len(node.args) > 1 else None
        if code is None:
            gaps.append(node.lineno)
        else:
            embedded.append({'filename': filename or unit['filename'] + ':literal:' + str(node.lineno), 'source': code})
            parent = parents.get(node)
            declared = declared_units.get(filename)
            expression = node.args[0] if node.args else None
            if (unit.get('id') == 'wire' and filename is not None and
                    declared is not None and declared['source'] == code and
                    isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name) and
                    parent.func.id == 'exec' and parent.args and parent.args[0] is node and
                    len(node.args) > 2 and literal(node.args[2]) == 'exec' and
                    isinstance(expression, ast.Constant) and isinstance(expression.value, str) and
                    expression.lineno == expression.end_lineno and
                    expression.end_col_offset - expression.col_offset > 2):
                lines_for_offsets = source.splitlines(keepends=True)
                line_start = sum(len(line.encode('utf-8')) for line in lines_for_offsets[:expression.lineno - 1])
                start = line_start + expression.col_offset
                end = line_start + expression.end_col_offset
                replacements.append({
                    'start': start,
                    'end': end,
                    'line': expression.lineno,
                    'startColumn': expression.col_offset,
                    'expressionBytes': source.encode('utf-8')[start:end],
                    'filename': filename,
                    'seedId': declared['id'],
                    'sourceHash': hashlib.sha256(code.encode('utf-8')).hexdigest(),
                })
    early = []
    top_calls = []

    class Early(ast.NodeVisitor):
        def visit_Call(self, node):
            top_calls.append(node.lineno)
            self.generic_visit(node)

        def visit_Name(self, node):
            if node.id == 'FMCAD' and isinstance(node.ctx, ast.Load):
                early.append({'line': node.lineno, 'column': node.col_offset + 1})

        def visit_FunctionDef(self, node):
            # Function bodies run after initialization, but defaults/decorators do not.
            for value in node.decorator_list + node.args.defaults + [v for v in node.args.kw_defaults if v is not None]:
                self.visit(value)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Lambda(self, node):
            for value in node.args.defaults:
                self.visit(value)

    Early().visit(tree)
    class RunBinding(ast.NodeVisitor):
        present = False
        line = 1

        def bind(self, node):
            self.present = True
            self.line = node.lineno

        def visit_Name(self, node):
            if node.id == 'run' and isinstance(node.ctx, ast.Store):
                self.bind(node)

        def visit_FunctionDef(self, node):
            if node.name == 'run':
                self.bind(node)
            for value in node.decorator_list + node.args.defaults + [v for v in node.args.kw_defaults if v is not None]:
                self.visit(value)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            if node.name == 'run':
                self.bind(node)
            for value in node.decorator_list + node.bases + [keyword.value for keyword in node.keywords]:
                self.visit(value)

        def visit_Lambda(self, node):
            for value in node.args.defaults + [v for v in node.args.kw_defaults if v is not None]:
                self.visit(value)

        def visit_ListComp(self, node):
            self.visit(node.elt)
            for generator in node.generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)

        visit_SetComp = visit_ListComp
        visit_GeneratorExp = visit_ListComp

        def visit_DictComp(self, node):
            self.visit(node.key)
            self.visit(node.value)
            for generator in node.generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)

        def visit_Import(self, node):
            if any((alias.asname or alias.name.split('.')[0]) == 'run' for alias in node.names):
                self.bind(node)

        visit_ImportFrom = visit_Import

    binding = RunBinding()
    binding.visit(tree)
    unit = dict(unit, originalSource=original_source, insert=insert, embedded=embedded, gaps=gaps, early=early,
                top_calls=top_calls, has_run=binding.present, run_line=binding.line)
    if replacements:
        source_bytes = source.encode('utf-8')
        analysis_bytes = source_bytes
        for replacement in sorted(replacements, key=lambda item: item['start'], reverse=True):
            analysis_bytes = (analysis_bytes[:replacement['start']] + b"''" +
                              analysis_bytes[replacement['end']:])
        adjustments, refs = [], []
        removed_utf16 = {}
        for replacement in sorted(replacements, key=lambda item: item['start']):
            row = replacement['line']
            prefix = source_bytes[:replacement['start']].split(b'\n')[-1].decode('utf-8')
            prefix_utf16 = len(prefix.encode('utf-16-le')) // 2
            expression_utf16 = len(replacement['expressionBytes'].decode('utf-8').encode('utf-16-le')) // 2
            delta = expression_utf16 - 2
            after_column = prefix_utf16 - removed_utf16.get(row, 0) + 3
            adjustments.append({'line': row, 'afterColumn': after_column, 'delta': delta})
            refs.append({
                'filename': replacement['filename'],
                'unitId': replacement['seedId'],
                'sourceHash': replacement['sourceHash'],
            })
            removed_utf16[row] = removed_utf16.get(row, 0) + delta
        unit['analysisSource'] = analysis_bytes.decode('utf-8')
        unit['analysisColumnAdjustments'] = adjustments
        unit['sanitizedLiterals'] = refs
    return unit


def function_policy(node, parents):
    # A one-line suite may follow a multi-line signature on the same line as
    # the return annotation (for example a Protocol method ending in `...`).
    # Replacing from that line would erase the closing signature and colon.
    header_end = getattr(node.returns, 'end_lineno', node.lineno)
    if not node.body or node.body[0].lineno <= header_end:
        return 'preserved'
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Call):
            name = decorator.func.id if isinstance(decorator.func, ast.Name) else ''
        else:
            name = decorator.id if isinstance(decorator, ast.Name) else ''
        if 'overload' in name.lower():
            return 'preserved'
    if node.name == '__init__':
        return 'preserved'
    arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    if node.args.vararg:
        arguments.append(node.args.vararg)
    if node.args.kwarg:
        arguments.append(node.args.kwarg)
    if node.returns is None or any(
            argument.annotation is None and argument.arg not in ('self', 'cls')
            for argument in arguments):
        return 'preserved'
    for child in ast.walk(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child is not node:
            child_arguments = [*child.args.posonlyargs, *child.args.args, *child.args.kwonlyargs]
            if child.args.vararg:
                child_arguments.append(child.args.vararg)
            if child.args.kwarg:
                child_arguments.append(child.args.kwarg)
            if child.returns is None or any(
                    argument.annotation is None and argument.arg not in ('self', 'cls')
                    for argument in child_arguments):
                return 'preserved'
        if isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name) and \
                child.value.id in ('self', 'cls') and isinstance(child.ctx, (ast.Store, ast.Del)):
            return 'preserved'
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and \
                child.func.id in ('globals', 'setattr'):
            return 'preserved'
    return 'projectable'


def root_functions(tree):
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    functions = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        parent = parents.get(node)
        nested = False
        while parent is not None:
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                nested = True
                break
            parent = parents.get(parent)
        if not nested:
            functions.append(node)
    return parents, functions


def source_unit_profile(unit):
    source = unit['source']
    tree = ast.parse(source, filename=unit['filename'])
    parents, functions = root_functions(tree)
    lines = source.splitlines(keepends=True)
    body_records = []
    for node in functions:
        policy = function_policy(node, parents)
        if unit['role'] != 'runtime':
            policy = 'preserved'
        start = node.body[0].lineno - 1 if node.body else node.lineno - 1
        end = node.end_lineno or node.lineno
        body = ''.join(lines[start:end])
        body_id = '%s:%s:%s:%s' % (unit['id'], node.lineno, node.col_offset, node.name)
        body_nodes = list(ast.walk(node))
        class_references = set()
        strings = [child.value for child in ast.walk(node)
                   if isinstance(child, ast.Constant) and isinstance(child.value, str)]
        names = [child.id for child in ast.walk(node)
                 if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)]
        body_records.append({
            'id': body_id,
            'unitId': unit['id'],
            'name': node.name,
            'line': node.lineno,
            'column': node.col_offset + 1,
            'bodyStartLine': node.body[0].lineno if node.body else node.lineno,
            'bodyEndLine': end,
            'bodyHash': hashlib.sha256(body.encode('utf-8')).hexdigest(),
            'policy': policy,
            'weight': sum(1 for _ in body_nodes) if policy == 'projectable' else 0,
            'names': names,
            'strings': strings,
        })
    class_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            class_names.append({
                'name': node.name,
                'line': node.lineno,
                'column': node.col_offset + 7,
            })
    return {'id': unit['id'], 'role': unit['role'], 'filename': unit['filename'],
            'sha256': unit.get('sha256') or hashlib.sha256(source.encode('utf-8')).hexdigest(),
            'bodyRecords': body_records, 'classNames': class_names}


def analysis_plan(source_units, projection_unit_ids=None, max_group_weight=75000, max_groups=16):
    if not isinstance(source_units, list) or len(source_units) > 256:
        raise ValueError('Invalid source-unit set for aggregate type analysis')
    profiles = [source_unit_profile(unit) for unit in source_units]
    ids = [profile['id'] for profile in profiles]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate source-unit id in aggregate type plan')
    projectable_units = set(projection_unit_ids) if projection_unit_ids is not None else {
        profile['id'] for profile in profiles if profile['role'] == 'runtime'}
    if not projectable_units.issubset(set(ids)) or any(
            next(profile for profile in profiles if profile['id'] == unit_id)['role'] != 'runtime'
            for unit_id in projectable_units):
        raise ValueError('Aggregate projection unit scope is invalid')
    for profile in profiles:
        if profile['id'] not in projectable_units:
            for record in profile['bodyRecords']:
                if record['policy'] == 'projectable':
                    record['policy'] = 'preserved'
                    record['weight'] = 0
    class_owner = {}
    for profile in profiles:
        for declaration in profile['classNames']:
            class_owner[declaration['name']] = {
                'unitId': profile['id'],
                'line': declaration['line'],
                'column': declaration['column'],
            }

    class_users = {}
    class_patterns = {name: re.compile(r'\b' + re.escape(name) + r'\b') for name in class_owner}
    body_class_references = {}
    weights = {profile['id']: 0 for profile in profiles if profile['role'] == 'runtime'}
    body_inventory = []
    for profile in profiles:
        for record in profile['bodyRecords']:
            if record['policy'] == 'projectable' and profile['id'] in projectable_units:
                weights[profile['id']] += record['weight']
            body_inventory.append({key: record[key] for key in (
                'id', 'unitId', 'name', 'line', 'column', 'bodyStartLine', 'bodyEndLine',
                'bodyHash', 'policy', 'weight')})
            if record['policy'] != 'projectable' or profile['id'] not in projectable_units:
                continue
            references = set(record['names']).intersection(class_owner)
            # A class identifier cannot span a newline. Joining literal strings
            # preserves their word boundaries while avoiding a regex compilation
            # and search for every (class, body, string) triple.
            literals = '\n'.join(record['strings'])
            if literals:
                references.update(name for name, pattern in class_patterns.items()
                                  if name not in references and pattern.search(literals))
            body_class_references[record['id']] = references
            for name in references:
                class_users.setdefault((class_owner[name]['unitId'], name), set()).add(profile['id'])

    # Bind a complete use body to each class. The checker aggregates unused-class
    # diagnostics only after that body is analyzed in its assigned full group.
    body_by_id = {record['id']: record for profile in profiles for record in profile['bodyRecords']}
    witnesses = {}
    for key, consumers in class_users.items():
        owner, name = key
        candidates = [body_by_id[record['id']]
                      for consumer in consumers
                      for record in next(profile for profile in profiles if profile['id'] == consumer)['bodyRecords']
                      if record['policy'] == 'projectable' and
                      name in body_class_references[record['id']]]
        if candidates:
            witness = min(candidates, key=lambda item: (item['weight'], item['unitId'], item['id']))
            witnesses[name] = witness['id']
    runtime_ids = sorted(projectable_units)
    parent = {unit_id: unit_id for unit_id in runtime_ids}

    def find(unit_id):
        if parent[unit_id] != unit_id:
            parent[unit_id] = find(parent[unit_id])
        return parent[unit_id]

    def union(left, right):
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for (owner, _name), consumers in class_users.items():
        if owner in parent:
            witness_id = witnesses.get(_name)
            if witness_id is not None:
                consumer = body_by_id[witness_id]['unitId']
                if consumer in parent:
                    union(owner, consumer)

    components = {}
    for unit_id in runtime_ids:
        components.setdefault(find(unit_id), []).append(unit_id)
    weighted = [(sum(weights[unit_id] for unit_id in members), members)
                for members in components.values()]
    bins = []
    for weight, members in sorted(weighted, key=lambda item: (-item[0], item[1])):
        target = next((index for index, (total, _ids) in enumerate(bins)
                       if total + weight <= max_group_weight), None)
        if target is None:
            if len(bins) >= max_groups:
                raise ValueError('Aggregate analysis requires more passes than the fixed checker budget')
            bins.append((0, []))
            target = len(bins) - 1
        total, current = bins[target]
        bins[target] = (total + weight, current + members)
    groups = [sorted(members) for _weight, members in bins]
    projected_ids = set(unit_id for group in groups for unit_id in group)
    if projected_ids != set(runtime_ids) or any(not group for group in groups):
        raise ValueError('Aggregate analysis groups omit or duplicate runtime units')
    plan = {
        'version': 1,
        'unitHashes': [{'id': profile['id'], 'filename': profile['filename'],
                        'role': profile['role'], 'sha256': profile['sha256']} for profile in profiles],
        'groups': groups,
        'bodyInventory': [{key: record[key] for key in (
            'id', 'unitId', 'name', 'line', 'column', 'bodyStartLine', 'bodyEndLine',
            'bodyHash', 'policy', 'weight')}
                          for profile in profiles for record in profile['bodyRecords']],
        'classUseWitnesses': witnesses,
        'classUseOwners': class_owner,
    }
    plan['sha256'] = hashlib.sha256(json.dumps(
        plan, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    return plan


def analysis_plan_from_concatenated(source, source_map, unit_metadata, extra_units=(), projection_unit_ids=None):
    metadata = {unit['id']: unit for unit in unit_metadata}
    lines = source.split('\n')
    source_units = []
    seen = set()
    next_generated_line = 1
    last_generated_line = 0
    for entry in source_map:
        unit_id = entry.get('unitId')
        record = metadata.get(unit_id)
        if not record or unit_id in seen:
            raise ValueError('Source map has an unknown or duplicate original unit')
        start, end = entry.get('generatedStartLine'), entry.get('generatedEndLine')
        source_start = entry.get('sourceStartLine')
        if (not isinstance(start, int) or not isinstance(end, int) or
                not isinstance(source_start, int) or start < 1 or end < start or
                end > len(lines) or source_start != 1 or start != next_generated_line):
            raise ValueError('Source map has an invalid line interval')
        text = '\n'.join(lines[start - 1:end])
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        if digest != record.get('sha256'):
            raise ValueError('Original source segment hash differs from its declared unit')
        source_units.append({
            'id': unit_id, 'filename': record['filename'], 'role': record['role'],
            'sha256': digest, 'source': text,
        })
        seen.add(unit_id)
        last_generated_line = end
        next_generated_line = end + 2
    if not source_map or last_generated_line != len(lines):
        raise ValueError('Source map does not cover the complete concatenated source')
    mapped_order = [entry['unitId'] for entry in source_map]
    declared_order = [unit['id'] for unit in unit_metadata if unit['id'] in seen]
    if mapped_order != declared_order:
        raise ValueError('Source map changes the declared source-unit order')
    for unit in extra_units:
        if unit['id'] in seen:
            raise ValueError('Duplicate extra source unit in aggregate plan')
        source = unit['source']
        digest = hashlib.sha256(source.encode('utf-8')).hexdigest()
        if digest != unit['sha256']:
            raise ValueError('Embedded source unit hash differs from its origin manifest')
        source_units.append({
            'id': unit['id'], 'filename': unit['filename'], 'role': unit['role'],
            'sha256': digest, 'source': source,
        })
        seen.add(unit['id'])
    return analysis_plan(source_units, projection_unit_ids)


def project_source(source, source_map, roles, selected_unit_ids):
    tree = ast.parse(source)
    parents, functions = root_functions(tree)
    lines = source.splitlines(keepends=True)
    selected = set(selected_unit_ids)
    projected = []
    for node in functions:
        if function_policy(node, parents) != 'projectable' or not node.body:
            continue
        source_entry = next((entry for entry in source_map
                             if entry['generatedStartLine'] <= node.lineno <= entry['generatedEndLine']), None)
        if source_entry is None:
            continue
        unit_id = source_entry['unitId']
        if roles.get(unit_id) != 'runtime' or unit_id in selected:
            continue
        local_line = node.lineno - source_entry['generatedStartLine'] + source_entry['sourceStartLine']
        body_id = '%s:%s:%s:%s' % (unit_id, local_line, node.col_offset, node.name)
        end_line = node.end_lineno or node.lineno
        if end_line > source_entry['generatedEndLine']:
            raise ValueError('Function body crosses a declared source-unit boundary')
        start = node.body[0].lineno - 1
        original = lines[start:end_line]
        if not original:
            continue
        indent = original[0][:len(original[0]) - len(original[0].lstrip(' \t'))]
        ending = '\r\n' if original[0].endswith('\r\n') else ('\n' if original[0].endswith('\n') else '')
        replacement = [indent + 'raise NotImplementedError' + ending]
        replacement.extend(('\r\n' if line.endswith('\r\n') else ('\n' if line.endswith('\n') else ''))
                           for line in original[1:])
        lines[start:end_line] = replacement
        local_start = start + 1 - source_entry['generatedStartLine'] + source_entry['sourceStartLine']
        local_end = end_line - source_entry['generatedStartLine'] + source_entry['sourceStartLine']
        body_text = ''.join(original)
        projected.append({
            'id': body_id,
            'unitId': unit_id,
            'startLine': local_start,
            'endLine': local_end,
            'sha256': hashlib.sha256(body_text.encode('utf-8')).hexdigest(),
        })
    return ''.join(lines), projected


if __name__ == '__main__':
    request = json.load(sys.stdin)
    if 'analysisSourcePath' in request:
        source_path = pathlib.Path(request['analysisSourcePath'])
        if source_path.resolve().parent != pathlib.Path.cwd().resolve():
            raise ValueError('Analysis source must stay in the checker inventory directory')
        source_bytes = source_path.read_bytes()
        if hashlib.sha256(source_bytes).hexdigest() != request.get('analysisSourceHash'):
            raise ValueError('Analysis source hash changed before planning')
        plan = analysis_plan_from_concatenated(
            source_bytes.decode('utf-8'), request['sourceMap'], request['sourceUnits'],
            request.get('extraUnits', ()), request.get('projectionUnitIds'))
        json.dump({'analysisPlan': plan}, sys.stdout, ensure_ascii=True)
        raise SystemExit(0)
    if 'projectionSourcePath' in request:
        source_path = pathlib.Path(request['projectionSourcePath'])
        output_path = pathlib.Path(request['projectionOutputPath'])
        cwd = pathlib.Path.cwd().resolve()
        if source_path.resolve().parent != cwd or output_path.resolve().parent != cwd:
            raise ValueError('Projection files must stay in the checker inventory directory')
        source_bytes = source_path.read_bytes()
        source = source_bytes.decode('utf-8')
        projected, ranges = project_source(
            source,
            request['sourceMap'],
            request['sourceRoles'],
            request['selectedUnitIds'],
        )
        encoded = projected.encode('utf-8')
        if len(encoded) > 16 * 1024 * 1024:
            raise ValueError('Projected analysis source exceeds 16 MiB')
        with output_path.open('xb') as stream:
            stream.write(encoded)
        json.dump({
            'sourceSha256': hashlib.sha256(source_bytes).hexdigest(),
            'analysisSourceHash': hashlib.sha256(encoded).hexdigest(),
            'projectedBodies': ranges,
        }, sys.stdout)
        raise SystemExit(0)
    result = []
    source_bytes = 0
    pending = request['units']
    declared_units = {unit['filename']: unit for unit in pending if unit.get('id') != 'wire'}
    aggregate_plan = None
    if 'sourceUnits' in request and request.get('skipAnalysisPlan') is not True:
        aggregate_plan = analysis_plan(request['sourceUnits'])
    seen = {u['filename']: u['source'] for u in pending}
    while pending:
        if len(result) >= 256:
            raise ValueError('Literal source inventory exceeds 256 units')
        unit = inspect(pending.pop(0), declared_units)
        for child in unit.pop('embedded'):
            filename, source = child['filename'], child['source']
            if filename in seen:
                if seen[filename] != source:
                    raise ValueError('Conflicting literal filename: ' + filename)
                continue
            seen[filename] = source
            pending.append(dict(child, id='literal:' + str(len(seen)), context={'kind': 'raw'}))
        # Keep process output a bounded inventory, not multiple JSON-escaped
        # copies of the wire and every nested source. Original code is never run.
        original_encoded = unit.pop('source').encode('utf-8')
        untouched = unit.pop('originalSource').encode('utf-8')
        encoded = unit.pop('analysisSource', None)
        encoded = encoded.encode('utf-8') if encoded is not None else original_encoded
        source_bytes += len(original_encoded)
        if source_bytes > 16 * 1024 * 1024:
            raise ValueError('Analyzed source inventory exceeds 16 MiB')
        source_index = len(result)
        with open('source-' + str(source_index) + '.txt', 'xb') as stream:
            stream.write(encoded)
        with open('original-source-' + str(source_index) + '.txt', 'xb') as stream:
            stream.write(untouched)
        unit['analysisSourceHash'] = hashlib.sha256(encoded).hexdigest()
        unit['originalSourceHash'] = hashlib.sha256(untouched).hexdigest()
        unit['originalSourceFile'] = 'original-source-' + str(source_index) + '.txt'
        result.append(unit)
    output = {'pythonVersion': sys.version, 'units': result}
    if aggregate_plan is not None:
        output['analysisPlan'] = aggregate_plan
    json.dump(output, sys.stdout, ensure_ascii=True)
