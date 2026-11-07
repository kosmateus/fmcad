"""Document manual examples use isolated cloud stubs; never save a real document."""
import unittest

import document_save_test as fixtures
import document_clear_test as clear_fixtures
from manual_assembly_test import manual, validate_manual


STATUS_KEYS = {'name', 'creationId', 'saved', 'modified', 'fileId', 'fileName', 'version',
               'versionId', 'isComplete', 'isReadOnly', 'folderId', 'projectId'}


class ManualDocumentTests(unittest.TestCase):
    def test_catalog_coverage_metadata_and_outer_validator(self):
        validate_manual(self, 'document')
        self.assertEqual(len(manual('document')), 5)

    def test_every_example_saved_unsaved_complete_pending_and_false(self):
        for operation, entry in manual('document').items():
            for example in entry['examples']:
                if operation in ('document.save.once', 'document.save.observe'):
                    # These public methods are Node-only coordinators; their manual examples
                    # are executed by tests/document-publication.test.js, not Python handlers.
                    continue
                if operation == 'document.clear':
                    fixture = clear_fixtures.DocumentClearTests()
                    fixture.setUp()
                    fixture.fixture()
                    data = dict(example['data'], fileId=fixture.file.id)
                    output = fixture.call(**data)
                    self.assertEqual(output['status'], 'inspected' if data.get('dryRun') else 'cleared')
                    self.assertFalse(output['savePerformed'])
                    if data.get('dryRun'):
                        self.assertEqual(fixture.calls, [])
                    else:
                        self.assertTrue(all(count == 0 for count in output['after'].values()))
                    continue
                for saved in (False, True):
                    for behavior in ('complete', 'processing', 'unchanged', 'false'):
                        with self.subTest(operation=operation, example=example['label'], saved=saved, behavior=behavior):
                            fixture = fixtures.DocumentSaveTests()
                            fixture.setUp()
                            fixture.doc.isSaved = saved
                            fixture.doc.dataFile = fixture.file('original-id') if saved else None
                            fixture.behavior = behavior
                            output = fixture.call(operation, example['data'])
                            if operation == 'document.status':
                                self.assertEqual(set(output), STATUS_KEYS)
                                self.assertEqual(fixture.calls, [])
                            else:
                                self.assertEqual(set(output), {'accepted', 'pending', 'status', 'targetObserved',
                                    'original', 'current', 'target', 'copyRequested', 'warning'})
                                self.assertEqual(set(output['original']), STATUS_KEYS)
                                self.assertEqual(set(output['current']), STATUS_KEYS)
                                self.assertEqual(set(output['target']), {'name', 'projectId', 'projectName', 'folderId', 'folder'})
                                self.assertEqual(output['copyRequested'], saved)
                                self.assertEqual(output['status'], 'complete' if behavior == 'complete' else
                                                 'failed' if behavior == 'false' else 'pending')

    def test_save_as_status_followup_uses_current_target_identity(self):
        fixture = fixtures.DocumentSaveTests()
        fixture.setUp()
        fixture.doc.isSaved = True
        fixture.doc.dataFile = fixture.file('original-id')
        output = fixture.call(data=manual('document')['document.save_as']['examples'][0]['data'])
        current = fixture.call('document.status', {})
        self.assertNotEqual(current['fileId'], output['original']['fileId'])
        for field, target in (('fileName', 'name'), ('folderId', 'folderId'), ('projectId', 'projectId')):
            self.assertEqual(current[field], output['target'][target])
        self.assertTrue(current['saved'])
        self.assertFalse(current['modified'])
        self.assertTrue(current['isComplete'])


if __name__ == '__main__':
    unittest.main()
