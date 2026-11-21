"""Preservation evidence, not a Fusion/live or physical geometry acceptance."""
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ('model', 'sketch', 'sketch_plan', 'curve', 'datum', 'surface', 'shapes', 'feature')
BASELINE = ROOT / 'tests/fixtures/python-geometry/baseline.json'
STRUCTURAL_SEAMS = json.loads(
    (BASELINE.parent / 'structural-seams.json').read_text())
SEAM_FUNCTIONS_BY_FILE = {}
SEAM_REGISTRATIONS_BY_FILE = {}
for mapping in STRUCTURAL_SEAMS['mappings']:
    registrations = mapping.get('registrations', {})
    if registrations:
        source = mapping['historicalFile'].removeprefix('runtime/python/fmcad/')
        current = SEAM_REGISTRATIONS_BY_FILE.setdefault(source, {})
        for key, handler in registrations.items():
            if key in current:
                raise AssertionError(f'Duplicate structural seam registration in fixture: {key}')
            current[key] = handler
for source, delegates in STRUCTURAL_SEAMS['delegations'].items():
    SEAM_FUNCTIONS_BY_FILE.setdefault(source, set()).update(delegates)
for source, names in STRUCTURAL_SEAMS['additionalExecutionSeams'].items():
    SEAM_FUNCTIONS_BY_FILE.setdefault(source, set()).update(names)
# The fixture binds six historical statement hashes to current dispatch and
# execution roles; those roles are structurally checked before this comparison.
# These adapter bodies received type-directed boundary/SDK rewrites. Their
# runtime behavior is checked by the fake-SDK suites (`model_test.py` and
# `feature_rework_test.py`) and the captured geometry transcript below; keep
# exact AST preservation for every other migrated statement.
TYPE_DIRECTED_REWRITES = {
    '_geometry_datum_expression', '_datum_path_position',
    '_shapes_expression', '_shapes_count',
    '_model_enum', '_model_assembly_context', '_model_native_object',
    '_model_json_object_or_none', '_model_json_text', '_model_resolve',
    '_model_sketch_entities', '_model_extrude_profile_plane', '_model_path', 'model_path_create',
    'model_sketch_create', 'model_sketch_check', 'model_sketch_edit',
    'model_sketch_constrain', 'model_sketch_dimension', 'model_sketch_project',
    'model_sketch_offset', 'model_sketch_mirror', 'model_sketch_pattern',
    '_model_add_feature', 'model_feature', 'model_sketch_geometry',
    '_feature_record_text', '_feature_record_string_list', '_feature_record_value_list',
    '_feature_json_object', '_feature_json_object_or_none', '_feature_contract',
    '_feature_parameter', '_feature_parameter_value', '_feature_target', '_feature_cast',
    '_feature_extrude_bindings', '_feature_revolve_bindings', '_feature_hole_bindings',
    '_feature_edge_set_parameters', '_feature_fillet_bindings', '_feature_chamfer_bindings',
    '_feature_misc_bindings', '_feature_sweep_bindings', '_feature_bindings',
    '_feature_capability_parameters', '_feature_extent_summary', '_feature_snapshot',
    '_feature_extent_plan', '_feature_target_matches', '_feature_plan_target',
    '_feature_text', '_feature_boolean', '_feature_apply_extent', '_feature_downstream',
    '_feature_operation_pose_snapshot', '_feature_native_path', '_feature_native_collection',
    '_feature_validate_hole_position', '_feature_native_enum', '_feature_native_plan',
    '_feature_entity_refs', '_feature_object_sequence', '_feature_plan_text',
    '_feature_object_records', '_feature_object_record', '_feature_object_record_or_none',
    '_feature_entity_values', '_feature_entity_value', '_feature_body_values',
    '_feature_face_values', '_feature_object_items', '_feature_sdk_object',
    '_feature_cad_entity', '_feature_native_value',
    '_feature_hole_position_snapshot', '_feature_native_read', '_feature_native_apply',
    '_feature_native_edit', '_feature_edit', '_feature_json_array', '_feature_json_text',
    '_feature_snapshot_capability_parameters',
    '_feature_supported_capabilities',
}


def _is_mapped_registry_update(node, relative):
    if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.value.id == 'CAD_HANDLERS'
            and node.value.func.attr == 'update'
            and len(node.value.args) == 1 and isinstance(node.value.args[0], ast.Dict)):
        return False
    keys = node.value.args[0].keys
    mapped_keys = SEAM_REGISTRATIONS_BY_FILE.get(relative, {})
    return bool(keys) and all(isinstance(key, ast.Constant) and isinstance(key.value, str)
                              and key.value in mapped_keys for key in keys)


def statement_hashes(source, relative=None):
    class TypeAnnotations(ast.NodeTransformer):
        def __init__(self):
            self.function_stack = []

        def visit_FunctionDef(self, node):
            if relative is not None and node.name in SEAM_FUNCTIONS_BY_FILE.get(relative, set()):
                return None
            # These helpers add precise typing around existing nullable SDK calls;
            # the dedicated fake-SDK transcript still checks their runtime effects.
            if node.name in ('_curve_profile_file', '_curve_offset_constraint', '_curve_offset_dimension'):
                return None
            if node.name in TYPE_DIRECTED_REWRITES:
                return None
            if node.name in ('_model_json_object', '_model_json_array'):
                return None
            if (node.name == '_model_entities' and len(node.body) == 1
                    and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and node.body[0].value.value is Ellipsis):
                return None
            if node.name == '_model_entities':
                return ast.parse("""def _model_entities(ctx, refs, sketch=None, kind=None):
    if not isinstance(refs, list) or not refs:
        raise ValueError('entities must be a nonempty array of references')
    entities = [_model_resolve(ctx, ref, kind) for ref in refs]
    if sketch is not None:
        for entity in entities:
            if entity.parentSketch != sketch:
                raise ValueError('All entities must belong to the selected sketch')
    return entities
""").body[0]
            if node.name == 'model_sketch_geometry':
                return None
            if node.name == '_datum_vector':
                return ast.parse("""def _datum_vector(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
            type(v) not in (int, float) or not math.isfinite(v) for v in value):
        raise ValueError('Vector requires three finite unitless numbers')
    return list(value)
""").body[0]
            node.returns = None
            node.decorator_list = [decorator for decorator in node.decorator_list
                                   if not (isinstance(decorator, ast.Name)
                                           and decorator.id == '_geometry_model_overload')]
            for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                arg.annotation = None
            if node.args.vararg is not None:
                node.args.vararg.annotation = None
            if node.args.kwarg is not None:
                node.args.kwarg.annotation = None
            self.function_stack.append(node.name)
            result = self.generic_visit(node)
            self.function_stack.pop()
            return result

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            if (node.name in ('_GeometryModelNamed', '_GeometryModelConstruction')
                    or node.name.startswith(('_GeometryModel', '_Feature'))
                    or node.name in ('_OffsetConstraintFactory', '_SketchExisting', '_SketchPending')):
                return None
            return self.generic_visit(node)

        def visit_Call(self, node):
            node = self.generic_visit(node)
            # typing.cast is an identity at runtime; erase only these narrow casts.
            if (isinstance(node.func, ast.Name) and node.func.id in
                    ('_geometry_datum_cast', '_geometry_datum_adapter_cast',
                     '_geometry_surface_cast', '_geometry_model_cast',
                     '_geometry_model_fields_cast', '_geometry_feature_cast',
                     '_geometry_feature_adapter_cast', '_geometry_shapes_cast',
                     '_geometry_curve_cast', '_geometry_sketch_cast', '_geometry_sketch_plan_cast')
                    and len(node.args) == 2):
                return node.args[1]
            if isinstance(node.func, ast.Name) and node.func.id == '_curve_offset_constraint':
                return ast.Call(func=ast.Attribute(
                    value=ast.Attribute(
                        value=ast.Attribute(value=ast.Name(id='adsk', ctx=ast.Load()),
                                            attr='fusion', ctx=ast.Load()),
                        attr='OffsetConstraint', ctx=ast.Load()),
                    attr='cast', ctx=ast.Load()), args=node.args, keywords=[])
            if isinstance(node.func, ast.Name) and node.func.id == '_curve_offset_dimension':
                return ast.Attribute(value=node.args[0], attr='dimension', ctx=ast.Load())
            if (self.function_stack[-1:] == ['_curve_evidence']
                    and isinstance(node.func, ast.Name) and node.func.id == 'getattr' and len(node.args) == 2
                    and isinstance(node.args[1], ast.Constant) and node.args[1].value == 'geometry'):
                return ast.Attribute(value=node.args[0], attr='geometry', ctx=ast.Load())
            if (self.function_stack[-1:] in (['_sketch_ellipse_points'], ['_sketch_component_expressions'])
                    and isinstance(node.func, ast.Name) and node.func.id == '_model_ok' and len(node.args) == 2
                    and isinstance(node.args[1], ast.Constant) and node.args[1].value == 'Point3D.create'):
                return node.args[0]
            return node

        def visit_Dict(self, node):
            node = self.generic_visit(node)
            for index, (key, value) in enumerate(zip(node.keys, node.values)):
                if (isinstance(key, ast.Constant) and key.value == 'sketch.profile-file'
                        and isinstance(value, ast.Name) and value.id == '_curve_profile_file'):
                    node.values[index] = ast.Lambda(
                        args=ast.arguments(posonlyargs=[], args=[ast.arg(arg='ctx'), ast.arg(arg='data')],
                                           vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
                        body=ast.Call(func=ast.Name(id='curve_fit', ctx=ast.Load()),
                                      args=[ast.Name(id='ctx', ctx=ast.Load()), ast.Name(id='data', ctx=ast.Load()),
                                            ast.Constant(value='sketch.profile-file')], keywords=[]))
            return node

        def visit_Attribute(self, node):
            node = self.generic_visit(node)
            module_aliases = {
                '_geometry_model_core': 'core',
                '_geometry_model_fusion': 'fusion',
                '_geometry_feature_core': 'core',
                '_geometry_feature_fusion': 'fusion',
            }
            if isinstance(node.value, ast.Name) and node.value.id in module_aliases:
                node.value = ast.Attribute(value=ast.Name(id='adsk', ctx=ast.Load()),
                                           attr=module_aliases[node.value.id], ctx=ast.Load())
            aliases = {
                '_geometry_curve_math': 'math',
                '_geometry_curve_time': 'time',
                '_geometry_datum_math': 'math',
                '_geometry_surface_math': 'math',
                '_geometry_sketch_plan_hashlib': 'hashlib',
                '_geometry_surface_re': 're',
                '_geometry_surface_time': 'time',
                '_geometry_surface_core': 'adsk.core',
                '_geometry_surface_fusion': 'adsk.fusion',
            }
            if isinstance(node.value, ast.Name) and node.value.id in aliases:
                node.value.id = aliases[node.value.id]
            if (self.function_stack[-1:] == ['_shapes_count'] and isinstance(node.value, ast.Name)
                    and node.value.id == 'ctx' and node.attr == 'expression'):
                node.attr = '_expression'
            return node

        def visit_Name(self, node):
            aliases = {
                '_geometry_feature_json': 'json',
                '_geometry_feature_re': 're',
            }
            if node.id in aliases:
                node.id = aliases[node.id]
            modules = {
                '_geometry_model_core': 'core',
                '_geometry_model_fusion': 'fusion',
                '_geometry_feature_core': 'core',
                '_geometry_feature_fusion': 'fusion',
            }
            if node.id in modules:
                return ast.Attribute(value=ast.Name(id='adsk', ctx=ast.Load()),
                                     attr=modules[node.id], ctx=ast.Load())
            if self.function_stack[-1:] == ['_model_entities']:
                if node.id == 'references':
                    node.id = 'refs'
                elif node.id == 'sketch_entity':
                    node.id = 'entity'
            elif self.function_stack[-1:] == ['_model_fields'] and node.id == 'fields':
                node.id = 'data'
            elif self.function_stack[-2:] == ['_feature_dispatch', 'handler'] and node.id == 'payload':
                node.id = 'data'
            return node

        def visit_Assign(self, node):
            target = node.targets[0] if len(node.targets) == 1 else None
            if (isinstance(target, ast.Name) and target.id == 'time'
                    and isinstance(node.value, ast.Name) and node.value.id == '_geometry_sketch_plan_time'):
                return None
            if (isinstance(target, ast.Name) and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and node.value.func.id in ('_geometry_curve_cast', '_geometry_sketch_cast',
                                               '_geometry_sketch_plan_cast')
                    and len(node.value.args) == 2 and isinstance(node.value.args[1], ast.Name)
                    and target.id == node.value.args[1].id):
                return None
            if (self.function_stack[-1:] == ['_model_entities'] and isinstance(target, ast.Name)
                    and target.id == 'references'):
                return None
            if (self.function_stack[-1:] == ['_model_entities'] and isinstance(target, ast.Name)
                    and target.id == 'sketch_entity'):
                return None
            if (self.function_stack[-1:] == ['_model_path'] and isinstance(target, ast.Name)
                    and target.id == 'data'):
                return None
            if (self.function_stack[-1:] == ['_model_fields'] and isinstance(target, ast.Name)
                    and target.id == 'fields'):
                return None
            if (self.function_stack[-2:] == ['_feature_dispatch', 'handler'] and isinstance(target, ast.Name)
                    and target.id == 'payload'):
                return None
            result = self.generic_visit(node)
            if (self.function_stack and len(result.targets) == 1
                    and isinstance(result.targets[0], ast.Name) and isinstance(result.value, ast.Name)
                    and result.targets[0].id == result.value.id):
                # A no-op cast-to-existing-variable appears as a self-assignment after cast normalization.
                return None
            return result

        def visit_AnnAssign(self, node):
            if node.value is None:
                return None
            if self.function_stack and isinstance(node.target, ast.Name):
                return ast.Assign(targets=[node.target], value=self.visit(node.value))
            return self.generic_visit(node)

        def visit_If(self, node):
            if (isinstance(node.test, ast.Name)
                    and node.test.id in ('_GeometryDatum_TYPE_CHECKING', '_GeometrySurface_TYPE_CHECKING')
                    and not node.orelse
                    and all(isinstance(statement, ast.ClassDef)
                            and statement.name.startswith(('_GeometryDatum', '_GeometrySurface'))
                            for statement in node.body)):
                return None
            if (isinstance(node.test, ast.Name) and node.test.id == '_GeometryFeature_TYPE_CHECKING'
                    and not node.orelse and node.body
                    and all(isinstance(statement, ast.ClassDef)
                            and statement.name.startswith('_Feature') for statement in node.body)):
                return None
            return self.generic_visit(node)

    statements = [normalized for node in ast.parse(source).body
                  if not _is_mapped_registry_update(node, relative)
                  if (normalized := TypeAnnotations().visit(node)) is not None]
    normalized = []
    for node in statements:
        if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == '__setitem__'
                and isinstance(node.value.func.value, ast.Call)
                and isinstance(node.value.func.value.func, ast.Name)
                and node.value.func.value.func.id == 'globals'
                and len(node.value.args) == 2 and isinstance(node.value.args[0], ast.Constant)
                and node.value.args[0].value == '_FMCAD_GEOMETRY_LOADED'):
            node = ast.Assign(targets=[ast.Name(id='_FMCAD_GEOMETRY_LOADED', ctx=ast.Store())], value=node.value.args[1])
        normalized.append(node)
    return [hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest()
            for node in normalized
            if not isinstance(node, (ast.Import, ast.ImportFrom))
            and not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant))
            and not (isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id in
                ('_FMCAD_GEOMETRY_LOADED', '_GeometryModelItem', '_FeatureClassResult')
                for target in node.targets))
            and not (isinstance(node, ast.If) and ast.unparse(node.test) == "hasattr(CAD_HANDLERS, 'owner')")]


class GeometryExtractionTests(unittest.TestCase):
    def _geometry_source(self, relative):
        return ROOT / 'runtime/python/fmcad' / relative

    def _function(self, relative, name, source=None):
        tree = ast.parse(source if source is not None else self._geometry_source(relative).read_text())
        matches = [node for node in tree.body
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        self.assertEqual(len(matches), 1, f'{relative} must define {name} exactly once')
        return matches[0]

    def _function_in_source(self, source, name):
        tree = ast.parse(source)
        matches = [node for node in tree.body
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        self.assertEqual(len(matches), 1, f'{name} must be defined exactly once')
        return matches[0]

    def _assert_registry_mappings(self, overrides=None):
        for relative, expected in SEAM_REGISTRATIONS_BY_FILE.items():
            source = (overrides or {}).get(relative, self._geometry_source(relative).read_text())
            tree = ast.parse(source)
            actual = Counter()
            for node in tree.body:
                if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                        and isinstance(node.value.func, ast.Attribute)
                        and isinstance(node.value.func.value, ast.Name)
                        and node.value.func.value.id == 'CAD_HANDLERS'
                        and node.value.func.attr == 'update' and len(node.value.args) == 1
                        and isinstance(node.value.args[0], ast.Dict)):
                    continue
                for key, value in zip(node.value.args[0].keys, node.value.args[0].values):
                    if isinstance(key, ast.Constant) and key.value in expected:
                        target = value.id if isinstance(value, ast.Name) else ast.unparse(value)
                        actual[(key.value, target)] += 1
            self.assertEqual(actual, Counter((key, target) for key, target in expected.items()), relative)

    def _assert_delegation(self, relative, name, expected, source=None):
        function = self._function(relative, name, source)
        if relative == 'application/geometry_shapes.py' and name in {
                'shape_box', 'shape_cylinder', 'shape_tube', 'shape_ring', 'shape_cone'}:
            reserve = ast.parse("if 'name' in data:\n    _shapes_reserve(ctx, [data['name']])").body[0]
            self.assertEqual(len(function.body), 2, name)
            self.assertEqual(ast.dump(function.body[0]), ast.dump(reserve), name)
        else:
            self.assertEqual(len(function.body), 1, name)
        statement = function.body[-1]
        self.assertIsInstance(statement, ast.Return, name)
        call = statement.value
        self.assertIsInstance(call, ast.Call, name)
        self.assertIsInstance(call.func, ast.Name, name)
        target, *tail = expected
        self.assertEqual(call.func.id, target, name)
        self.assertEqual(call.keywords, [], name)
        actual_args = [(type(arg), getattr(arg, 'id', getattr(arg, 'value', None))) for arg in call.args]
        expected_args = [(ast.Name, 'ctx'), (ast.Name, 'data')]
        expected_args.extend((ast.Constant, value) for value in tail)
        self.assertEqual(actual_args, expected_args, name)

    def _assert_primitive_preflight(self, source):
        name = STRUCTURAL_SEAMS['primitiveDispatch']['inputFunction']
        function = self._function_in_source(source, name)
        tries = [node for node in ast.walk(function) if isinstance(node, ast.Try)]
        self.assertEqual(len(tries), 1, 'Primitive preflight must contain exactly one Try boundary')
        self.assertTrue(function.body and function.body[0] is tries[0],
                        'Primitive input validation must remain inside the preflight Try')
        digest = hashlib.sha256(ast.dump(tries[0], include_attributes=False).encode()).hexdigest()
        self.assertEqual(digest, STRUCTURAL_SEAMS['primitiveDispatch']['inputTrySha256'],
                         'Primitive preflight rejection boundary or witness changed')

    def _assert_primitive_execution_seams(self):
        source = self._geometry_source('adapters/fusion/geometry_shapes.py').read_text()
        primitive = STRUCTURAL_SEAMS['primitiveDispatch']
        self._assert_primitive_preflight(source)
        self._function_in_source(source, '_shapes_primitive_plane')

        dispatch = self._function_in_source(source, primitive['dispatcher'])
        self.assertEqual(len(dispatch.body), 1)
        result = dispatch.body[0]
        self.assertIsInstance(result, ast.Return)
        self.assertIsInstance(result.value, ast.Call)
        self.assertIsInstance(result.value.func, ast.Subscript)
        table = result.value.func.value
        self.assertIsInstance(table, ast.Dict)
        actual_modes = Counter((key.value, value.id) for key, value in zip(table.keys, table.values)
                               if isinstance(key, ast.Constant) and isinstance(value, ast.Name))
        self.assertEqual(actual_modes, Counter(primitive['modes'].items()))

        for name, (mode, sizes) in primitive['primitiveWrappers'].items():
            function = self._function_in_source(source, name)
            self.assertEqual(len(function.body), 1, name)
            returned = function.body[0]
            self.assertIsInstance(returned, ast.Return, name)
            call = returned.value
            self.assertIsInstance(call, ast.Call, name)
            self.assertIsInstance(call.func, ast.Name, name)
            self.assertEqual(call.func.id, '_shapes_extruded_primitive', name)
            self.assertEqual([ast.unparse(arg) for arg in call.args],
                             ['ctx', 'data', repr(mode), repr(tuple(sizes))], name)

        for name in primitive['creationFunctions']:
            function = self._function_in_source(source, name)
            self.assertGreaterEqual(len(function.body), 3, name)
            first = function.body[0]
            self.assertIsInstance(first, ast.Assign, name)
            self.assertIsInstance(first.value, ast.Call, name)
            self.assertIsInstance(first.value.func, ast.Name, name)
            self.assertEqual(first.value.func.id, primitive['inputFunction'], name)
            rejection = function.body[1]
            self.assertIsInstance(rejection, ast.If, name)
            self.assertIsInstance(rejection.test, ast.Compare, name)
            self.assertIsInstance(rejection.test.left, ast.Name, name)
            self.assertEqual(rejection.test.left.id, 'rejection', name)
            self.assertEqual([type(op) for op in rejection.test.ops], [ast.IsNot], name)
            self.assertEqual(len(rejection.body), 1, name)
            self.assertIsInstance(rejection.body[0], ast.Return, name)
            self.assertIsInstance(function.body[2], ast.Assign, name)
            plane_call = function.body[2].value
            self.assertIsInstance(plane_call, ast.Call, name)
            self.assertIsInstance(plane_call.func, ast.Name, name)
            self.assertEqual(plane_call.func.id, '_shapes_primitive_plane', name)

    def _assert_extrusion_execution_seam(self):
        relative = 'adapters/fusion/geometry_model.py'
        wrapper = self._function(relative, 'model_extrude')
        self.assertEqual(len(wrapper.body), 1)
        self.assertIsInstance(wrapper.body[0], ast.Return)
        self.assertIsInstance(wrapper.body[0].value, ast.Call)
        self.assertEqual(ast.unparse(wrapper.body[0].value), '_model_extrude(ctx, data)')

        feature = self._function(relative, 'model_feature')
        expected = ast.parse("if mode == 'extrude':\n    return _model_extrude(ctx, data)").body[0]
        self.assertEqual(ast.dump(feature.body[0]), ast.dump(expected))

        extrude = self._function(relative, '_model_extrude')
        self.assertGreaterEqual(len(extrude.body), 3)
        self.assertIsInstance(extrude.body[0], ast.Expr)
        self.assertEqual(ast.unparse(extrude.body[0].value.func), '_model_fields')
        self.assertIsInstance(extrude.body[1], ast.Assign)
        self.assertEqual(ast.unparse(extrude.body[1].value.func), '_model_extrude_profiles')
        self.assertIsInstance(extrude.body[2], ast.Assign)
        self.assertEqual(ast.unparse(extrude.body[2].value.func), '_model_extent_mode')

    def _assert_feature_dispatch_seams(self):
        for name, target, mode in (('feature_inspect', '_feature_inspect', 'inspect'),
                                   ('feature_edit', '_feature_edit', 'edit')):
            function = self._function('application/geometry_feature.py', name)
            expected_source = (
                "if not isinstance(data, dict):\n"
                "    raise TypeError('Operation data must be an object')\n"
                "payload = _geometry_feature_cast(\"JsonObject\", data)\n"
                f"if 'schemaVersion' in payload or 'frame' in payload:\n"
                f"    return {target}(ctx, payload)\n"
                f"return _assembly_history(ctx, payload, '{mode}')\n")
            expected = ast.parse(expected_source)
            actual = ast.Module(body=function.body, type_ignores=[])
            self.assertEqual(ast.dump(actual), ast.dump(expected), name)

    def _assert_structural_seams(self):
        baseline = json.loads(BASELINE.read_text())
        mapped_by_family = {}
        for mapping in STRUCTURAL_SEAMS['mappings']:
            family, digest = mapping['family'], mapping['historicalDigest']
            self.assertEqual(baseline['statements'][family].count(digest), 1,
                             f"Historical mapping must pin one {family} statement: {digest}")
            mapped_by_family.setdefault(family, []).append(digest)

        self._assert_registry_mappings()
        for relative, delegates in STRUCTURAL_SEAMS['delegations'].items():
            for name, expected in delegates.items():
                self._assert_delegation(relative, name, expected)
        for relative, names in STRUCTURAL_SEAMS['additionalExecutionSeams'].items():
            for name in names:
                self._function(relative, name)
        self._assert_primitive_execution_seams()
        self._assert_extrusion_execution_seam()
        self._assert_feature_dispatch_seams()
        return mapped_by_family

    def _family_statement_hashes(self, family, overrides=None):
        actual = []
        for layer in ('domain', 'adapters/fusion', 'application'):
            relative = f'{layer}/geometry_{family}.py'
            source = (overrides or {}).get(relative, self._geometry_source(relative).read_text())
            actual.extend(statement_hashes(source, relative))
        return actual

    def _assert_statement_multiset(self, expected, actual):
        self.assertEqual(Counter(actual), Counter(expected))

    def test_geometry_datum_cast_imports_are_unique_in_flat_namespace(self):
        modules = ('domain/geometry_datum.py', 'adapters/fusion/geometry_datum.py')
        aliases = []
        for module in modules:
            tree = ast.parse((ROOT / 'runtime/python/fmcad' / module).read_text())
            imports = [alias.asname or alias.name
                       for node in tree.body
                       if isinstance(node, ast.ImportFrom) and node.module == 'typing'
                       for alias in node.names if alias.name == 'cast']
            self.assertEqual(len(imports), 1, module)
            aliases.append(imports[0])
        self.assertEqual(len(set(aliases)), len(aliases),
                         'flattened geometry domain/adapter modules must not rebind the same cast alias')

    def test_every_unmodified_original_statement_is_present_exactly_once(self):
        baseline = json.loads(BASELINE.read_text())
        rewrites = json.loads((BASELINE.parent / 'typed-rewrites.json').read_text())
        adjusted = dict(baseline['statements'])
        mapped = self._assert_structural_seams()
        for family in ('model', 'feature', 'datum', 'shapes'):
            excluded = {digest for values in rewrites[family].values() for digest in values}
            adjusted[family] = [digest for digest in adjusted[family] if digest not in excluded]
        for family, digests in mapped.items():
            remaining = list(adjusted[family])
            for digest in digests:
                self.assertIn(digest, remaining, f'No historical statement to map: {digest}')
                remaining.remove(digest)
            adjusted[family] = remaining
        # This source is intentionally staged to validate nested JSON shapes;
        # fake-SDK output/effect ordering remains covered by model_test.
        adjusted['model'] = [digest for digest in adjusted['model']
                             if digest != 'a80df3ad20aa88a06ab4f8c4906e5ec2fa3b29a7b7450facb91e0449dced026d']
        for family in FAMILIES:
            with self.subTest(family=family):
                actual = self._family_statement_hashes(family)
                self._assert_statement_multiset(adjusted[family], actual)

    def test_statement_preservation_detects_removal_and_duplication(self):
        baseline = json.loads(BASELINE.read_text())
        rewrites = json.loads((BASELINE.parent / 'typed-rewrites.json').read_text())
        mapped = self._assert_structural_seams()
        adjusted = dict(baseline['statements'])
        for family in ('model', 'feature', 'datum', 'shapes'):
            excluded = {digest for values in rewrites[family].values() for digest in values}
            adjusted[family] = [digest for digest in adjusted[family] if digest not in excluded]
        for family, digests in mapped.items():
            for digest in digests:
                adjusted[family].remove(digest)
        adjusted['model'].remove('a80df3ad20aa88a06ab4f8c4906e5ec2fa3b29a7b7450facb91e0449dced026d')

        selected = None
        for family in FAMILIES:
            for layer in ('domain', 'adapters/fusion', 'application'):
                relative = f'{layer}/geometry_{family}.py'
                source = self._geometry_source(relative).read_text()
                for node in ast.parse(source).body:
                    if (not isinstance(node, (ast.FunctionDef, ast.ClassDef)) or node.decorator_list
                            or node.end_lineno is None):
                        continue
                    snippet = ast.get_source_segment(source, node)
                    hashes = statement_hashes(snippet, relative)
                    if len(hashes) == 1 and hashes[0] in adjusted[family]:
                        selected = family, relative, source, node, hashes[0]
                        break
                if selected:
                    break
            if selected:
                break
        self.assertIsNotNone(selected, 'Expected an unchanged source statement for negative controls')
        family, relative, source, node, digest = selected
        lines = source.splitlines(keepends=True)
        start, end = node.lineno - 1, node.end_lineno
        removed = ''.join(lines[:start] + lines[end:])
        duplicated = source + '\n\n' + ast.get_source_segment(source, node) + '\n'
        for label, mutated in (('removed', removed), ('duplicated', duplicated)):
            with self.subTest(mutation=label, digest=digest):
                actual = self._family_statement_hashes(family, {relative: mutated})
                with self.assertRaises(AssertionError):
                    self._assert_statement_multiset(adjusted[family], actual)

    def test_primitive_rejection_normalization_rejects_boundary_or_witness_drift(self):
        source = (ROOT / 'runtime/python/fmcad/adapters/fusion/geometry_shapes.py').read_text()
        moved_tree = ast.parse(source)
        input_function = next(node for node in moved_tree.body
                              if isinstance(node, ast.FunctionDef)
                              and node.name == '_shapes_primitive_inputs')
        plane_function = next(node for node in moved_tree.body
                              if isinstance(node, ast.FunctionDef)
                              and node.name == '_shapes_primitive_plane')
        moved_try = input_function.body.pop(0)
        plane_function.body.insert(0, moved_try)
        moved_try_source = ast.unparse(moved_tree)
        mutations = (
            source.replace("'mutationStatus': 'not_started'", "'mutationStatus': 'unknown'", 1),
            source.replace('    except ValueError as exc:', '    except Exception as exc:', 1),
            source.replace("        _model_fields(data, ('name',) + sizes, ('plane',))",
                           "        ctx.call('model.extrude', {})\n"
                           "        _model_fields(data, ('name',) + sizes, ('plane',))", 1),
            moved_try_source,
        )
        for mutated in mutations:
            self.assertNotEqual(mutated, source)
            with self.assertRaises(AssertionError):
                self._assert_primitive_preflight(mutated)

    def test_structural_dispatch_guards_reject_registration_and_wrapper_drift(self):
        relative = 'application/geometry_model.py'
        source = self._geometry_source(relative).read_text()
        changed_target = source.replace("'model.revolve': model_revolve",
                                        "'model.revolve': model_sweep", 1)
        removed_registration = source.replace("'model.revolve': model_revolve, ", '', 1)
        duplicated_registration = source.replace(
            "'model.revolve': model_revolve,",
            "'model.revolve': model_revolve, 'model.revolve': model_revolve,", 1)
        for mutated in (changed_target, removed_registration, duplicated_registration):
            with self.assertRaises(AssertionError):
                self._assert_registry_mappings({relative: mutated})

        wrong_mode = source.replace("return model_feature(ctx, data, 'revolve')",
                                    "return model_feature(ctx, data, 'sweep')", 1)
        with self.assertRaises(AssertionError):
            self._assert_delegation(relative, 'model_revolve', ['model_feature', 'revolve'], wrong_mode)

        feature_relative = 'adapters/fusion/geometry_feature.py'
        feature_source = self._geometry_source(feature_relative).read_text()
        feature_tree = ast.parse(feature_source)
        checking = next(node for node in feature_tree.body
                        if isinstance(node, ast.If) and isinstance(node.test, ast.Name)
                        and node.test.id == '_GeometryFeature_TYPE_CHECKING')
        checking.body.insert(0, ast.Expr(ast.Call(func=ast.Name(id='runtime_effect', ctx=ast.Load()),
                                                  args=[], keywords=[])))
        injected_effect = ast.unparse(feature_tree)
        self.assertNotEqual(Counter(statement_hashes(feature_source, feature_relative)),
                            Counter(statement_hashes(injected_effect, feature_relative)))

    def test_domains_import_without_sdk_and_keep_native_entities_out(self):
        script = '''import builtins, importlib.util, sys
real_import = builtins.__import__
def no_sdk(name, *args, **kwargs):
    if name == 'adsk' or name.startswith('adsk.'):
        raise AssertionError('domain attempted SDK import')
    return real_import(name, *args, **kwargs)
builtins.__import__ = no_sdk
for path in sys.argv[1:]:
    spec = importlib.util.spec_from_file_location('geometry_domain', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
assert 'adsk' not in sys.modules
'''
        paths = [str(ROOT / f'runtime/python/fmcad/domain/geometry_{family}.py') for family in FAMILIES]
        result = subprocess.run([sys.executable, '-B', '-c', script, *paths], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in paths:
            source = Path(path).read_text()
            names = {node.id for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Name)}
            self.assertTrue(names.isdisjoint({'adsk', 'ctx', 'CAD_HANDLERS', 'UnitsManager'}), path)

    def test_fake_sdk_results_effect_order_partial_failure_and_drift(self):
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'tests/geometry_runtime_probe.py')],
                                capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        baseline = json.loads(BASELINE.read_text())
        self.assertEqual(actual, baseline['transcript'])
        self.assertIn('result', actual['extrude'])
        self.assertIn('result', actual['sweep'])
        self.assertEqual(actual['invalid']['trace'], [])
        self.assertEqual(actual['unsupported']['trace'], [])
        self.assertEqual(actual['partial']['trace'][0][0], 'applied-first-step')
        self.assertEqual(actual['partial']['error'], 'RuntimeError')
        self.assertEqual(actual['drift']['message'], 'DOCUMENT_CHANGED')
        self.assertEqual(actual['drift']['trace'], [['identity']])


if __name__ == '__main__':
    unittest.main()
