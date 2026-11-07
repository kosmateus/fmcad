import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
EPOCH = '01234567-89ab-4cde-8fab-0123456789ab'


def count(value=0):
    return types.SimpleNamespace(count=value)


class Document:
    def __init__(self, creation_id, name='Existing user document'):
        self.creationId, self.name = creation_id, name
        self.isValid, self.isSaved, self.isModified, self.dataFile = True, False, False, None
        self.allDocumentReferences = count()
        self.design = types.SimpleNamespace(rootComponent=types.SimpleNamespace(
            bRepBodies=count(), sketches=count(), allOccurrences=count()), userParameters=count(), timeline=count())
        self.products = types.SimpleNamespace(itemByProductType=lambda _: self.design)
        self.closed, self.close_result, self.documents = [], True, None
        self.activations, self.activate_result = 0, True

    def close(self, save_changes):
        self.closed.append(save_changes)
        self.documents.rows.remove(self)
        if self.documents.app.activeDocument is self:
            self.documents.app.activeDocument = self.documents.rows[-1] if self.documents.rows else None
        return self.close_result

    def activate(self):
        self.activations += 1
        if self.activate_result:
            self.documents.app.activeDocument = self
        return self.activate_result


class Documents:
    def __init__(self, old):
        self.rows, self.calls, self.factory = [old], 0, lambda: Document('genuinely-new')

    @property
    def count(self):
        return len(self.rows)

    def item(self, index):
        return self.rows[index]

    def add(self, _kind):
        self.calls += 1
        doc = self.factory()
        if doc not in self.rows:
            self.rows.append(doc)
        doc.documents = self
        self.app.activeDocument = doc
        return doc


class ScratchEpochTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='epoch-python-', dir='/tmp/opencode')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.old = Document('old-open')
        self.docs = Documents(self.old)
        self.old.documents = self.docs
        self.app = types.SimpleNamespace(documents=self.docs, activeDocument=self.old,
                                         userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
        self.docs.app = self.app
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        adsk.core.DocumentTypes = types.SimpleNamespace(FusionDesignDocumentType=1)
        adsk.fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        self.modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.namespace = {}
        for name in ['atomic_audit.py', 'scratch_epoch.py']:
            source = ROOT / 'runtime/python/recovery' / name
            exec(compile(source.read_text(), str(source), 'exec'), self.namespace)
        self.args = {'epochId': EPOCH, 'name': 'FMCAD_ISOLATED_' + EPOCH,
                     'proofPath': str(self.root / 'sdk-qualified.json'), 'bindingHash': 'broker-binding',
                     'forbiddenIds': ['historical-closed']}

    def create(self):
        return self.namespace['qualify_new_scratch'](self.app, self.args)

    def close(self, result):
        args = {'epochId': EPOCH, 'document': result['document'], 'bindingHash': 'close-binding',
                'proofPath': str(self.root / 'sdk-closed.json')}
        if 'previousActiveCreationId' in result:
            args['restoreActiveCreationId'] = result['previousActiveCreationId']
        return self.namespace['close_qualified_scratch'](self.app, args)

    def test_proves_actual_new_empty_unsaved_doc_without_touching_old(self):
        result = self.create()
        self.assertEqual(result['document']['creationId'], 'genuinely-new')
        self.assertTrue(result['independent'] and result['empty'] and result['unsaved'])
        self.assertEqual(self.docs.calls, 1)
        self.assertEqual(self.old.name, 'Existing user document')
        self.assertEqual(self.old.closed, [])
        self.assertEqual(json.loads(pathlib.Path(self.args['proofPath']).read_text()), result)

    def test_existing_active_return_is_not_renamed_adopted_or_replayed(self):
        self.docs.factory = lambda: self.old
        with self.assertRaises(RuntimeError):
            self.create()
        self.assertEqual(self.old.name, 'Existing user document')
        with self.assertRaises((ValueError, FileExistsError)):
            self.create()
        self.assertEqual(self.docs.calls, 1)

    def test_historical_closed_id_is_never_treated_as_new(self):
        self.docs.factory = lambda: Document('historical-closed')
        with self.assertRaises(RuntimeError):
            self.create()
        self.assertEqual(self.docs.rows[-1].name, 'Existing user document')

    def test_busy_or_existing_scratch_name_does_not_create(self):
        self.app.userInterface.activeCommand = 'ExtrudeCommand'
        with self.assertRaises(ValueError):
            self.create()
        self.app.userInterface.activeCommand = 'SelectCommand'
        self.old.name = self.args['name']
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual(self.docs.calls, 0)

    def test_nonempty_creation_retains_uncertainty_without_cleanup_or_replay(self):
        doc = Document('new-nonempty')
        doc.design.rootComponent.bRepBodies.count = 1
        self.docs.factory = lambda: doc
        with self.assertRaises(RuntimeError):
            self.create()
        self.assertTrue(pathlib.Path(self.args['proofPath'] + '.created').exists())
        self.assertEqual(doc.closed, [])
        with self.assertRaises((ValueError, FileExistsError)):
            self.create()
        self.assertEqual(self.docs.calls, 1)

    def test_concurrent_other_document_creation_is_rejected(self):
        def raced():
            self.docs.rows.append(Document('unexpected-concurrent'))
            return Document('new-raced')
        self.docs.factory = raced
        with self.assertRaises(RuntimeError):
            self.create()
        self.assertFalse(pathlib.Path(self.args['proofPath']).exists())

    def test_close_discards_only_the_qualified_new_doc(self):
        created = self.create()
        new_doc = self.docs.rows[-1]
        result = self.close(created)
        self.assertTrue(result['closed'])
        self.assertFalse(result['saved'])
        self.assertEqual(new_doc.closed, [False])
        self.assertEqual(self.docs.rows, [self.old])
        self.assertEqual(self.old.closed, [])

    def test_saved_renamed_or_linked_scratch_is_not_discarded(self):
        created = self.create()
        doc = self.docs.rows[-1]
        for key, changed, normal in [('isSaved', True, False), ('name', 'user-renamed', created['document']['name'])]:
            setattr(doc, key, changed)
            with self.assertRaises(ValueError):
                self.close(created)
            setattr(doc, key, normal)
        doc.allDocumentReferences.count = 1
        with self.assertRaises(ValueError):
            self.close(created)
        self.assertEqual(doc.closed, [])

    def test_uncertain_close_is_not_replayed_and_does_not_touch_old(self):
        created = self.create()
        doc = self.docs.rows[-1]
        doc.close_result = False
        with self.assertRaises(RuntimeError):
            self.close(created)
        with self.assertRaises(ValueError):
            self.close(created)
        self.assertEqual(doc.closed, [False])
        self.assertEqual(self.old.closed, [])

    def test_successor_captures_and_restores_exact_prior_active_document(self):
        other = Document('another-user-document')
        other.documents = self.docs
        self.docs.rows.append(other)
        self.args['captureActiveDocument'] = True
        created = self.create()
        self.assertEqual(created['previousActiveCreationId'], self.old.creationId)
        self.assertEqual(self.app.activeDocument.creationId, created['document']['creationId'])
        closed = self.close(created)
        self.assertTrue(closed['activeDocumentRestored'])
        self.assertEqual(closed['restoredActiveCreationId'], self.old.creationId)
        self.assertIs(self.app.activeDocument, self.old)
        self.assertEqual(self.old.activations, 1)
        self.assertEqual(self.old.closed, [])
        self.assertEqual(other.closed, [])

    def test_successor_preserves_a_different_user_selected_active_document(self):
        self.args['captureActiveDocument'] = True
        created = self.create()
        other = Document('user-selected-document')
        other.documents = self.docs
        self.docs.rows.append(other)
        other.activate()
        closed = self.close(created)
        self.assertIs(self.app.activeDocument, other)
        self.assertEqual(closed['restoredActiveCreationId'], other.creationId)
        self.assertEqual(self.old.activations, 0)
        self.assertEqual(other.activations, 1)
        self.assertEqual(other.closed, [])

    def test_successor_can_restore_no_document_without_closing_any_other_document(self):
        self.docs.rows.clear()
        self.app.activeDocument = None
        self.args['captureActiveDocument'] = True
        created = self.create()
        self.assertIsNone(created['previousActiveCreationId'])
        closed = self.close(created)
        self.assertTrue(closed['activeDocumentRestored'])
        self.assertIsNone(closed['restoredActiveCreationId'])
        self.assertIsNone(self.app.activeDocument)

    def test_missing_captured_document_never_adopts_another_restore_target(self):
        self.args['captureActiveDocument'] = True
        created = self.create()
        self.docs.rows.remove(self.old)  # Simulated separate user action, not a controller mutation.
        with self.assertRaises(RuntimeError):
            self.close(created)
        self.assertFalse((self.root / 'sdk-closed.json').exists())
        self.assertEqual(self.old.activations, 0)
        self.assertEqual(self.old.closed, [])

    def test_restore_activation_failure_is_not_reported_as_cleanup_pass(self):
        other = Document('other-open-document')
        other.documents = self.docs
        self.docs.rows.append(other)
        self.args['captureActiveDocument'] = True
        created = self.create()
        self.old.activate_result = False
        with self.assertRaises(RuntimeError):
            self.close(created)
        self.assertFalse((self.root / 'sdk-closed.json').exists())
        self.assertIs(self.app.activeDocument, other)
        self.assertEqual(other.closed, [])

    def test_invalid_prior_active_identity_rejects_before_creation(self):
        self.args['captureActiveDocument'] = True
        self.app.activeDocument = Document('not-in-the-open-document-set')
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual(self.docs.calls, 0)


if __name__ == '__main__':
    unittest.main()
