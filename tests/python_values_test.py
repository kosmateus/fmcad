"""Pure runtime import/DTO/registry tests: no mocked SDK is needed."""
import importlib.util
import pathlib
import sys
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('fmcad_values', ROOT / 'runtime/python/fmcad/domain/values.py')
values = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(values)


class PythonValuesTest(unittest.TestCase):
    def test_import_does_not_load_adsk(self):
        program = ('import runpy, sys; runpy.run_path(sys.argv[1]); '
                   'assert not any(name == "adsk" or name.startswith("adsk.") for name in sys.modules)')
        result = subprocess.run([sys.executable, '-B', '-c', program, str(SPEC.origin)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dto_rejects_opaque_and_nonfinite_values(self):
        self.assertEqual(values.json_value({'a': [True, None, '日本語']}), {'a': [True, None, '日本語']})
        for value in (object(), {'sdk': object()}, {1: 'bad key'}):
            with self.assertRaises(TypeError):
                values.json_value(value)
        with self.assertRaises(ValueError):
            values.json_value(float('nan'))

    def test_validation_and_single_dispatch(self):
        values.fields({'confirm': True}, required=('confirm',))
        with self.assertRaises(ValueError):
            values.fields({'confirm': 1}, required=('confirm',))
        self.assertEqual(values.direction([0, 3, 0]), [0, 1, 0])
        registry = values.HandlerRegistry()
        calls = []
        registry['fixture'] = lambda ctx, data: calls.append(data) or 'ok'
        self.assertEqual(registry.dispatch(None, 'fixture', {}), 'ok')
        self.assertEqual(calls, [{}])
        with self.assertRaises(ValueError):
            registry.update({'new': lambda ctx, data: None, 'fixture': lambda ctx, data: None})
        self.assertNotIn('new', registry)
