"""Simulation manual metadata tests never import the real Autodesk module."""
import types
import unittest
from unittest.mock import patch

import simulation_test as fixtures
from manual_assembly_test import manual, validate_manual


class ManualSimulationTests(unittest.TestCase):
    def test_catalog_coverage_metadata_and_outer_validator(self):
        validate_manual(self, 'simulation')
        self.assertEqual(len(manual('simulation')), 1)

    def test_example_missing_and_present_modules_exact_return_contract(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                fixture = fixtures.SimulationTests()
                fixture.setUp()
                module = types.SimpleNamespace(Study=type('Study', (), {'__doc__': 'preview'}))
                with patch.object(fixture.ns['importlib'], 'import_module', return_value=module,
                                  side_effect=ModuleNotFoundError('offline fixture') if missing else None):
                    data = manual('simulation')['simulation.capabilities']['examples'][0]['data']
                    output = fixture.ns['CAD_HANDLERS']['simulation.capabilities'](object(), data)
                self.assertEqual(set(output), {'profile', 'module', 'moduleAvailable', 'importError', 'classes',
                    'stableFEASolve', 'entitlement', 'productAccessed', 'limitations', 'nativeExamples'})
                self.assertEqual(output['moduleAvailable'], not missing)
                self.assertEqual(output['importError'] is None, not missing)
                self.assertEqual(len(output['classes']), 5)
                for row in output['classes']:
                    self.assertEqual(set(row), {'name', 'available', 'preview', 'runtimeDocMarksPreview', 'statusSource', 'supported'})
                    self.assertTrue(row['preview'])
                    self.assertFalse(row['supported'])
                self.assertFalse(output['stableFEASolve']['available'])
                self.assertFalse(output['productAccessed'])
                self.assertEqual(output['entitlement'], 'notChecked')


if __name__ == '__main__':
    unittest.main()
