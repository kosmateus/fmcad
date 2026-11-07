"""Private ordinary-save SDK handler contract; no Fusion connection."""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]


class SavePublicationHandlerTests(unittest.TestCase):
    def setUp(self):
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        self.module = types.ModuleType('save_publication_under_test')
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            load_legacy_core(self.module.__dict__, ROOT)
            exec(compile((ROOT / 'assets/cad/identity.py').read_text(), '<identity>', 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/document_snapshot.py').read_text(), '<document_snapshot>', 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/document.py').read_text(), '<document>', 'exec'), self.module.__dict__)
        self.project = types.SimpleNamespace(id='project-1')
        self.file = types.SimpleNamespace(id='file-1', parentProject=self.project,
            versionNumber=3, isComplete=True, isReadOnly=False)
        self.calls = []
        self.doc = types.SimpleNamespace(name='SavedScratch', creationId='creation-1', isValid=True,
            isSaved=True, isModified=True, dataFile=self.file)
        self.app = types.SimpleNamespace(activeDocument=self.doc,
            userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
        self.ctx = types.SimpleNamespace(doc=self.doc, app=self.app)
        self.ctx.assert_identity = lambda: None
        self.doc.save = self.save
        self.data = {'requestId': 'request-1', 'operationId': 'operation-1',
            'projectId': 'project-1', 'fileId': 'file-1', 'creationId': 'creation-1',
            'version': 3, 'description': 'Authorized test save'}
        self.behavior = 'accepted'

    def save(self, description):
        self.calls.append(description)
        if self.behavior == 'raise':
            raise RuntimeError('post-entry SDK failure')
        if self.behavior == 'false':
            return False
        self.doc.isModified = False
        return True

    def call(self):
        return self.module.CAD_HANDLERS['document.save_native'](self.ctx, self.data)

    def test_changed_saved_target_accepted_exactly_once_without_post_save_getters(self):
        result = self.call()
        self.assertEqual(result['status'], 'accepted')
        self.assertTrue(result['accepted'])
        self.assertTrue(result['saveAttempted'])
        self.assertEqual(self.calls, ['Authorized test save'])

    def test_clean_document_is_noop_and_preserves_baseline_version(self):
        self.doc.isModified = False
        self.file.isReadOnly = True
        self.file.isComplete = False
        self.app.activeDocument = object()
        self.app.userInterface.activeCommand = 'MoveCommand'
        result = self.call()
        self.assertEqual(result['status'], 'noop')
        self.assertFalse(result['saveAttempted'])
        self.assertEqual(result['resultingVersion'], 3)
        self.assertFalse(result['cloudComplete'])
        self.assertEqual(self.calls, [])

    def test_identity_version_active_document_command_and_writability_guards_precede_save(self):
        changes = [
            lambda: setattr(self.file, 'id', 'other-file'),
            lambda: setattr(self.file, 'versionNumber', 4),
            lambda: setattr(self.app, 'activeDocument', object()),
            lambda: setattr(self.app.userInterface, 'activeCommand', 'MoveCommand'),
            lambda: setattr(self.file, 'isReadOnly', True),
            lambda: setattr(self.file, 'isComplete', False),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                change()
                result = self.call()
                self.assertEqual(result['status'], 'blocked')
                self.assertFalse(result['saveAttempted'])
                self.assertEqual(self.calls, [])

    def test_native_false_and_post_entry_exception_are_not_conflated(self):
        self.behavior = 'false'
        failed = self.call()
        self.assertEqual(failed['status'], 'failed')
        self.assertFalse(failed['accepted'])
        self.assertTrue(failed['saveAttempted'])
        self.assertEqual(len(self.calls), 1)

        self.calls.clear()
        self.behavior = 'raise'
        unknown = self.call()
        self.assertEqual(unknown['status'], 'unknown')
        self.assertIsNone(unknown['accepted'])
        self.assertTrue(unknown['saveAttempted'])
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
