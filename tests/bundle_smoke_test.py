"""Prepared-bundle and retained-asset smoke tests.

The canonical prepared bundle supplies the typed values unit before its CAD
handlers. Retained compatibility assets are also loaded as one module after that
prelude so their module-scope registrations are tested in the intended context.
The prepared-manifest path is checked separately; these tests cover compatibility
asset initialization with a mocked ``adsk`` and verify every handler is callable.
"""
import pathlib
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_canonical_values


ROOT = pathlib.Path(__file__).resolve().parents[1]
CAD_DIR = ROOT / 'assets' / 'cad'


def bundle_files():
    return ['core.py'] + sorted(p.name for p in CAD_DIR.glob('*.py') if p.name != 'core.py')


def bundle_source(files):
    return '\n\n'.join((CAD_DIR / name).read_text() for name in files)


def load_bundle():
    files = bundle_files()
    source = bundle_source(files)
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        namespace = {'CAD_HANDLERS': {}}
        load_canonical_values(namespace, ROOT)
        exec(compile(source, '<cad-bundle>', 'exec'), namespace)
    return namespace, files


class BundleSmokeTest(unittest.TestCase):
    def test_prepared_manifest_bundle_and_light_profile(self):
        script = """
const { prepareCadBundle } = require('./packages/node-adapters/dist/python/bundle');
const full = prepareCadBundle(process.cwd(), '# wrapper');
const light = prepareCadBundle(process.cwd(), '# wrapper', {}, 'document-status');
if (light.bytes.length >= full.bytes.length / 10) throw new Error('status bundle is not lightweight');
process.stdout.write(full.script);
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            namespace = {}
            exec(compile(result.stdout, '<fmcad-artifact>', 'exec'), namespace)
        self.assertGreater(len(namespace['CAD_HANDLERS']), 200)
        self.assertEqual(namespace['CAD_HANDLERS'].owners['model.thread'], 'thread')

    def test_retained_assets_keep_core_first_and_stable_family_order(self):
        files = bundle_files()
        self.assertEqual(files[0], 'core.py')
        self.assertEqual(files[1:], sorted(files[1:]))
        self.assertIn('surface.py', files)
        self.assertIn('document.py', files)

    def test_bundle_loads_with_mocked_adsk_without_module_exception(self):
        namespace, _ = load_bundle()
        self.assertIn('CAD_HANDLERS', namespace)
        self.assertTrue(namespace['CAD_HANDLERS'], 'bundle registered no CAD handlers')

    def test_every_registered_handler_resolves_to_a_defined_callable(self):
        namespace, _ = load_bundle()
        non_callable = [name for name, handler in namespace['CAD_HANDLERS'].items() if not callable(handler)]
        self.assertEqual(non_callable, [], 'non-callable CAD_HANDLERS entries: %r' % non_callable)


if __name__ == '__main__':
    unittest.main()
