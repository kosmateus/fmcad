"""Offline doubles only; these tests are not a native qualification."""
import copy
import pathlib
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
NS = {}
for layer in ('domain', 'adapters/fusion', 'application'):
    path = ROOT / 'runtime/python/fmcad' / layer / 'semantic_model_state.py'
    exec(compile(path.read_text(), str(path), 'exec'), NS)

I = NS['_SEMANTIC_IDENTITY']


def translate(x, y=0, z=0):
    out = list(I)
    out[3], out[7], out[11] = x, y, z
    return out


def entity(path, role='body', source='shared-definition'):
    return {'role': role, 'instance': path,
            'source': {'id': source, 'document': {'fileId': 'source', 'version': 3}},
            'geometry': {'volumeCm3': 5.0}, 'pose': list(I), 'attributes': [],
            'topology': {'vertices': 8}, 'visibility': {'proxyVisible': True},
            'observedTokens': {'body': 'volatile'}}


def snapshot(entities):
    return {'schemaVersion': 2, 'status': 'partial', 'coverage': 'partial', 'precision': 'observational',
            'scope': {'kind': 'explicit-bindings', 'document': {'fileId': 'fixture'}},
            'entities': entities}


class SemanticDiffTests(unittest.TestCase):
    def setUp(self):
        self.before = snapshot([entity(['a']), entity(['a', 'b']), entity(['a', 'b', 'c']),
                                entity(['other', 'b', 'c']), entity([])])

    def diff(self, after, **kwargs):
        return NS['_semantic_diff'](self.before, after, **kwargs)

    def test_three_nested_repeated_root_reorder_and_tokens(self):
        after = copy.deepcopy(self.before)
        after['entities'].reverse()
        for row in after['entities']:
            row['observedTokens'] = {'body': 'new token'}
        result = self.diff(after)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['changes'], [])
        after['entities'][1]['geometry']['volumeCm3'] = 6
        result = self.diff(after)
        self.assertEqual(result['changes'][0]['instance'], ['other', 'b', 'c'])
        self.assertEqual(result['changes'][0]['channel'], 'geometry')

    def test_channels_and_authorized_subtree_are_explicit(self):
        after = copy.deepcopy(self.before)
        for row in after['entities']:
            row['pose'] = translate(3)
        result = self.diff(after, allowed_moved_subtrees=[['a']])
        self.assertEqual(result['status'], 'fail')
        self.assertEqual([c['allowed'] for c in result['changes']], [False, True, True, True, False])
        after = copy.deepcopy(self.before)
        after['entities'][2]['pose'] = translate(3)
        self.assertEqual(self.diff(after, allowed_moved_subtrees=[['a', 'b']])['status'], 'pass')
        for channel, value in [('geometry', {}), ('attributes', [{'name': 'changed'}]),
                               ('topology', {'vertices': 9}), ('visibility', {'proxyVisible': False})]:
            variant = copy.deepcopy(after)
            variant['entities'][2][channel] = value
            report = self.diff(variant, allowed_moved_subtrees=[['a']])
            self.assertEqual(report['status'], 'fail', channel)
            self.assertIn(channel, [c['channel'] for c in report['changes']])

    def test_missing_role_duplicate_source_version_and_missing_observation(self):
        after = copy.deepcopy(self.before)
        after['entities'].pop(2)
        self.assertEqual(self.diff(after)['changes'][0]['change'], 'removed')
        after = copy.deepcopy(self.before)
        after['entities'].append(copy.deepcopy(after['entities'][0]))
        after['entities'][-1]['source']['id'] = 'different-source-does-not-hide-duplicate'
        self.assertEqual(len(self.diff(after)['duplicates']['after']), 1)
        after = copy.deepcopy(self.before)
        after['entities'][2]['source']['document']['version'] = 4
        self.assertEqual(self.diff(after)['changes'][0]['channel'], 'source')
        after = copy.deepcopy(self.before)
        del after['entities'][2]['geometry']
        self.assertEqual(self.diff(after)['status'], 'partial')

    def test_precision_scope_and_invalid_inputs(self):
        after = copy.deepcopy(self.before)
        after['entities'][0]['geometry']['volumeCm3'] += 1e-8
        self.assertEqual(self.diff(after)['status'], 'pass')
        self.assertEqual(self.diff(after, tolerances={'geometry': 1e-10})['status'], 'fail')
        after['scope']['kind'] = 'all-bodies'
        self.assertTrue(self.diff(after)['scopeChanged'])
        for kwargs in ({'allowed_moved_subtrees': [[]]}, {'tolerances': {'pose': float('nan')}},
                       {'tolerances': {'unknown': 1}}):
            with self.assertRaises(ValueError):
                self.diff(self.before, **kwargs)
        with self.assertRaises(ValueError):
            NS['_semantic_diff']({'schemaVersion': 1}, self.before)


class FrameAuditTests(unittest.TestCase):
    def observation(self):
        return {'nativeChain': [translate(10), translate(0, 20), translate(0, 0, 30)],
                'proxyToRoot': translate(10, 20, 30), 'datumToRoot': translate(10, 20, 30),
                'brepWitnesses': [{'nativePoint': [1, 2, 3], 'proxyPoint': [11, 22, 33]}]}

    def test_independent_witnesses_not_roundtrip(self):
        observation = self.observation()
        self.assertEqual(NS['_semantic_frame_audit'](observation)['status'], 'pass')
        observation['datumToRoot'] = translate(20, 40, 60)
        self.assertIn('datumProxyMismatch', NS['_semantic_frame_audit'](observation)['failures'])
        observation = self.observation()
        observation['brepWitnesses'][0]['proxyPoint'][0] += 1
        self.assertIn('brepPointMismatch', NS['_semantic_frame_audit'](observation)['failures'])
        observation = self.observation()
        observation['nativeChain'][1] = translate(10, 20)
        self.assertIn('nativeProxyMismatch', NS['_semantic_frame_audit'](observation)['failures'])

    def test_root_missing_witness_reflection_and_scale(self):
        self.assertEqual(NS['_semantic_frame_audit']({'nativeChain': [], 'proxyToRoot': I,
                         'datumToRoot': I, 'brepWitnesses': []})['status'], 'partial')
        for scale in (-1, 2):
            observation = self.observation()
            observation['proxyToRoot'][0] = scale
            self.assertIn('nonRigidFrame', NS['_semantic_frame_audit'](observation)['failures'])

    def test_rotated_parent_chain_has_correct_order_and_point_units(self):
        rotated = [0, -1, 0, 10, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        expected = list(rotated)
        expected[3], expected[11] = -10, 30
        observation = {'nativeChain': [rotated, translate(0, 20), translate(0, 0, 30)],
                       'proxyToRoot': expected, 'datumToRoot': expected,
                       'brepWitnesses': [{'nativePoint': [1, 2, 3], 'proxyPoint': [-12, 1, 33]}]}
        self.assertEqual(NS['_semantic_frame_audit'](observation)['status'], 'pass')
        observation['nativeChain'].reverse()
        self.assertIn('nativeProxyMismatch', NS['_semantic_frame_audit'](observation)['failures'])

    def test_fusion_adapter_uses_root_proxy_once_and_native_chain_separately(self):
        class Collection:
            def __init__(self, values):
                self.values, self.count = values, len(values)
            def item(self, i):
                return self.values[i]

        def matrix(values):
            return types.SimpleNamespace(asArray=lambda: values)

        document = types.SimpleNamespace(isSaved=True, creationId='scratch',
                                        dataFile=types.SimpleNamespace(id='file', versionNumber=1))
        design = types.SimpleNamespace(parentDocument=document)
        component = types.SimpleNamespace(parentDesign=design)
        proxy_vertex = types.SimpleNamespace(geometry=types.SimpleNamespace(x=11, y=22, z=33))
        vertex = types.SimpleNamespace(geometry=types.SimpleNamespace(x=1, y=2, z=3),
                                       createForAssemblyContext=lambda o: proxy_vertex)
        native = types.SimpleNamespace(parentComponent=component, isLightBulbOn=True,
                                      vertices=Collection([vertex]))
        native.createForAssemblyContext = lambda o: types.SimpleNamespace(isVisible=False)
        occurrences = []
        for path, root, local in [('a', translate(10), translate(10)),
                                  ('a+b', translate(10, 20), translate(0, 20)),
                                  ('a+b+c', translate(10, 20, 30), translate(0, 0, 30))]:
            occurrences.append(types.SimpleNamespace(fullPathName=path, component=component,
                transform2=matrix(root), nativeObject=types.SimpleNamespace(transform2=matrix(local))))
        ctx = types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=Collection(occurrences)),
                                    resolve=lambda ref, kind: native, design=design, assert_identity=lambda: None)
        data = {'ref': 'body', 'instance': ['a', 'b', 'c'], 'sourceId': 'source',
                'datumToRoot': translate(10, 20, 30),
                'datumSource': {'kind': 'fixture-analytic-placement', 'version': 1}}
        observation = NS['_semantic_fusion_frame_observation'](ctx, data)
        self.assertEqual(NS['_semantic_frame_audit'](observation)['status'], 'pass')
        self.assertFalse(observation['visibility']['proxyVisible'])
        self.assertEqual(observation['source']['document']['version'], 1)
        occurrences[-1].nativeObject = None
        with self.assertRaisesRegex(ValueError, 'Nested native'):
            NS['_semantic_fusion_frame_observation'](ctx, data)

    def test_capture_is_detached_and_registration_leaves_v1_untouched(self):
        request = {'scope': {'document': {'version': 1}}}
        rows = [entity(['instance'])]
        captured = NS['_semantic_capture'](lambda r: rows, request)
        self.assertEqual(captured['status'], 'partial')
        self.assertEqual(captured['coverage'], 'partial')
        rows[0]['pose'][3] = 10
        request['scope']['document']['version'] = 2
        self.assertEqual(captured['entities'][0]['pose'][3], 0)
        self.assertEqual(captured['scope']['document']['version'], 1)
        v1 = object()
        registry = {'snapshot.diff': v1}
        NS['_semantic_register_handlers'](registry)
        self.assertIs(registry['snapshot.diff'], v1)
        self.assertEqual(len(registry), 4)

    def test_fusion_root_capture_channels_and_scope_guard(self):
        class Collection:
            def __init__(self, values):
                self.values, self.count = values, len(values)
            def item(self, i):
                return self.values[i]
        document = types.SimpleNamespace(isSaved=True, creationId='scratch',
                                        dataFile=types.SimpleNamespace(id='file', versionNumber=1))
        root = types.SimpleNamespace(parentDesign=types.SimpleNamespace(parentDocument=document))
        point = lambda x: types.SimpleNamespace(x=x, y=x, z=x)
        body = types.SimpleNamespace(parentComponent=root, entityToken='body-token',
            volume=6, area=22, boundingBox=types.SimpleNamespace(minPoint=point(0), maxPoint=point(3)),
            faces=Collection([1]*6), edges=Collection([1]*12), vertices=Collection([1]*8),
            shells=Collection([1]), isLightBulbOn=False, isVisible=False,
            attributes=Collection([types.SimpleNamespace(groupName='z', name='b', value='2'),
                                   types.SimpleNamespace(groupName='a', name='b', value='1')]))
        checks = []
        ctx = types.SimpleNamespace(root=root, design=root.parentDesign,
                                    resolve=lambda ref, kind: body, assert_identity=lambda: checks.append(True))
        request = {'scope': {'kind': 'explicit-bindings',
                            'document': {'creationId': 'scratch', 'fileId': 'file', 'version': 1}},
                   'bindings': [{'role': 'root-body', 'sourceId': 'body-source', 'ref': 'body', 'instance': []}]}
        captured = NS['_semantic_snapshot_v2'](ctx, request)
        self.assertEqual(len(checks), 2)
        row = captured['entities'][0]
        self.assertEqual(row['pose'], I)
        self.assertEqual(row['geometry']['volumeCm3'], 6)
        self.assertEqual(row['attributes'][0]['group'], 'a')
        self.assertEqual(row['topology']['edges'], 12)
        self.assertFalse(row['visibility']['proxyVisible'])
        request['scope']['document']['version'] = 2
        with self.assertRaisesRegex(ValueError, 'Scope'):
            NS['_semantic_snapshot_v2'](ctx, request)

    def test_native_recipe_refuses_without_separate_consent_or_matching_identity(self):
        ns = {}
        script = ROOT / 'tests/native/semantic-model-state/qualify.py'
        source = script.read_text()
        exec(compile(source, str(script), 'exec'), ns)
        self.assertTrue(callable(ns['run']))
        self.assertIn("expectedFusionBuild') != fusion_build", source)
        self.assertIn("'document.clear'", source)
        self.assertIn("target_document.close(False)", source)
        self.assertNotIn("app.activeDocument.activate", source)
        self.assertIn("'path': repeated.fullPathName", source)
        self.assertIn("entity = facade.resolve(ref)", source)
        self.assertIn("expected_document_name.startswith(DOC_PREFIX)", source)
        self.assertIn("left-open-for-inspection", source)
        with self.assertRaisesRegex(RuntimeError, 'consent'):
            ns['qualify'](None, {})
        prefix = 'SEMTEST01'
        doc_name = ns['DOC_PREFIX'] + prefix + ' v1'
        args = {'confirmNativeQualification': True, 'runId': 'run-offline-test',
                'fixturePrefix': prefix, 'documentName': doc_name,
                'documentFileName': doc_name,
                'projectId': 'project', 'folderId': 'folder', 'fileId': 'file',
                'creationId': 'creation', 'version': 1, 'expectedFusionBuild': '2706.1.14'}
        facade = types.SimpleNamespace(call=lambda op, data: {'name': 'UserModel'})
        with self.assertRaisesRegex(RuntimeError, 'Dedicated scratch'):
            ns['qualify'](facade, args)
        matching_name_status = {'name': doc_name, 'projectId': 'project', 'folderId': 'folder',
                                'fileId': 'file', 'creationId': 'creation', 'version': 1,
                                'saved': True, 'isReadOnly': False, 'isComplete': True}
        facade = types.SimpleNamespace(call=lambda op, data: matching_name_status)
        with self.assertRaisesRegex(RuntimeError, 'Saved scratch file name differs'):
            ns['qualify'](facade, args)

    def test_native_recipe_only_discards_after_complete_pass_and_restore(self):
        ns = {}
        script = ROOT / 'tests/native/semantic-model-state/qualify.py'
        exec(compile(script.read_text(), str(script), 'exec'), ns)
        report = {'nativeModelQualification': 'pass',
                  'checks': [{'passed': True}, {'passed': True}],
                  'restoration': {'pose': 'verified-by-independent-capture',
                                  'visibility': 'verified-by-readback'}}
        self.assertTrue(ns['_native_pass_is_discardable'](report))
        report['checks'][1]['passed'] = False
        self.assertFalse(ns['_native_pass_is_discardable'](report))
        report['checks'][1]['passed'] = True
        report['restoration']['pose'] = 'unknown-or-failed'
        self.assertFalse(ns['_native_pass_is_discardable'](report))


if __name__ == '__main__':
    unittest.main()
