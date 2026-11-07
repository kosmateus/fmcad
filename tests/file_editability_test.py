"""In-memory SDK stubs execute the actual CLI-generated payload; no Fusion or writes."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = subprocess.run(
    ['node', '-e', 'process.stdout.write(require("./src/ops").buildOpScript("file_editability", []))'],
    cwd=ROOT, check=True, capture_output=True, text=True,
).stdout


class FileEditabilityTests(unittest.TestCase):
    def report(self, data, args=None):
        core = types.ModuleType('adsk.core')
        fusion = types.ModuleType('adsk.fusion')
        adsk = types.ModuleType('adsk')
        adsk.core, adsk.fusion = core, fusion
        # No document/UI/mutation methods are exposed by these stubs.
        core.Application = types.SimpleNamespace(get=lambda: types.SimpleNamespace(data=data))
        output = io.StringIO()
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion}):
            namespace = {}
            exec(compile(SCRIPT, '<generated file_editability>', 'exec'), namespace)
            self.assertEqual(namespace['OP'], 'file_editability')
            self.assertEqual(namespace['ARGS'], [])
            if args is not None:
                namespace['ARGS'] = args
            with contextlib.redirect_stdout(output):
                namespace['run']('')
        return output.getvalue()

    def result(self, data):
        lines = self.report(data).splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1], 'DONE')
        self.assertTrue(lines[0].startswith('FILE_EDITABILITY '))
        result = json.loads(lines[0].removeprefix('FILE_EDITABILITY '))
        self.assertIs(result['diagnosticsComplete'], True)
        return result

    def test_non_personal_license(self):
        self.assertEqual(self.result(types.SimpleNamespace(personalUseLimits=None)), {
            'mutationSupported': False, 'diagnosticsComplete': True, 'personalUseLimits': None,
        })

    def test_quota_and_duplicate_names_keep_ids_and_getter_values(self):
        class File:
            def __init__(self, identity, readonly):
                self.id, self.name, self._readonly = identity, 'Same "name"\npart', readonly

            @property
            def isReadOnly(self):
                return self._readonly

        files = [File('id-1', False), File('id-2', True)]
        limits = types.SimpleNamespace(maxEditableFileCount=10, editableFileCount=2, editableFiles=files)
        self.assertEqual(self.result(types.SimpleNamespace(personalUseLimits=limits)), {
            'mutationSupported': False, 'diagnosticsComplete': True,
            'personalUseLimits': {
                'maxEditableFileCount': 10, 'editableFileCount': 2,
                'editableFiles': [{'id': f.id, 'name': f.name, 'isReadOnly': f.isReadOnly} for f in files],
            },
        })

    def test_empty_personal_quota(self):
        limits = types.SimpleNamespace(maxEditableFileCount=10, editableFileCount=0, editableFiles=[])
        result = self.result(types.SimpleNamespace(personalUseLimits=limits))
        self.assertEqual(result['personalUseLimits'], {
            'maxEditableFileCount': 10, 'editableFileCount': 0, 'editableFiles': [],
        })

    def test_getter_errors_never_fabricate_quota_or_partial_files(self):
        class Broken:
            def __getattr__(self, name):
                raise RuntimeError('getter failed: ' + name)

        for attribute in ['personalUseLimits', 'maxEditableFileCount', 'editableFileCount']:
            with self.subTest(attribute=attribute):
                data = types.SimpleNamespace(personalUseLimits=types.SimpleNamespace(
                    maxEditableFileCount=10, editableFileCount=1, editableFiles=[]))
                if attribute == 'personalUseLimits':
                    data = Broken()
                else:
                    limits = Broken()
                    limits.__dict__.update(vars(data.personalUseLimits))
                    limits.__dict__.pop(attribute)
                    data.personalUseLimits = limits
                output = self.report(data)
                self.assertEqual(output, 'ERROR file_editability ' + json.dumps({
                    'mutationSupported': False, 'error': 'getter failed: ' + attribute,
                }) + '\n')

    def assert_incomplete(self, limits, getter, message):
        lines = self.report(types.SimpleNamespace(personalUseLimits=limits)).splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1], 'ERROR file_editability ' + getter + ': ' + message)
        self.assertEqual(json.loads(lines[0].removeprefix('FILE_EDITABILITY ')), {
            'mutationSupported': False, 'diagnosticsComplete': False,
            'personalUseLimits': {
                'maxEditableFileCount': 10, 'editableFileCount': 6, 'editableFiles': None,
            },
            'errors': [{'getter': getter, 'message': message}],
        })

    def test_live_editable_files_getter_failure_preserves_counts(self):
        class Limits:
            maxEditableFileCount = 10
            editableFileCount = 6

            @property
            def editableFiles(self):
                raise RuntimeError('2 : InternalValidationError : file')

        self.assert_incomplete(Limits(), 'personalUseLimits.editableFiles',
                               '2 : InternalValidationError : file')

    def test_per_file_getter_failures_discard_partial_list(self):
        class BrokenFile:
            def __getattr__(self, name):
                raise RuntimeError('getter failed: ' + name)

        for attribute in ['id', 'name', 'isReadOnly']:
            with self.subTest(attribute=attribute):
                file = BrokenFile()
                file.__dict__.update(id='bad', name='Part', isReadOnly=False)
                file.__dict__.pop(attribute)
                limits = types.SimpleNamespace(maxEditableFileCount=10, editableFileCount=6,
                    editableFiles=[types.SimpleNamespace(id='ok', name='Part', isReadOnly=False), file])
                self.assert_incomplete(limits, 'personalUseLimits.editableFiles[1].' + attribute,
                                       'getter failed: ' + attribute)

    def test_payload_rejects_extra_args_without_reading_limits(self):
        self.assertEqual(self.report(object(), ['Part']),
                         'ERROR file_editability takes no positional arguments\n')


if __name__ == '__main__':
    unittest.main()
