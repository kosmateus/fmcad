"""FAKE SDK only: exact publication/retention scope, no Fusion/cloud connection."""
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
NS = {}
for name in ('atomic_audit', 'scratch_epoch', 'saved_fixture'):
    source = ROOT / 'runtime/python/recovery' / (name + '.py')
    exec(compile(source.read_text(), str(source), 'exec'), NS)


class DataFile(types.SimpleNamespace):
    @property
    def parentProject(self):
        raise RuntimeError('DataFile.parentProject InternalValidationError')


class Documents:
    def __init__(self):
        self.rows = []

    @property
    def count(self):
        return len(self.rows)

    def item(self, index):
        return self.rows[index]

    def add(self, unused):
        raise AssertionError('Observer/retention must not create another document')


class Document:
    def __init__(self, app, name, creation_id, file=None):
        self.app, self.name, self.creationId, self.file = app, name, creation_id, file
        self.isValid, self.isSaved, self.isModified = True, file is not None, False
        self.allDocumentReferences = types.SimpleNamespace(count=0)
        self.closes, self.activations = 0, 0
        self.close_result, self.drift_after_close = True, False
        self.file_error = None

    @property
    def dataFile(self):
        if not self.isSaved:
            raise RuntimeError('Temporary DataFile getter must not be read')
        if self.file_error is not None:
            raise self.file_error
        return self.file

    def save(self, unused):
        raise AssertionError('Publication observation or retain must never save')

    def saveAs(self, *unused):
        raise AssertionError('Publication observation or retain must never saveAs')

    def close(self, save_changes):
        assert save_changes is False
        self.closes += 1
        self.app.documents.rows.remove(self)
        if self.app.activeDocument is self:
            self.app.activeDocument = self.app.documents.rows[-1]
        if self.drift_after_close:
            self.file.versionNumber += 1
        return self.close_result

    def activate(self):
        self.activations += 1
        self.app.activeDocument = self
        return True


class SavedFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='/tmp/opencode/saved-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.epoch = 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12
        self.app = types.SimpleNamespace(documents=Documents(), userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
        self.file = DataFile(id='new-file', name='FMCAD_ISOLATED_' + self.epoch,
            parentFolder=types.SimpleNamespace(id='approved-folder', parentProject=types.SimpleNamespace(id='native-project')),
            versionNumber=1, isComplete=True)
        self.user = Document(self.app, 'USER_UNTOUCHED', 'user-restore')
        self.other = Document(self.app, 'USER_SELECTED', 'user-other')
        self.owned = Document(self.app, self.file.name, 'owned-new', self.file)
        self.app.documents.rows = [self.user, self.other, self.owned]
        self.app.activeDocument = self.owned
        self.args = {'epochId': self.epoch, 'document': {'name': self.file.name, 'creationId': 'owned-new', 'fileId': None},
            'proofPath': str(Path(self.temp.name) / 'proof.json'), 'bindingHash': 'b' * 64,
            'destination': {'projectId': 'native-project', 'folderId': 'approved-folder'}, 'expectedFileId': 'new-file',
            'savedDocument': {'name': self.file.name, 'creationId': 'owned-new', 'fileId': 'new-file',
                'projectId': 'native-project', 'folderId': 'approved-folder', 'version': 1},
            'restoreActiveCreationId': 'user-restore'}

    def test_observation_is_read_only_and_keeps_upload_pending_distinct(self):
        self.file.isComplete = False
        value = NS['observe_saved_fixture'](self.app, self.args)
        self.assertTrue(value['readOnly'])
        self.assertFalse(value['observed']['isComplete'])
        self.assertEqual(value['observed']['fileId'], 'new-file')
        self.assertEqual(self.owned.closes, 0)
        self.assertIs(self.app.activeDocument, self.owned)

    def test_destination_probe_reads_actual_native_ids_without_saving_or_switching_hubs(self):
        self.owned.isSaved = False
        collection = lambda rows: types.SimpleNamespace(count=len(rows), item=lambda index: rows[index])
        folder = types.SimpleNamespace(name='FMCAD_NATIVE_20261105_123456ab', id='approved-folder')
        project = types.SimpleNamespace(name='APPROVED', id='native-project',
            rootFolder=types.SimpleNamespace(dataFolders=collection([folder])),
            parentHub=types.SimpleNamespace(id='native-hub', name='KADOL'))
        folder.parentProject = project
        self.app.data = types.SimpleNamespace(dataProjects=collection([project]))
        self.args['destination'] = {'projectName': 'APPROVED', 'folderName': folder.name, 'folderId': folder.id}
        value = NS['probe_saved_destination'](self.app, self.args)
        self.assertTrue(value['readOnly'])
        self.assertEqual(value['destination']['nativeProjectId'], 'native-project')
        self.assertEqual(value['destination']['nativeHubId'], 'native-hub')
        self.assertFalse(self.owned.isSaved)
        self.assertEqual(self.owned.closes, 0)
        self.assertIs(self.app.activeDocument, self.owned)

    def test_unsaved_publication_does_not_read_temporary_file_getter(self):
        self.owned.isSaved = False
        value = NS['observe_saved_fixture'](self.app, self.args)
        self.assertIsNone(value['observed']['fileId'])
        self.assertFalse(value['observed']['saved'])

    def test_saved_upload_with_metadata_not_ready_stays_read_only(self):
        self.file.parentFolder = None
        self.file.isComplete = False
        value = NS['observe_saved_fixture'](self.app, self.args)
        self.assertIsNone(value['observed']['projectId'])
        self.assertIsNone(value['observed']['folderId'])
        self.assertFalse(value['observed']['isComplete'])
        self.assertEqual(self.owned.closes, 0)

    def test_known_temporary_file_error_remains_diagnostic_not_unsaved_or_published(self):
        self.owned.file_error = RuntimeError('3 : Failed to get temporary file')
        value = NS['observe_saved_fixture'](self.app, self.args)
        self.assertTrue(value['observed']['saved'])
        self.assertIsNone(value['observed']['fileId'])
        self.assertIn('Failed to get temporary file', value['observed']['dataFileError']['message'])
        self.assertEqual(self.owned.closes, 0)

    def test_foreign_publication_file_is_not_adopted(self):
        self.file.id = 'foreign-file'
        with self.assertRaisesRegex(ValueError, 'lineage changed'):
            NS['observe_saved_fixture'](self.app, self.args)
        self.assertFalse(Path(self.args['proofPath']).exists())
        self.assertEqual(self.owned.closes, 0)

    def test_complete_unmodified_file_is_retained_and_exact_active_identity_restored(self):
        value = NS['retain_saved_fixture'](self.app, self.args)
        self.assertTrue(value['retained'])
        self.assertTrue(value['saved'])
        self.assertEqual(self.owned.closes, 1)
        self.assertEqual(self.user.closes + self.other.closes, 0)
        self.assertIs(self.app.activeDocument, self.user)
        self.assertEqual(self.file.id, 'new-file')
        self.assertEqual(self.file.versionNumber, 1)

    def test_user_selected_other_document_is_preserved(self):
        self.app.activeDocument = self.other
        value = NS['retain_saved_fixture'](self.app, self.args)
        self.assertEqual(value['restoredActiveCreationId'], 'user-other')
        self.assertIs(self.app.activeDocument, self.other)
        self.assertEqual(self.user.activations, 0)

    def test_dirty_incomplete_or_version_drift_refuses_before_close(self):
        for field, value in [('isModified', True), ('isComplete', False), ('versionNumber', 2)]:
            with self.subTest(field=field):
                obj = self.owned if field == 'isModified' else self.file
                previous = getattr(obj, field)
                setattr(obj, field, value)
                with self.assertRaisesRegex(ValueError, 'published unmodified'):
                    NS['retain_saved_fixture'](self.app, self.args)
                self.assertEqual(self.owned.closes, 0)
                setattr(obj, field, previous)

    def test_missing_restore_target_refuses_before_close(self):
        self.args['restoreActiveCreationId'] = 'missing-user-document'
        with self.assertRaisesRegex(ValueError, 'restore document'):
            NS['retain_saved_fixture'](self.app, self.args)
        self.assertEqual(self.owned.closes, 0)

    def test_uncertain_close_never_replays_or_publishes_success(self):
        self.owned.close_result = False
        with self.assertRaisesRegex(RuntimeError, 'uncertain'):
            NS['retain_saved_fixture'](self.app, self.args)
        self.assertFalse(Path(self.args['proofPath']).exists())
        with self.assertRaisesRegex(ValueError, 'absent'):
            NS['retain_saved_fixture'](self.app, self.args)
        self.assertEqual(self.owned.closes, 1)


if __name__ == '__main__':
    unittest.main()
