"""Public assembly runtime behavior and source dependency seams."""
import ast
import importlib.util
from pathlib import Path
import unittest

from assembly_test import AssemblyTests, Context, Entity


ROOT = Path(__file__).resolve().parents[1]
DOMAIN = ROOT / 'runtime/python/fmcad/domain/assembly.py'
ADAPTER = ROOT / 'runtime/python/fmcad/adapters/fusion/assembly.py'
CHECKER = ROOT / 'runtime/python/entrypoints/dependency_facts.py'

REGISTRATIONS = (
    ('component.inspect', '_assembly_component_inspect'),
    ('component.create', '_assembly_component_create'),
    ('component.rename', '_assembly_component_rename'),
    ('component.reparent', '_assembly_component_reparent'),
    ('component.from_bodies', '_assembly_component_from_bodies'),
    ('occurrence.add', '_assembly_occurrence_add'),
    ('occurrence.duplicate', '_assembly_occurrence_duplicate'),
    ('occurrence.transform', '_assembly_occurrence_transform'),
    ('occurrence.align', '_assembly_occurrence_align'),
    ('joint.rigid', '_assembly_joint_rigid'),
    ('joint.revolute', '_assembly_joint_revolute'),
    ('joint.slider', '_assembly_joint_slider'),
    ('joint.cylindrical', '_assembly_joint_cylindrical'),
    ('joint.inspect', '_assembly_joint_inspect'),
    ('joint.edit', '_assembly_joint_edit'),
    ('joint.drive', '_assembly_joint_drive'),
    ('joint.limits', '_assembly_joint_limits'),
    ('assembly.parts', '_assembly_misc_parts'),
    ('assembly.ground', '_assembly_misc_ground'),
    ('assembly.unground', '_assembly_misc_unground'),
    ('assembly.rigid_group', '_assembly_misc_rigid_group'),
    ('feature.list', '_assembly_feature_list'),
    ('feature.suppress', '_assembly_feature_suppress'),
    ('feature.unsuppress', '_assembly_feature_unsuppress'),
    ('feature.dependencies', '_assembly_feature_dependencies'),
    ('history.check', '_assembly_history_check_handler'),
    ('history.recompute', '_assembly_history_recompute'),
    ('change.preview', '_assembly_change_preview'),
)


def load_runtime_assembly(namespace):
    for path in (DOMAIN, ADAPTER):
        exec(compile(path.read_text(), str(path), 'exec'), namespace)


def dependency_facts():
    spec = importlib.util.spec_from_file_location('assembly_dependency_facts', CHECKER)
    if spec is None or spec.loader is None:
        raise AssertionError('Could not load the production dependency checker')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeAssemblyTests(AssemblyTests):
    """Run the established assembly behavior suite against runtime sources."""

    def setUp(self):
        super().setUp()
        load_runtime_assembly(self.ctx.ns)


class AssemblyDependencySeamTests(unittest.TestCase):
    def runtime_registry(self):
        ctx = Context()
        ctx.ns['CAD_HANDLERS'] = {}
        load_runtime_assembly(ctx.ns)
        return ctx.ns

    def test_registration_is_direct_and_keeps_public_order(self):
        namespace = self.runtime_registry()
        handlers = namespace['CAD_HANDLERS']

        self.assertEqual(list(handlers), [operation for operation, _ in REGISTRATIONS])
        for operation, function_name in REGISTRATIONS:
            with self.subTest(operation=operation):
                handler = handlers[operation]
                self.assertIs(handler, namespace[function_name])
                self.assertIsNone(handler.__closure__)

    def test_component_and_occurrence_closures_exclude_joint_and_history_execution(self):
        sources = {
            'assembly-domain': DOMAIN,
            'assembly-fusion': ADAPTER,
        }
        trees = {
            unit: ast.parse(path.read_text(), filename=str(path))
            for unit, path in sources.items()
        }
        declarations = {}
        declaration_units = {}
        for unit, tree in trees.items():
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                    declarations[node.name] = node
                    declaration_units[node.name] = unit
        checker = dependency_facts()
        handlers = checker.registrations(trees['assembly-fusion'])
        analysis = checker.analyse({
            'source': 'def run(context):\n    return None\n',
            'generated': True,
            'units': [
                {
                    'id': unit,
                    'filename': str(path),
                    'source': path.read_text(),
                    'dependencies': ['assembly-domain'] if unit == 'assembly-fusion' else [],
                }
                for unit, path in sources.items()
            ],
        })
        self.assertFalse(analysis['unsupported'])
        retained_initializers = [
            name
            for definition in analysis['facts']['definitions']
            if not definition['removable']
            for name in definition['defines']
            if name in declarations
        ]

        def closure(operation):
            # Public preparation keeps non-inert function declarations even
            # when the operation graph does not otherwise reach them.
            pending = [*handlers[operation], *retained_initializers]
            visited = set()
            while pending:
                name = pending.pop()
                if name in visited or name not in declarations:
                    continue
                visited.add(name)
                unit = declaration_units[name]
                facts = checker.facts(
                    ast.Module(body=[declarations[name]], type_ignores=[]),
                    str(sources[unit]),
                    unit=unit,
                )
                pending.extend((set(facts['references']) | set(facts['calls'])) - visited)
            return visited

        forbidden = {
            '_assembly_joint', '_assembly_joint_rigid_regular',
            '_assembly_joint_direction', '_assembly_joint_line',
            '_assembly_joint_origin', '_assembly_limits_read',
            '_assembly_limits_write', '_assembly_limits_plan', '_assembly_limits_apply',
            '_assembly_pose_snapshot', '_assembly_pose_delta',
            '_assembly_history', '_assembly_history_check',
        }
        for operation in ('component.inspect', 'occurrence.add'):
            with self.subTest(operation=operation):
                expected_handler = dict(REGISTRATIONS)[operation]
                dependencies = closure(operation)
                self.assertEqual(handlers[operation], [expected_handler])
                self.assertIn('_assembly_component' if operation.startswith('component.')
                              else '_assembly_occurrence', dependencies)
                self.assertTrue(dependencies.isdisjoint(forbidden))

    def test_runtime_installation_replaces_handlers_without_reordering_registry(self):
        ctx = Context()
        handlers = ctx.ns['CAD_HANDLERS']
        before = list(handlers)
        previous = handlers['component.inspect']

        load_runtime_assembly(ctx.ns)

        self.assertEqual(list(handlers), before)
        self.assertIsNot(handlers['component.inspect'], previous)
        self.assertIs(handlers['component.inspect'], ctx.ns['_assembly_component_inspect'])

    def test_runtime_and_compatibility_dispatch_preserve_error_order(self):
        cases = (
            ('component.create', {'name': 'Created component'}),
            ('component.rename', {'component': 'A', 'name': 'Renamed component'}),
            ('occurrence.add', {'component': 'A', 'copyMode': 'linked'}),
            ('joint.rigid', {'name': 'Rigid', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'}),
            ('component.create', {'name': ''}),
            ('occurrence.add', {'component': 'missing', 'copyMode': 'unsupported'}),
            ('joint.drive', {'joint': 'missing', 'rotation': 'invalid'}),
        )

        def observe(runtime, operation, data):
            Entity.serial = 0
            ctx = Context()
            if runtime:
                load_runtime_assembly(ctx.ns)
            try:
                result = ('returned', ctx.call(operation, data))
            except Exception as error:
                result = ('raised', type(error).__name__, str(error))
            return result, list(ctx.trace), list(ctx.created)

        for operation, data in cases:
            with self.subTest(operation=operation):
                self.assertEqual(
                    observe(True, operation, data),
                    observe(False, operation, data),
                )


if __name__ == '__main__':
    unittest.main()
