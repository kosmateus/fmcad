"""Offline L3 tests: a per-step `component` override is honored through `_scope`.

These exercise the real `CadContext._scope` resolution and the
`_cad_scoped_step`/`_cad_step_scope` wrapper applied to mutating handlers, plus
the fail-loud occurrence rejection for native-only operations. No Fusion kernel.
"""
import types
import unittest

import core_test as fixture


class ComponentScopeTests(unittest.TestCase):
    def setUp(self):
        self.root = fixture.component('Assembly')
        self.child = fixture.component('Part')
        self.units = fixture.Units()
        self.parameters = fixture.Parameters(self.units)
        self.units.parameters = self.parameters
        self.tokens = {}
        self.design = types.SimpleNamespace(
            rootComponent=self.root,
            allComponents=fixture.Items([self.root, self.child]),
            unitsManager=self.units, allParameters=self.parameters,
            userParameters=self.parameters,
            findEntityByToken=lambda token: self.tokens.get(token, []))
        self.doc = types.SimpleNamespace(
            name='Test',
            products=types.SimpleNamespace(itemByProductType=lambda kind: self.design),
            dataFile=types.SimpleNamespace(parentProject=types.SimpleNamespace(id='project-from-test')))
        self.app = types.SimpleNamespace(
            documents=fixture.Items([self.doc]), activeDocument=self.doc,
            userInterface=types.SimpleNamespace(activeSelections=fixture.Items()))
        self.core = fixture.load_core(self.app)
        self.ctx = self.core.CadContext('Test')
        for entity in (self.root, self.child):
            self.tokens[entity.entityToken] = [entity]

    def test_component_override_targets_overridden_component_and_restores(self):
        @self.core._cad_scoped_step('component.create', native_only=True)
        def create(ctx, data):
            body = fixture.Entity('BRepBody', data['name'], ctx.component)
            ctx.component.bRepBodies.items.append(body)
            return body

        create(self.ctx, {'name': 'RootBody'})
        create(self.ctx, {'name': 'PartBody', 'component': 'Part'})
        self.assertEqual([body.name for body in self.root.bRepBodies.items], ['RootBody'])
        self.assertEqual([body.name for body in self.child.bRepBodies.items], ['PartBody'])
        # Scope is restored to the batch base context after each handler.
        self.assertIs(self.ctx.component, self.root)
        self.assertIsNone(self.ctx.occurrence)

    def test_native_only_handler_rejects_occurrence_override_and_restores(self):
        occurrence = fixture.Entity('Occurrence', 'Part:1')
        occurrence.component = self.child
        occurrence.fullPathName = 'Part:1'
        self.root.allOccurrences.items.append(occurrence)
        self.tokens[occurrence.entityToken] = [occurrence]

        @self.core._cad_scoped_step('component.create', native_only=True)
        def create(ctx, data):
            return ctx.component

        with self.assertRaisesRegex(ValueError, 'occurrence override is unsupported'):
            create(self.ctx, {'name': 'X', 'occurrence': 'Part:1'})
        self.assertIs(self.ctx.component, self.root)
        self.assertIsNone(self.ctx.occurrence)

    def test_scope_restored_after_handler_exception(self):
        @self.core._cad_scoped_step('component.create', native_only=True)
        def create(ctx, data):
            raise RuntimeError('boom')

        with self.assertRaisesRegex(RuntimeError, 'boom'):
            create(self.ctx, {'name': 'X', 'component': 'Part'})
        self.assertIs(self.ctx.component, self.root)
        self.assertIsNone(self.ctx.occurrence)

    def test_injected_component_stripped_before_strict_validation(self):
        # The scope wrapper strips the injected override before the handler's
        # strict field validation, so it is honored rather than rejected.
        accepted = []

        @self.core._cad_scoped_step('datum.plane')
        def plane(ctx, data):
            self.core._cad_fields(data, ('name',), ('offset',))
            accepted.append(ctx.component)
            return ctx.component

        result = plane(self.ctx, {'name': 'P', 'offset': '1 mm', 'component': 'Part'})
        self.assertIs(result, self.child)
        self.assertEqual(accepted, [self.child])


if __name__ == '__main__':
    unittest.main()
