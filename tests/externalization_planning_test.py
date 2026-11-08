"""Pure externalization plans, compared with frozen historical function bodies."""
import ast
import copy
import hashlib
import json
from pathlib import Path
from typing import cast
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/file-workflows'
DOMAIN = ROOT / 'runtime/python/fmcad/domain/externalization.py'


def require(value, message):
    if not value:
        raise ValueError(message)
    return value


def versions():
    manifest = json.loads((FIXTURES / 'manifest.json').read_text())
    for label in ('baseline', 'before', 'current'):
        ns = {'TYPE_CHECKING': False, '_external_cast': cast, '_external_require': require}
        if label == 'current':
            source = DOMAIN.read_text()
        else:
            row = next(r for r in manifest if r['file'] == label + '-externalization-planning.py.txt')
            raw = (FIXTURES / row['file']).read_bytes()
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise AssertionError('Historical planning source hash mismatch')
            source = raw.decode()
        exec(compile(source, label, 'exec'), ns)
        yield label, ns


def fixture():
    binding = {'sourceFileId': 'driver', 'sourceParameter': 'Width',
               'nativeDerivedParameter': 'Width_Ref', 'consumerAlias': 'Alias'}
    edge = {'edgeId': 'derive-edge', 'edgeIdentityUnique': True, 'kind': 'derive',
            'sourceFileId': 'driver', 'sourceParameters': [{'name': 'Width'}],
            'derivedParameters': [{'name': 'Width_Ref'}], 'targetVersion': 5}
    probe = {'refresh': {'reportPath': '/owned/refresh', 'nativeFallback': 'qualifiedOnce',
                        'driverUiLeases': {'consumer': {'token': 'driver'}},
                        'restoreUiLeases': {'consumer': {'token': 'restore'}}}}
    state = {'targetPin': {'projectId': 'project', 'fileId': 'consumer', 'version': 3},
             'source': {'projectId': 'project', 'fileId': 'driver', 'version': 5},
             'publishedVersion': 5,
             'refreshBindings': [{**binding, 'edgeId': 'derive-edge'}],
             'baselineEdges': [{'edgeId': 'derive-edge', 'sourceFileId': 'driver', 'baselineVersion': 4}]}
    return binding, edge, probe, state


class ExternalizationPlanningTests(unittest.TestCase):
    def test_requests_and_restore_preserve_exact_identity_without_mutating_input(self):
        observed = []
        for label, ns in versions():
            with self.subTest(version=label):
                binding, edge, probe, state = fixture()
                bindings = ns['_external_probe_refresh_bindings']([binding], [edge])
                state['refreshBindings'] = bindings
                before = copy.deepcopy(state)
                forward = ns['_external_probe_refresh_plan_request']({'operationId': 'op'}, probe, state, 'width')
                self.assertEqual(state, before)
                self.assertEqual(forward['root'], state['targetPin'])
                state['refreshRequest'] = forward
                plan = {'planId': 'immutable', 'invocationStatus': 'complete', 'root': forward['root'], 'edges': [edge]}
                ns['_external_probe_validate_refresh_plan'](state, plan)
                applied = ns['_external_probe_refresh_apply_request']({'operationId': 'op'}, probe, state, 'width', plan)
                state = {**state, 'restoring': True, 'targetPin': {**state['targetPin'], 'version': 4},
                         'source': {**state['source'], 'version': 6}, 'publishedVersion': 6}
                restored = ns['_external_probe_refresh_plan_request']({'operationId': 'op'}, probe, state, 'width')
                state['refreshRequest'] = restored
                receipt = {**plan, 'root': restored['root'], 'edges': [{**edge, 'targetVersion': 6}]}
                ns['_external_probe_validate_refresh_plan'](state, receipt)
                restore_apply = ns['_external_probe_refresh_apply_request']({'operationId': 'op'}, probe, state, 'width', receipt)
                self.assertEqual(restore_apply['uiLeases'], probe['refresh']['restoreUiLeases'])
                self.assertEqual(restore_apply['root']['version'], 4)
                self.assertEqual(applied['uiLeases'], probe['refresh']['driverUiLeases'])
                observed.append((bindings, forward, applied, restored, restore_apply))
        self.assertEqual(observed[1:], [observed[0], observed[0]])

    def test_ambiguous_driver_edges_never_choose_a_first_match(self):
        for label, ns in versions():
            with self.subTest(version=label):
                binding, edge, _, _ = fixture()
                for edges in ([], [edge, {**edge, 'edgeId': 'other'}]):
                    with self.assertRaisesRegex(ValueError, 'uniquely identify'):
                        ns['_external_probe_refresh_bindings']([binding], edges)

    def test_changed_publication_or_foreign_target_is_rejected(self):
        for label, ns in versions():
            with self.subTest(version=label):
                _, edge, probe, state = fixture()
                with self.assertRaisesRegex(ValueError, 'settled producer publication'):
                    ns['_external_probe_refresh_plan_request']({'operationId': 'op'}, probe,
                        {**state, 'publishedVersion': 6}, 'width')
                state['refreshRequest'] = ns['_external_probe_refresh_plan_request']({'operationId': 'op'}, probe, state, 'width')
                plan = {'planId': 'immutable', 'invocationStatus': 'complete',
                        'root': {**state['targetPin'], 'fileId': 'foreign'}, 'edges': [edge]}
                with self.assertRaisesRegex(ValueError, 'exact saved consumer baseline'):
                    ns['_external_probe_refresh_apply_request']({'operationId': 'op'}, probe, state, 'width', plan)
                with self.assertRaisesRegex(ValueError, 'exact producer publication'):
                    ns['_external_probe_validate_refresh_plan'](state, {'edges': [{**edge, 'targetVersion': 6}]})

    def test_unrelated_dependency_cannot_advance_in_a_driver_plan(self):
        for label, ns in versions():
            with self.subTest(version=label):
                _, edge, _, state = fixture()
                state['baselineEdges'].append({'edgeId': 'other', 'sourceFileId': 'other', 'baselineVersion': 2})
                plan = {'edges': [edge, {'edgeId': 'other', 'sourceFileId': 'other', 'targetVersion': 3}]}
                with self.assertRaisesRegex(ValueError, 'Unrelated dependency drift'):
                    ns['_external_probe_validate_refresh_plan'](state, plan)

    def test_planning_functions_have_one_domain_implementation_without_sdk_globals(self):
        names = set(next(r['symbols'] for r in json.loads((FIXTURES / 'manifest.json').read_text())
                         if r['file'] == 'before-externalization-planning.py.txt'))
        domain_functions = {n.name for n in ast.parse(DOMAIN.read_text()).body if isinstance(n, ast.FunctionDef)}
        adapter = ROOT / 'runtime/python/fmcad/adapters/fusion/externalization.py'
        adapter_functions = {n.name for n in ast.parse(adapter.read_text()).body if isinstance(n, ast.FunctionDef)}
        self.assertTrue(names <= domain_functions)
        self.assertFalse(names & adapter_functions)
        current = dict(versions())['current']
        self.assertNotIn('adsk', current)
        self.assertNotIn('_external_document', current)

class ExternalizationBoundaryTests(unittest.TestCase):
    def test_invalid_json_envelopes_fail_before_registry_or_sdk_access(self):
        ns = {'TYPE_CHECKING': False, 'CAD_HANDLERS': {}}
        for file in ('runtime/python/fmcad/domain/values.py',
                     'runtime/python/fmcad/domain/externalization.py',
                     'runtime/python/fmcad/adapters/fusion/externalization.py'):
            exec(compile((ROOT / file).read_text(), file, 'exec'), ns)
        for action, payload in ((None, {}), ('foreign', {}), ('inspect', None), ('perform', [])):
            with self.subTest(action=action, payload=payload):
                with self.assertRaisesRegex(ValueError, 'private externalization action|payload must be an object'):
                    ns['_external_refresh_internal'](action, payload)
        self.assertNotIn('adsk', ns)
