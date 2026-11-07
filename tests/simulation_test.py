"""Offline metadata discovery tests; no live calls or preview API execution."""
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class SimulationTests(unittest.TestCase):
    def setUp(self):
        def fields(data):
            if data != {}:
                raise ValueError('Unexpected inputs')
        self.ns = {'CAD_HANDLERS': {}, '_cad_fields': fields}
        exec(compile((ROOT / 'assets/cad/simulation.py').read_text(), 'simulation.py', 'exec'), self.ns)

    def call(self, module):
        with patch.object(self.ns['importlib'], 'import_module', return_value=module) as importer:
            result = self.ns['CAD_HANDLERS']['simulation.capabilities'](object(), {})
            importer.assert_called_once_with('adsk.sim')
            return result

    def test_missing_module_is_not_missing_license(self):
        with patch.object(self.ns['importlib'], 'import_module', side_effect=ModuleNotFoundError('adsk.sim')):
            result = self.ns['_simulation_capabilities'](object(), {})
        self.assertFalse(result['moduleAvailable'])
        self.assertIn('ModuleNotFoundError', result['importError'])
        self.assertEqual(result['entitlement'], 'notChecked')
        self.assertFalse(result['stableFEASolve']['available'])
        self.assertTrue(all(c['preview'] and not c['available'] for c in result['classes']))

    def test_import_failure_is_reported_not_hidden(self):
        with patch.object(self.ns['importlib'], 'import_module', side_effect=RuntimeError('binary unavailable')):
            result = self.ns['_simulation_capabilities'](object(), {})
        self.assertIn('binary unavailable', result['importError'])

    def test_preview_classes_never_constructed_or_invoked(self):
        class Preview:
            """This class is a preview feature. Do not use it in distributed programs."""
            def __init__(self):
                raise AssertionError('No preview construction')

            @staticmethod
            def get(*args):
                raise AssertionError('No get-or-create product access')

            def solve(self):
                raise AssertionError('No solve')

        module = types.SimpleNamespace(**{n: Preview for n in
            ('Simulations', 'SimulationModel', 'SimulationModels', 'Studies', 'Study')})
        result = self.call(module)
        self.assertTrue(result['moduleAvailable'])
        self.assertFalse(result['productAccessed'])
        self.assertTrue(all(c['runtimeDocMarksPreview'] and not c['supported'] for c in result['classes']))
        self.assertFalse(result['stableFEASolve']['available'])

    def test_stripped_or_changed_docs_do_not_promote_preview(self):
        result = self.call(types.SimpleNamespace(Study=type('Study', (), {'__doc__': None})))
        study = result['classes'][-1]
        self.assertTrue(study['available'])
        self.assertTrue(study['preview'])
        self.assertFalse(study['runtimeDocMarksPreview'])
        self.assertIn('known SDK', study['statusSource'])
        self.assertFalse(study['supported'])

    def test_catalog_only_exposes_discovery(self):
        catalog = json.loads((ROOT / 'src/catalog/simulation.json').read_text())
        self.assertEqual(set(catalog), {'simulation.capabilities'})
        self.assertEqual(set(catalog), set(self.ns['CAD_HANDLERS']))
        self.assertTrue(catalog['simulation.capabilities']['readOnly'])
        with self.assertRaises(ValueError):
            self.ns['_simulation_capabilities'](object(), {'solve': True})


if __name__ == '__main__':
    unittest.main()
