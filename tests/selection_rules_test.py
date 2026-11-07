"""Offline tests for rule behavior over the retained entity.find resolver."""
from pathlib import Path
import types
import unittest

import core_test as fixture

ROOT = Path(__file__).resolve().parents[1]


def load_rule_family(core):
    for relative in (
        'runtime/python/fmcad/domain/selection_rules.py',
        'runtime/python/fmcad/adapters/fusion/selection_rules.py',
        'runtime/python/fmcad/application/selection_rules.py',
    ):
        source = ROOT / relative
        exec(compile(source.read_text(), str(source), 'exec'), core.__dict__)


class SelectionRuleTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.CoreTests('runTest')
        self.fixture.setUp()
        self.ctx = self.fixture.ctx
        self.core = self.fixture.core
        self.doc = self.fixture.doc
        self.root = self.fixture.root
        self.child = self.fixture.child
        self.tokens = self.fixture.tokens
        self.doc.creationId = 'creation-test'
        self.doc.dataFile.id = 'file-test'
        self.doc.dataFile.versionNumber = 7
        load_rule_family(self.core)
        self.rule_body = self.fixture.body('RuleBody')

    def face(self, name):
        face = fixture.Entity('BRepFace', name, self.rule_body.parentComponent)
        face.body = self.rule_body
        face.edges, face.vertices = fixture.Items(), fixture.Items()
        face.geometry, face.area = None, 1.0
        self.rule_body.faces.items.append(face)
        self.fixture.register(face)
        return face

    def body(self, name, owner=None):
        return self.fixture.body(name, owner)

    def occurrence(self, name):
        return self.fixture.occurrence(name)

    def define(self, rule_id='rule', expected=1, filters=None, exclude=None, **scope):
        query = {'kind': 'face', 'filters': filters or {}, 'expect': expected, **scope}
        if not scope:
            query['scope'] = {'component': 'root'}
        data = {'ruleId': rule_id, 'query': query}
        if exclude is not None:
            data['exclude'] = exclude
        return self.ctx.call('selection.rule.define', data)['manifest']

    def resolve(self, manifest, operation='selection.rule.resolve'):
        return self.ctx.call(operation, {'manifest': manifest})

    def test_define_inspect_resolve_check_and_exclusions(self):
        target = self.face('Target')
        self.face('Skip')
        result = self.ctx.call('selection.rule.define', {
            'ruleId': 'target-face',
            'query': {'kind': 'face', 'scope': {'component': 'root'}, 'filters': {}, 'expect': 1},
            'exclude': [{'name': 'Skip'}],
        })
        manifest = result['manifest']
        self.assertEqual(result['refs'], [self.ctx.ref(target)])
        self.assertEqual(result['excludedCount'], 1)
        self.assertEqual(manifest['owner']['projectId'], 'project-from-test')
        self.assertEqual(manifest['owner']['documentFileId'], 'file-test')
        self.assertEqual(manifest['source']['version'], 7)
        self.assertEqual(manifest['lastResolution']['count'], 1)
        self.assertEqual(manifest['provenance']['resolver'], 'entity._entity_query')
        inspected = self.resolve(manifest, 'selection.rule.inspect')
        self.assertEqual(inspected['manifest'], manifest)
        resolved = self.resolve(manifest)
        self.assertEqual(resolved['status'], 'resolved')
        self.assertEqual(resolved['refs'], [self.ctx.ref(target)])
        checked = self.resolve(resolved['manifest'], 'selection.rule.check')
        self.assertTrue(checked['passed'])

    def test_reordering_and_repeated_instances_are_not_index_bound(self):
        first = self.face('Target')
        second = self.face('Target')
        manifest = self.define(expected=2, filters={'name': 'Target'})
        self.rule_body.faces.items.reverse()
        resolved = self.resolve(manifest)
        self.assertEqual(resolved['status'], 'resolved')
        self.assertEqual({ref['token'] for ref in resolved['refs']},
                         {self.ctx.ref(first)['token'], self.ctx.ref(second)['token']})

        occurrence_a = self.occurrence('Part:1')
        occurrence_b = self.occurrence('Part:2')
        occurrence_a.component = occurrence_b.component = self.child
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        occurrence_a.transform2 = occurrence_b.transform2 = types.SimpleNamespace(asArray=lambda: identity)
        child_body = fixture.Entity('BRepBody', 'RepeatedBody', self.child)
        child_body.faces, child_body.edges, child_body.vertices = fixture.Items(), fixture.Items(), fixture.Items()
        self.child.bRepBodies.items.append(child_body)
        self.fixture.register(child_body)
        child_face = fixture.Entity('BRepFace', 'RepeatedFace', self.child)
        child_face.body = child_body
        child_face.edges, child_face.vertices = fixture.Items(), fixture.Items()
        child_face.geometry, child_face.area = None, 1.0
        child_body.faces.items.append(child_face)
        self.fixture.register(child_face)
        repeated = self.define('repeated', expected=2, filters={'name': 'RepeatedFace'},
                               component='Part', instances=True)
        self.root.allOccurrences.items.reverse()
        repeated_result = self.resolve(repeated)
        self.assertEqual(repeated_result['status'], 'resolved')
        self.assertEqual({ref['occurrence']['path'] for ref in repeated_result['refs']},
                         {'Part:1', 'Part:2'})
        scoped = self.define('one-instance', filters={'name': 'RepeatedFace'}, occurrence='Part:1')
        self.assertEqual(scoped['instanceScope'], {'occurrence': 'Part:1'})
        self.assertEqual(self.resolve(scoped)['count'], 1)

    def test_topology_split_and_merge_are_explicit_without_reference_repair(self):
        original = self.face('Target')
        split_manifest = self.define('split', filters={'name': 'Target'})
        self.rule_body.faces.items.remove(original)
        left, right = self.face('Target'), self.face('Target')
        self.tokens[original.entityToken] = [left, right]
        split = self.resolve(split_manifest)
        self.assertEqual(split['status'], 'split')
        self.assertEqual([change['kind'] for change in split['changes']], ['split'])
        self.assertEqual(split['manifest'], split_manifest)
        self.assertNotEqual({ref['token'] for ref in split['refs']}, {original.entityToken})

        first, second = left, right
        merge_manifest = self.define('merge', expected=2, filters={'name': 'Target'})
        self.rule_body.faces.items.remove(first)
        self.rule_body.faces.items.remove(second)
        merged = self.face('Target')
        self.tokens[first.entityToken] = [merged]
        self.tokens[second.entityToken] = [merged]
        merge = self.resolve(merge_manifest)
        self.assertEqual(merge['status'], 'merge')
        self.assertEqual([change['kind'] for change in merge['changes']], ['merge'])
        self.assertEqual(merge['manifest'], merge_manifest)

    def test_deleted_entity_is_missing_and_saved_version_drift_is_stale(self):
        original = self.face('Target')
        manifest = self.define(filters={'name': 'Target'})
        self.rule_body.faces.items.remove(original)
        self.tokens[original.entityToken] = []
        missing = self.resolve(manifest)
        self.assertEqual(missing['status'], 'missing')
        self.assertEqual(missing['count'], 0)

        current = self.face('Target')
        current_manifest = self.define('source-drift', filters={'name': 'Target'})
        self.doc.dataFile.versionNumber += 1
        stale = self.resolve(current_manifest)
        self.assertEqual(stale['status'], 'stale')
        self.assertTrue(stale['sourceChanged'])
        self.assertEqual(stale['refs'], [self.ctx.ref(current)])

    def test_lineage_uses_exact_persistent_token_when_native_wrappers_differ(self):
        class DistinctHandle(fixture.Entity):
            def __eq__(self, other):
                return self is other

        token = 'same-fusion-token'
        historical = DistinctHandle('BRepFace', 'face')
        current = DistinctHandle('BRepFace', 'face')
        historical.entityToken = current.entityToken = token
        context = type('LineageContext', (), {
            'design': types.SimpleNamespace(findEntityByToken=lambda value: [historical] if value == token else []),
            'ref': lambda _self, entity: {'token': entity.entityToken, 'kind': 'face'},
        })()
        self.assertEqual(
            self.core._selection_rules_lineage(context, {'token': token, 'kind': 'face'}, [current]),
            [0],
        )
        self.assertEqual(
            self.core._selection_rules_lineage(context, {'token': 'different-token', 'kind': 'face'}, [current]),
            [],
        )

    def test_multiple_matching_entities_are_reported_ambiguous(self):
        self.face('Target')
        manifest = self.define(filters={'name': 'Target'})
        self.face('Target')
        ambiguous = self.resolve(manifest)
        self.assertEqual(ambiguous['status'], 'ambiguous')
        self.assertFalse(ambiguous['passed'])
        self.assertEqual(ambiguous['count'], 2)
        self.assertEqual(ambiguous['manifest'], manifest)

    def test_owner_conflicts_and_unsatisfied_cardinality_fail_closed(self):
        self.face('Target')
        with self.assertRaisesRegex(ValueError, 'expected 2..2 entities, found 1'):
            self.define(expected=2, filters={'name': 'Target'})
        manifest = self.define(filters={'name': 'Target'})
        self.doc.dataFile.parentProject.id = 'other-project'
        with self.assertRaisesRegex(ValueError, 'ownership conflict'):
            self.resolve(manifest)
        self.doc.dataFile.parentProject.id = 'project-from-test'
        self.doc.dataFile.id = 'other-file'
        with self.assertRaisesRegex(ValueError, 'ownership conflict'):
            self.resolve(manifest)


if __name__ == '__main__':
    unittest.main()
