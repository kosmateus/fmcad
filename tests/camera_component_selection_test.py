"""Compare string specialization with the canonical constructor, including error outcomes."""
import json
from pathlib import Path
import unittest

import core_test as fixture


class CameraComponentTests(unittest.TestCase):
    register = fixture.CoreTests.register
    body = fixture.CoreTests.body
    occurrence = fixture.CoreTests.occurrence

    def setUp(self):
        fixture.CoreTests.setUp(self)
        helper = Path(__file__).resolve().parents[1] / 'runtime/python/fmcad/adapters/fusion/camera_component.py'
        exec(compile(helper.read_text(), str(helper), 'exec'), self.core.__dict__)

    def alias(self, name, ref):
        self.root.attributes.add(self.core._CAD_ALIAS_GROUP, name, json.dumps(ref))

    def select(self, name):
        ctx = self.core.CadContext('Test')
        pending = self.core._camera_try_component_name(ctx, name)
        if pending is not None:
            self.core._camera_resume_component_name(ctx, name, pending, lambda raw: ctx.resolve(json.loads(raw)))
        return ctx

    def compare(self, name):
        def outcome(fn):
            try:
                ctx = fn(name)
                return (ctx.component, ctx.occurrence)
            except (TypeError, ValueError) as error:
                return type(error), str(error)
        expected = outcome(lambda value: self.core.CadContext('Test', value))
        self.assertEqual(expected, outcome(self.select))
        return expected

    def test_root_names_occurrence_paths_and_ambiguity(self):
        occ = self.occurrence()
        occ.fullPathName = 'Assembly:1+Part:1'
        self.assertEqual(self.compare('root'), (self.root, None))
        self.assertEqual(self.compare('Part'), (self.child, None))
        self.assertEqual(self.compare(occ.name), (self.child, occ))
        self.assertEqual(self.compare(occ.fullPathName), (self.child, occ))
        self.assertEqual(self.compare('XY')[0], ValueError)
        self.assertEqual(self.compare('missing')[1], 'Reference missing: expected one match, found 0')
        self.body('Part')
        self.assertEqual(self.compare('Part')[1], 'Reference Part: expected one match, found 2')

    def test_token_alias_chain_and_query_can_change_an_existing_name(self):
        self.alias('inner', self.ctx.ref(self.child))
        self.alias('outer', 'inner')
        self.assertEqual(self.compare('outer'), (self.child, None))
        self.assertEqual(self.compare('Part'), (self.child, None))
        self.alias('Part', self.ctx.ref(self.child))
        self.assertEqual(self.compare('Part'), (self.child, None))
        self.alias('Part', {'query': {'kind': 'component', 'scope': {'component': 'root'}}})
        self.assertEqual(self.compare('Part')[1], 'Reference Part: expected one match, found 2')

    def test_alias_to_wrong_kind_observes_reference_scope(self):
        self.alias('local', self.ctx.ref(self.body('body')))
        self.assertEqual(self.compare('local')[1], 'component_ref must resolve to a component or occurrence')
        self.alias('foreign', self.ctx.ref(self.body('body', self.child)))
        self.assertEqual(self.compare('foreign')[1], 'Reference foreign: expected one match, found 0')

    def test_changed_alias_stops_before_resolving(self):
        self.alias('view', self.ctx.ref(self.child))
        before = self.core._camera_try_component_name(self.ctx, 'view')
        self.assertIsInstance(before, str)
        self.alias('view', 'root')
        with self.assertRaisesRegex(RuntimeError, '^DOCUMENT_STATE_CHANGED:'):
            self.core._camera_resume_component_name(self.ctx, 'view', before, lambda _: self.fail('used stale alias'))


if __name__ == '__main__':
    unittest.main()
