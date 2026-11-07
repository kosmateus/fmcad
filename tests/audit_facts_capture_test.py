import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='audit-capture-sdk-', dir='/tmp/opencode')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        adsk = types.ModuleType('adsk')
        adsk.fusion = types.ModuleType('adsk.fusion')
        modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.fusion': adsk.fusion})
        modules.start()
        self.addCleanup(modules.stop)
        self.namespace = {}
        for name in ['atomic_audit.py', 'audit_facts_capture.py']:
            file = ROOT / 'runtime/python/recovery' / name
            exec(compile(file.read_text(), str(file), 'exec'), self.namespace)
        self.app = types.SimpleNamespace(documents=types.SimpleNamespace(count=0),
            userInterface=types.SimpleNamespace(activeCommand='SelectCommand',
                commandDefinitions=types.SimpleNamespace(itemById=lambda _: None)))
        self.args = {'identity': {'commandId': 'fmcad_atomic_fixture',
            'resolvedIdentity': {'name': 'Historical', 'creationId': 'old', 'fileId': None}},
            'proofPath': str(self.root / 'sdk-facts.json'), 'bindingHash': 'actual-broker-binding', 'originalRpcId': 'prior-rpc'}

    def test_facts_are_durable_before_any_network_response_and_remain_historically_unknown(self):
        value = self.namespace['capture_current_audit_facts'](self.app, self.args)
        self.assertEqual(json.loads((self.root / 'sdk-facts.json').read_text()), value)
        self.assertEqual(value['bindingHash'], 'actual-broker-binding')
        self.assertEqual(value['originalRpcId'], 'prior-rpc')
        self.assertTrue(value['summary']['ui']['idle'])
        self.assertEqual(value['summary']['document'], {'status': 'absent', 'matches': 0})
        self.assertEqual(value['summary']['nativeOutcome'], 'unknown')
        self.assertEqual(value['rollbackVerification'], 'not_performed')

    def test_same_capture_cannot_read_again_after_a_lost_reply(self):
        calls = []
        reader = self.namespace['atomic_recovery_audit']
        self.namespace['atomic_recovery_audit'] = lambda app, args: (calls.append(1), reader(app, args))[1]
        self.namespace['capture_current_audit_facts'](self.app, self.args)
        with self.assertRaises(FileExistsError):
            self.namespace['capture_current_audit_facts'](self.app, self.args)
        self.assertEqual(calls, [1])

    def test_reader_failure_retains_started_evidence_and_is_not_replayed(self):
        self.namespace['atomic_recovery_audit'] = lambda *_: (_ for _ in ()).throw(RuntimeError('fixture getter error'))
        with self.assertRaises(RuntimeError):
            self.namespace['capture_current_audit_facts'](self.app, self.args)
        self.assertTrue((self.root / 'sdk-facts.json.started').exists())
        self.assertFalse((self.root / 'sdk-facts.json').exists())
        with self.assertRaises(FileExistsError):
            self.namespace['capture_current_audit_facts'](self.app, self.args)


if __name__ == '__main__':
    unittest.main()
