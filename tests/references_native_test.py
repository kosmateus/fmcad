"""Offline source/API-contract checks; no Fusion kernel is simulated here."""
import ast
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ReferencesEngineTests(unittest.TestCase):
    def setUp(self):
        self.ns = {'_cad_items': lambda collection: list(collection)}
        exec(compile((ROOT / 'assets/cad/references.py').read_text(), 'references.py', 'exec'), self.ns)

    def _versioned_project(self):
        class DataFiles:
            def __init__(self, items): self._items = items
            @property
            def count(self): return len(self._items)
            def item(self, index): return self._items[index]
            def __iter__(self): return iter(self._items)

        project = types.SimpleNamespace(id='project')
        folder = types.SimpleNamespace(id='folder', dataFiles=[], dataFolders=[])
        project.rootFolder = folder
        versions = [types.SimpleNamespace(id='source-file', name='SameName', versionNumber=number,
            latestVersionNumber=3, parentProject=project, parentFolder=folder,
            isComplete=True, isReadOnly=False) for number in (3, 2, 1)]
        versions[0].versions = DataFiles(versions)
        folder.dataFiles = [versions[0]]
        app = types.SimpleNamespace(data=types.SimpleNamespace(dataProjects=[project]))
        return app, project, folder, versions

    def test_project_file_resolves_exact_historical_version_without_latest_or_name_fallback(self):
        app, _project, _folder, versions = self._versioned_project()
        exact = self.ns['_references_project_file'](app, 'project', 'source-file', 2)
        self.assertIs(exact, versions[1])
        self.assertEqual(exact.versionNumber, 2)
        self.assertEqual(exact.latestVersionNumber, 3)
        pinned = self.ns['_references_project_file'](app, 'project', 'source-file', 1)
        self.assertIs(pinned, versions[2])
        with self.assertRaisesRegex(ValueError, 'latest/name fallback refused'):
            self.ns['_references_project_file'](app, 'project', 'source-file', 4)

    def test_nested_native_token_unavailable_keeps_distinct_proxy_and_native_attribute_evidence(self):
        class Native:
            attributes=[types.SimpleNamespace(groupName='ROLE',name='native',value='leaf')]
            @property
            def entityToken(self):raise RuntimeError('3 : Tokens can only be created for proxies whose top-level parent is the root component.')
        native=Native()
        proxy=types.SimpleNamespace(entityToken='root-qualified-proxy',fullPathName='Carrier:1+Leaf:1',nativeObject=native,
            component=types.SimpleNamespace(entityToken='leaf-definition',name='Leaf'),assemblyContext=object(),
            isDerived=False,isReferencedComponent=False,
            transform2=types.SimpleNamespace(asArray=lambda:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
            attributes=[types.SimpleNamespace(groupName='ROLE',name='context',value='north')])
        root=types.SimpleNamespace(entityToken='root',attributes=[],bRepBodies=[],features=[],allOccurrences=[proxy])
        self.ns['_references_own_components']=lambda root:[root]
        result=self.ns['_references_metadata'](object(),root)
        self.assertTrue(result['metadataComplete']);self.assertIsNone(result['occurrences'][0]['nativeToken'])
        self.assertEqual(result['occurrences'][0]['nativeAttributeLocator'],'nativeObjectOf:root-qualified-proxy')
        self.assertTrue(any(r['kind']=='nativeObject' and r['name']=='native' and r['value']=='leaf' for r in result['attributes']))
        self.assertTrue(any(r['kind']=='nativeOccurrence' and r['name']=='context' and r['value']=='north' for r in result['attributes']))

    def test_direct_cloud_id_lookup_is_project_pinned_and_never_walks_unrelated_folders(self):
        app, _project, _folder, versions = self._versioned_project()
        calls = []
        versions[1].latestVersion = versions[0]
        app.data.findFileById = lambda fid: (calls.append(fid), versions[1])[1]
        self.ns['_references_walk_files'] = lambda *args: self.fail('unexpected project-wide scan')
        self.assertIs(self.ns['_references_project_file'](app, 'project', 'source-file'), versions[0])
        self.assertIs(self.ns['_references_project_file'](app, 'project', 'source-file', 1), versions[2])
        self.assertEqual(calls, ['source-file', 'source-file'])
        versions[1].parentProject = types.SimpleNamespace(id='other-project')
        with self.assertRaisesRegex(ValueError, 'allowed project'):
            self.ns['_references_project_file'](app, 'project', 'source-file')

    def test_derive_baseline_stays_reference_version_while_latest_comes_from_project_datafile(self):
        app, project, _folder, versions = self._versioned_project()
        stale_reference_file = types.SimpleNamespace(id='source-file', versionNumber=2,
            latestVersionNumber=2, parentProject=project)
        reference = types.SimpleNamespace(dataFile=stale_reference_file, version=2)
        doc = types.SimpleNamespace(dataFile=types.SimpleNamespace(childReferences=[]))
        row = self.ns['_references_edge_version'](doc, reference, 'source-file', 1,
            app, {'project'})
        self.assertEqual(row['baselineVersion'], 2)
        self.assertEqual(row['dataFileVersion'], 2)
        self.assertEqual(row['latestVersion'], 3)
        self.assertEqual(row['latestVersionSource'], 'project_datafile')
        self.assertEqual(self.ns['_references_target_file'](app, 'project', 'source-file',
                         row['latestVersion'], stale_reference_file), versions[0])
        baseline_file = self.ns['_references_target_file'](app, 'project', 'source-file',
                         row['baselineVersion'], stale_reference_file)
        self.assertEqual(baseline_file.id, 'source-file')
        self.assertEqual(baseline_file.versionNumber, 2)

    def test_child_references_supplement_only_one_proven_forward_edge(self):
        source = types.SimpleNamespace(id='source-file', versionNumber=6, latestVersionNumber=7,
                                       parentProject=types.SimpleNamespace(id='project'))
        class Reference:
            dataFile = source
            @property
            def version(self): raise RuntimeError('2 : InternalValidationError : doc')
        ref = Reference()
        doc = types.SimpleNamespace(dataFile=types.SimpleNamespace(childReferences=[
            types.SimpleNamespace(id='source-file', versionNumber=6)]))
        resolved = self.ns['_references_edge_version'](doc, ref, 'source-file', 1)
        self.assertEqual(resolved['baselineVersion'], 6, resolved)
        self.assertEqual(resolved['versionSource'], 'saved_forward_cloud_reference')
        self.assertIn('InternalValidationError : doc', resolved['getterError'])

    def test_ambiguous_or_reverse_cloud_metadata_never_guesses_a_derive_version(self):
        source = types.SimpleNamespace(id='source-file', versionNumber=6, latestVersionNumber=7,
                                       parentProject=types.SimpleNamespace(id='project'))
        class Reference:
            dataFile = source
            @property
            def version(self): raise RuntimeError('2 : InternalValidationError : doc')
        ref = Reference()
        doc = types.SimpleNamespace(dataFile=types.SimpleNamespace(childReferences=[
            types.SimpleNamespace(id='source-file', versionNumber=5),
            types.SimpleNamespace(id='source-file', versionNumber=6)]))
        ambiguous = self.ns['_references_edge_version'](doc, ref, 'source-file', 1)
        self.assertIsNone(ambiguous['baselineVersion'])
        self.assertEqual(ambiguous['versionSource'], 'unresolved')
        reverse_only = types.SimpleNamespace(dataFile=types.SimpleNamespace(childReferences=[
            types.SimpleNamespace(id='different-consumer', versionNumber=6)]))
        unresolved = self.ns['_references_edge_version'](reverse_only, ref, 'source-file', 2)
        self.assertIsNone(unresolved['baselineVersion'])
        self.assertEqual(unresolved['versionSource'], 'unresolved')

    def test_length_angle_and_unitless_values_keep_internal_and_display_units_distinct(self):
        units = types.SimpleNamespace(convert=lambda value, source, target: value * 10 if source == 'cm' and target == 'mm'
                                     else value * 180 / 3.141592653589793 if source == 'rad' and target == 'deg' else value)
        length = types.SimpleNamespace(name='length', expression='12 mm', unit='mm', value=1.2, isFavorite=True)
        angle = types.SimpleNamespace(name='angle', expression='90 deg', unit='deg', value=1.5707963267948966, isFavorite=False)
        one = types.SimpleNamespace(name='one', expression='1', unit='', value=1.0, isFavorite=False)
        self.assertEqual(self.ns['_references_parameter_value'](length, units), {
            'name': 'length', 'expression': '12 mm', 'dependsOn': None,
            'internal_value': 1.2, 'internal_unit': 'cm', 'display_value': 12.0,
            'display_unit': 'mm', 'isFavorite': True})
        angle_row = self.ns['_references_parameter_value'](angle, units)
        self.assertEqual((angle_row['internal_unit'], angle_row['display_unit'], angle_row['display_value']),
                         ('rad', 'deg', 90.0))
        scalar = self.ns['_references_parameter_value'](one, units)
        self.assertEqual((scalar['internal_value'], scalar['internal_unit'], scalar['display_unit']),
                         (1.0, '1', '1'))

    def test_derived_parameter_vector_without_count_is_still_enumerated(self):
        class IterableWithoutCount:
            def __iter__(self):
                return iter(['actual-derived-parameter'])
        self.assertEqual(self.ns['_references_items'](IterableWithoutCount()), ['actual-derived-parameter'])

    def test_occurrence_metadata_comparison_ignores_versioned_display_paths_but_keeps_pose_and_context(self):
        before = {'occurrences': [{'token': 'stable-occurrence', 'nativeToken': 'stable-native',
            'path': 'Part v2:1', 'componentToken': 'definition-v2', 'transform': [1, 0, 0, 0],
            'contextKind': 'native', 'isDerived': False, 'isReferencedComponent': True}]}
        after = {'occurrences': [{'token': 'stable-occurrence', 'nativeToken': 'stable-native',
            'path': 'Part v3:1', 'componentToken': 'definition-v3', 'transform': [1, 0, 0, 0],
            'contextKind': 'native', 'isDerived': False, 'isReferencedComponent': True}]}
        self.assertEqual(self.ns['_references_occurrence_states'](before),
                         self.ns['_references_occurrence_states'](after))
        moved = {'occurrences': [{**after['occurrences'][0], 'transform': [1, 0, 0, 1]}]}
        self.assertNotEqual(self.ns['_references_occurrence_states'](before),
                            self.ns['_references_occurrence_states'](moved))

    def test_cold_open_owned_lifecycle_can_claim_only_the_exact_captured_clean_editor(self):
        doc = types.SimpleNamespace(creationId='owned-root-editor')
        self.assertTrue(self.ns['_references_cold_editor_owned'](doc, {
            'lifecycle': 'openOwned', 'ownedCreationId': 'owned-root-editor'}))
        self.assertFalse(self.ns['_references_cold_editor_owned'](doc, {
            'lifecycle': 'existingOnly', 'ownedCreationId': 'owned-root-editor'}))
        self.assertFalse(self.ns['_references_cold_editor_owned'](doc, {
            'lifecycle': 'openOwned', 'ownedCreationId': 'different-editor'}))

    def test_preflight_observes_cold_derive_before_linked_collection_like_graph_capture(self):
        calls = []
        inventory=object()
        def derives(*args):
            self.assertIs(args[2],inventory)
            calls.append('derive')
            return [{'edgeId': 'derive'}]
        def linked(*args):
            self.assertIs(args[2],inventory)
            self.assertEqual(calls, ['derive'])
            calls.append('linked')
            return [{'edgeId': 'lazy-source-reference'}]
        self.ns.update(_references_owned_derives=derives, _references_linked_edges=linked,
            _references_forward_inventory=lambda ctx:inventory)
        self.assertEqual(self.ns['_references_current_edges'](object()),
            [{'edgeId': 'lazy-source-reference'}, {'edgeId': 'derive'}])

    def _echo_fixture(self):
        class Document:pass
        owner=Document();owner.creationId='owner-editor';owner.dataFile=types.SimpleNamespace(id='owner')
        source=Document();source.creationId='source-buffer'
        file=types.SimpleNamespace(id='source',versionNumber=3,parentProject=types.SimpleNamespace(id='project'))
        def reference():return types.SimpleNamespace(dataFile=file,version=3,parentDocument=owner,referencedDocument=source)
        ref=reference();derived=reference()
        feature=types.SimpleNamespace(entityToken='derive-feature',documentReference=derived,isSuppressed=False)
        owner.documentReferences=[ref]
        root=types.SimpleNamespace(occurrences=[],allOccurrences=[],features=types.SimpleNamespace(deriveFeatures=[feature]))
        return types.SimpleNamespace(doc=owner,root=root),ref,feature,reference

    def test_forward_inventory_normalizes_only_correlated_derive_collection_echo(self):
        ctx,ref,feature,_=self._echo_fixture()
        result=self.ns['_references_forward_inventory'](ctx)
        self.assertEqual(result['linked'],[])
        self.assertEqual(result['derives'],[(ctx.root,feature)])
        proof=result['deriveCollectionEchoes']['derive-feature']
        self.assertEqual((proof['sourceFileId'],proof['version'],proof['referencedCreationId']),('source',3,'source-buffer'))
        ctx.doc.documentReferences=[]
        cold=self.ns['_references_forward_inventory'](ctx)
        self.assertEqual(cold['linked'],result['linked']);self.assertEqual(cold['derives'],result['derives'])

    def test_forward_inventory_preserves_self_multiple_pins_and_distinct_uses(self):
        for case in ('self','ordinaryOccurrence','multipleCollectionRefs','multipleDerives','differentPin','differentDocument','differentOwner','explicitIdentity','suppressed','missingFeatureIdentity'):
            ctx,ref,feature,reference=self._echo_fixture()
            if case=='self':ctx.doc.dataFile.id='source'
            elif case=='ordinaryOccurrence':ctx.root.allOccurrences=[types.SimpleNamespace(isReferencedComponent=True,documentReference=reference())]
            elif case=='multipleCollectionRefs':ctx.doc.documentReferences.append(reference())
            elif case=='multipleDerives':ctx.root.features.deriveFeatures.append(types.SimpleNamespace(entityToken='another-use',documentReference=reference(),isSuppressed=False))
            elif case=='differentPin':ref.version=2
            elif case=='differentDocument':ref.referencedDocument=object()
            elif case=='differentOwner':ref.parentDocument=object()
            elif case=='explicitIdentity':ref.entityToken='ordinary-reference-identity'
            elif case=='suppressed':feature.isSuppressed=True
            elif case=='missingFeatureIdentity':feature.entityToken=None
            result=self.ns['_references_forward_inventory'](ctx)
            self.assertEqual(result['linked'],ctx.doc.documentReferences,case)
            self.assertEqual(result['deriveCollectionEchoes'],{},case)

    def test_forward_inventory_keeps_reference_when_pin_getter_is_unavailable(self):
        ctx,ref,feature,_=self._echo_fixture()
        class Unavailable:
            dataFile=ref.dataFile;parentDocument=ref.parentDocument;referencedDocument=ref.referencedDocument
            @property
            def version(self):raise RuntimeError('pin unavailable')
        ctx.doc.documentReferences=[Unavailable()]
        result=self.ns['_references_forward_inventory'](ctx)
        self.assertEqual(result['linked'],ctx.doc.documentReferences)
        self.assertEqual(result['deriveCollectionEchoes'],{})

    def _native_update_fixture(self, clock, time_budget_ms, initial_preflight_ms, execute_ms, direct=False):
        edge = {'edgeId': 'edge-1', 'ownerFileId': 'root-file', 'sourceFileId': 'source-file',
                'kind': 'linked', 'baselineVersion': 1,
                'targetVersion': 2, 'latestVersion': 2, 'scopeProjectAllowed': True,
                'explicitPin': False, 'selfReference': False}
        derive_edge = {'edgeId': 'derive-edge', 'ownerFileId': 'root-file', 'sourceFileId': 'parameter-source',
                'kind': 'derive', 'baselineVersion': 1, 'latestVersion': 2,
                'targetVersion': 2, 'scopeProjectAllowed': True, 'explicitPin': False,
                'selfReference': False, 'bindingCoverage': {'complete': True}}
        edges = [edge, derive_edge] if direct else [edge]
        snapshot = {'status': 'complete',
            'document': {'isUpToDate': False, 'health': {'healthy': True}},
            'edges': edges,
            'metadata': {'attributes': [], 'occurrences': [], 'consumedBodiesVerified': True,
                         'metadataComplete': True}}
        calls = {'preflight': 0, 'execute': 0, 'compute': 0, 'order': []}

        def preflight(_ctx, _data):
            calls['preflight'] += 1
            calls['order'].append('preflight')
            clock.now += (initial_preflight_ms if calls['preflight'] == 1 else 100) / 1000.0
            return snapshot

        class Command:
            isValid = True
            isNative = True
            def execute(self):
                calls['execute'] += 1
                calls['order'].append('execute')
                clock.now += execute_ms / 1000.0
                return True

        # Keep one clock shared by command execution and the Python time module.
        command = Command()
        command_definitions = types.SimpleNamespace(itemById=lambda _name: command)
        app = types.SimpleNamespace(userInterface=types.SimpleNamespace(
            activeCommand='SelectCommand', activeSelections=types.SimpleNamespace(count=0),
            commandDefinitions=command_definitions))
        doc = types.SimpleNamespace(dataFile=types.SimpleNamespace(id='root-file', versionNumber=1),
                                    isModified=False, isUpToDate=False)
        app.activeDocument = doc
        def compute():
            calls['compute'] += 1
            calls['order'].append('compute')
            return True
        design = types.SimpleNamespace(timeline=types.SimpleNamespace(markerPosition=7, count=7),
                                       snapshots=types.SimpleNamespace(hasPendingSnapshot=False), computeAll=compute)
        self.ns.update({'time': clock, 'adsk': types.SimpleNamespace(doEvents=lambda: setattr(clock, 'now', clock.now + .01)),
            '_references_feature_health': lambda _ctx: {'healthy': True},
            '_references_preflight': preflight,
            '_references_edge_snapshot_matches': lambda *args, **kwargs: (True, None),
            '_references_user_parameter_state': lambda *args, **kwargs: []})
        ctx = types.SimpleNamespace(doc=doc, app=app, design=design)
        data = {'confirm': True, 'command': 'UpdateAllLatestCmd', 'fileId': 'root-file',
            'projectId': 'project', 'version': 1, 'timeBudgetMs': time_budget_ms,
            'planEdges': edges, 'effectiveTargets': {}, 'edgeIds': [row['edgeId'] for row in edges],
            'parameterBindings': []}
        if direct:
            data.update({'method': 'UpdateAllLatestCmd', 'plannedMethod': 'UpdateAllLatestCmd',
                'nativeRoute': 'directPlanned', 'nativeFallback': 'qualifiedOnce',
                'update': {'method': 'UpdateAllLatestCmd', 'fallback': None},
                'parameterBindings': [{'edgeId': 'derive-edge', 'sourceParameter': 'sourceLength',
                    'nativeDerivedParameter': 'derivedLength'}]})
            self.ns['_references_binding_checks'] = lambda *args, **kwargs: {'passed': True, 'bindings': []}
        else:
            data.update({'method': 'document.updateAllReferences',
                'plannedMethod': 'document.updateAllReferences', 'nativeRoute': 'sdkFallback',
                'nativeFallback': 'qualifiedOnce',
                'update': {'method': 'document.updateAllReferences', 'fallback': 'UpdateAllLatestCmd'},
                'priorSdkResult': {'status': 'knownStale', 'modified': False,
                                   'after': {'edges': [edge]}}})
        return ctx, data, calls

    def test_native_update_preflight_cost_can_block_before_command_submission(self):
        class FakeClock:
            def __init__(self): self.now = 0.0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        clock = FakeClock()
        ctx, data, calls = self._native_update_fixture(clock, 15000, 6000, 0)
        result = self.ns['_references_native_update'](ctx, data)
        self.assertEqual(result['status'], 'blocked')
        self.assertTrue(result['notStarted'])
        self.assertFalse(result['actionSubmitted'])
        self.assertEqual(result['reason'], 'nativeUpdateBudgetInsufficientBeforeCommand')
        self.assertEqual(calls['execute'], 0)

    def test_native_update_poll_deadline_returns_settled_stale_report_inside_rpc_budget(self):
        class FakeClock:
            def __init__(self): self.now = 0.0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        clock = FakeClock()
        time_budget_ms = 25000
        ctx, data, calls = self._native_update_fixture(clock, time_budget_ms, 3000, 500)
        result = self.ns['_references_native_update'](ctx, data)
        self.assertEqual(calls['execute'], 1)
        self.assertEqual(result['status'], 'knownStale')
        self.assertEqual(result['outcome'], 'settled')
        self.assertTrue(result['actionSubmitted'])
        self.assertFalse(result['checks']['intendedReferencesCurrent'])
        self.assertEqual(result['before']['status'], 'complete')
        self.assertEqual(result['after']['status'], 'complete')
        self.assertLess(clock.now * 1000, time_budget_ms)
        self.assertEqual(calls['preflight'], 2, 'no metadata/graph/cloud scan inside the poll loop')
        self.assertEqual(calls['compute'], 0, 'unsettled update must not recompute')

    def test_native_update_computes_once_after_settlement_before_independent_readback(self):
        class FakeClock:
            def __init__(self): self.now = 0.0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        ctx, data, calls = self._native_update_fixture(FakeClock(), 25000, 3000, 500, direct=True)
        ctx.doc.isUpToDate = True
        result = self.ns['_references_native_update'](ctx, data)
        self.assertEqual(calls['order'], ['preflight', 'execute', 'compute', 'preflight'])
        self.assertEqual(result['status'], 'knownStale', 'status/compute success alone never proves bindings')
        self.assertFalse(result['checks']['intendedReferencesCurrent'])

    def test_native_recompute_failure_prevents_acceptance_without_second_command(self):
        class FakeClock:
            def __init__(self): self.now = 0.0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        ctx, data, calls = self._native_update_fixture(FakeClock(), 25000, 3000, 500)
        ctx.doc.isUpToDate = True
        ctx.design.computeAll = lambda: False
        result = self.ns['_references_native_update'](ctx, data)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'computeFailedAfterNativeUpdate')
        self.assertEqual(calls['execute'], 1)

    def test_direct_native_route_submits_once_without_synthetic_prior_sdk_result(self):
        class FakeClock:
            def __init__(self): self.now = 0.0
            def monotonic(self): return self.now
            def sleep(self, seconds): self.now += seconds
        clock = FakeClock()
        time_budget_ms = 25000
        ctx, data, calls = self._native_update_fixture(clock, time_budget_ms, 3000, 500, direct=True)
        self.assertNotIn('priorSdkResult', data)
        result = self.ns['_references_native_update'](ctx, data)
        self.assertEqual(calls['execute'], 1)
        self.assertEqual(result['status'], 'knownStale')
        self.assertEqual(result['outcome'], 'settled')
        self.assertTrue(result['actionSubmitted'])
        self.assertFalse(result['checks']['intendedReferencesCurrent'])
        self.assertEqual(result['before']['status'], 'complete')
        self.assertEqual(result['after']['status'], 'complete')
        self.assertLess(clock.now * 1000, time_budget_ms)

    def test_no_automatic_reselect_promote_lineage_replacement_or_derive_recreation(self):
        tree = ast.parse((ROOT / 'assets/cad/references.py').read_text())
        forbidden = {'setSourceEntities', 'promote', 'saveCopyAs', 'upload', 'deleteMe', 'sourceversion'}
        calls = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute): calls.add(func.attr)
                elif isinstance(func, ast.Name): calls.add(func.id)
        self.assertTrue(forbidden.isdisjoint(calls), sorted(forbidden & calls))

    def test_step_context_carries_the_resolved_exact_document_into_cad_context(self):
        tree = ast.parse((ROOT / 'assets/cad/references.py').read_text())
        function = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and
                        node.name == '_references_step_context')
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call) and
                 isinstance(node.func, ast.Name) and node.func.id == 'CadContext']
        self.assertEqual(len(calls), 1)
        self.assertTrue(any(keyword.arg == 'resolved_doc' and isinstance(keyword.value, ast.Name) and
                            keyword.value.id == 'doc' for keyword in calls[0].keywords))


if __name__ == '__main__':
    unittest.main()
