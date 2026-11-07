"""In-memory SDK contracts only. No Fusion, cloud or filesystem mutation."""
import contextlib
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]


class Entity:
    def __init__(self, kind='Entity', **kwargs):
        self.isValid = True
        self.objectType = 'adsk::fusion::' + kind
        self.__dict__.update(kwargs)


class Items:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class AttributeVector:
    """SWIG array shape: iterable/indexable, neither list nor count/item collection."""
    def __init__(self, values=()):
        self.values = tuple(values)

    def __iter__(self):
        return iter(self.values)

    def __len__(self):
        return len(self.values)

    def __getitem__(self, index):
        return self.values[index]


class CutPasteBody(Entity):
    def __init__(self, component):
        super().__init__('CutPasteBody', parentComponent=component,
                         isParametric=True, baseFeature=None)

    @property
    def sourceBody(self):
        raise AssertionError('CutPasteBody.sourceBody requires timeline rollback; not a read-only audit')


class DocumentClearTests(unittest.TestCase):
    def setUp(self):
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        adsk.fusion.DesignTypes = types.SimpleNamespace(ParametricDesignType=1)
        self.module = types.ModuleType('clear_under_test')
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            load_legacy_core(self.module.__dict__, ROOT)
            for name in ('identity', 'document'):
                exec(compile((ROOT / ('assets/cad/' + name + '.py')).read_text(), name, 'exec'), self.module.__dict__)
        self.calls = []
        self.file = Entity(id='exact-cloud-id', isComplete=True, isReadOnly=False)
        self.doc = Entity(name='Reusable_Test', isSaved=True, isModified=False,
                          dataFile=self.file, attributes=Items(), documentReferences=Items())
        self.design = Entity(designType=1, isConfiguredDesign=False, isConfiguration=False,
                             attributes=Items(), allParameters=Items(), userParameters=Items(),
                             selectionSets=Items(), contactSets=Items(), analyses=Items(), namedViews=Items(), snapshots=Items())
        self.doc.products = Items([self.design])
        self.root = self.component()
        self.design.allComponents = Items([self.root])
        self.design.activeEditObject = self.root
        self.timeline = Items()
        self.timeline.markerPosition = 0
        self.timeline.timelineGroups = Items()
        self.timeline.deleteAllAfterMarker = self.delete_history
        self.design.timeline = self.timeline
        self.entity_attributes = Items()
        self.design.findAttributes = lambda group, name: AttributeVector(self.entity_attributes.values)
        self.ctx = Entity(doc=self.doc, design=self.design, root=self.root, component=self.root,
                          occurrence=None, doc_file_id=self.file.id, doc_id=None)
        self.ctx.require_confirm = lambda data: self.module.CadContext.require_confirm(self.ctx, data)
        self.ctx.assert_identity = lambda: self.module._document_assert_identity(self.doc, None, self.ctx.doc_file_id)
        self.ctx.activate_target = lambda: self.calls.append('activate')
        self.data = {'fileId': self.file.id, 'confirm': True}
        self.history_result = True
        self.history_error = None
        self.leave_history = False

    def component(self):
        return Entity('Component', parentDesign=self.design, flatPattern=None,
                      **{name: Items() for name in self.module._DOCUMENT_CLEAR_COMPONENT_COLLECTIONS})

    def add(self, collection, kind='Entity', **kwargs):
        entity = Entity(kind, **kwargs)
        collection.values.append(entity)
        def delete():
            self.calls.append(kind)
            collection.values.remove(entity)
            entity.isValid = False
            self.doc.isModified = True
            return True
        entity.deleteMe = delete
        return entity

    def history(self, collection, kind, **kwargs):
        entity = self.add(collection, kind, isDerived=False, **kwargs)
        self.timeline.values.append(Entity(entity=entity, isGroup=False, isSuppressed=False))
        self.timeline.markerPosition = self.timeline.count
        return entity

    def parameter(self, name):
        p = self.add(self.design.userParameters, 'UserParameter', name=name,
                     dependentParameters=Items(), dependencyParameters=Items(), isDeletable=True)
        self.design.allParameters.values.append(p)
        original = p.deleteMe
        def delete():
            self.assertTrue(all(d not in self.design.allParameters.values for d in p.dependentParameters.values))
            self.design.allParameters.values.remove(p)
            for other in p.dependencyParameters.values:
                other.isDeletable = True
            return original()
        p.deleteMe = delete
        return p

    def delete_history(self):
        self.calls.append('history')
        self.assertEqual(self.timeline.markerPosition, 0)
        if self.history_error:
            raise self.history_error
        if self.history_result and not self.leave_history:
            self.timeline.values.clear()
            self.timeline.timelineGroups.values.clear()
            for component in self.design.allComponents.values:
                for name in self.module._DOCUMENT_CLEAR_COMPONENT_COLLECTIONS:
                    if name not in ('canvases', 'customGraphicsGroups'):
                        getattr(component, name).values.clear()
            self.design.allComponents.values[:] = [self.root]
            self.design.snapshots.values.clear()
            self.design.allParameters.values[:] = self.design.userParameters.values
            for p in self.design.userParameters.values:
                p.dependentParameters.values[:] = [d for d in p.dependentParameters.values if d in self.design.userParameters.values]
                p.isDeletable = not p.dependentParameters.values
            self.doc.isModified = True
        return self.history_result

    def fixture(self):
        child = self.component()
        self.design.allComponents.values.append(child)
        self.history(self.root.occurrences, 'Occurrence', component=child, isReferencedComponent=False)
        self.history(child.sketches, 'Sketch')
        feature = self.history(child.features, 'ExtrudeFeature')
        self.add(child.bRepBodies, 'BRepBody', baseFeature=None, isDerived=False)
        self.history(self.root.constructionPlanes, 'ConstructionPlane')
        self.add(self.root.canvases, 'Canvas', isDerived=False)
        self.add(self.root.customGraphicsGroups, 'CustomGraphicsGroup')
        for group in ('fmcad.aliases', 'fmcad.frames', 'runmarkers', 'third-party'):
            self.add(self.entity_attributes, 'Attribute', groupName=group)
        self.add(self.doc.attributes, 'Attribute')
        self.add(self.design.attributes, 'Attribute')
        a, b = self.parameter('a'), self.parameter('b')
        a.dependentParameters.values = [b]
        a.isDeletable = False
        b.dependencyParameters.values = [a]
        m = self.add(self.design.allParameters, 'ModelParameter', createdBy=feature)
        b.dependentParameters.values = [m]
        b.isDeletable = False
        return child, a, b

    def call(self, **changes):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.module._document_clear(self.ctx, dict(self.data, **changes))

    def test_import_group_and_brep_only_base_feature_audit_and_clear(self):
        base = self.history(self.root.features, 'BaseFeature', parentComponent=self.root,
                            assemblyContext=None, baseFeature=None)
        for name in ('sketches', 'constructionPlanes', 'constructionAxes',
                     'constructionPoints', 'meshBodies', 'linkedFeatures'):
            setattr(base, name, AttributeVector())
        body = self.add(self.root.bRepBodies, 'BRepBody', baseFeature=None, isDerived=False)
        base.sourceBodies = AttributeVector([body])
        group = Entity('TimelineGroup', entity=None, isGroup=True, isSuppressed=False)
        group.count = 1
        leaf = self.timeline.values[0]
        group.item = lambda index: leaf
        self.timeline.values[:] = [group]
        self.timeline.timelineGroups.values[:] = [group]
        before = self.call(dryRun=True)
        self.assertEqual(before['before']['bRepBodies'], 1)
        self.assertEqual(self.calls, [])
        base.meshBodies = AttributeVector([Entity('MeshBody')])
        with self.assertRaisesRegex(ValueError, 'base feature contents'):
            self.call()
        self.assertEqual(self.calls, [])
        base.meshBodies = AttributeVector()
        result = self.call()
        self.assertTrue(all(v == 0 for v in result['after'].values()))
        self.assertEqual(self.calls.count('history'), 1)

    def test_removed_occurrence_audits_historical_definition_without_current_path(self):
        class RemovedOccurrence(Entity):
            @property
            def isDerived(self):
                raise RuntimeError('2 : InternalValidationError : occPath.valid()')
        historical = self.component()
        occurrence = RemovedOccurrence('Occurrence', component=historical, isReferencedComponent=False)
        self.timeline.values.append(Entity(entity=occurrence, isGroup=False, isSuppressed=False))
        self.history(historical.features, 'ExtrudeFeature')
        self.add(historical.bRepBodies, 'BRepBody', baseFeature=None, isDerived=False)
        self.root.occurrences.values.append(occurrence)
        with self.assertRaises(RuntimeError):
            self.call(dryRun=True)  # Never excuse unreadable provenance of current contents.
        self.root.occurrences.values.clear()
        index = self.timeline.count
        binding = Entity(entity=occurrence, index=index, parentTimeline=self.timeline,
                         isGroup=False, isSuppressed=False)
        self.timeline.values.append(binding)
        self.timeline.markerPosition = self.timeline.count
        self.add(self.root.features, 'RemoveFeature', timelineObject=binding,
                 parentComponent=self.root, assemblyContext=None, isParametric=True, baseFeature=None)
        before = self.call(dryRun=True)
        self.assertEqual(before['before']['descendantComponents'], 1)
        self.assertEqual(before['before']['bRepBodies'], 1)
        self.assertEqual(self.calls, [])
        result = self.call()
        self.assertTrue(all(v == 0 for v in result['after'].values()))

    def cross_component_fixture(self):
        children, moves = [], []
        for unused in range(4):
            child = self.component()
            children.append(child)
            self.design.allComponents.values.append(child)
            self.history(self.root.occurrences, 'Occurrence', component=child, isReferencedComponent=False)
        for index in range(20):
            self.history(self.root.sketches, 'Sketch', parentComponent=self.root)
            feature = self.history(self.root.features, 'ExtrudeFeature', parentComponent=self.root)
            # Original feature stays in root; the moved native body belongs to a child.
            child = children[index % 4]
            self.add(child.bRepBodies, 'BRepBody', parentComponent=child, baseFeature=None, isDerived=False)
            move = CutPasteBody(child)
            child.features.values.append(move)
            self.timeline.values.append(Entity(entity=move, isGroup=False, isSuppressed=False))
            moves.append(move)
            self.add(self.design.allParameters, 'ModelParameter', component=self.root, createdBy=feature)
        self.history(self.root.canvases, 'Canvas')
        self.add(self.entity_attributes, 'Attribute', groupName='runmarkers')
        return children, moves

    def test_cross_component_cutpaste_65_entry_dryrun_and_zero_audit(self):
        children, moves = self.cross_component_fixture()
        self.assertEqual(self.root.bRepBodies.count, 0)
        self.assertEqual(self.root.features.count, 20)
        self.assertTrue(all(child.bRepBodies.count == 5 for child in children))
        self.assertTrue(all(child.features.count == 5 for child in children))
        dry = self.call(dryRun=True)
        self.assertEqual(dry['before']['timeline'], 65)
        self.assertEqual(dry['before']['features'], 40)
        self.assertEqual(dry['before']['bRepBodies'], 20)
        self.assertEqual(dry['before']['sketches'], 20)
        self.assertEqual(dry['before']['occurrences'], 4)
        self.assertEqual(dry['before']['descendantComponents'], 4)
        self.assertEqual(dry['before']['canvases'], 1)
        self.assertEqual(dry['before']['modelParameters'], 20)
        self.assertEqual(self.timeline.markerPosition, 65)
        self.assertEqual(self.calls, [])
        result = self.call()
        self.assertEqual(result['status'], 'cleared')
        self.assertTrue(all(count == 0 for count in result['after'].values()))
        self.assertEqual(result['before'], dry['before'])
        self.assertEqual(self.calls.count('history'), 1)
        self.assertTrue(result['unsavedChanges'])
        self.assertFalse(result['savePerformed'])
        self.assertEqual(result['current']['fileId'], self.file.id)

    def test_cutpaste_rejects_nonparametric_base_and_foreign_ownership_with_index_type(self):
        children, moves = self.cross_component_fixture()
        for field, value in (('isParametric', False), ('baseFeature', Entity('BaseFeature')),
                             ('parentComponent', self.component())):
            old = getattr(moves[0], field)
            setattr(moves[0], field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, r'timeline index 6 type CutPasteBody'):
                self.call(dryRun=True)
            setattr(moves[0], field, old)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.timeline.markerPosition, 65)

    def test_cross_component_cutpaste_keeps_body_provenance_and_remaining_count_guards(self):
        children, moves = self.cross_component_fixture()
        body = children[0].bRepBodies.values[0]
        body.baseFeature = Entity('BaseFeature')
        with self.assertRaisesRegex(ValueError, 'direct/base/derived bodies'):
            self.call()
        self.assertEqual(self.calls, [])
        body.baseFeature = None
        delete = self.timeline.deleteAllAfterMarker
        def leave_component():
            result = delete()
            self.design.allComponents.values.append(children[0])
            return result
        self.timeline.deleteAllAfterMarker = leave_component
        with self.assertRaisesRegex(RuntimeError, 'verification failed.*descendantComponents'):
            self.call()
        self.assertEqual(self.calls.count('history'), 1)

    def test_unsupported_timeline_message_names_index_and_actual_type(self):
        self.history(self.root.sketches, 'Sketch')
        self.history(self.root.features, 'UnrecognizedFeature')
        with self.assertRaisesRegex(ValueError, r'timeline index 1 type UnrecognizedFeature: unsupported'):
            self.call(dryRun=True)
        row = self.timeline.values[1]
        for field, value, message in (
                ('isSuppressed', True, 'type UnrecognizedFeature: suppressed'),
                ('isGroup', True, 'type UnrecognizedFeature: grouped'),
                ('entity', None, 'type <no public entity>: no public API entity'),
                ('entity', Entity('Sketch', isValid=False), 'type Sketch: invalid')):
            old = getattr(row, field)
            setattr(row, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'timeline index 1 ' + message):
                self.call(dryRun=True)
            setattr(row, field, old)
        self.assertEqual(self.calls, [])

    def compound_cutpaste_fixture(self):
        children, moves = self.cross_component_fixture()
        rows = self.timeline.values
        source = [r for r in rows if r.entity.objectType.endswith(('::Sketch', '::ExtrudeFeature'))]
        occurrences = [r for r in rows if r.entity.objectType.endswith('::Occurrence')]
        cutpaste = [r for r in rows if r.entity.objectType.endswith('::CutPasteBody')]
        canvas = rows[-1]
        self.timeline.values = source
        offset = 0
        for occurrence, count in zip(occurrences, (8, 5, 2, 5)):
            self.timeline.values.append(occurrence)
            self.timeline.values.extend(cutpaste[offset:offset + count])
            offset += count
        self.timeline.values.append(canvas)
        helpers = []
        for index, row in enumerate(self.timeline.values):
            row.index, row.parentTimeline = index, self.timeline
            row.entity.timelineObject = row
            if row.entity not in moves:
                continue
            for kind in ('Feature', 'RemoveFeature'):
                helper = self.add(self.root.features, kind, parentComponent=self.root,
                                  isParametric=True, baseFeature=None, assemblyContext=None,
                                  name='arbitrary localized name ' + str(index))
                helper.timelineObject = Entity('TimelineObject', index=index, parentTimeline=self.timeline,
                                               entity=helper, isGroup=False, isSuppressed=False)
                helpers.append(helper)
        return helpers

    def test_compound_helpers_share_canonical_cutpaste_index_and_clear_to_zero(self):
        helpers = self.compound_cutpaste_fixture()
        expected = list(range(41, 49)) + list(range(50, 55)) + [56, 57] + list(range(59, 64))
        self.assertEqual([h.timelineObject.index for h in helpers[::2]], expected)
        self.assertTrue(all(h.timelineObject.entity is h for h in helpers))
        self.assertTrue(all(self.timeline.item(h.timelineObject.index).entity is not h for h in helpers))
        # Parameter owners may be these audited helpers, not arbitrary unbound features.
        self.add(self.design.allParameters, 'ModelParameter', createdBy=helpers[0])
        result = self.call(dryRun=True)
        self.assertEqual(result['before']['timeline'], 65)
        self.assertEqual(result['before']['features'], 80)
        self.assertEqual(result['before']['modelParameters'], 21)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.timeline.markerPosition, 65)
        cleared = self.call()
        self.assertEqual(cleared['before'], result['before'])
        self.assertTrue(all(count == 0 for count in cleared['after'].values()))
        self.assertEqual(self.calls.count('history'), 1)
        self.assertNotIn('Feature', self.calls)
        self.assertNotIn('RemoveFeature', self.calls)
        self.assertEqual(cleared['current']['fileId'], self.file.id)

    def test_compound_helper_requires_local_valid_binding_to_cutpaste_not_just_an_index(self):
        helper = self.compound_cutpaste_fixture()[0]
        binding = helper.timelineObject
        other_component = self.component()
        cases = [(binding, 'index', v) for v in (-1, 65, True, None, 0)]
        cases += [(binding, 'parentTimeline', Entity('Timeline')), (binding, 'isValid', False),
                  (binding, 'entity', Entity('Feature')), (binding, 'isGroup', True),
                  (binding, 'isSuppressed', True), (helper, 'timelineObject', None),
                  (helper, 'parentComponent', other_component),
                  (helper, 'parentComponent', self.design.allComponents.item(1)),
                  (helper, 'assemblyContext', Entity('Occurrence')), (helper, 'isParametric', False),
                  (helper, 'baseFeature', Entity('BaseFeature')),
                  (helper, 'objectType', 'adsk::fusion::UnrecognizedFeature'),
                  (self.timeline.item(41), 'index', 40),
                  (self.timeline.item(41), 'parentTimeline', Entity('Timeline'))]
        for obj, field, value in cases:
            old = getattr(obj, field)
            setattr(obj, field, value)
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'CutPasteBody helper'):
                self.call(dryRun=True)
            setattr(obj, field, old)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.timeline.markerPosition, 65)

    def test_compound_helper_does_not_admit_top_level_generic_feature_or_surviving_helpers(self):
        helpers = self.compound_cutpaste_fixture()
        row = self.timeline.item(41)
        canonical = row.entity
        row.entity = helpers[0]
        with self.assertRaisesRegex(ValueError, 'timeline index 41 type Feature: unsupported'):
            self.call(dryRun=True)
        self.assertEqual(self.calls, [])
        row.entity = canonical
        delete = self.timeline.deleteAllAfterMarker
        def leave_helper():
            result = delete()
            self.root.features.values.append(helpers[0])
            return result
        self.timeline.deleteAllAfterMarker = leave_helper
        with self.assertRaisesRegex(ValueError, 'CutPasteBody helper'):
            self.call()
        self.assertEqual(self.calls.count('history'), 1)

    def test_full_clear_counts_descendants_parameters_attributes_same_identity_unsaved(self):
        self.fixture()
        result = self.call()
        self.assertEqual(result['status'], 'cleared')
        self.assertEqual(result['before']['descendantComponents'], 1)
        self.assertEqual(result['before']['attributes'], 6)
        self.assertEqual(result['before']['userParameters'], 2)
        self.assertEqual(result['before']['modelParameters'], 1)
        self.assertTrue(all(v == 0 for v in result['after'].values()))
        self.assertEqual(result['current']['fileId'], 'exact-cloud-id')
        self.assertTrue(result['unsavedChanges'])
        self.assertFalse(result['savePerformed'])
        self.assertEqual(self.calls.count('history'), 1)
        self.assertIs(self.doc.dataFile, self.file)

    def test_dry_run_is_actual_read_only_audit_and_allows_modified(self):
        self.fixture()
        self.doc.isModified = True
        result = self.call(dryRun=True)
        self.assertEqual(result['before']['bRepBodies'], 1)
        self.assertEqual(result['before']['timeline'], 4)
        self.assertEqual(result['status'], 'inspected')
        self.assertFalse(result['mutation'])
        self.assertEqual(self.timeline.markerPosition, 4)
        self.assertEqual(self.calls, [])

    def test_attribute_vector_empty_and_populated_dry_run(self):
        self.assertEqual(self.call(dryRun=True)['before']['attributes'], 0)
        self.add(self.entity_attributes, 'Attribute', groupName='fmcad.aliases')
        self.add(self.entity_attributes, 'Attribute', groupName='runmarkers')
        self.add(self.doc.attributes, 'Attribute')
        self.add(self.design.attributes, 'Attribute')
        result = self.call(dryRun=True)
        self.assertEqual(result['before']['attributes'], 4)
        self.assertFalse(result['mutation'])
        self.assertFalse(self.doc.isModified)
        self.assertEqual(self.calls, [])

    def test_attribute_vector_clear_snapshots_before_deletion_and_verifies_empty(self):
        for group in ('fmcad.aliases', 'runmarkers', 'third-party'):
            self.add(self.entity_attributes, 'Attribute', groupName=group)
        result = self.call()
        self.assertEqual(result['before']['attributes'], 3)
        self.assertEqual(result['after']['attributes'], 0)
        self.assertEqual(self.calls, ['activate', 'Attribute', 'Attribute', 'Attribute'])
        self.assertTrue(result['unsavedChanges'])
        self.assertFalse(result['savePerformed'])

    def test_attribute_vector_invalid_entries_and_iteration_errors_fail_before_mutation(self):
        for values in ([None], [Entity(isValid=False)]):
            self.design.findAttributes = lambda *args: AttributeVector(values)
            with self.assertRaisesRegex(ValueError, 'null/invalid entity'):
                self.call()
        class BrokenVector(AttributeVector):
            def __iter__(self):
                yield Entity('Attribute')
                raise RuntimeError('SDK vector iteration failed')
        self.design.findAttributes = lambda *args: BrokenVector()
        with self.assertRaisesRegex(RuntimeError, 'SDK vector iteration failed'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_count_collection_errors_are_not_reinterpreted_as_empty_arrays(self):
        class BadCount(Items):
            @property
            def count(self):
                raise RuntimeError('SDK count failed')

            def __iter__(self):
                return iter(())
        self.root.sketches = BadCount()
        with self.assertRaisesRegex(RuntimeError, 'SDK count failed'):
            self.call()
        self.root.sketches = types.SimpleNamespace(count=None, item=lambda i: None)
        with self.assertRaisesRegex(ValueError, 'invalid collection count'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_invalid_payload_and_required_confirmation_fail_before_mutation(self):
        for changes in ({'confirm': False}, {'confirm': 1}, {'confirm': 'true'}, {'dryRun': 1},
                        {'dryRun': 'true'}, {'fileId': 'other'}, {'fileId': None}, {'save': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call(**changes)
        for key in ('fileId', 'confirm'):
            data = {k: v for k, v in self.data.items() if k != key}
            with self.assertRaises(ValueError):
                self.module._document_clear(self.ctx, data)
        self.assertEqual(self.calls, [])

    def test_guards_and_unsupported_data_fail_closed_for_clear_and_dry_run(self):
        cases = [(self.ctx, 'doc_file_id', None), (self.doc, 'isSaved', False),
                 (self.doc, 'isValid', False), (self.doc, 'isModified', None),
                 (self.file, 'isComplete', False), (self.file, 'isComplete', None),
                 (self.file, 'isReadOnly', True), (self.file, 'isReadOnly', None),
                 (self.design, 'designType', 0), (self.design, 'isConfiguredDesign', True),
                 (self.design, 'isConfiguration', None), (self.design, 'activeEditObject', object()),
                 (self.root, 'flatPattern', object())]
        for obj, name, value in cases:
            old = getattr(obj, name)
            for dry in (False, True):
                setattr(obj, name, value)
                with self.subTest(name=name, value=value, dry=dry), self.assertRaises(ValueError):
                    self.call(dryRun=dry)
            setattr(obj, name, old)
        collections = [self.doc.products, self.doc.documentReferences, self.design.selectionSets,
                       self.design.contactSets, self.design.analyses, self.design.namedViews,
                       self.timeline.timelineGroups, self.root.meshBodies, self.root.decals,
                       self.root.pmiAnnotations, self.root.userCoordinateSystems]
        for collection in collections:
            self.add(collection)
            with self.assertRaises(ValueError):
                self.call()
            collection.values.pop()
        self.assertEqual(self.calls, [])

    def test_missing_and_throwing_audit_getters_do_not_become_empty(self):
        del self.root.canvases
        with self.assertRaises(AttributeError):
            self.call()
        self.root.canvases = None
        with self.assertRaises(ValueError):
            self.call()
        self.root.canvases = Items([None])
        with self.assertRaises(ValueError):
            self.call()
        self.root.canvases = Items()
        def fail(*args):
            raise RuntimeError('audit unavailable')
        self.design.findAttributes = fail
        with self.assertRaisesRegex(RuntimeError, 'audit unavailable'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_extend_and_trim_features_are_supported_timeline_types(self):
        self.history(self.root.features, 'ExtendFeature')
        self.history(self.root.features, 'TrimFeature')
        before = self.call(dryRun=True)
        self.assertEqual(before['before']['features'], 2)
        self.assertEqual(self.calls, [])
        result = self.call()
        self.assertEqual(result['status'], 'cleared')
        self.assertTrue(all(v == 0 for v in result['after'].values()))

    def test_unknown_suppressed_grouped_rolled_back_and_untimelined_contents_refuse(self):
        for kind in ('BaseFeature', 'MeshFeature', 'CustomFeature', 'UnknownFeature'):
            self.history(self.root.features, kind)
            with self.assertRaises(ValueError):
                self.call()
            self.root.features.values.clear()
            self.timeline.values.clear()
        self.history(self.root.sketches, 'Sketch')
        row = self.timeline.values[0]
        for key, value in (('isSuppressed', True), ('isGroup', True), ('entity', None)):
            old = getattr(row, key)
            setattr(row, key, value)
            with self.assertRaises(ValueError):
                self.call()
            setattr(row, key, old)
        self.timeline.markerPosition = 0
        with self.assertRaises(ValueError):
            self.call()
        self.timeline.markerPosition = 1
        self.add(self.root.constructionPlanes, 'ConstructionPlane')
        with self.assertRaises(ValueError):
            self.call()
        self.assertEqual(self.calls, [])

    def test_parameter_cycles_model_dependencies_and_unavailable_deletability_refuse(self):
        a, b = self.parameter('a'), self.parameter('b')
        a.dependentParameters.values = [b]
        b.dependentParameters.values = [a]
        with self.assertRaisesRegex(ValueError, 'cyclic'):
            self.call()
        a.dependentParameters.values.clear()
        b.dependentParameters.values.clear()
        a.isDeletable = False
        with self.assertRaisesRegex(ValueError, 'undeletable'):
            self.call()
        a.isDeletable = True
        b.dependencyParameters.values = [Entity('ModelParameter')]
        with self.assertRaisesRegex(ValueError, 'relationships'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_recheck_identity_immediately_before_mutation(self):
        self.fixture()
        self.ctx.activate_target = lambda: setattr(self.file, 'id', 'changed')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            self.call()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.timeline.markerPosition, 4)

    def test_failure_no_retry_rollback_or_success_and_zero_verification(self):
        self.fixture()
        self.history_result = False
        with self.assertRaisesRegex(RuntimeError, 'Clear timeline failed'):
            self.call()
        self.assertEqual(self.calls, ['activate', 'history'])
        self.timeline.markerPosition = self.timeline.count
        self.history_error = RuntimeError('primary SDK failure')
        with self.assertRaises(RuntimeError) as error:
            self.call()
        self.assertIs(error.exception, self.history_error)
        self.assertEqual(self.calls.count('history'), 2)

    def test_false_residual_delete_and_residual_counts_never_report_success(self):
        canvas = self.add(self.root.canvases, 'Canvas', isDerived=False)
        canvas.deleteMe = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Clear canvases failed'):
            self.call()
        canvas.deleteMe = lambda: True
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            self.call()

    def test_empty_noop_does_not_require_dirty_state(self):
        result = self.call()
        self.assertFalse(result['mutation'])
        self.assertFalse(result['unsavedChanges'])
        self.assertEqual(self.calls, ['activate'])

    def test_post_mutation_identity_editability_and_readback_failures_propagate(self):
        for field, value in (('id', 'different-file'), ('isReadOnly', True), ('isComplete', None)):
            self.setUp()
            self.fixture()
            original = self.timeline.deleteAllAfterMarker
            def delete():
                result = original()
                setattr(self.file, field, value)
                return result
            self.timeline.deleteAllAfterMarker = delete
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.call()
            self.assertEqual(self.calls.count('history'), 1)
            self.assertTrue(self.doc.isModified)
        self.setUp()
        self.fixture()
        original = self.timeline.deleteAllAfterMarker
        def delete_then_bad_audit():
            result = original()
            self.root.sketches = None
            return result
        self.timeline.deleteAllAfterMarker = delete_then_bad_audit
        with self.assertRaisesRegex(ValueError, 'audit unavailable'):
            self.call()
        self.assertEqual(self.calls.count('history'), 1)

    def test_parameter_failure_and_missing_modified_evidence_never_succeed(self):
        parameter = self.parameter('test')
        parameter.deleteMe = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Clear user parameter failed'):
            self.call()
        self.setUp()
        self.history(self.root.sketches, 'Sketch')
        original = self.timeline.deleteAllAfterMarker
        def delete_without_dirty_status():
            result = original()
            self.doc.isModified = False
            return result
        self.timeline.deleteAllAfterMarker = delete_without_dirty_status
        with self.assertRaisesRegex(RuntimeError, 'unsaved modification status'):
            self.call()

    def test_derived_and_external_local_component_contents_refuse(self):
        child, unused_a, unused_b = self.fixture()
        sketch = child.sketches.values[0]
        sketch.isDerived = True
        with self.assertRaisesRegex(ValueError, 'derived'):
            self.call()
        sketch.isDerived = False
        self.root.occurrences.values[0].isReferencedComponent = True
        with self.assertRaisesRegex(ValueError, 'external'):
            self.call()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
