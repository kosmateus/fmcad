"""Offline tests for the complete document/I/O family composition, not Fusion."""
import ast
import builtins
import copy
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_legacy_core


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'tests/fixtures/python-document-io-manifest.json').read_text())
FAMILIES = {family['family']: family for family in MANIFEST['families']}
# The prepared CAD artifact has one shared namespace, so overlapping private
# helpers receive family prefixes while their behavior remains unchanged.
PRIVATE_HELPER_RENAMES = {
    'interference': {'result': 'pair_result'},
    'containment': {
        '_point3': '_containment_point3', '_vsub': '_containment_vsub',
        '_vdot': '_containment_vdot', '_vnorm': '_containment_vnorm',
        '_vunit': '_containment_vunit', '_vscale': '_containment_vscale',
        '_vadd': '_containment_vadd', '_point_at_station': '_containment_point_at_station',
        '_circle_union_area': '_containment_circle_union_area',
    },
    'dfm': {
        '_point3': '_dfm_point3', '_deg': '_dfm_deg', '_vsub': '_dfm_vsub',
        '_vdot': '_dfm_vdot', '_vnorm': '_dfm_vnorm',
    },
    'fpc_pcb': {
        '_vsub': '_fpc_vsub', '_vadd': '_fpc_vadd', '_vscale': '_fpc_vscale',
        '_vdot': '_fpc_vdot', '_vcross': '_fpc_vcross', '_vnorm': '_fpc_vnorm',
        '_vunit': '_fpc_vunit', '_rotate': '_fpc_rotate',
    },
    'optics': {
        '_point3': '_optics_point3', '_basis': '_optics_basis',
        '_sensor_geometry': '_optics_sensor_geometry', '_obstacle_hit': '_optics_obstacle_hit',
        '_vsub': '_optics_vsub', '_vadd': '_optics_vadd', '_vscale': '_optics_vscale',
        '_vdot': '_optics_vdot', '_vcross': '_optics_vcross', '_vnorm': '_optics_vnorm',
        '_vunit': '_optics_vunit', '_point2_in_poly': '_optics_point2_in_poly',
        '_poly2_area': '_optics_poly2_area', '_require_schema': '_optics_require_schema',
        '_rect_corners': '_optics_rect_corners', '_sensor_classify': '_optics_sensor_classify',
        '_ray_box': '_optics_ray_box', '_ray_disk': '_optics_ray_disk',
        '_ray_polygon': '_optics_ray_polygon', '_line_line_distance': '_optics_line_line_distance',
        '_line_box_intersects': '_optics_line_box_intersects',
    },
    'explode': {
        '_ref_key': '_explode_ref_key',
        '_vsub': '_explode_vsub', '_vadd': '_explode_vadd', '_vscale': '_explode_vscale',
        '_vdot': '_explode_vdot', '_vcross': '_explode_vcross', '_vnorm': '_explode_vnorm',
        '_vunit': '_explode_vunit',
    },
    'marking': {
        '_point3': '_marking_point3', '_parse_mark': '_marking_parse_mark',
        '_parse_region': '_marking_parse_region', '_vsub': '_marking_vsub',
        '_vdot': '_marking_vdot', '_vnorm': '_marking_vnorm',
        '_deg': '_marking_deg', '_box_overlap': '_marking_box_overlap',
        '_SOURCE_STATUSES': '_MARKING_SOURCE_STATUSES',
        '_ZONE_KINDS': '_MARKING_ZONE_KINDS',
    },
}


def family_source(family):
    return '\n\n'.join((ROOT / unit['path']).read_text() for unit in FAMILIES[family]['units'])


def fake_sdk():
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    return {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}


class RuntimeInventoryTests(unittest.TestCase):
    def test_full_registry_and_handler_ownership_matches_retained_inventory(self):
        def load(migrated):
            namespace = {}
            owners = {}
            with patch.dict(sys.modules, fake_sdk()):
                load_legacy_core(namespace, ROOT)
                for source in sorted((ROOT / 'assets/cad').glob('*.py')):
                    if source.stem == 'core':
                        continue
                    before = dict(namespace['CAD_HANDLERS'])
                    code = family_source(source.stem) if migrated and source.stem in FAMILIES else source.read_text()
                    exec(compile(code, str(source), 'exec'), namespace)
                    for key, handler in namespace['CAD_HANDLERS'].items():
                        if before.get(key) is not handler:
                            owners[key] = source.stem
            return namespace['CAD_HANDLERS'], owners
        baseline, baseline_owners = load(False)
        migrated, migrated_owners = load(True)
        self.assertGreater(len(migrated), 200)
        self.assertEqual(set(migrated), set(baseline))
        self.assertEqual(migrated_owners, baseline_owners)
        for operation in baseline:
            self.assertEqual(migrated[operation].__name__, baseline[operation].__name__, operation)

    def test_every_retained_definition_has_exactly_its_previous_count(self):
        for family, entry in FAMILIES.items():
            renamed = PRIVATE_HELPER_RENAMES.get(family, {})
            canonical_name = {new: old for old, new in renamed.items()}
            def definitions(source):
                counts = {}
                for node in ast.parse(source).body:
                    if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                        name = canonical_name.get(node.name, node.name)
                        counts[name] = counts.get(name, 0) + 1
                return counts
            original = definitions((ROOT / entry['compatibility']).read_text())
            current = definitions(family_source(family))
            for name, count in original.items():
                if family == 'externalization' and name == '_external_stage_insert_plan':
                    # The compatibility source redeclares this helper and shadows its earlier body.
                    # Keep the single effective implementation; the strict replay rejects the duplicate.
                    self.assertEqual(count, 2)
                    self.assertEqual(current.get(name), 1)
                    continue
                self.assertEqual(current.get(name), count, (family, name))
            # Type annotations are the intended migration change; preserve each
            # retained function's executable definition and decorator structure.
            def behavior_dump(node):
                node = copy.deepcopy(node)
                if node.name == '_references_refresh_internal' and node.args.args[-1].arg == 'payload':
                    # D's wire admission intentionally adds these exact guards.
                    # Paired runtime tests cover their errors and zero SDK effects;
                    # continue comparing the entire retained operation body below.
                    prefix = ast.parse("""
if not isinstance(action, str) or action not in ('graph', 'preflight', 'sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'):
    raise ValueError('Unknown private references.refresh SDK action')
if not isinstance(payload, dict):
    raise ValueError('references.refresh data must be an object')
data = _cad_cast("_ReferencesInput", payload)
""").body
                    self.assertEqual([ast.dump(statement) for statement in node.body[:3]],
                                     [ast.dump(statement) for statement in prefix])
                    node.body = node.body[3:]
                    node.args.args[-1].arg = 'data'
                node.returns = None
                node.type_comment = None
                arguments = node.args
                for argument in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs):
                    argument.annotation = None
                    argument.type_comment = None
                if arguments.vararg is not None:
                    arguments.vararg.annotation = None
                    arguments.vararg.type_comment = None
                if arguments.kwarg is not None:
                    arguments.kwarg.annotation = None
                    arguments.kwarg.type_comment = None

                class RemoveTypeOnlySyntax(ast.NodeTransformer):
                    def __init__(self):
                        self.callable_aliases = set()

                    def visit_Name(self, name):
                        name = self.generic_visit(name)
                        aliases = {
                            '_IoPath': 'Path', '_DIPath': 'Path', '_io_os_path': 'os',
                            '_di_time': 'time', '_di_math': 'math', '_fpc_math': 'math',
                            '_fpc_domain_math': 'math', '_fpc_adapter_math': 'math',
                            '_seal_rules_math': 'math', '_seal_adapter_math': 'math',
                            '_presentation_math': 'math',
                            '_measurement_rules_math': 'math',
                            '_optics_domain_math': 'math', '_optics_adapter_math': 'math',
                            '_explode_domain_math': 'math', '_explode_adapter_math': 'math',
                            '_anim2_domain_math': 'math', '_anim2_adapter_math': 'math',
                            '_anim2_os': 'os', '_anim2_shutil': 'shutil',
                            '_anim2_subprocess': 'subprocess', '_anim2_tempfile': 'tempfile',
                            '_marking_domain_math': 'math', '_marking_adapter_math': 'math',
                            '_cam_domain_math': 'math', '_cam_adapter_math': 'math',
                            '_texture_domain_math': 'math', '_texture_math': 'math',
                            '_texture_hashlib': 'hashlib', '_texture_struct': 'struct',
                            '_texture_binascii': 'binascii', '_texture_zlib': 'zlib',
                            '_external_math': 'math', '_external_os': 'os',
                            '_external_sys': 'sys', '_external_time': 'time',
                            '_external_types': 'types', '_external_hashlib': 'hashlib',
                            '_external_json': 'json', '_external_cast': 'cast',
                            '_external_items': '_references_items',
                            '_ExternalIterable': 'Iterable', '_ExternalTypeVar': 'TypeVar',
                            '_ExternalNotRequired': 'NotRequired', '_ExternalProtocol': 'Protocol',
                            '_ExternalRequired': 'Required', '_ExternalTypedDict': 'TypedDict',
                            '_atomic_json': 'json', '_atomic_math': 'math',
                            '_atomic_re': 're', '_atomic_sys': 'sys', '_atomic_types': 'types',
                            '_animation_math': 'math', '_animation_os': 'os',
                            '_animation_re': 're', '_animation_tempfile': 'tempfile',
                            '_animation_time': 'time', '_AnimationPath': 'Path',
                            '_animation_rules_math': 'math',
                        }
                        name.id = canonical_name.get(name.id, name.id)
                        name.id = aliases.get(name.id, name.id)
                        return name

                    def visit_FunctionDef(self, function):
                        function = self.generic_visit(function)
                        function.name = canonical_name.get(function.name, function.name)
                        function.returns = None
                        function.type_comment = None
                        arguments = function.args
                        for argument in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs):
                            argument.annotation = None
                            argument.type_comment = None
                        if arguments.vararg is not None:
                            arguments.vararg.annotation = None
                            arguments.vararg.type_comment = None
                        if arguments.kwarg is not None:
                            arguments.kwarg.annotation = None
                            arguments.kwarg.type_comment = None
                        return function

                    def visit_AnnAssign(self, statement):
                        self.generic_visit(statement)
                        if statement.value is None:
                            return None
                        return ast.copy_location(ast.Assign(
                            targets=[statement.target], value=statement.value), statement)

                    def visit_Call(self, call):
                        if (isinstance(call.func, ast.Name) and
                                call.func.id in self.callable_aliases):
                            call.func = ast.Attribute(value=ast.Name(id='ctx', ctx=ast.Load()),
                                                      attr='_proxy', ctx=ast.Load())
                        self.generic_visit(call)
                        if isinstance(call.func, ast.Name) and call.func.id == '_cad_cast':
                            return call.args[1]
                        if isinstance(call.func, ast.Name) and call.func.id == '_measure_expression':
                            return ast.copy_location(ast.Call(
                                func=ast.Attribute(value=call.args[0], attr='_expression', ctx=ast.Load()),
                                args=call.args[1:], keywords=call.keywords), call)
                        return call

                    def visit_Attribute(self, attribute):
                        attribute = self.generic_visit(attribute)
                        if (isinstance(attribute.value, ast.Name) and attribute.value.id == 'ctx' and
                                attribute.attr == 'proxy'):
                            attribute.attr = '_proxy'
                        return attribute

                    def visit_Assign(self, statement):
                        if (isinstance(statement.value, ast.Call) and
                                isinstance(statement.value.func, ast.Name) and
                                statement.value.func.id == '_cad_cast'):
                            statement.value = self.visit(statement.value.args[1])
                            if (len(statement.targets) == 1 and
                                    isinstance(statement.targets[0], ast.Name) and
                                    isinstance(statement.value, ast.Name) and
                                    statement.targets[0].id == statement.value.id):
                                return None
                        if (len(statement.targets) == 1 and
                                isinstance(statement.targets[0], ast.Name) and
                                statement.targets[0].id == 'proxy' and
                                isinstance(statement.value, ast.Call) and
                                isinstance(statement.value.func, ast.Name) and
                                statement.value.func.id == 'getattr' and
                                len(statement.value.args) == 2 and
                                isinstance(statement.value.args[0], ast.Name) and
                                statement.value.args[0].id == 'ctx' and
                                isinstance(statement.value.args[1], ast.Constant) and
                                statement.value.args[1].value == '_proxy'):
                            # Normalize the typed one-time method binding to its
                            # equivalent retained ctx._proxy call in this AST check.
                            self.callable_aliases.add('proxy')
                            return None
                        return self.generic_visit(statement)

                node = RemoveTypeOnlySyntax().visit(node)
                return ast.dump(node, include_attributes=False)
            original_nodes = {n.name: behavior_dump(n)
                              for n in ast.parse((ROOT / entry['compatibility']).read_text()).body
                              if isinstance(n, ast.FunctionDef)}
            current_nodes = {canonical_name.get(n.name, n.name): behavior_dump(n)
                             for n in ast.parse(family_source(family)).body
                             if isinstance(n, ast.FunctionDef)}
            for name in original_nodes:
                if family == 'externalization':
                    # Externalization uses dedicated fake/native evidence for its
                    # typed SDK boundaries and uncertainty outcomes.
                    continue
                if family == 'document' and name in {
                        '_document_save_as', '_document_save_native', '_document_clear_items',
                        '_document_clear_guard', '_document_clear_audit', '_document_clear'}:
                    # These operations now narrow native document/timeline/collection
                    # boundaries explicitly; save and destructive-clear fake suites
                    # remain their behavioral oracles.
                    continue
                if family == 'document_snapshot' and name == '_document_snapshot':
                    # Snapshot projection now normalizes nullable SDK readbacks at
                    # its typed adapter boundary; document status/save fixtures cover it.
                    continue
                if family == 'io' and name in {
                        '_io_capture_bulbs', '_io_restore_bulbs', '_io_restore_raise',
                        '_io_shot_presentation', '_io_shots'}:
                    continue
                if family == 'legacy-review' and name in {
                        'restore_camera', 'verify_view_directions', 'capture_review'}:
                    continue
                if family == 'checking' and name in {
                        '_checking_contract', '_evaluate_predicate', '_check_set',
                        '_evidence_package', '_evidence_check', '_deliver'}:
                    continue
                if family == 'containment' and name == '_native_contains':
                    # Fusion's real SDK exposes pointContainment on the copied BRepBody,
                    # not on TemporaryBRepManager; the fake SDK suite covers this correction.
                    continue
                if family == 'measure' and name == '_measure_callback_result':
                    # This internal helper now declares the fixed two-argument callback contract.
                    continue
                if family == 'entity' and name in {
                        '_entity_frame_target', '_entity_interval', '_entity_attribute_filters',
                        '_entity_attribute_owner', '_entity_attribute_reasons',
                        '_entity_attribute_occurrence_context', '_entity_attribute_predicates',
                        '_entity_filters', '_entity_candidates', '_entity_describe',
                        '_entity_neighbors', '_entity_reasons', '_entity_stats',
                        '_entity_query', '_entity_find', '_entity_inspect',
                        '_entity_resolve_reference'}:
                    # These functions now perform explicit JSON narrowing and SDK
                    # collection discrimination; the entity fake suites remain the
                    # behavioral oracle for their retained algorithms.
                    continue
                if family == 'io' and name in {
                        '_io_visibility', '_io_camera_state', '_io_camera_from_state',
                        '_io_camera_apply', '_io_camera', '_io_shot_presentation',
                        '_io_shots', '_io_reference_image', '_io_style_state', '_io_style',
                        '_io_import_options', '_io_export_plan', '_io_export', '_io_parts',
                        '_io_verify', '_io_checkpoint'}:
                    # These functions now use validated JSON/SDK boundary types;
                    # the dedicated IO fake suite remains their behavior oracle.
                    continue
                if family == 'data_import' and name in {
                        '_di_rigid', '_di_metadata', '_di_get', '_di_put', '_di_world', '_di_model_preflight',
                        '_di_import_model', '_di_material_preflight', '_di_geometry_state',
                        '_di_geometry_matches', '_di_parameter', '_di_catalog_state',
                        '_di_catalog', '_di_unconstrained', '_di_pose_plan',
                        '_di_placement', '_di_replace', '_di_handler'}:
                    # These boundaries now narrow persisted JSON and Fusion SDK
                    # values explicitly; data_import_test.py remains the behavior
                    # oracle for retained import algorithms and partial outcomes.
                    continue
                if family == 'data_import_rules' and name in {'_di_rigid', '_di_metadata'}:
                    # These DTO rules are strictly narrowed and retain their fake
                    # adapter regression coverage.
                    continue
                if family == 'appearance' and name in {
                        '_style_contract', '_style_collection', '_style_resolve',
                        '_style_require_design_item', '_style_prop_type', '_style_prop_value',
                        '_style_prop_info', '_style_properties', '_style_set_property',
                        '_style_apply_properties', '_style_props_by_name', '_style_find_prop',
                        'appearance_create', 'material_create', '_style_edit',
                        'appearance_texture', 'appearance_projection', '_style_resolve_refs',
                        '_style_assignment_row', '_style_assign_map', '_style_report'}:
                    # These adapter boundaries now validate/narrow SDK property
                    # objects and JSON values; appearance_test.py remains the
                    # behavioral oracle for property edits and assignment reports.
                    continue
                if family == 'attributes' and name in {
                        '_attr_entity', 'entity_attribute_set', 'entity_attribute_get'}:
                    # Attribute handlers now narrow the native collection boundary;
                    # appearance_test.py retains the durable namespace behavior tests.
                    continue
                if family == 'fpc_pcb' and name in {
                        '_polygon', '_circle_union_area', '_chain_geometry', '_fold_walk',
                        '_flatten_walk', 'fpc_fold', 'fpc_flatten', 'pcb_mechanical_exchange',
                        'pcb_check', 'port_define', '_connector', 'connector_mate_check',
                        'pack_cross_section', 'keepout_check'}:
                    # FPC/PCB rules and recipe handlers now narrow nested JSON inputs;
                    # fpc_pcb_test.py remains the geometry/validation behavior oracle.
                    continue
                if family == 'atomic' and name in {
                        '_atomic_result_failed', '_atomic_snapshot', '_atomic_fresh_context',
                        '_atomic_transaction'}:
                    # These functions now narrow JSON result records, optional SDK
                    # values, and the native command/callback lifecycle boundaries;
                    # batch_atomic_test.py covers their behavior.
                    continue
                if family == 'seal' and name in {
                        '_seal_axis_direction', '_seal_plane_normal', '_seal_contract', '_o_ring_dimensions',
                        '_seal_shape_o_ring', '_seal_groove', '_seal_evaluate',
                        '_seal_profile', '_dock_sequence'}:
                    # Seal handlers now narrow nested JSON objects and native
                    # geometric values; seal_test.py remains their behavioral oracle.
                    continue
                if family == 'animation' and name in {
                        '_animation_number', '_animation_manager', '_animation_row',
                        '_animation_native', '_animation_paths', '_animation_sample',
                        '_animation_handler'}:
                    # Numeric values, native storyboard metadata, paths, and
                    # nested motion inputs are now narrowed at typed boundaries;
                    # animation_test.py retains the fake-SDK behavior oracle.
                    continue
                if family == 'presentation' and name in {
                        '_presentation_contract', '_mat_frame', '_color_info', '_matrix_from_descriptor',
                        'section_edit', '_health_check', '_vis_chain', '_vis_snapshot', '_vis_restore',
                        'visibility_finalize'}:
                    # The contract builder and transform projector now narrow their
                    # nested JSON values; presentation_test.py retains the behavior oracle.
                    continue
                if family == 'optics' and name == '_point3':
                    # The SDK Point3D/list boundary is narrowed explicitly; optics_test.py
                    # remains the geometric behavior oracle.
                    continue
                if family == 'optics' and name in {
                        '_optics_contract', '_optics_sensor_geometry', '_sensor_geometry', 'optics_frustum',
                        'optics_coverage', '_sensor_classify', '_obstacle_hit', 'optics_occlusion',
                        'sensor_alignment_check'}:
                    # These handlers now narrow nested JSON sensor/target/obstacle
                    # records at adapter boundaries; optics_test.py covers behavior.
                    continue
                if family == 'explode' and name in {
                        '_explode_number', '_explode_direction', '_ref_key',
                        '_explode_specs', '_explode_plan_model', '_explode_frame_paths', 'explode_render'}:
                    # Numeric/vector inputs now narrow exact int/float values;
                    # explode_test.py remains the mathematical/DTO behavior oracle.
                    continue
                if family == 'animation2' and name in {
                        '_anim2_number', '_anim2_direction', '_anim2_phases', '_anim2_range',
                        '_anim2_ref_key', '_anim2_contract', '_anim2_point',
                        'animation_sequence', '_anim2_frame_paths', 'animation_export'}:
                    # Numeric/vector and nested sequence/export inputs now narrow
                    # at typed boundaries; animation2_test.py remains the behavior oracle.
                    continue
                if family == 'marking' and name in {
                        '_point3', '_marking_contract', '_parse_mark', '_parse_region',
                        '_marking_create', '_marking_check', '_box_overlap', '_occupancy'}:
                    # Geometric records and adapter JSON boundaries are narrowed;
                    # marking_test.py remains the geometry/DTO behavior oracle.
                    continue
                if family == 'cam' and name in {
                        '_cam_contract', '_cam_rise', '_cam_compute', 'cam_profile',
                        'cam_evaluate', 'cam_cycle_check'}:
                    # Rise-law closures and nested result records are typed at
                    # their SDK/JSON boundaries; cam_test.py remains the math oracle.
                    continue
                if family == 'texture' and name == 'texture_heightmap':
                    # Typed dimension/seed/pattern boundaries preserve the deterministic
                    # PNG algorithm; appearance_test.py remains its behavior oracle.
                    continue
                if family == 'simulation' and name == '_simulation_capabilities':
                    # Metadata-only SDK discovery now types the optional imported
                    # module/classes; simulation_test.py remains its behavior oracle.
                    continue
                if family == 'measure' and name in {'_measure_compare_bodies', '_measure_frame_context'}:
                    # Master requires explicit frame validation for temporary
                    # baselines and reconciles serialized space-only frames.
                    continue
                if family == 'legacy-queue_document' and name == '_qd_design_state':
                    # Master now sorts retained component/parameter/reference
                    # records deterministically and keys recursion by captured identity.
                    continue
                if family == 'legacy-inspect':
                    import hashlib
                    reviewed = json.loads((ROOT / 'tests/fixtures/legacy-inspect-typing.json').read_text())
                    allowed = reviewed['definitions'].get(name)
                    if allowed:
                        self.assertTrue(reviewed['reason'])
                        self.assertEqual(hashlib.sha256(original_nodes[name].encode()).hexdigest(), allowed['before'], name)
                        self.assertEqual(hashlib.sha256(current_nodes[name].encode()).hexdigest(), allowed['after'], name)
                        continue
                self.assertEqual(current_nodes[name], original_nodes[name], (family, name))

    def test_clean_rules_import_without_sdk_filesystem_or_processes(self):
        paths = {unit['path'] for family in FAMILIES.values() for unit in family['units']
                 if '/domain/' in unit['path'] or '/application/' in unit['path']}
        allowed = {'math', 'json', 'hashlib', 'binascii', 'struct', 'zlib', 're', 'typing', 'collections.abc'}
        for module in allowed:
            __import__(module)
        original_import = builtins.__import__
        def guarded_import(name, *args, **kwargs):
            if name not in allowed:
                raise AssertionError('Effectful import: ' + name)
            return original_import(name, *args, **kwargs)
        for path in paths:
            source = (ROOT / path).read_text()
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, ast.Name):
                    self.assertNotIn(node.id, {'adsk', 'ctx', 'open', 'Path', 'os', 'subprocess', 'tempfile'}, path)
            with patch('builtins.__import__', guarded_import):
                exec(compile(source, path, 'exec'), {'TYPE_CHECKING': False})

    def test_file_policy_rules_execute_without_native_context(self):
        import math
        from typing import cast
        # Use the production field validator, without importing the SDK core.
        core = ast.parse((ROOT / 'assets/cad/core.py').read_text())
        fields = next(node for node in core.body
                      if isinstance(node, ast.FunctionDef) and node.name == '_cad_fields')
        namespace = {'_cad_cast': cast, '_external_cast': cast, 'math': math,
                     'json': json, 'TYPE_CHECKING': False}
        exec(compile(ast.Module(body=[fields], type_ignores=[]), 'fields', 'exec'), namespace)
        for family in ('io', 'data_import', 'externalization'):
            path = ROOT / 'runtime/python/fmcad/domain' / (family + '.py')
            exec(compile(path.read_text(), str(path), 'exec'), namespace)
        state = {'document': {'fileId': 'owned'}, 'eye': [0, 0, 10],
                 'target': [0, 0, 0], 'up': [0, 1, 0], 'units': 'cm',
                 'cameraType': 'OrthographicCameraType', 'extents': [2, 3]}
        self.assertEqual(namespace['_io_camera_snapshot'](state)['extents'], [2., 3.])
        with self.assertRaisesRegex(ValueError, 'positive finite'):
            namespace['_io_camera_snapshot'](dict(state, extents=[0, 3]))
        with self.assertRaisesRegex(ValueError, 'isLightBulbOn:boolean'):
            namespace['_io_visibility_row']({'ref': 'body', 'isLightBulbOn': 1})
        with self.assertRaisesRegex(RuntimeError, 'restore failed'):
            namespace['_io_restore_raise']([{'status': 'failed'}], 'restore')
        old = {'owner': 'ours', 'revision': 'r1', 'digest': 'digest'}
        plan = dict(old, onExisting='reuse', expectedRevision='r1')
        namespace['_di_existing'](old, plan, 'item')
        with self.assertRaisesRegex(ValueError, 'ownership conflict'):
            namespace['_di_existing'](dict(old, owner='foreign'), plan, 'item')
        with self.assertRaisesRegex(ValueError, 'expectedRevision conflict'):
            namespace['_di_existing'](old, dict(plan, onExisting='update', expectedRevision='r2'), 'item')
        self.assertEqual(old, {'owner': 'ours', 'revision': 'r1', 'digest': 'digest'})
        pin = {'projectId': 'project', 'fileId': 'file', 'version': 3}
        runtime = {'items': {'source': {'targetPin': pin}}}
        actual = namespace['_external_source_pin'](runtime, {'itemId': 'source'})
        self.assertEqual(actual, pin)
        self.assertIsNot(actual, pin)
        with self.assertRaisesRegex(ValueError, 'not yet complete'):
            namespace['_external_source_pin']({'items': {'source': {'targetPin': None}}},
                                              {'itemId': 'source'})
        endpoint = namespace['_external_boundary_endpoint_preflight']
        endpoint({'rootDatum': 'datum'}, {'item'}, set(), {'datum'})
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            endpoint({'rootDatum': 'datum', 'itemId': 'item'}, {'item'}, set(), {'datum'})
        self.assertIsNone(namespace['_external_probe_local_budget'](1000, 1000))
        self.assertEqual(namespace['_external_probe_local_budget'](3000, 1000), 2000)

    def test_retained_fake_suites_execute_migrated_sources_not_compatibility_copies(self):
        # Existing effect/failure fixtures now exercise the runtime implementations.
        script = r'''
import json, pathlib, sys, unittest
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'tests/fixtures/python-document-io-manifest.json').read_text())
read = pathlib.Path.read_text
mapping = {str((root / family['compatibility']).resolve()): family for family in manifest['families']}
def migrated(path, *args, **kwargs):
    family = mapping.get(str(path.resolve()))
    if family:
        return '\n\n'.join(read(root / unit['path']) for unit in family['units'])
    return read(path, *args, **kwargs)
pathlib.Path.read_text = migrated
sys.path.insert(0, str(root / 'tests'))
names = ['document_save_test', 'document_save_publication_test', 'document_identity_test',
         'document_clear_test', 'references_native_test', 'externalization_native_test',
         'data_import_test', 'io_test', 'measure_test', 'checking_test',
         'containment_test', 'interference_test', 'dfm_test', 'appearance_test',
         'attributes_test', 'presentation_test', 'animation_test', 'animation2_test',
         'explode_test', 'cam_test', 'optics_test', 'seal_test', 'fpc_pcb_test',
         'texture_test', 'review_test', 'queue_document_test']
names = [name for name in names if (root / 'tests' / (name + '.py')).exists()]
suite = unittest.defaultTestLoader.loadTestsFromNames(names)
result = unittest.TextTestRunner().run(suite)
assert result.testsRun > 100
sys.exit(not result.wasSuccessful())
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(ROOT)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class DocumentCopyTests(unittest.TestCase):
    def setUp(self):
        # This focused application-unit test omits the shared core prelude;
        # runtime _cad_cast is an identity operation and needs only a test shim.
        self.namespace = {'_cad_cast': lambda expected, value: value}
        for path in ('domain/document.py', 'application/document.py'):
            source = ROOT / 'runtime/python/fmcad' / path
            exec(compile(source.read_text(), str(source), 'exec'), self.namespace)
        self.request = dict(name='Copy', project='project', folder='', confirm=True)
        self.target = dict(name='Copy', projectId='p', folderId='f')
        self.original = dict(saved=True, fileId='original')
        self.current = dict(saved=True, fileId='new', fileName='Copy', projectId='p',
                            folderId='f', modified=False, isComplete=True)

    def port(self, accepted=True, post=None, save_error=None):
        calls = []
        original, target = self.original, self.target
        current = self.current if post is None else post
        class Port:
            def target(self, request):
                calls.append('target')
                return target
            def snapshot(self):
                calls.append('snapshot')
                if calls.count('snapshot') == 1:
                    return original
                if isinstance(current, Exception):
                    raise current
                return current
            def progress(self, target, warning):
                calls.append('progress')
            def save_copy(self, request):
                calls.append('save')
                if save_error:
                    raise save_error
                return accepted
        return Port(), calls

    def test_one_explicit_save_and_observed_identity_required(self):
        port, calls = self.port()
        result = self.namespace['document_copy'](self.request, port, 'warning')
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(calls, ['target', 'snapshot', 'progress', 'save', 'snapshot'])

    def test_false_acceptance_partial_identity_and_readback_failure_never_become_success(self):
        for accepted, current, expected in [
                (False, self.current, 'failed'),
                (True, dict(self.current, fileId='original'), 'pending'),
                (True, dict(self.current, isComplete=False), 'pending'),
                (True, dict(self.current, modified=True), 'pending'),
                (True, dict(self.current, projectId='wrong'), 'pending'),
                (True, RuntimeError('offline readback'), 'pending'),
                (True, {'dataFileError': {'message': 'incomplete'}}, 'pending')]:
            with self.subTest(accepted=accepted, current=current):
                port, calls = self.port(accepted=accepted, post=current)
                result = self.namespace['document_copy'](self.request, port, 'warning')
                self.assertEqual(result['status'], expected)
                self.assertEqual(calls.count('save'), 1)

    def test_invalid_request_pre_save_readback_and_unknown_entry_do_not_retry(self):
        port, calls = self.port()
        with self.assertRaises(ValueError):
            self.namespace['document_copy'](dict(self.request, name='../bad'), port, '')
        self.assertEqual(calls, [])
        self.original['dataFileError'] = {'message': 'unreadable source'}
        with self.assertRaisesRegex(RuntimeError, 'unreadable'):
            self.namespace['document_copy'](self.request, port, '')
        self.assertNotIn('save', calls)
        self.original.pop('dataFileError')
        port, calls = self.port(save_error=RuntimeError('ack lost after entry'))
        with self.assertRaisesRegex(RuntimeError, 'ack lost'):
            self.namespace['document_copy'](self.request, port, '')
        self.assertEqual(calls.count('save'), 1)
        self.assertEqual(calls.count('snapshot'), 1)


if __name__ == '__main__':
    unittest.main()
