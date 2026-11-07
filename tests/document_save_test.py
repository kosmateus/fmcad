"""Offline Document/DataFolder contract stubs only; never connects to Fusion/cloud."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]


class Items:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]

    def add(self, *args):
        raise AssertionError('Must not create cloud destinations')

    def itemByName(self, *args):
        raise AssertionError('Must enumerate to detect duplicates')


class DataFolder:
    def __init__(self, name, id, children=(), files=()):
        self.name, self.id = name, id
        self.dataFolders, self.dataFiles = Items(children), Items(files)


class DataFile(types.SimpleNamespace):
    @property
    def parentProject(self):
        raise RuntimeError('DataFile.parentProject InternalValidationError')


class Document(types.SimpleNamespace):
    data_file_reads = 0
    data_file_error = None

    @property
    def dataFile(self):
        self.data_file_reads += 1
        if not self.isSaved:
            raise RuntimeError('3 : Failed to get temporary file')
        if self.data_file_error is not None:
            raise self.data_file_error
        return self._file

    @dataFile.setter
    def dataFile(self, value):
        self._file = value


class DocumentSaveTests(unittest.TestCase):
    def setUp(self):
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        self.module = types.ModuleType('document_under_test')
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            load_legacy_core(self.module.__dict__, ROOT)
            self.core_handlers = set(self.module.CAD_HANDLERS)
            exec(compile((ROOT / 'assets/cad/identity.py').read_text(), '<identity>', 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/document_snapshot.py').read_text(), '<document_snapshot>', 'exec'), self.module.__dict__)
            exec(compile((ROOT / 'assets/cad/document.py').read_text(), '<document>', 'exec'), self.module.__dict__)
        self.parts = DataFolder('Parts', 'parts-id')
        self.designs = DataFolder('Designs', 'designs-id', [self.parts])
        self.root = DataFolder('Root', 'root-id', [self.designs])
        self.project = types.SimpleNamespace(name='ProductProject', id='project-id', rootFolder=self.root)
        for folder in (self.root, self.designs, self.parts):
            folder.parentProject = self.project
        self.doc = Document(name='Untitled', creationId='creation-id', isSaved=False,
                                         isModified=True, dataFile=None, saveAs=self.save_as)
        self.app = types.SimpleNamespace(data=types.SimpleNamespace(dataProjects=Items([self.project])),
                                         activeDocument=object())
        self.ctx = types.SimpleNamespace(doc=self.doc, app=self.app)
        self.ctx.require_confirm = lambda data: self.module.CadContext.require_confirm(self.ctx, data)
        self.calls = []
        self.behavior = 'complete'
        self.output = io.StringIO()
        self.data = dict(name='Housing', project='ProductProject', folder='Designs/Parts', confirm=True)

    def file(self, id='new-id', complete=True, folder=None, name='Housing'):
        return DataFile(id=id, name=name, versionNumber=1, versionId=id + '?version=1',
                        isComplete=complete, parentFolder=folder or self.parts)

    def save_as(self, name, folder, description, tag):
        self.calls.append((name, folder, description, tag))
        if self.behavior == 'error':
            raise RuntimeError('SDK command transaction error')
        if self.behavior == 'false':
            return False
        if self.behavior == 'unchanged':
            return True
        self.doc.name, self.doc.isSaved, self.doc.isModified = name, True, False
        self.doc.dataFile = self.file(complete=self.behavior == 'complete', folder=folder, name=name)
        return True

    def call(self, operation='document.save_as', data=None):
        with contextlib.redirect_stdout(self.output):
            return self.module.CAD_HANDLERS[operation](self.ctx, self.data if data is None else data)

    def test_first_save_complete_and_exact_destination(self):
        result = self.call()
        self.assertTrue(result['accepted'])
        self.assertFalse(result['pending'])
        self.assertEqual(result['status'], 'complete')
        self.assertIsNone(result['original']['fileId'])
        self.assertEqual(result['current']['fileId'], 'new-id')
        self.assertFalse(result['copyRequested'])
        self.assertEqual(self.calls, [('Housing', self.parts, '', '')])
        self.assertIn('command-related events', self.output.getvalue())

    def test_first_save_can_pin_expected_folder_id(self):
        result = self.call(data=dict(self.data, expectedFolderId='parts-id'))
        self.assertEqual(result['target']['folderId'], 'parts-id')
        self.assertEqual(len(self.calls), 1)

    def test_first_save_pins_native_project_not_an_inferred_workspace_alias(self):
        with self.assertRaisesRegex(ValueError, 'expectedProjectId'):
            self.call(data=dict(self.data, expectedProjectId='urn:adsk.workspace:foreign'))
        self.assertEqual(self.calls, [])
        result = self.call(data=dict(self.data, expectedProjectId='project-id', expectedFolderId='parts-id'))
        self.assertEqual(result['target']['projectId'], 'project-id')
        self.assertEqual(len(self.calls), 1)

    def test_expected_folder_id_refuses_replaced_destination_before_save(self):
        for expected in ('another-folder-id', '', None, 42):
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(ValueError, 'expectedFolderId'):
                    self.call(data=dict(self.data, expectedFolderId=expected))
                self.assertEqual(self.calls, [])

    def test_root_by_project_id_and_optional_strings(self):
        result = self.call(data=dict(self.data, project='project-id', folder='', description='Initial', tag='Review'))
        self.assertEqual(result['target']['folderId'], 'root-id')
        self.assertEqual(self.calls, [('Housing', self.root, 'Initial', 'Review')])

    def test_saved_copy_retains_original_identity(self):
        self.doc.isSaved = True
        self.doc.dataFile = self.file('original-id')
        result = self.call()
        self.assertTrue(result['copyRequested'])
        self.assertEqual(result['original']['fileId'], 'original-id')
        self.assertEqual(result['current']['fileId'], 'new-id')
        self.assertEqual(result['current']['creationId'], 'creation-id')

    def test_recovery_status_is_diagnostic_but_cloud_copy_does_not_guess_original_identity(self):
        self.doc.isSaved = True
        self.doc.data_file_error = RuntimeError('3 : Failed to get temporary file')
        with self.assertRaisesRegex(RuntimeError, 'Failed to get temporary file'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_saved_and_unsaved_rejected_errors_and_pending(self):
        for saved in (False, True):
            for behavior in ('false', 'error', 'unchanged', 'processing'):
                with self.subTest(saved=saved, behavior=behavior):
                    self.doc.isSaved, self.doc.isModified = saved, True
                    self.doc.dataFile = self.file('original-id') if saved else None
                    self.behavior = behavior
                    if behavior == 'error':
                        with self.assertRaisesRegex(RuntimeError, 'SDK command transaction'):
                            self.call()
                    else:
                        result = self.call()
                        self.assertEqual(result['accepted'], behavior != 'false')
                        self.assertEqual(result['pending'], behavior != 'false')
                        self.assertEqual(result['status'], 'failed' if behavior == 'false' else 'pending')

    def test_complete_original_or_wrong_target_is_not_completed_copy(self):
        self.doc.isSaved, self.doc.isModified = True, False
        self.doc.dataFile = self.file('original-id')
        self.behavior = 'unchanged'
        self.assertTrue(self.call()['pending'])
        other_project_folder = types.SimpleNamespace(id=self.parts.id,
                                                     parentProject=types.SimpleNamespace(id='other-project'))
        for override in ({'parentFolder': self.root}, {'name': 'Other'}, {'isComplete': None},
                         {'parentFolder': other_project_folder}):
            with self.subTest(override=override):
                def save(*args):
                    self.doc.dataFile = self.file('different-' + str(len(self.calls)))
                    self.calls.append(args)
                    self.doc.dataFile.__dict__.update(override)
                    return True
                self.doc.saveAs = save
                self.assertTrue(self.call()['pending'])

    def test_transient_file_project_error_preserves_completion_criteria(self):
        for saved in (False, True):
            for changes, observed, complete in (
                    ({}, True, True),
                    ({'isComplete': False}, True, False),
                    ({'isComplete': None}, True, False),
                    ({'modified': True}, True, False),
                    ({'saved': False}, False, False),
                    ({'id': ''}, False, False),
                    ({'id': 'original-id'}, not saved, not saved)):
                with self.subTest(saved=saved, changes=changes):
                    self.doc.isSaved, self.doc.isModified = saved, False
                    self.doc.dataFile = self.file('original-id') if saved else None
                    target_file = self.file()
                    with self.assertRaisesRegex(RuntimeError, 'InternalValidationError'):
                        _ = target_file.parentProject
                    def save(*args):
                        self.calls.append(args)
                        self.doc.dataFile = target_file
                        self.doc.isSaved = changes.get('saved', True)
                        self.doc.isModified = changes.get('modified', False)
                        for key in ('id', 'isComplete'):
                            if key in changes:
                                setattr(target_file, key, changes[key])
                        return True
                    self.doc.saveAs = save
                    before = len(self.calls)
                    result = self.call()
                    self.assertEqual(len(self.calls), before + 1)
                    self.assertTrue(result['accepted'])
                    self.assertEqual(result['targetObserved'], observed)
                    self.assertEqual(result['status'], 'complete' if complete else 'pending')
                    self.assertEqual(result['pending'], not complete)
                    self.assertEqual(result['current']['projectId'], self.project.id if result['current']['saved'] else None)
                    self.assertEqual(result['current']['folderId'], self.parts.id if result['current']['saved'] else None)
                    self.assertEqual(self.call('document.status', {}), result['current'])

    def test_all_input_validation_precedes_save(self):
        bad = [{'confirm': v} for v in (False, 'true', 1, None)]
        bad += [{'name': v} for v in ('', ' ', '../Housing', 'Housing/', 'Housing.', ' Housing', 3)]
        bad += [{'folder': v} for v in (None, '/Designs', 'Designs/', 'Designs//Parts', '.', '..',
                                      'Designs/../Parts', 'C:/Parts', 'Designs\\Parts', 'urn:folder:id')]
        bad += [{'project': v} for v in ('', None, 'Product', 'missing')]
        bad += [{'description': 1}, {'tag': False}, {'overwrite': True}]
        for changes in bad:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call(data=dict(self.data, **changes))
        for key in self.data:
            with self.subTest(missing=key), self.assertRaises(ValueError):
                self.call(data={k: v for k, v in self.data.items() if k != key})
        self.assertEqual(self.calls, [])

    def test_duplicate_projects_and_id_name_ambiguity(self):
        for name in ('ProductProject', 'project-id'):
            self.app.data.dataProjects.values = [self.project,
                types.SimpleNamespace(name=name, id='other-id', rootFolder=self.root)]
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                self.call(data=dict(self.data, project=name))
        self.assertEqual(self.calls, [])

    def test_full_path_missing_and_duplicate_folder_segments(self):
        for path in ('Parts', 'Designs/Missing', 'designs/Parts'):
            with self.assertRaisesRegex(ValueError, 'folder segment'):
                self.call(data=dict(self.data, folder=path))
        self.designs.dataFolders.values.append(DataFolder('Parts', 'duplicate'))
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.call()
        self.root.dataFolders.values.append(DataFolder('Designs', 'duplicate-parent'))
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.call()
        self.assertEqual(self.calls, [])

    def test_filename_collision_rejects_all_types_and_case(self):
        for name in ('Housing', 'HOUSING'):
            self.parts.dataFiles.values = [types.SimpleNamespace(name=name, fileExtension='step')]
            with self.assertRaisesRegex(ValueError, 'already exists'):
                self.call()
        self.assertEqual(self.calls, [])

    def test_read_only_status_and_optional_metadata(self):
        active = self.app.activeDocument
        before = dict(self.doc.__dict__)
        result = self.call('document.status', {})
        self.assertFalse(result['saved'])
        self.assertIsNone(result['fileId'])
        self.assertIsNone(result['isComplete'])
        self.assertEqual(before, self.doc.__dict__)
        self.doc.dataFile = self.file()
        self.doc.isSaved = True
        del self.doc.dataFile.isComplete
        result = self.call('document.status', {})
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['versionId'], 'new-id?version=1')
        self.assertIsNone(result['isComplete'])
        self.assertIs(self.app.activeDocument, active)
        self.assertEqual(self.output.getvalue(), '')
        self.assertEqual(self.calls, [])

    def test_unsaved_status_skips_throwing_data_file_getter(self):
        with self.assertRaisesRegex(RuntimeError, 'Failed to get temporary file'):
            _ = self.doc.dataFile
        reads = self.doc.data_file_reads
        result = self.call('document.status', {})
        self.assertEqual(self.doc.data_file_reads, reads)
        self.assertEqual(result, dict(name='Untitled', creationId='creation-id', saved=False,
                                     modified=True, fileId=None, fileName=None, version=None,
                                     versionId=None, isComplete=None, isReadOnly=None, folderId=None, projectId=None))

    def test_post_readback_errors_preserve_exact_acceptance_and_original_without_retry(self):
        for saved in (False, True):
            for accepted in (True, False):
                with self.subTest(saved=saved, accepted=accepted):
                    self.doc.data_file_error = None
                    self.doc.isSaved = saved
                    self.doc.name, self.doc.creationId = 'Before', 'before-id'
                    self.doc.dataFile = self.file('original-id') if saved else None
                    original = self.call('document.status', {})
                    def save(*args):
                        self.calls.append(args)
                        self.doc.name, self.doc.creationId = 'After', 'after-id'
                        self.doc.isSaved = True
                        self.doc.data_file_error = RuntimeError('3 : Failed to get temporary file')
                        return accepted
                    self.doc.saveAs = save
                    before = len(self.calls)
                    active = self.app.activeDocument
                    result = self.call()
                    self.assertIs(result['accepted'], accepted)
                    self.assertIs(result['pending'], accepted)
                    self.assertEqual(result['status'], 'pending' if accepted else 'failed')
                    self.assertFalse(result['targetObserved'])
                    self.assertIsNone(result['current'])
                    self.assertEqual(result['original'], original)
                    self.assertEqual(result['copyRequested'], saved)
                    self.assertEqual(result['readbackError'], {
                        'type': 'RuntimeError', 'message': '3 : Failed to get temporary file'})
                    self.assertEqual(len(self.calls), before + 1)
                    self.assertIs(self.app.activeDocument, active)
                    json.dumps(result)

    def test_accepted_unsaved_identity_change_remains_pending_without_data_file_read(self):
        original = self.call('document.status', {})
        def save(*args):
            self.calls.append(args)
            self.doc.name, self.doc.creationId = 'Housing v0', 'after-id'
            return True
        self.doc.saveAs = save
        result = self.call()
        self.assertEqual(result['original'], original)
        self.assertEqual(result['current']['creationId'], 'after-id')
        self.assertFalse(result['current']['saved'])
        self.assertTrue(result['current']['modified'])
        self.assertIsNone(result['current']['fileId'])
        self.assertTrue(result['accepted'])
        self.assertTrue(result['pending'])
        self.assertEqual(result['status'], 'pending')
        self.assertFalse(result['targetObserved'])
        self.assertNotIn('readbackError', result)
        self.assertEqual(self.doc.data_file_reads, 0)
        self.assertEqual(len(self.calls), 1)

    def test_pre_save_status_error_propagates_without_save(self):
        self.doc.isSaved = True
        error = RuntimeError('pre-save metadata unavailable')
        self.doc.data_file_error = error
        for operation, data in (('document.status', {}), ('document.save_as', self.data)):
            with self.assertRaises(RuntimeError) as caught:
                self.call(operation, data)
            self.assertIs(caught.exception, error)
        self.assertEqual(self.calls, [])

    def test_primary_save_error_preserved_without_post_readback_or_resave(self):
        error = RuntimeError('primary SDK save failure')
        def save(*args):
            self.calls.append(args)
            self.doc.isSaved = True
            self.doc.data_file_error = RuntimeError('secondary readback failure')
            raise error
        self.doc.saveAs = save
        with self.assertRaises(RuntimeError) as caught:
            self.call()
        self.assertIs(caught.exception, error)
        self.assertEqual(self.doc.data_file_reads, 0)
        self.assertEqual(len(self.calls), 1)

    def test_catalog_bundle_and_cli_boolean_cloud_paths(self):
        catalog = json.loads((ROOT / 'src/catalog/document.json').read_text())
        python_operations = {operation for operation, entry in catalog.items() if not entry.get('nodeOnly')}
        self.assertEqual(python_operations, set(self.module.CAD_HANDLERS) - self.core_handlers)
        for entry in catalog.values():
            self.assertLessEqual(set(entry['required']), set(entry['example']))
            self.assertLessEqual(set(entry['example']), set(entry['inputs']))
        self.assertTrue(catalog['document.status']['readOnly'])
        self.assertFalse(catalog['document.save_as']['readOnly'])
        core = ROOT / 'assets/cad/core.py'
        compile('\n\n'.join(p.read_text() for p in [core] + sorted(p for p in core.parent.glob('*.py') if p != core)),
                '<bundle>', 'exec')
        script = """
const assert = require('node:assert/strict');
const {parseCadInput} = require('./src/cad-input');
const {catalog, validateCad, mapCadPaths} = require('./src/cad');
const op = 'document.save_as';
const {data} = parseCadInput(['--name', 'Housing', '--project', 'ProductProject', '--folder', '', '--confirm', 'true'], catalog[op].inputs);
assert.equal(data.confirm, true);
assert.equal(data.folder, '');
validateCad(op, data);
assert.deepEqual(mapCadPaths(op, data), data);
data.folder = 'Designs/Parts';
assert.deepEqual(mapCadPaths(op, data), data);
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
