"""Behavioral document targeting tests for the bundled box script."""
import contextlib
import io
from pathlib import Path
import runpy
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'assets/scripts/box.py'


class BoxTargetTests(unittest.TestCase):
    def execute(self, names, requested, activation=True, design=True):
        created = []
        documents = []
        app = SimpleNamespace(documents=documents, activeDocument=None, activeProduct=None)
        for name in names:
            root = SimpleNamespace(xYConstructionPlane='XY')
            def add(plane, name=name):
                created.append(name)
                raise StopIteration('geometry reached')
            root.sketches = SimpleNamespace(add=add)
            product = SimpleNamespace(rootComponent=root) if design else None
            doc = SimpleNamespace(name=name, products=SimpleNamespace(itemByProductType=lambda kind, p=product: p))
            def activate(doc=doc, product=product):
                if activation:
                    app.activeDocument, app.activeProduct = doc, product
                return activation
            doc.activate = activate
            documents.append(doc)
        if documents:
            app.activeDocument = documents[0]
            app.activeProduct = documents[0].products.itemByProductType('DesignProductType')
        adsk = ModuleType('adsk')
        adsk.core = ModuleType('adsk.core')
        adsk.fusion = ModuleType('adsk.fusion')
        adsk.core.Application = SimpleNamespace(get=lambda: app)
        adsk.core.Point3D = SimpleNamespace(
            create=lambda x, y, z: SimpleNamespace(x=x, y=y, z=z))
        adsk.fusion.Design = SimpleNamespace(cast=lambda product: product)
        output = io.StringIO()
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            script = runpy.run_path(str(SCRIPT))
            script['run'].__globals__['DOC_NAME'] = requested
            with contextlib.redirect_stdout(output):
                try:
                    script['run']('')
                except StopIteration:
                    pass
        return created, output.getvalue(), app

    def test_missing_target_does_not_mutate_active_design(self):
        created, output, app = self.execute(['Unrelated'], 'Missing')
        self.assertEqual(created, [])
        self.assertIn('ERROR', output)
        self.assertEqual(app.activeDocument.name, 'Unrelated')

    def test_ambiguous_case_insensitive_target_is_refused(self):
        created, output, _ = self.execute(['Box', 'BOX'], 'box')
        self.assertEqual(created, [])
        self.assertIn('ERROR', output)

    def test_failed_activation_is_refused(self):
        created, output, _ = self.execute(['Other', 'Target'], 'Target', activation=False)
        self.assertEqual(created, [])
        self.assertIn('ERROR', output)

    def test_non_design_target_is_refused(self):
        created, output, _ = self.execute(['Target'], 'Target', design=False)
        self.assertEqual(created, [])
        self.assertIn('ERROR', output)

    def test_valid_target_not_unrelated_active_design_receives_geometry(self):
        created, _, app = self.execute(['Other', 'Target'], 'target')
        self.assertEqual(created, ['Target'])
        self.assertEqual(app.activeDocument.name, 'Target')

    def test_omitted_target_preserves_active_design_contract(self):
        created, _, _ = self.execute(['Active'], '')
        self.assertEqual(created, ['Active'])


if __name__ == '__main__':
    unittest.main()
