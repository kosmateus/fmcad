"""Actual legacy handlers under offline SDK stubs; no Fusion process is contacted."""
import contextlib
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class LegacyManualContracts(unittest.TestCase):
    def setUp(self):
        self.app = types.SimpleNamespace(data=types.SimpleNamespace(), documents=[], activeProduct=None)
        core = types.ModuleType('adsk.core')
        core.Application = types.SimpleNamespace(get=lambda: self.app)
        core.ValueInput = types.SimpleNamespace(createByString=lambda value: value)
        fusion = types.ModuleType('adsk.fusion')
        fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        fusion.DistanceUnits = types.SimpleNamespace(MillimeterDistanceUnits=0, CentimeterDistanceUnits=1, InchDistanceUnits=2)
        adsk = types.ModuleType('adsk')
        adsk.core, adsk.fusion = core, fusion
        self.modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def load(self, name):
        namespace = {'__name__': 'offline_legacy_manual'}
        file = Path(__file__).resolve().parents[1] / 'assets' / name
        exec(compile(file.read_text(), str(file), 'exec'), namespace)
        return namespace

    def output(self, function, *args):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            function(*args)
        return stream.getvalue()

    def test_param_add_safe_padded_slots_and_documented_omission_defect(self):
        made = []

        class Parameters(list):
            def add(self, name, expression, unit, comment):
                made.append((name, expression, unit, comment))
                return types.SimpleNamespace(name=name, expression=expression, unit=unit)

        self.app.activeProduct = types.SimpleNamespace(userParameters=Parameters())
        self.app.documents = [types.SimpleNamespace(name='Model', activate=lambda: True)]
        ns = self.load('fusion_data_manager.py')
        ns['OP'], ns['ARGS'] = 'param_add', ['wall', '3 mm', '', '', 'Model']
        self.assertIn('CREATED_PARAM', self.output(ns['run'], ''))
        self.assertEqual(made, [('wall', '3 mm', 'mm', '')])
        ns['ARGS'] = ['other', '3 mm', 'Model']
        self.assertIn('ERROR document commands require', self.output(ns['run'], ''))
        self.assertEqual(len(made), 1)

    def test_folder_delete_slash_only_path_reaches_root_despite_guard(self):
        deleted = []
        root = types.SimpleNamespace(deleteMe=lambda: deleted.append('root') or False)
        project = types.SimpleNamespace(name='Project', rootFolder=root)
        data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
        ns = self.load('fusion_data_manager.py')
        self.assertIn('cannot delete project root', self.output(ns['cmd_folder_delete'], data, 'Project', ''))
        self.assertEqual(deleted, [])
        self.assertIn('ERROR folder_delete', self.output(ns['cmd_folder_delete'], data, 'Project', '///'))
        self.assertEqual(deleted, ['root'])

    def test_file_move_ignores_false_api_result_as_documented(self):
        file = types.SimpleNamespace(name='Part', fileExtension='f3d', id='file-id', move=lambda target: False, deleteMe=lambda: False)
        root = types.SimpleNamespace(name='Root', dataFiles=types.SimpleNamespace(asArray=lambda: [file]))
        project = types.SimpleNamespace(name='Project', rootFolder=root)
        data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
        ns = self.load('fusion_data_manager.py')
        self.assertIn('MOVED_FILE', self.output(ns['cmd_file_move'], data, 'Project', '', 'Part', ''))

    def test_file_delete_acceptance_false_and_exception_without_replay(self):
        for outcome in (True, False, RuntimeError('SDK deletion failed')):
            with self.subTest(outcome=outcome):
                class File:
                    fileExtension = 'f3d'
                    calls = 0

                    @property
                    def id(self):
                        if self.calls:
                            raise RuntimeError('invalid after deleteMe')
                        return 'file-id'

                    @property
                    def name(self):
                        if self.calls:
                            raise RuntimeError('invalid after deleteMe')
                        return 'Part'

                    def deleteMe(self):
                        self.calls += 1
                        if isinstance(outcome, Exception):
                            raise outcome
                        return outcome

                file = File()
                reads = []

                def files():
                    reads.append('lookup')
                    self.assertEqual(file.calls, 0, 'no post-delete folder readback')
                    return [file]

                root = types.SimpleNamespace(dataFiles=types.SimpleNamespace(asArray=files))
                project = types.SimpleNamespace(name='Project', rootFolder=root)
                self.app.data = types.SimpleNamespace(dataProjects=types.SimpleNamespace(asArray=lambda: [project]))
                ns = self.load('fusion_data_manager.py')
                ns['OP'], ns['ARGS'] = 'file_delete', ['Project', '', 'Part.f3d']
                stream = io.StringIO()
                with contextlib.redirect_stdout(stream):
                    if isinstance(outcome, Exception):
                        with self.assertRaises(RuntimeError) as caught:
                            ns['run']('')
                        self.assertIs(caught.exception, outcome)
                    else:
                        ns['run']('')
                self.assertEqual(file.calls, 1)
                self.assertEqual(reads, ['lookup'])
                lines = stream.getvalue().splitlines()
                if outcome is True:
                    self.assertEqual(len(lines), 3)
                    self.assertEqual(lines[0], 'DELETED_FILE name=Part.f3d')
                    self.assertTrue(lines[1].startswith('FILE_DELETE '))
                    self.assertEqual(json.loads(lines[1].removeprefix('FILE_DELETE ')), {
                        'id': 'file-id', 'name': 'Part', 'accepted': True,
                        'permanentDeletionVerified': False, 'editableSlotReleased': 'notVerified'})
                    self.assertEqual(lines[2], 'DONE')
                elif outcome is False:
                    self.assertEqual(lines, ['ERROR file_delete deleteMe returned false: Part.f3d'])
                else:
                    self.assertEqual(lines, [])

    def test_body_volume_failure_is_reported_as_zero_not_real_measurement(self):
        class Body:
            name = 'Body'
            isVisible = True

            @property
            def physicalProperties(self):
                raise RuntimeError('MOCK property failure')

        root = types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=1, item=lambda index: Body()))
        self.app.activeProduct = types.SimpleNamespace(rootComponent=root)
        self.app.documents = [types.SimpleNamespace(name='Model', activate=lambda: True)]
        ns = self.load('inspect.py')
        self.assertIn('volume=0.00 mm3', self.output(ns['cmd_bodies'], None, 'Model'))

    def test_builtin_box_missing_document_is_rejected_without_active_design_fallback(self):
        class ActiveDesign:
            @property
            def rootComponent(self):
                raise RuntimeError('MOCK reached active design despite missing target')

        self.app.activeProduct = ActiveDesign()
        self.app.activeDocument = types.SimpleNamespace(name='OtherDocument')
        ns = self.load('scripts/box.py')
        ns['DOC_NAME'] = 'MissingTarget'
        output = self.output(ns['run'], '')
        self.assertIn('ERROR expected exactly one open document: MissingTarget', output)


if __name__ == '__main__':
    unittest.main()
