"""Canonical modeling compatibility paths and independently frozen registry oracle."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import python_document_io_test as runtime_inventory
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/modeling-python-history'
MANIFEST = json.loads((FIXTURES / 'manifest.json').read_text())


class ModelingLoaderTests(unittest.TestCase):
    def test_frozen_sources_preserve_hashes_and_loaders_have_no_handler_bodies(self):
        self.assertEqual(len(MANIFEST), 19)
        for family, entry in MANIFEST.items():
            with self.subTest(family=family):
                original = (FIXTURES / entry['fixture']).read_bytes()
                self.assertEqual(hashlib.sha256(original).hexdigest(), entry['sha256'])
                loader = ast.parse((ROOT / entry['source']).read_text())
                self.assertFalse(any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                                     for node in ast.walk(loader)))
                for unit in entry['units']:
                    self.assertTrue((ROOT / unit).is_file(), unit)

    def test_frozen_originals_still_drive_retained_body_and_registry_oracles(self):
        # Reuse the established comparator while preserving its independent pre-migration
        # input. The compatibility loaders must never become their own historical oracle.
        original_read = Path.read_text
        originals = {str((ROOT / entry['source']).resolve()): entry for entry in MANIFEST.values()}
        def historical_read(path, *args, **kwargs):
            entry = originals.get(str(path.resolve()))
            if entry is not None:
                fixture = FIXTURES / entry['fixture']
                self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(), entry['sha256'])
                return original_read(fixture, *args, **kwargs)
            return original_read(path, *args, **kwargs)
        oracle = runtime_inventory.RuntimeInventoryTests()
        with patch.object(Path, 'read_text', historical_read):
            oracle.test_every_retained_definition_has_exactly_its_previous_count()
            oracle.test_full_registry_and_handler_ownership_matches_retained_inventory()

    def test_every_owned_python_handler_is_accounted_for_in_admission_inventory(self):
        inventory = json.loads((ROOT / 'tests/fixtures/modeling-operation-contracts.json').read_text())
        operations = {row['operation']: row for row in inventory['operations']}
        owned_families = set(inventory['pythonFamilies'])
        namespace = {'_FMCAD_RUNTIME_ROOT': str(ROOT)}
        owners = {}
        with patch.dict(sys.modules, runtime_inventory.fake_sdk()):
            load_legacy_core(namespace, ROOT)
            for source in sorted((ROOT / 'assets/cad').glob('*.py')):
                if source.stem == 'core':
                    continue
                before = dict(namespace['CAD_HANDLERS'])
                exec(compile(source.read_text(), str(source), 'exec'), namespace)
                for operation, handler in namespace['CAD_HANDLERS'].items():
                    if before.get(operation) is not handler:
                        owners[operation] = source.stem
        covered = {operation for operation, family in owners.items() if family in owned_families}
        self.assertGreater(len(covered), 200)
        self.assertEqual(covered - set(operations), set(), 'Owned handlers omitted from public admission inventory')
        for operation in covered:
            with self.subTest(operation=operation):
                row = operations[operation]
                if row['owner'] == 'C':
                    self.assertEqual(row['nativeProgram'], operation)
                    self.assertEqual(row['route'], 'generated-python')
                else:
                    self.assertTrue(row['coordination'], 'Shared handler needs an explicit owner handoff')

    def test_each_compatibility_entry_uses_canonical_handlers_from_foreign_cwd(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory(prefix='fmcad-modeling-loader-') as directory:
            try:
                os.chdir(directory)
                for family, entry in MANIFEST.items():
                    with self.subTest(family=family), patch.dict(sys.modules, runtime_inventory.fake_sdk()):
                        baseline = {}
                        current = {'_FMCAD_RUNTIME_ROOT': str(ROOT)}
                        load_legacy_core(baseline, ROOT)
                        load_legacy_core(current, ROOT)
                        initial_handlers = dict(current['CAD_HANDLERS'])
                        historical = FIXTURES / entry['fixture']
                        exec(compile(historical.read_text(), str(historical), 'exec'), baseline)
                        source = ROOT / entry['source']
                        code = compile(source.read_text(), str(source), 'exec')
                        exec(code, current)
                        self.assertEqual(set(current['CAD_HANDLERS']), set(baseline['CAD_HANDLERS']))
                        for operation, handler in current['CAD_HANDLERS'].items():
                            self.assertEqual(handler.__name__, baseline['CAD_HANDLERS'][operation].__name__, operation)
                            if initial_handlers.get(operation) is not handler:
                                self.assertTrue(str(handler.__code__.co_filename).startswith(str(ROOT / 'runtime/python/')),
                                                (operation, handler.__code__.co_filename))
                        before = dict(current['CAD_HANDLERS'])
                        with patch.object(Path, 'read_text', side_effect=AssertionError('Repeated bundled loader read a file')):
                            exec(code, current)
                        self.assertEqual(current['CAD_HANDLERS'], before)
            finally:
                os.chdir(original_cwd)
