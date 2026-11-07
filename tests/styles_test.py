"""Offline styling contracts; no live Fusion writes or kernel validation."""
import json
import types
import unittest

import io_test
from io_test import Items, entity


class StyledBody:
    def __init__(self, name, component, material):
        self.objectType = 'adsk::fusion::BRepBody'
        self.name = self.entityToken = name
        self.parentComponent = component
        self.material = material
        self.faces = Items()
        self.nativeObject = self.assemblyContext = None
        self.isTransient = False
        self._appearance = None
        self.writes = 0
        self.fail = False

    @property
    def appearance(self):
        return self._appearance or self.material.appearance

    @appearance.setter
    def appearance(self, value):
        if self.fail:
            raise RuntimeError('injected setter failure')
        self.writes += 1
        self._appearance = value

    @property
    def appearanceSourceType(self):
        return 1 if self._appearance else 0


class StyledFace(StyledBody):
    def __init__(self, name, body):
        super().__init__(name, body.parentComponent, body.material)
        self.objectType = 'adsk::fusion::BRepFace'
        self.body = body

    @property
    def appearance(self):
        return self._appearance or self.body.appearance

    @appearance.setter
    def appearance(self, value):
        self._appearance = value

    @property
    def appearanceSourceType(self):
        return 3 if self._appearance else self.body.appearanceSourceType


class StyleTests(unittest.TestCase):
    call = io_test.IOTests.call

    def setUp(self):
        io_test.IOTests.setUp(self)
        self.adsk.core.AppearanceSourceTypes = types.SimpleNamespace(
            MaterialAppearanceSource=0, BodyAppearanceSource=1, OccurrenceAppearanceSource=2,
            FaceAppearanceSource=3, OverrideAppearanceSource=4)
        self.visual = types.SimpleNamespace(id='local-visual', name='Visual')
        self.base = types.SimpleNamespace(id='base-visual', name='Base')
        self.material = types.SimpleNamespace(id='physical', name='Physical', appearance=self.base)
        self.root.material = self.material
        self.root.occurrences = Items()
        self.body = StyledBody('Body', self.root, self.material)
        self.other = StyledBody('Other', self.root, self.material)
        self.root.bRepBodies = Items([self.body, self.other])
        self.face = StyledFace('Face', self.body)
        self.face.appearance = self.visual
        self.body.faces = Items([self.face])
        self.occurrences = [entity('Occurrence', name) for name in ('Part:1', 'Part:2')]
        for occurrence in self.occurrences:
            occurrence.component = self.root
            occurrence.fullPathName = occurrence.name
            occurrence.appearance = None
        self.occurrences[1].appearance = self.visual
        self.root.allOccurrences = Items(self.occurrences)
        self.design.appearances = Items([self.visual])
        self.design.materials = Items([self.material])
        self.entities.update({e.name: e for e in [self.body, self.other, self.face] + self.occurrences})
        self.copies = []

    def library(self, kind, id='foreign:/exact?ID=AbC', name='Foreign'):
        value = types.SimpleNamespace(id=id, name=name)
        prop = 'appearances' if kind == 'appearance' else 'materials'
        library = types.SimpleNamespace(id='loaded-library', name='Loaded')
        setattr(library, prop, Items([value]))
        self.app.materialLibraries = Items([library])
        local = getattr(self.design, prop)

        def add_by_copy(source, copy_name):
            self.copies.append(source)
            copied = types.SimpleNamespace(id='actual-local-copy', name=copy_name)
            local.values.append(copied)
            return copied

        local.addByCopy = add_by_copy
        return value

    def test_material_mixed_face_invalid_prevalidates_before_copy_or_assignment(self):
        value = self.library('material')
        with self.assertRaisesRegex(ValueError, 'appearance.assign'):
            self.call('material.assign', refs=['Body', 'Face'], library='loaded-library', id=value.id)
        self.assertIs(self.body.material, self.material)
        self.assertEqual(self.copies, [])

    def test_component_material_and_face_occurrence_inspection(self):
        new = types.SimpleNamespace(id='another-material', name='Another', appearance=self.base)
        self.design.materials.values.append(new)
        result = self.call('material.assign', refs=['root'], id=new.id)
        self.assertIs(self.root.material, new)
        self.assertIs(self.face.appearance, self.visual)
        self.assertEqual(result['affectedDefinitionCount'], 1)
        self.assertEqual(result['affected'][0]['before']['material']['id'], 'physical')
        self.assertEqual(result['affected'][0]['after']['material']['id'], new.id)
        inspection = self.call('material.inspect', refs=['Face', 'Part:1'])
        self.assertEqual(inspection['items'][0]['materialReadFrom']['token'], 'Body')
        self.assertEqual(inspection['items'][1]['materialSource'], 'Component.material')
        self.assertEqual(inspection['items'][1]['material']['id'], new.id)
        self.assertTrue(all(row['before'] == row['after'] for row in inspection['affected']))
        json.dumps(result)

    def test_component_cascade_shared_definition_preserves_overrides(self):
        result = self.call('appearance.assign', refs=['root', 'Body'], id=self.visual.id)
        self.assertEqual(result['count'], 2)
        self.assertEqual(self.body.writes, 1)
        self.assertEqual(self.other.writes, 1)
        self.assertFalse(hasattr(self.root, 'appearance'))
        self.assertEqual(result['mapping'][0]['scope'], 'component-body-cascade')
        occurrence_rows = [row for row in result['affected'] if row['after']['scope'] == 'instance']
        self.assertEqual(len(occurrence_rows), 2)
        self.assertTrue(all(row['before'] == row['after'] for row in occurrence_rows))
        self.assertIs(self.face.appearance, self.visual)
        self.assertIs(self.occurrences[1].appearance, self.visual)
        self.assertEqual(result['affected'][0]['after']['appearanceSource'], 'BodyAppearanceSource')
        self.assertTrue(result['affected'][0]['after']['appearanceOverride'])

    def test_descendant_opt_in_and_shared_component_deduplication(self):
        child = entity('Component', 'Child')
        child.occurrences = Items()
        body = StyledBody('ChildBody', child, self.material)
        child.bRepBodies = Items([body])
        self.root.occurrences = Items([types.SimpleNamespace(component=child)] * 2)
        self.assertEqual(self.call('appearance.assign', refs=['root'], id=self.visual.id)['count'], 2)
        self.assertEqual(body.writes, 0)
        result = self.call('appearance.assign', refs=['root'], includeChildren=True, id=self.visual.id)
        self.assertEqual(result['count'], 3)
        self.assertEqual(body.writes, 1)
        self.assertEqual(result['affectedDefinitionCount'], 2)
        with self.assertRaisesRegex(ValueError, 'boolean'):
            self.call('appearance.clear', refs=['root'], includeChildren='true')

    def test_clear_body_reads_inherited_actual_appearance_without_material_change(self):
        self.call('appearance.assign', refs=['Body'], id=self.visual.id)
        result = self.call('appearance.clear', refs=['Body'])
        state = result['affected'][0]
        self.assertEqual(state['before']['appearance']['id'], self.visual.id)
        self.assertEqual(state['after']['appearance']['id'], self.base.id)
        self.assertFalse(state['after']['appearanceOverride'])
        self.assertEqual(state['after']['appearanceSource'], 'MaterialAppearanceSource')
        self.assertIs(self.body.material, self.material)
        self.assertIs(self.face.appearance, self.visual)

    def test_face_and_instance_assignment_and_clear(self):
        self.occurrences[0].nativeObject = self.occurrences[0]
        self.call('appearance.assign', refs=['Face', 'Part:1'], id=self.visual.id)
        self.assertIs(self.face.appearance, self.visual)
        self.assertIs(self.occurrences[0].appearance, self.visual)
        self.assertEqual(self.body.writes, 0)
        result = self.call('appearance.clear', refs=['Face', 'Part:1'])
        self.assertIs(self.face.appearance, self.body.appearance)
        self.assertEqual(result['items'][0]['appearanceSource'], 'MaterialAppearanceSource')
        self.assertFalse(result['items'][0]['appearanceOverride'])
        self.assertIsNone(self.occurrences[0].appearance)
        self.assertIs(self.occurrences[1].appearance, self.visual)
        self.assertEqual(result['mapping'][1]['scope'], 'instance')

    def test_real_source_constants_are_scope_aware(self):
        names = ('MaterialAppearanceSource', 'BodyAppearanceSource', 'OccurrenceAppearanceSource',
                 'FaceAppearanceSource', 'OverrideAppearanceSource')
        for kind, expected in (('BRepBody', (False, True, False, False, True)),
                               ('BRepFace', (False, False, False, True, True))):
            for source, override in enumerate(expected):
                for proxy in (False, True):
                    with self.subTest(kind=kind, source=source, proxy=proxy):
                        target = entity(kind, 'SourceTest')
                        target.parentComponent = self.root
                        target.body = self.body
                        target.material = self.material
                        target.appearance = self.visual
                        target.appearanceSourceType = source
                        if proxy:
                            target.nativeObject = self.body if kind == 'BRepBody' else self.face
                            target.assemblyContext = self.occurrences[0]
                        state = self.module._io_style_state(self.ctx, target)
                        self.assertEqual(state['appearanceSource'], names[source])
                        self.assertIs(state['appearanceOverride'], override)
                        scope = None if not override else 'definition' if not proxy else (
                            'proxy-context-unspecified' if source == 4 else 'native-definition')
                        self.assertEqual(state['appearanceOverrideScope'], scope)
                        self.assertEqual(state['scope'], 'proxy-read-only' if proxy else 'definition')

    def test_face_clear_inherits_body_source_without_face_override(self):
        self.call('appearance.assign', refs=['Body'], id=self.visual.id)
        assigned = self.call('appearance.inspect', refs=['Face'])['items'][0]
        self.assertEqual(assigned['appearanceSource'], 'FaceAppearanceSource')
        self.assertTrue(assigned['appearanceOverride'])
        cleared = self.call('appearance.clear', refs=['Face'])['items'][0]
        self.assertEqual(cleared['appearanceSource'], 'BodyAppearanceSource')
        self.assertFalse(cleared['appearanceOverride'])
        self.assertIsNone(cleared['appearanceOverrideScope'])
        self.assertIs(self.face.appearance, self.body.appearance)

    def test_occurrence_override_uses_nullable_getter_and_unknown_source_stays_unknown(self):
        for occurrence in self.occurrences:
            state = self.module._io_style_state(self.ctx, occurrence)
            self.assertIs(state['appearanceOverride'], occurrence.appearance is not None)
            self.assertEqual(state['appearanceOverrideScope'], 'instance' if occurrence.appearance else None)
        target = entity('BRepBody', 'Unknown')
        target.appearanceSourceType = 99
        state = self.module._io_style_state(self.ctx, target)
        self.assertIsNone(state['appearanceSource'])
        self.assertIsNone(state['appearanceOverride'])
        self.assertIsNone(state['appearanceOverrideScope'])

    def test_real_context_ref_handles_unnamed_face_and_owning_component(self):
        self.ctx.ref = lambda e: self.module.CadContext.ref(self.ctx, e)
        del self.face.name
        result = self.call('appearance.inspect', refs=[{'token': 'Face'}])
        ref = result['items'][0]['ref']
        self.assertEqual(ref['kind'], 'face')
        self.assertIsNone(ref['name'])
        self.assertEqual(ref['component'], {'kind': 'component', 'name': 'root'})
        self.assertEqual(result['items'][0]['materialReadFrom']['kind'], 'body')

    def test_invalid_or_transient_targets_do_not_allow_earlier_write(self):
        self.other.isTransient = True
        with self.assertRaisesRegex(ValueError, 'persistent'):
            self.call('appearance.assign', refs=['Body', 'Other'], id=self.visual.id)
        self.assertEqual(self.body.writes, 0)
        self.root.isValid = False
        with self.assertRaisesRegex(ValueError, 'valid'):
            self.call('appearance.clear', refs=['Body', 'root'])
        self.assertEqual(self.body.writes, 0)

    def test_occurrence_material_assignment_is_not_silently_definition_assignment(self):
        with self.assertRaisesRegex(ValueError, 'native Component or BRepBody'):
            self.call('material.assign', refs=['Body', 'Part:1'], id=self.material.id)
        self.assertIs(self.root.material, self.material)
        self.assertIs(self.body.material, self.material)

    def test_proxy_mutation_rejected_but_inspection_allowed(self):
        self.other.nativeObject = self.body
        self.other.assemblyContext = self.occurrences[0]
        for op in ('appearance.assign', 'material.assign', 'appearance.clear'):
            with self.subTest(op=op), self.assertRaisesRegex(ValueError, 'Proxy mutation'):
                args = {} if op.endswith('clear') else {'id': self.visual.id if op.startswith('appearance') else self.material.id}
                self.call(op, refs=['Body', 'Other'], **args)
        self.assertEqual(self.body.writes, 0)
        result = self.call('appearance.inspect', refs=['Other'])
        self.assertEqual(result['items'][0]['scope'], 'proxy-read-only')

    def test_library_copy_reports_foreign_and_actual_ids_and_never_duplicates(self):
        for kind in ('appearance', 'material'):
            with self.subTest(kind=kind):
                value = self.library(kind)
                result = self.call(kind + '.assign', refs=['Body'], library='loaded-library', id=value.id)
                self.assertEqual(result['requested']['id'], 'foreign:/exact?ID=AbC')
                self.assertEqual(result['id'], 'actual-local-copy')
                self.assertEqual(result['affected'][0]['after'][kind]['id'], 'actual-local-copy')
                copies = len(self.copies)
                with self.assertRaisesRegex(ValueError, 'collision'):
                    self.call(kind + '.assign', refs=['Other'], library='loaded-library', id=value.id)
                self.assertEqual(len(self.copies), copies)
                self.call(kind + '.assign', refs=['Other'], id=result['id'])
                self.assertEqual(len(self.copies), copies)

    def test_foreign_matching_id_is_not_proof_of_equivalence(self):
        self.library('appearance', id=self.visual.id, name='Different name')
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.call('appearance.assign', refs=['Body'], id=self.visual.id, library='loaded-library')
        self.assertEqual(self.copies, [])
        self.assertEqual(self.body.writes, 0)

    def test_all_refs_and_style_ids_prevalidated_and_search_is_optional(self):
        for data in ({'refs': ['Body', 'missing'], 'id': self.visual.id},
                     {'refs': ['Body'], 'id': 'missing'},
                     {'refs': ['Body'], 'id': self.visual.id, 'includeChildren': True}):
            with self.assertRaises(ValueError):
                self.call('appearance.assign', **data)
        self.assertEqual(self.body.writes, 0)
        self.assertEqual(self.call('appearance.list', search='VIS')['items'][0]['id'], self.visual.id)
        self.assertEqual(self.call('appearance.list', search='absent')['items'], [])
        value = self.library('material')
        self.assertEqual(self.call('material.list')['libraries'][0]['id'], 'loaded-library')
        self.assertEqual(self.call('material.list', library='loaded-library')['items'][0]['id'], value.id)

    def test_partial_runtime_failure_reports_actual_states_without_rollback_claim(self):
        self.other.fail = True
        with self.assertRaisesRegex(RuntimeError, 'without rollback') as raised:
            self.call('appearance.assign', refs=['Body', 'Other'], id=self.visual.id)
        result = json.loads(str(raised.exception).split(': ', 1)[1])
        self.assertFalse(result['atomic'])
        self.assertEqual(result['affected'][0]['after']['appearance']['id'], self.visual.id)
        self.assertEqual(result['affected'][1]['after']['appearance']['id'], self.base.id)
        self.assertEqual(self.body.writes, 1)


if __name__ == '__main__':
    unittest.main()
