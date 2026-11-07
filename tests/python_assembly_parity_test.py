"""Golden fake-SDK traces for every migrated family's existing behavioral suite.

The baseline contains hashes/data only, never a second copy of CAD handlers.
To deliberately recapture the pre-migration oracle, run this file with
--record-baseline <commit>. Ordinary tests require neither Git nor Fusion.
"""
import ast
import builtins
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ('assembly', 'pose', 'mechanism', 'route3d', 'sequence', 'spring',
            'thread', 'fastener', 'gear', 'sheetmetal', 'definitions')
SUITES = tuple(family + '_test' if family != 'definitions' else 'definitions_recipe_test'
               for family in FAMILIES)
GOLDEN = ROOT / 'tests/fixtures/python-assembly-parity.json'
POST_BASELINE_CASES = {
    # Native MotionLink was added after the legacy parity baseline. These cases
    # still execute and assert here; they have no pre-migration implementation.
    'mechanism_test.MechanismTests.test_native_representation_does_not_infer_motion_link_from_api_presence',
    'mechanism_test.MechanismTests.test_native_motion_link_uses_documented_create_and_reads_back',
    'mechanism_test.MechanismTests.test_native_motion_link_rejects_confirmation_units_and_non_revolute_before_add',
    'mechanism_test.MechanismTests.test_native_motion_link_reports_unhealthy_readback_without_rollback',
}


def projection(value, depth=0):
    if depth > 5:
        return '<depth>'
    if value is None or type(value) in (bool, int, float):
        return value
    if isinstance(value, str):
        if value.startswith(('{', '[')):
            try:
                return {'json': projection(json.loads(value), depth + 1)}
            except (ValueError, TypeError):
                pass
        # Poses intentionally use the current UTC timestamp.
        return '<timestamp>' if len(value) > 20 and value[4:5] == '-' and value[10:11] == 'T' else value
    if isinstance(value, (tuple, list)):
        return [projection(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): projection(item, depth + 1) for key, item in value.items()}
    if isinstance(value, set):
        return sorted((projection(item, depth + 1) for item in value), key=str)
    attrs = getattr(value, '__dict__', {})
    return {'type': type(value).__name__, **{
        key: projection(attrs[key], depth + 1)
        for key in ('objectType', 'entityToken', 'name', 'fullPathName', 'expression',
                    'unit', 'assemblyContext', 'nativeObject', 'values', 'calls') if key in attrs}}


def capture_suites():
    modules = [importlib.import_module(name) for name in SUITES]
    fixture_modules = set(SUITES) | {'model_test', 'shapes_test', 'sketch_test'}
    result = {}
    for family, module in zip(FAMILIES, modules):
        suite = unittest.defaultTestLoader.loadTestsFromModule(module)
        for group in suite:
            for case in group:
                # Fixture IDs, including native/proxy tokens, start identically.
                for name in fixture_modules:
                    entity = getattr(sys.modules.get(name), 'Entity', None)
                    if entity is not None and hasattr(entity, 'serial'):
                        entity.serial = 0
                events = []

                def profile(frame, event, arg):
                    if event not in ('call', 'return') or frame.f_globals.get('__name__') not in fixture_modules:
                        return
                    instance = frame.f_locals.get('self')
                    if instance is None or isinstance(instance, unittest.TestCase):
                        return
                    if event == 'call':
                        count = frame.f_code.co_argcount
                        payload = {key: projection(frame.f_locals[key])
                                   for key in frame.f_code.co_varnames[:count]
                                   if key not in ('self', 'ns', 'namespace') and key in frame.f_locals}
                    else:
                        payload = projection(arg)
                    events.append([event, type(instance).__name__, frame.f_code.co_name, payload])

                outcome = unittest.TestResult()
                sys.setprofile(profile)
                try:
                    case.run(outcome)
                finally:
                    sys.setprofile(None)
                if not outcome.wasSuccessful():
                    raise AssertionError(str(outcome.errors + outcome.failures))
                encoded = json.dumps(events, sort_keys=True, allow_nan=True).encode()
                result[case.id()] = {'family': family, 'events': len(events),
                                     'sha256': hashlib.sha256(encoded).hexdigest()}
    return result


def capture_handler_inventory():
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    namespace = {}
    inventory = {}
    paths = sorted(path for path in (ROOT / 'assets/cad').glob('*.py') if path.stem != 'core')
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        load_legacy_core(namespace, ROOT)
        for path in paths:
            before = dict(namespace.get('CAD_HANDLERS', {}))
            exec(compile(path.read_text(), str(path), 'exec'), namespace)
            if path.stem in FAMILIES:
                inventory[path.stem] = sorted(name for name, handler in namespace['CAD_HANDLERS'].items()
                                               if before.get(name) is not handler)
    return inventory


class AssemblyParityTests(unittest.TestCase):
    def test_all_family_fake_sdk_calls_match_pre_migration(self):
        golden = json.loads(GOLDEN.read_text())
        actual = capture_suites()
        self.assertEqual(set(FAMILIES), {entry['family'] for entry in actual.values()})
        self.assertTrue(POST_BASELINE_CASES.isdisjoint(golden['cases']))
        self.assertEqual(set(actual), set(golden['cases']) | POST_BASELINE_CASES)
        for name, trace in golden['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(actual[name], trace)

    def test_registry_runtime_suites_match_the_same_oracle(self):
        run = subprocess.run([sys.executable, '-B', str(Path(__file__)), '--registry-traces'],
                             cwd=ROOT, capture_output=True, text=True, check=True)
        actual = json.loads(run.stdout)
        expected = json.loads(GOLDEN.read_text())['cases']
        self.assertTrue(POST_BASELINE_CASES.isdisjoint(expected))
        self.assertEqual(set(actual), set(expected) | POST_BASELINE_CASES)
        self.assertEqual({name: trace for name, trace in actual.items()
                          if name not in POST_BASELINE_CASES}, expected)

    def test_domain_and_application_import_cleanly_without_sdk(self):
        original_import = builtins.__import__

        def no_sdk(name, *args, **kwargs):
            if name == 'adsk' or name.startswith('adsk.'):
                raise AssertionError('Pure module imported the SDK: ' + name)
            return original_import(name, *args, **kwargs)

        for path in [*(ROOT / 'runtime/python/fmcad/domain').glob('*.py'),
                     *(ROOT / 'runtime/python/fmcad/application').glob('*.py')]:
            if path.stem not in FAMILIES:
                continue
            with self.subTest(path=path), patch('builtins.__import__', no_sdk):
                source = path.read_text()
                tree = ast.parse(source)
                for node in ast.walk(tree):
                    if isinstance(node, ast.FunctionDef):
                        self.assertNotIn('ctx', [arg.arg for arg in node.args.args])
                exec(compile(source, str(path), 'exec'), {})

    def test_pure_family_rules_execute_on_plain_data(self):
        def domain(family):
            path = ROOT / 'runtime/python/fmcad/domain' / (family + '.py')
            ns = {}
            exec(compile(path.read_text(), str(path), 'exec'), ns)
            return ns

        assembly = domain('assembly')
        self.assertEqual(assembly['_assembly_name']('mount'), 'mount')
        with self.assertRaisesRegex(ValueError, 'allInstances'):
            assembly['_assembly_nested_options']({'sharedParentPolicy': 'one'})
        identity = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
        moved = list(identity)
        moved[3] = 2.
        self.assertEqual(assembly['_assembly_pose_delta'](identity, moved), (2., 0.))

        pose = domain('pose')
        pose['_pose_validate_fields']({'fillState': 'EMPTY', 'service': {'disconnections': []}})
        with self.assertRaisesRegex(ValueError, 'FREE'):
            pose['_pose_validate_fields']({'springState': 'invented'})
        self.assertEqual(pose['_pose_manifest_data']('open', 2, {}, {'name': 'doc'}, 'now', 'schema')['revision'], 2)

        mechanism = domain('mechanism')
        self.assertAlmostEqual(mechanism['_mechanism_driven'](
            {'type': 'screw', 'lead': 2., 'zeroPhase': 0., 'drivenZero': 0.}, 2 * 3.141592653589793), 2.)

        route = domain('route3d')
        points = [[0., 0., 0.], [2., 0., 0.]]
        self.assertEqual(route['_arc_length'](points), 2.)
        self.assertEqual(route['_point_at_station'](points, 1.), [1., 0., 0.])

        sequence = {}
        path = ROOT / 'runtime/python/fmcad/application/sequence.py'
        exec(compile(path.read_text(), str(path), 'exec'), sequence)
        self.assertEqual(sequence['_sequence_plan']({'parts': ['base', 'lid'], 'dependencies': [['base', 'lid']]})['order'], ['base', 'lid'])
        self.assertEqual(sequence['_sequence_plan']({'parts': ['a', 'b'], 'dependencies': [['a', 'b'], ['b', 'a']]})['cycles'], ['a', 'b'])

        spring = domain('spring')
        params = {'hand': 'right', 'turns': 2., 'startPhase': 0., 'radius': 1., 'pitch': 3.}
        self.assertEqual(spring['_helix_samples'](params)[-1][2], 6.)
        self.assertGreater(spring['_helix_metrics'](params)['arcLength'], 6.)

        thread = domain('thread')
        thread['_thread_profile_fields']({'majorDiameter': '10 mm', 'pitch': '1 mm'}, 'thread')
        self.assertEqual(thread['_thread_lead'](10., 1., None, 'thread'), (None, None))
        self.assertEqual(thread['_thread_lead'](10., 1., 3, 'thread'), (3., 3.))

        fastener = domain('fastener')
        self.assertEqual(fastener['_locating_dof']('two-pin', [{'clearance': 0.}], .01), (4, True, 1))

        gear = domain('gear')
        self.assertEqual(gear['_gear_diameter_plan'](.1, 20, .3, {})['pitch'], 2.)

        sheet = domain('sheetmetal')
        segments = [{'index': 0, 'type': 'flat', 'length': 2.}]
        self.assertEqual(sheet['_formed_walk'](segments, {})[0][-1], [2., 0., 0.])
        self.assertEqual(sheet['_flat_walk'](segments, {})[0][-1], [2., 0., 0.])

        definitions = domain('definitions')
        record = {'bindings': [{'parameter': 'a'}, {'parameter': 'b'}]}
        self.assertEqual(definitions['_definition_regeneration_bindings'](record, {'b': '2 mm', 'a': '1 mm'}), record['bindings'])
        with self.assertRaisesRegex(ValueError, 'migration'):
            definitions['_definition_regeneration_bindings'](record, {'unknown': '3 mm'})


if __name__ == '__main__' and sys.argv[1:] == ['--registry-traces']:
    read_text = Path.read_text
    values = read_text(ROOT / 'runtime/python/fmcad/domain/values.py')

    def runtime_source(path, *args, **kwargs):
        if path.parent == ROOT / 'assets/cad' and path.stem in FAMILIES:
            family = path.stem
            prefix = "_assembly_seed = CAD_HANDLERS\n" + values + '''
CAD_HANDLERS = HandlerRegistry([('shapes', 'spring', 'shape.helix'), ('model', 'thread', 'model.thread')])
for _assembly_key, _assembly_handler in _assembly_seed.items():
    dict.__setitem__(CAD_HANDLERS, _assembly_key, _assembly_handler)
    CAD_HANDLERS.owners[_assembly_key] = 'shapes' if _assembly_key == 'shape.helix' else 'model'
'''
            layers = ['domain', *(['application'] if family == 'sequence' else []), 'adapters/fusion']
            return prefix + '\n\n'.join(read_text(ROOT / 'runtime/python/fmcad' / layer / path.name)
                                          for layer in layers)
        return read_text(path, *args, **kwargs)

    with patch.object(Path, 'read_text', runtime_source):
        print(json.dumps(capture_suites(), sort_keys=True))
elif __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--record-baseline':
    commit = sys.argv[2]
    sources = {ROOT / 'assets/cad' / (family + '.py'):
               subprocess.check_output(['git', 'show', commit + ':assets/cad/' + family + '.py'], cwd=ROOT).decode()
               for family in FAMILIES}
    sources[ROOT / 'runtime/python/fmcad/adapters/fusion/assembly.py'] = sources[ROOT / 'assets/cad/assembly.py']
    read_text = Path.read_text

    def original_source(path, *args, **kwargs):
        return sources[path] if path in sources else read_text(path, *args, **kwargs)

    with patch.object(Path, 'read_text', original_source):
        cases = capture_suites()
        handlers = capture_handler_inventory()
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps({'baselineCommit': commit, 'handlers': handlers, 'cases': cases}, indent=2) + '\n')
elif __name__ == '__main__':
    unittest.main()
