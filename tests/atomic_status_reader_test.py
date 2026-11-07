"""Canonical reader/normal-dispatch equivalence with SDK doubles; no Fusion."""
import copy
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]
FUSION = ROOT / 'runtime/python/fmcad/adapters/fusion'


class AtomicStatusReaderTests(unittest.TestCase):
    def setUp(self):
        adsk, core, fusion = types.ModuleType('adsk'), types.ModuleType('adsk.core'), types.ModuleType('adsk.fusion')
        adsk.core, adsk.fusion = core, fusion
        core.Document = object
        self.module = types.ModuleType('atomic_status_legacy_fixture')
        self.command = 'fmcad_atomic_' + 'a' * 32
        doc = {'name': 'owned scratch', 'creationId': 'owned-id', 'fileId': None}
        self.args = {'operation': 'atomic_status', 'commandId': self.command, 'runId': 'owned-run',
            'requestHash': 'b' * 64, 'sessionNonce': 'c' * 32, 'backend': 'addin',
            'documentIdentity': {'expected': doc, 'resolved': doc, 'assertionsOnly': True}}
        self.holder = types.ModuleType('_fmcad_' + self.command)
        self.holder.identity = {key: value for key, value in self.args.items() if key != 'operation'}
        self.holder.identity['resolvedIdentity'] = doc
        self.holder.definitionId = self.command
        self.holder.state = {'outcome': 'aborted', 'completed': True, 'destroyed': True,
            'accepted': True, 'cleanupCompleted': False, 'definitionDeleted': False}
        def forbidden(*_args, **_kwargs):
            self.fail('Read-only status attempted an SDK mutation')
        target = types.SimpleNamespace(name=doc['name'], creationId=doc['creationId'], dataFile=None,
            isValid=True, activate=forbidden, save=forbidden, close=forbidden)
        definition = types.SimpleNamespace(id=self.command, isNative=False, isValid=True, deleteMe=forbidden)
        self.other = types.SimpleNamespace(name='unrelated active document')
        self.app = types.SimpleNamespace(documents=[target], activeDocument=self.other,
            userInterface=types.SimpleNamespace(activeCommand='SelectCommand',
                commandDefinitions=types.SimpleNamespace(itemById=lambda _key: definition, addButtonDefinition=forbidden)))
        modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion,
            self.module.__name__: self.module, self.holder.__name__: self.holder})
        modules.start()
        self.addCleanup(modules.stop)
        load_legacy_core(self.module.__dict__, ROOT)
        exec(compile((FUSION / 'atomic.py').read_text(), str(FUSION / 'atomic.py'), 'exec'), self.module.__dict__)
        self.legacy = self.module._atomic_transaction
        exec((FUSION / 'atomic_status.py').read_text(), self.module.__dict__)
        exec((FUSION / 'atomic_status_dispatch.py').read_text(), self.module.__dict__)

    def test_shared_reader_matches_legacy_status_without_state_or_document_changes(self):
        before = copy.deepcopy(self.holder.state)
        self.assertEqual(self.module._atomic_transaction(self.app, self.args), self.legacy(self.app, self.args))
        self.assertEqual(self.holder.state, before)
        self.assertIs(self.app.activeDocument, self.other)

    def test_other_atomic_operations_forward_unchanged_to_the_original_handler(self):
        calls = []
        args = {'operation': 'atomic_start', 'opaque': {'untouched': True}}
        def original(app, payload):
            calls.append((app, payload))
            return {'forwarded': True}
        self.module._atomic_status_previous_transaction = original
        self.assertEqual(self.module._atomic_transaction(self.app, args), {'forwarded': True})
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0][0], self.app)
        self.assertIs(calls[0][1], args)

    def test_missing_holder_remains_unknown_not_terminal(self):
        del sys.modules[self.holder.__name__]
        actual = self.module._atomic_transaction(self.app, self.args)
        self.assertEqual(actual, self.legacy(self.app, self.args))
        self.assertEqual(actual['outcome'], 'unknown')
        self.assertFalse(actual['completed'])
        self.assertFalse(actual['destroyed'])

    def test_forged_holder_identity_never_becomes_a_terminal_result(self):
        forged = copy.deepcopy(self.args)
        forged['sessionNonce'] = 'd' * 32
        actual = self.module._atomic_transaction(self.app, forged)
        self.assertEqual(actual, self.legacy(self.app, forged))
        self.assertEqual(actual['status'], 'identity_mismatch')
        self.assertEqual(actual['outcome'], 'unknown')


if __name__ == '__main__':
    unittest.main()
