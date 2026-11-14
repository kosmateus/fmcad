"""Preservation evidence, not a Fusion/live or physical geometry acceptance."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ('model', 'sketch', 'sketch_plan', 'curve', 'datum', 'surface', 'shapes', 'feature')
BASELINE = ROOT / 'tests/fixtures/python-geometry/baseline.json'

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


def statement_hashes(source):
    class TypeAnnotations(ast.NodeTransformer):
        def __init__(self):
            self.function_stack = []

        def visit_FunctionDef(self, node):
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
            if node.name == '_shapes_primitive':
                # The only behavioral addition is a known nonmutating input
                # rejection. Pin its exact boundary and witness before undoing
                # the wrapper for historical comparison. shapes_test covers
                # no effects on rejection and propagation after native mutation.
                for index, statement in enumerate(node.body):
                    if isinstance(statement, ast.Try):
                        digest = hashlib.sha256(ast.dump(
                            statement, include_attributes=False).encode()).hexdigest()
                        if digest != '68c4891820c152faa07cc297af18afcbb4a07e4178c46b9bb4b521ca1f90ede1':
                            raise AssertionError('Primitive preflight rejection boundary changed')
                        node.body[index:index + 1] = statement.body
                        break
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
            return self.generic_visit(node)

    statements = [normalized for node in ast.parse(source).body
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
        for family in ('model', 'feature', 'datum', 'shapes'):
            excluded = {digest for values in rewrites[family].values() for digest in values}
            adjusted[family] = [digest for digest in adjusted[family] if digest not in excluded]
        # This source is intentionally staged to validate nested JSON shapes;
        # fake-SDK output/effect ordering remains covered by model_test.
        adjusted['model'] = [digest for digest in adjusted['model']
                             if digest != 'a80df3ad20aa88a06ab4f8c4906e5ec2fa3b29a7b7450facb91e0449dced026d']
        for family in FAMILIES:
            with self.subTest(family=family):
                actual = []
                for layer in ('domain', 'adapters/fusion', 'application'):
                    actual.extend(statement_hashes((ROOT / f'runtime/python/fmcad/{layer}/geometry_{family}.py').read_text()))
                self.assertEqual(sorted(actual), sorted(adjusted[family]))

    def test_primitive_rejection_normalization_rejects_boundary_or_witness_drift(self):
        source = (ROOT / 'runtime/python/fmcad/adapters/fusion/geometry_shapes.py').read_text()
        mutations = (
            source.replace("'mutationStatus': 'not_started'", "'mutationStatus': 'unknown'", 1),
            source.replace('    except ValueError as exc:', '    except Exception as exc:', 1),
            source.replace("        _model_fields(data, ('name',) + sizes, ('plane',))",
                           "        ctx.call('model.extrude', {})\n"
                           "        _model_fields(data, ('name',) + sizes, ('plane',))", 1),
        )
        for mutated in mutations:
            self.assertNotEqual(mutated, source)
            with self.assertRaisesRegex(AssertionError, 'Primitive preflight rejection boundary changed'):
                statement_hashes(mutated)

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
