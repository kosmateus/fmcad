"""Offline identity guards; fixtures live only under the caller's TMPDIR."""
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


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'assets'))
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
NS = {}
with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
    load_legacy_core(NS, REPO)
    exec((REPO / 'assets/cad/identity.py').read_text(), NS)
CadContext = NS['CadContext']
payload = sys.stdin.read()
if not payload:
    payload = subprocess.check_output(['node', '-e', """
const {buildCadScript, catalog} = require('./src/cad');
console.log(JSON.stringify(Object.fromEntries(
  ['status', 'model.extrude', 'export.step', 'document.save_as'].map(op =>
    [op, buildCadScript(op, catalog[op].example, {
      doc: 'Model', docId: 'creation-original', docFileId: 'urn:cloud:original'
    })]))));
"""], cwd=REPO, text=True)
SCRIPTS = json.loads(payload)


class Document:
    def __init__(self, app, name='Model', creation='creation-original', file_id='urn:cloud:original'):
        self.app, self.name, self.creationId = app, name, creation
        self.dataFile = (types.SimpleNamespace(id=file_id, parentProject=types.SimpleNamespace(id='source'))
                         if file_id else None)
        self.products = types.SimpleNamespace(itemByProductType=lambda _: types.SimpleNamespace(rootComponent=object()))
        self.activations = 0
        self.activation_result, self.switch = True, True

    @property
    def allDocumentReferences(self):
        return types.SimpleNamespace(count=0)

    def activate(self):
        self.activations += 1
        if self.switch:
            self.app.activeDocument = self
        return self.activation_result


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.app = types.SimpleNamespace(documents=[], activeDocument=None)
        self.target = Document(self.app)
        self.other = Document(self.app, name='Other', creation='other', file_id='other-file')
        self.app.documents = [self.target, self.other]
        self.app.activeDocument = self.other
        adsk.core.Application = types.SimpleNamespace(get=lambda: self.app)
        adsk.fusion.Design = types.SimpleNamespace(cast=lambda value: value)
        # Re-register the fake adsk for the duration of this test: other offline test
        # modules overwrite sys.modules['adsk.core'] at import time, and the bundle
        # script's `import adsk.core` must resolve to this module (with Application).
        self._modules = patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
        self._modules.start()
        self.addCleanup(self._modules.stop)

    def context(self, **kwargs):
        return CadContext('Model', **kwargs)

    def test_target_not_active_and_independent_pins(self):
        for kwargs in ({'doc_id': 'creation-original'}, {'doc_file_id': 'urn:cloud:original'},
                       {'doc_id': 'creation-original', 'doc_file_id': 'urn:cloud:original'}):
            self.assertIs(self.context(**kwargs).doc, self.target)
        self.assertEqual(self.target.activations, 0)
        for kwargs in ({'doc_id': 'other'}, {'doc_file_id': 'other-file'}):
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                self.context(**kwargs)

    def test_name_required_exact_unique_even_when_pin_matches_one(self):
        for name in ('model', '', 'urn:cloud:original'):
            with self.assertRaises(ValueError):
                CadContext(name, doc_id='creation-original')
        self.other.name = 'Model'
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.context(doc_id='creation-original')

    def test_nested_reference_wrappers_do_not_masquerade_as_open_editor_matches(self):
        class NestedDocument(Document):
            @property
            def allDocumentReferences(self):
                raise RuntimeError('non-top-level document')
        nested = NestedDocument(self.app)
        self.app.documents = [self.target, nested]
        self.assertIs(self.context(doc_id='creation-original').doc, self.target)

    def test_unsaved_source_and_legacy_without_id_properties(self):
        self.target.dataFile = None
        self.assertIs(self.context(doc_id='creation-original').doc, self.target)
        with self.assertRaisesRegex(ValueError, 'doc-file-id mismatch'):
            self.context(doc_file_id='urn:cloud:original')
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.context(project_id='destination', doc_id='creation-original')
        del self.target.creationId
        del self.target.dataFile
        self.assertIs(self.context().doc, self.target)

    def test_project_filter_retains_existing_contract(self):
        self.assertIs(self.context(project_id='source', doc_id='creation-original').doc, self.target)
        with self.assertRaises(ValueError):
            self.context(project_id='destination', doc_id='creation-original')

    def test_activation_bool_actual_target_and_recheck(self):
        ctx = self.context(doc_id='creation-original')
        self.target.activation_result = False
        with self.assertRaisesRegex(RuntimeError, 'activation failed'):
            ctx.activate_target()
        self.app.activeDocument = self.other
        self.target.activation_result, self.target.switch = True, False
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            ctx.activate_target()
        self.target.switch = True
        ctx.activate_target()
        self.assertIs(self.app.activeDocument, self.target)
        self.target.creationId = 'replacement'
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            ctx.activate_target()

    def test_identity_transition_during_activation_is_not_accepted(self):
        ctx = self.context(doc_id='creation-original')

        def activate():
            self.app.activeDocument = self.target
            self.target.creationId = 'after-transition'
            return True

        self.target.activate = activate
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            ctx.activate_target()
        self.assertEqual(ctx.doc_id, 'creation-original')

    def test_wrappers_block_before_handlers_and_activation(self):
        for operation, script in SCRIPTS.items():
            for failure in ('creation', 'file', 'false-activation', 'wrong-active', None):
                with self.subTest(operation=operation, failure=failure):
                    self.setUp()
                    namespace = {}
                    exec(script, namespace)
                    calls = []
                    # Explicit fixture replacement; production bundles reject
                    # accidental handler overwrites during registration.
                    namespace['CAD_HANDLERS'].pop(operation)
                    namespace['CAD_HANDLERS'][operation] = lambda ctx, data: calls.append(ctx.doc) or {}
                    if failure == 'creation':
                        self.target.creationId = 'replacement'
                    elif failure == 'file':
                        self.target.dataFile.id = 'replacement'
                    elif failure == 'false-activation':
                        self.target.activation_result = False
                    elif failure == 'wrong-active':
                        self.target.switch = False
                    blocked = failure is not None and (operation != 'status' or failure in ('creation', 'file'))
                    with contextlib.redirect_stdout(io.StringIO()):
                        if blocked:
                            with self.assertRaises((ValueError, RuntimeError)):
                                namespace['run']('')
                        else:
                            namespace['run']('')
                    self.assertEqual(calls, [] if blocked else [self.target])
                    if failure in ('creation', 'file'):
                        self.assertEqual(self.target.activations, 0)


if __name__ == '__main__':
    unittest.main()
