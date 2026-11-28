"""Offline contracts for the canonical references runtime family."""
import hashlib
from pathlib import Path
import types
import unittest
from typing import cast


ROOT = Path(__file__).resolve().parents[1]


def cad_items(collection):
    if isinstance(collection, (list, tuple)):
        return list(collection)
    return [collection.item(index) for index in range(collection.count)]


def fields(data, required, optional=()):
    if not isinstance(data, dict):
        raise TypeError('Operation data must be an object')
    missing = set(required) - data.keys()
    unknown = data.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError('Invalid fields')


def load_module(path, namespace=None):
    result = {} if namespace is None else namespace
    result['_CAD_TYPE_CHECKING'] = False
    exec(compile(path.read_text(), str(path), 'exec'), result)
    return result


class Collection:
    def __init__(self, items):
        self.items = list(items)

    @property
    def count(self):
        return len(self.items)

    def item(self, index):
        return self.items[index]


class ReferencesRuntimeTests(unittest.TestCase):
    def test_occurrence_snapshot_rule_matches_archived_sources_without_sdk(self):
        import copy
        import json
        base = ROOT / 'tests/fixtures/file-workflows'
        manifest = json.loads((base / 'manifest.json').read_text())
        rules = []
        for label in ('baseline', 'before'):
            row = next(row for row in manifest if row['file'] == label + '-reference-occurrence.py.txt')
            source = (base / row['file']).read_bytes()
            self.assertEqual(hashlib.sha256(source).hexdigest(), row['sha256'])
            namespace = {'_cad_cast': cast}
            exec(compile(source, row['sourcePath'], 'exec'), namespace)
            rules.append(namespace['_references_occurrence_states'])
        rules.append(load_module(ROOT / 'runtime/python/fmcad/domain/references.py', {'_cad_cast': cast})['_references_occurrence_states'])
        cases = [{}, {'occurrences': [{'token': ''}]}, {'occurrences': [
            {'token': 'z', 'nativeToken': 'native-z', 'transform': [1, 2], 'contextKind': 'owned', 'isDerived': False},
            {'token': 'a', 'nativeToken': 'native-a', 'isReferencedComponent': True}]}]
        for value in cases:
            observations = []
            for rule in rules:
                copied = copy.deepcopy(value)
                observations.append(rule(copied))
                self.assertEqual(copied, value)
            self.assertEqual(observations[0], observations[1])
            self.assertEqual(observations[0], observations[2])

    def test_private_reference_wire_refuses_invalid_payload_before_sdk(self):
        runtime = load_module(ROOT / 'runtime/python/fmcad/adapters/fusion/references.py', {'_cad_cast': cast})
        for action in (None, [], 'foreign'):
            with self.assertRaisesRegex(ValueError, 'Unknown private references.refresh SDK action'):
                runtime['_references_refresh_internal'](action, {})
        for action in ('graph', 'preflight', 'sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'):
            with self.assertRaisesRegex(ValueError, 'references.refresh data must be an object'):
                runtime['_references_refresh_internal'](action, None)

    def test_domain_edge_identity_snapshot_and_private_field_projection(self):
        rules = load_module(ROOT / 'runtime/python/fmcad/domain/references.py', {'_cad_cast': cast})
        edge_id = rules['_references_edge_id']('owner', 'linked', 'source', 'token')
        self.assertEqual(edge_id, 'edge:' + hashlib.sha256(b'owner\0linked\0source\0token').hexdigest())
        row = {'edgeId': edge_id, 'ownerFileId': 'owner', 'sourceFileId': 'source',
               'kind': 'linked', 'baselineVersion': 2, 'latestVersion': 3,
               '_sourceDataFile': object()}
        public = rules['_references_public_edges']([row])
        self.assertEqual(public, [{key: value for key, value in row.items() if not key.startswith('_')}])
        self.assertEqual(rules['_references_edge_snapshot_matches'](
            [row], [row], 'owner', {'edge:' + hashlib.sha256(b'owner\0linked\0source\0token').hexdigest(): 3}),
            (True, None))
        drifted = {**row, 'baselineVersion': 1}
        self.assertEqual(rules['_references_edge_snapshot_matches'](
            [drifted], [row], 'owner'), (False, 'forwardEdgeVersionDrift'))

    def test_canonical_adapter_resolves_exact_project_version_and_rejects_missing_pin(self):
        runtime = load_module(ROOT / 'runtime/python/fmcad/adapters/fusion/references.py', {
            '_cad_items': cad_items,
            '_cad_cast': cast,
            '_CAD_TYPE_CHECKING': False,
        })
        project = types.SimpleNamespace(id='project')
        versions = [types.SimpleNamespace(
            id='source-file', name='SameName', versionNumber=number,
            latestVersionNumber=3, parentProject=project,
            isComplete=True, isReadOnly=False,
        ) for number in (3, 2, 1)]
        versions[0].latestVersion = versions[0]
        versions[0].versions = Collection(versions)
        folder = types.SimpleNamespace(id='folder', dataFiles=[versions[0]], dataFolders=[])
        project.rootFolder = folder
        app = types.SimpleNamespace(data=types.SimpleNamespace(
            dataProjects=[project], findFileById=lambda _file_id: versions[0]))

        exact = runtime['_references_project_file'](app, 'project', 'source-file', 2)
        self.assertIs(exact, versions[1])
        self.assertIs(runtime['_references_project_file'](app, 'project', 'source-file'), versions[0])
        with self.assertRaisesRegex(ValueError, 'latest/name fallback refused'):
            runtime['_references_project_file'](app, 'project', 'source-file', 4)

    def test_canonical_metadata_and_iterable_vector_fake_sdk_path(self):
        runtime = load_module(ROOT / 'runtime/python/fmcad/adapters/fusion/references.py', {
            '_cad_items': cad_items,
            '_cad_cast': cast,
            '_cad_type': lambda entity: entity.objectType,
            '_CAD_TYPE_CHECKING': False,
        })
        component = types.SimpleNamespace(
            entityToken='root-token', name='Root', attributes=[], bRepBodies=[],
            features=Collection([]), occurrences=Collection([]), allOccurrences=Collection([]))
        metadata = runtime['_references_metadata'](object(), component)
        self.assertEqual(metadata['components'], 1)
        self.assertTrue(metadata['metadataComplete'])
        self.assertEqual(metadata['componentTokens'], ['root-token'])

        class IterableWithoutCount:
            def __iter__(self):
                return iter(['actual-derived-parameter'])

        self.assertEqual(runtime['_references_items'](IterableWithoutCount()), ['actual-derived-parameter'])

    def test_reference_image_adapter_preserves_inspect_and_provenance_delegation(self):
        calls = []

        class Matrix:
            def asArray(self):
                return [1.0, 0.0, 0.0, 1.0]

        canvas = types.SimpleNamespace(kind='Canvas', transform=Matrix())
        def image_handler(ctx, data):
            calls.append((ctx, data))
            return {'status': 'calibrated', 'calibration': {'scaleFactor': 4}}

        runtime = load_module(ROOT / 'runtime/python/fmcad/adapters/fusion/reference.py', {
            '_cad_fields': fields,
            '_cad_type': lambda entity: entity.kind,
            '_cad_cast': cast,
            '_io_reference_image': image_handler,
            '_CAD_TYPE_CHECKING': False,
        })
        ctx = types.SimpleNamespace(resolve=lambda _ref: canvas,
                                    ref=lambda _canvas: {'token': 'canvas'})
        inspect = runtime['_reference_image'](ctx, {'mode': 'inspect', 'ref': 'canvas'})
        self.assertEqual(inspect['transform'], [1.0, 0.0, 0.0, 1.0])
        self.assertEqual(calls, [])

        data = {'mode': 'calibrate', 'ref': 'canvas', 'segment': [], 'length': '100 mm',
                'anchor': [], 'source': {'path': 'original.png', 'sha256': 'a' * 64,
                'status': 'CONFIRMED', 'uncertainty': 'verified'}}
        result = runtime['_reference_image'](ctx, data)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('source', calls[0][1])
        self.assertEqual(result['status'], 'notEvaluated')
        self.assertEqual(result['provenance'], data['source'])
        self.assertEqual(result['calibration']['scaleFactor'], 4)

        blocked = {**data, 'source': {**data['source'], 'status': 'OPEN'}}
        self.assertEqual(runtime['_reference_image'](ctx, blocked)['status'], 'blocked')
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
