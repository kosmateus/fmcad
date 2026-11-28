"""Offline tests for the basic/public entity resolver seam."""
import ast
import json
from pathlib import Path
import unittest

import core_test as fixture


ROOT = Path(__file__).resolve().parents[1]
CORE_SOURCE = ROOT / 'assets/cad/core.py'


class BasicResolverSeamTests(unittest.TestCase):
    register = fixture.CoreTests.register
    profile_sketch = fixture.CoreTests.profile_sketch
    body = fixture.CoreTests.body
    occurrence = fixture.CoreTests.occurrence

    def setUp(self):
        fixture.CoreTests.setUp(self)

    def test_basic_resolver_uses_injected_recursion_and_scope_without_query_closure(self):
        tree = ast.parse(CORE_SOURCE.read_text())
        context = next(node for node in tree.body
                       if isinstance(node, ast.ClassDef) and node.name == 'CadContext')
        definitions = [node for node in context.body
                       if isinstance(node, ast.FunctionDef) and
                       node.name == '_cad_resolve_basic_reference']
        self.assertEqual(len(definitions), 1, 'a named basic resolver is required')
        definition = definitions[0]

        loaded_names = {node.id for node in ast.walk(definition)
                        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
        self.assertTrue({'resolve_reference', 'resolve_scope'} <= loaded_names)
        self.assertTrue({
            '_entity_resolve_reference', '_entity_query', '_entity_filters',
            '_entity_frame', '_entity_frame_target', '_entity_describe',
        }.isdisjoint(loaded_names))

        query_globals = {
            '_cad_context_scope', '_entity_resolve_reference', '_entity_query',
            '_entity_filters', '_entity_frame', '_entity_frame_target',
            '_entity_describe',
        }
        namespace = {name: value for name, value in self.core.__dict__.items()
                     if not name.startswith(('_entity', '_Entity')) and
                     name != '_cad_context_scope'}
        isolated_class = ast.ClassDef(
            name='ResolverHarness', bases=[], keywords=[], body=[definition],
            decorator_list=[])
        isolated = ast.Module(body=[isolated_class], type_ignores=[])
        ast.fix_missing_locations(isolated)
        exec(compile(isolated, str(CORE_SOURCE), 'exec'), namespace)
        resolve_basic = namespace['ResolverHarness'].__dict__['_cad_resolve_basic_reference']
        self.assertTrue(query_globals.isdisjoint(resolve_basic.__globals__))

        sketch = fixture.CoreTests.profile_sketch(self, 2)
        calls = {'scope': [], 'recursive': []}

        def resolve_scope(data):
            calls['scope'].append(dict(data))
            return self.root, None

        def resolve_reference(ref, kind):
            calls['recursive'].append((ref, kind))
            self.assertEqual(kind, 'sketch')
            return sketch

        selector = {
            'kind': 'profile', 'sketch': 'Section', 'index': 1,
            'component': 'root',
        }
        result = resolve_basic(
            self.ctx, selector, 'profile', resolve_reference, resolve_scope)

        self.assertIs(result, sketch.profiles.item(1))
        self.assertEqual(calls['scope'], [selector])
        self.assertEqual(calls['recursive'], [
            ({'name': 'Section', 'component': 'root'}, 'sketch'),
        ])

    def test_public_resolve_preserves_basic_query_alias_scope_and_failure_behavior(self):
        self.doc.creationId = 'creation-test'
        self.doc.dataFile.id = 'file-test'
        self.doc.dataFile.versionNumber = 7
        body = self.body('Body')
        scoped_body = self.body('Scoped', self.child)
        self.assertIs(self.ctx.resolve({'token': body.entityToken, 'name': 'stale'}), body)
        self.assertIs(self.ctx.resolve('Body', 'body'), body)
        self.assertIs(self.ctx.resolve({'name': 'Scoped', 'component': 'Part'}, 'body'), scoped_body)

        self.root.attributes.add(
            self.core._CAD_ALIAS_GROUP, 'body-alias',
            json.dumps(self.ctx.ref(body)))
        self.assertIs(self.ctx.resolve('body-alias', 'body'), body)

        sketch = self.profile_sketch(2)
        selected_profile = self.ctx.resolve(
            {'kind': 'profile', 'sketch': self.ctx.ref(sketch), 'index': 1})
        self.assertIs(selected_profile, sketch.profiles.item(1))
        self.assertEqual(self.ctx.ref(selected_profile)['index'], 1)
        nested_query_profile = self.ctx.resolve({
            'kind': 'profile',
            'sketch': {'query': {
                'kind': 'sketch', 'filters': {'name': 'Section'}, 'expect': 1,
            }},
            'index': 0,
        })
        self.assertIs(nested_query_profile, sketch.profiles.item(0))

        query_result = self.ctx.resolve({'query': {'kind': 'body', 'expect': 1}})
        self.assertIs(query_result, body)
        with self.assertRaisesRegex(ValueError, 'Reference query expectation failed'):
            self.ctx.resolve({'query': {'kind': 'body', 'expect': 2}})
        with self.assertRaisesRegex(ValueError, 'Reference kind conflicts'):
            self.ctx.resolve({'name': 'Body', 'kind': 'body'}, 'face')
        with self.assertRaisesRegex(ValueError, 'Component and occurrence contexts disagree'):
            self.ctx.resolve({
                'name': 'Scoped', 'kind': 'body', 'component': 'Assembly',
                'occurrence': self.ctx.ref(self.occurrence()),
            })
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.ctx.resolve('missing')


if __name__ == '__main__':
    unittest.main()
