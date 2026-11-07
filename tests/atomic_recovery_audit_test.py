"""Pure SDK doubles: exact pin reads, unavailable facts, no mutation capability."""
import hashlib
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def forbidden(*_args):
            self.calls.append('mutation')
            raise AssertionError('No SDK writer may be invoked')
        self.forbidden = forbidden
        self.identity = {'commandId': 'fmcad_atomic_' + 'a' * 32, 'sessionNonce': 'b' * 32,
            'runId': 'run', 'requestHash': 'c' * 64, 'backend': 'addin',
            'resolvedIdentity': {'name': 'Owned', 'creationId': 'owned-id', 'fileId': None}}
        counts = lambda n: types.SimpleNamespace(count=n)
        design = types.SimpleNamespace(rootComponent=types.SimpleNamespace(bRepBodies=counts(2), sketches=counts(3),
            allOccurrences=counts(1)), userParameters=counts(4), timeline=counts(5))
        self.doc = types.SimpleNamespace(name='Owned', creationId='owned-id', dataFile=None, isValid=True,
            isSaved=False, isModified=True, allDocumentReferences=counts(0),
            products=types.SimpleNamespace(itemByProductType=lambda _kind: design), activate=forbidden,
            save=forbidden, close=forbidden)
        self.documents = [self.doc]
        self.app = types.SimpleNamespace(documents=types.SimpleNamespace(count=1, item=lambda i: self.documents[i]),
            activeDocument=object(), userInterface=types.SimpleNamespace(activeCommand='SelectCommand',
            commandDefinitions=types.SimpleNamespace(itemById=lambda _id: None, addButtonDefinition=forbidden)))
        adsk, fusion = types.ModuleType('adsk'), types.ModuleType('adsk.fusion')
        adsk.fusion = fusion
        fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.fusion': fusion})
        modules.start()
        self.addCleanup(modules.stop)
        self.namespace = {}
        source = Path(__file__).resolve().parents[1] / 'runtime/python/recovery/atomic_audit.py'
        exec(source.read_text(), self.namespace)

    def audit(self):
        result = self.namespace['atomic_recovery_audit'](self.app, {'identity': self.identity})
        self.assertEqual(self.calls, [])
        self.assertEqual(result['nativeOutcome'], 'unknown')
        self.assertEqual(result['modelValidation'], 'not_performed')
        self.assertEqual(result['rollbackVerification'], 'not_performed')
        return result

    def test_absent_holder_and_definition_still_return_present_document_facts(self):
        active = self.app.activeDocument
        result = self.audit()
        self.assertFalse(result['modulePresent'])
        self.assertEqual(result['commandDefinition'], {'status': 'absent'})
        self.assertTrue(result['ui']['idle'])
        self.assertEqual(result['document']['identity'], self.identity['resolvedIdentity'])
        self.assertEqual(result['snapshot']['bodies'], 2)
        expected = hashlib.sha256(json.dumps(result['snapshot'], sort_keys=True,
            separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(result['fingerprint'], expected)
        self.assertIs(self.app.activeDocument, active)

    def test_same_name_other_creation_id_never_returns_model_facts(self):
        self.doc.creationId = 'foreign-id'
        result = self.audit()
        self.assertEqual(result['document']['status'], 'absent')
        self.assertIsNone(result['snapshot'])

    def test_saved_file_drift_is_not_treated_as_the_old_unsaved_document(self):
        self.doc.dataFile = types.SimpleNamespace(id='other-file', versionNumber=1)
        self.assertEqual(self.audit()['document']['status'], 'absent')

    def test_ambiguous_exact_pins_produce_no_fingerprint(self):
        self.documents.append(self.doc)
        self.app.documents.count = 2
        result = self.audit()
        self.assertEqual(result['document']['status'], 'ambiguous')
        self.assertIsNone(result['fingerprint'])

    def test_module_presence_never_reads_holder_state_or_infers_outcome(self):
        class HostileHolder(types.ModuleType):
            def __getattr__(self, _name):
                raise AssertionError('Holder state must not be interpreted')
        with patch.dict(sys.modules, {'_fmcad_' + self.identity['commandId']: HostileHolder('owned')}):
            self.assertTrue(self.audit()['modulePresent'])

    def test_invalid_native_definition_and_busy_ui_are_facts_not_abort(self):
        self.app.userInterface.activeCommand = 'SomeExternalCommand'
        self.app.userInterface.commandDefinitions.itemById = lambda _id: types.SimpleNamespace(
            id=self.identity['commandId'], isNative=True, isValid=True, deleteMe=self.forbidden)
        result = self.audit()
        self.assertFalse(result['ui']['idle'])
        self.assertEqual(result['commandDefinition']['status'], 'foreign_or_invalid')

    def test_failed_model_getter_is_unavailable_not_zero_counts(self):
        self.doc.products.itemByProductType = lambda _kind: None
        result = self.audit()
        self.assertEqual(result['document']['status'], 'unavailable')
        self.assertIsNone(result['snapshot'])
        self.assertIsNone(result['fingerprint'])


if __name__ == '__main__':
    unittest.main()
